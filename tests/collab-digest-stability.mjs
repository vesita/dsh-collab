// collab-digest-stability.mjs
// 态势摘要**文本时间稳定性**回归测试 —— 针对一个实测过的真实退化。
//
// 背景（实测，不是推测）：
//   dsh-agent-loop 的 RuntimeContextProjection.project(current, sections) 里有
//   `if (this.retained?.text === snapshot) return`：新渲染的文本与上一份逐字节相同时，
//   **不提交**新的运行时上下文消息。而快照是**整块**提交的：沙箱策略 + 审批策略 +
//   本插件摘要的拼接文本一起重发。
//   旧摘要写「…，剩 47 分」，相对倒计时每分钟都变 ⇒ 去重被击穿 ⇒ 整块快照每分钟重发。
//   实测全部 90 个会话、415 次已提交快照：237 次（57.1%）**只差那个数字**，
//   累计 337014 字符被重复注入（237 是逐对做最小差异判定得到的精确值）。
//
// 修法：改成绝对 UTC 起止时刻，并让 renderDigest 的**签名不含时间参数**。
// 本测试守住四件事：纯函数、无相对倒计时、顺序确定、集合一变文本就变。
//
// 运行：node tests/collab-digest-stability.mjs
// 退出码非 0 表示失败。

import { renderDigest, clockUtc } from '../lib/collab-core.js'

let pass = 0, fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label) }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  <-- ' + extra : '')) }
}

// 固定绝对时刻，测试完全不依赖真实时钟。
const T0 = Date.UTC(2026, 0, 2, 3, 4, 37)
const HOUR = 3600 * 1000
const mkClaim = (o) => Object.assign({
  claimId: 'c_x', holderId: 'agent:x', holderName: 'Worker X',
  paths: ['src/x/'], mode: 'exclusive', ttlSec: 1800,
  expiresAt: T0 + 1800 * 1000, note: '', createdAt: T0
}, o)

const A = mkClaim({ claimId: 'c_a', holderId: 'agent:a', holderName: 'Alpha', paths: ['src/a/'] })
const B = mkClaim({ claimId: 'c_b', holderId: 'agent:b', holderName: 'Beta', paths: ['src/b/'], expiresAt: T0 + 900 * 1000, ttlSec: 900 })
const C = mkClaim({ claimId: 'c_c', holderId: 'agent:c', holderName: 'Gamma', paths: ['src/c/'], mode: 'shared', expiresAt: T0 + HOUR, ttlSec: 3600 })
const D = mkClaim({ claimId: 'c_d', holderId: 'agent:d', holderName: 'Delta', paths: ['src/d/'], expiresAt: T0 + 2 * HOUR, ttlSec: 7200 })

// ===== a. 纯函数：同输入 → 逐字节同输出，且签名里没有任何时间参数 =====
console.log('# a. renderDigest is a pure function of its argument (no time parameter)')
{
  const input = [A, B, C]
  const one = renderDigest(input)
  const two = renderDigest(input)
  ok(one === two, 'calling renderDigest twice yields byte-identical output')
  // 结构相等但**不同对象**的输入也必须同输出（防止函数偷偷读对象身份/时间）
  const clone = JSON.parse(JSON.stringify(input))
  ok(renderDigest(clone) === one, 'structurally equal input (fresh objects) yields identical output')
  // 硬约束：签名只有一个形参。多一个 now/t 参数就足以把倒计时放回来。
  ok(renderDigest.length === 1, 'renderDigest declares exactly one parameter (no now/t)', 'length=' + renderDigest.length)
  ok(clockUtc.length === 1, 'clockUtc declares exactly one parameter (a timestamp, not "now")', 'length=' + clockUtc.length)
  // 同一组占用、不同"当前时刻"下的唯一可能差异来源只能是入参：函数体内不可能读到时钟。
  const src = renderDigest.toString()
  ok(!/Date\.now|performance\.now|new Date\(\)/.test(src),
    'renderDigest body never reads the current clock', src)
}

// ===== b. 文本含绝对 UTC 时刻，绝不含相对倒计时 =====
console.log('# b. absolute UTC timestamps in, relative countdown out')
{
  const text = renderDigest([A, B, C])
  ok(/租约 30 分（01-02 03:04Z–01-02 03:34Z）/.test(text),
    'renders the absolute UTC lease window MM-DD HH:MMZ–MM-DD HH:MMZ', text)
  ok(clockUtc(T0) === '01-02 03:04Z', 'clockUtc truncates to UTC minutes and appends Z', clockUtc(T0))
  ok(!/剩\s*\d+\s*分/.test(text), 'no 「剩 N 分」 countdown', text)
  ok(!/剩余|还剩|倒计时|remaining|countdown/i.test(text), 'no other relative-remaining wording', text)
  // 「N 分」这个数字只能来自 ttlSec（静态属性），不能来自"离到期还有多久"。
  // 反证：ttlSec 相同、expiresAt 差 3 小时的两条声明，渲染出的分钟数必须相同。
  const far = mkClaim({ claimId: 'c_far', holderId: 'agent:a', holderName: 'Alpha', paths: ['src/a/'], ttlSec: 1800, expiresAt: T0 + 3 * HOUR })
  const near = mkClaim({ claimId: 'c_near', holderId: 'agent:a', holderName: 'Alpha', paths: ['src/a/'], ttlSec: 1800, expiresAt: T0 + 60 * 1000 })
  ok(renderDigest([far]).includes('租约 30 分') && renderDigest([near]).includes('租约 30 分'),
    'lease minutes come from ttlSec, not from (expiresAt - now)', renderDigest([near]))
  // 第二条管线：单位是"分"，不存在按秒递增的字段
  ok(!/\d+ ?秒|\d+ ?s\b/.test(text), 'no per-second counter that would tick every step', text)
}

// ===== c. 顺序确定性：打乱输入渲染成同一文本 =====
console.log('# c. input order does not change the rendered text (determinism)')
{
  const ordered = renderDigest([A, B, C, D])
  const shuffles = [
    [D, C, B, A],
    [B, D, A, C],
    [C, A, D, B]
  ]
  for (const s of shuffles) {
    ok(renderDigest(s) === ordered, 'shuffled input renders identically: ' + s.map((c) => c.claimId).join(','))
  }
  ok(!renderDigest([A, B, C, D]).includes('undefined'), 'no undefined leaked into the text')
}

// ===== d. 集合变化必须改变文本（摘要不能是冻结的常量） =====
console.log('# d. any real change to the claim set changes the text')
{
  const base = [A, B]
  const baseline = renderDigest(base)
  ok(renderDigest([A, B, C]) !== baseline, 'adding a claim changes the text')
  ok(renderDigest([A]) !== baseline, 'removing a claim changes the text')
  const modeChanged = [A, Object.assign({}, B, { mode: 'shared' })]
  ok(renderDigest(modeChanged) !== baseline, 'changing a mode changes the text')
  const extended = [A, Object.assign({}, B, { expiresAt: B.expiresAt + HOUR })]
  ok(renderDigest(extended) !== baseline, 'extending expiresAt changes the text')
  const renamed = [A, Object.assign({}, B, { holderName: 'Beta Renamed' })]
  ok(renderDigest(renamed) !== baseline, 'renaming a holder changes the text')
  const pathChanged = [A, Object.assign({}, B, { paths: ['src/b2/'] })]
  ok(renderDigest(pathChanged) !== baseline, 'changing a path changes the text')
}

// ===== e. 截断行为与文档一致：>3 条声明、>2 个路径 =====
console.log('# e. truncation: 3 claims max, 2 paths max')
{
  const four = renderDigest([A, B, C, D])
  ok(four.includes('；另有 1 条'), 'a 4th claim is folded into 「；另有 1 条」', four)
  ok(!four.includes('Delta'), 'the folded claim is not named', four)
  ok(four.includes('Alpha') && four.includes('Beta') && four.includes('Gamma'), 'first three claims are named', four)

  // 排序后前三条：B(03:19) A(03:34) C(04:04) D(05:04) → D 被折叠
  const six = renderDigest([A, B, C, D, mkClaim({ claimId: 'c_e', holderId: 'agent:e', holderName: 'Eps', expiresAt: T0 + 3 * HOUR }), mkClaim({ claimId: 'c_f', holderId: 'agent:f', holderName: 'Zeta', expiresAt: T0 + 4 * HOUR })])
  ok(six.includes('；另有 3 条'), 'more than three extra claims are counted, not listed', six)
  ok(!six.includes('Zeta'), 'claims past the third are not named', six)

  const wide = renderDigest([mkClaim({ claimId: 'c_w', holderId: 'agent:w', holderName: 'Wide', paths: ['p1/', 'p2/', 'p3/', 'p4/'] })])
  ok(wide.includes('占用 p1/ p2/ 等 4 条，'), 'only the first two paths are listed, the rest are counted', wide)
  ok(!wide.includes('p3/') && !wide.includes('p4/'), 'paths past the second are not listed', wide)

  const twoPaths = renderDigest([mkClaim({ claimId: 'c_2p', holderId: 'agent:2p', holderName: 'Two', paths: ['p1/', 'p2/'] })])
  ok(twoPaths.includes('占用 p1/ p2/，') && !twoPaths.includes('等'), 'exactly two paths are listed without a fold marker', twoPaths)
}

// ===== 附：这一行必须仍然指向协商工具（回归保护，防止重构时把尾句丢掉） =====
console.log('# f. the digest still points at the negotiation tools')
{
  const text = renderDigest([A])
  ok(text.includes('collab_lock op=wait') || text.includes('collab_board'), 'digest names the negotiation tools', text)
  ok(text.startsWith('[dsh-collab] '), 'digest keeps its stable prefix', text)
  ok(/。$/.test(text), 'digest is one sentence block ending in 。', text)
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
