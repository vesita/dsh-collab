// tests/collab-handoff-awareness.mts —— 接手交互的三条约束
//
// 载体是 awareness 的每步注入（不是新增投递面）：`collab_board` 按设计
// "不投递、不唤醒"，而 awareness 本来就每步注入一次同项目占用 ——
// 交接只要成为那一行上下文的一部分，就不需要推送。
//
// 三条约束（每条都要能独立失败）：
//   ① 只给相关的人看 —— 声明了交接涉及路径的会话才看到
//   ② 不重复 —— 已接手的不提示、草稿不提示
//   ③ 不报自己的 —— 自己（含会话家族）写的不提示

import { init, HANDOFF_FINAL_MARK } from '../lib/collab-core.js'
import { pendingHandoffsFor, renderPendingHandoffs } from '../lib/collab-ops.js'

let passed = 0
let failed = 0
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  ok  ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  <-- ' + detail : '')) }
}

const ops = await import('../lib/collab-ops.js')
const postOp = ops.post
const T = () => 5000
const FINAL_BODY = '正文\n\n' + HANDOFF_FINAL_MARK

/** 造一份状态：A 在 channel=path:src/a/ 写了一份 final 交接。 */
function stateWithHandoff({ channel = 'path:src/a/', status = 'final', acceptedBy } = {}) {
  const st = init()
  postOp(st, { holderId: 'agent:a', name: 'A' }, {
    body: FINAL_BODY,
    channel,
    kind: 'handoff',
    handoff: { status, items: [{ text: '做完了一件', status: 'done', negativeControl: { command: 'c', became: 'b' } }] },
  }, T)
  if (acceptedBy !== undefined) {
    st.messages[st.messages.length - 1].handoff.acceptedBy = acceptedBy
    st.messages[st.messages.length - 1].handoff.acceptedAt = 6000
  }
  return st
}

const NOBODY = new Set()

// ── 约束 ①：只给相关的人看 ────────────────────────────────────────

console.log('# ① 只给声明了相关路径的会话看')
{
  const st = stateWithHandoff({ channel: 'path:src/a/' })

  const related = pendingHandoffsFor(st.messages, 'agent:b', NOBODY, ['src/a/file.ts'])
  ok(related.length === 1, '声明了 src/a/ 的人能看到', 'got ' + related.length)

  const unrelated = pendingHandoffsFor(st.messages, 'agent:b', NOBODY, ['src/b/file.ts'])
  ok(unrelated.length === 0, '声明别的目录的人看不到', 'got ' + unrelated.length)

  const noPaths = pendingHandoffsFor(st.messages, 'agent:b', NOBODY, [])
  ok(noPaths.length === 0, '没声明任何路径的人看不到 path: 频道的交接', 'got ' + noPaths.length)

  // 前缀要按段比，不能按字符比（src/ab 不该匹配 src/a/）
  const sibling = pendingHandoffsFor(st.messages, 'agent:b', NOBODY, ['src/ab/file.ts'])
  ok(sibling.length === 0, '相邻路径不算相关（src/ab 不匹配 src/a/）', 'got ' + sibling.length)

  // general 频道：谁都能看到（那是广播）
  const general = stateWithHandoff({ channel: 'general' })
  ok(pendingHandoffsFor(general.messages, 'agent:b', NOBODY, []).length === 1,
    'general 频道的交接，没声明路径的人也能看到')
}

// ── 约束 ②：不重复 ────────────────────────────────────────────────

console.log('# ② 已接手 / 草稿都不提示')
{
  const accepted = stateWithHandoff({ acceptedBy: 'agent:c' })
  ok(pendingHandoffsFor(accepted.messages, 'agent:b', NOBODY, ['src/a/']).length === 0,
    '已被接手的交接不再提示')

  const draft = stateWithHandoff({ status: 'draft' })
  ok(pendingHandoffsFor(draft.messages, 'agent:b', NOBODY, ['src/a/']).length === 0,
    '草稿状态的交接不提示（只有 final 才允许接手）')

  // 同一份交接连续多次求值，结果必须一致（"不重复"的结构基础：无状态纯函数）
  const st = stateWithHandoff({})
  const first = pendingHandoffsFor(st.messages, 'agent:b', NOBODY, ['src/a/'])
  const second = pendingHandoffsFor(st.messages, 'agent:b', NOBODY, ['src/a/'])
  ok(first.length === second.length && first.length === 1,
    '同样输入反复求值结果一致（不累积、不漂移）')
}

// ── 约束 ③：不报自己的 ────────────────────────────────────────────

console.log('# ③ 自己（含会话家族）写的不提示')
{
  const st = stateWithHandoff({})

  ok(pendingHandoffsFor(st.messages, 'agent:a', NOBODY, ['src/a/']).length === 0,
    '自己写的不报给自己')

  // 会话家族：子智能体写的（agent:a），父会话（agent:parent）不该被提醒去接手
  const fam = new Set(['agent:parent', 'agent:a'])
  ok(pendingHandoffsFor(st.messages, 'agent:parent', fam, ['src/a/']).length === 0,
    '家族内成员写的不提醒家人')

  // 但家族外的人仍然看得到（fam 里没有 author）
  const outsiderFam = new Set(['agent:outsider'])
  ok(pendingHandoffsFor(st.messages, 'agent:outsider', outsiderFam, ['src/a/']).length === 1,
    '家族外的人仍能看到')
}

// ── 非法 kind 不该被当成交接 ──────────────────────────────────────

console.log('# 普通留言不参与接手提示')
{
  const st = init()
  postOp(st, { holderId: 'agent:a', name: 'A' }, { body: '普通留言', channel: 'path:src/a/' }, T)
  ok(pendingHandoffsFor(st.messages, 'agent:b', NOBODY, ['src/a/']).length === 0,
    'note 类型的留言不会被当成交接')
}

// ── 渲染 ──────────────────────────────────────────────────────────

console.log('# 渲染')
{
  const st = stateWithHandoff({})
  const line = renderPendingHandoffs(pendingHandoffsFor(st.messages, 'agent:b', NOBODY, ['src/a/']))
  ok(/有 1 份交接等你接手/u.test(line), '包含份数')
  ok(/agent:a/u.test(line), '包含交接人')
  ok(/collab_board op=read/u.test(line), '告诉怎么读全文')
  ok(/handoff-accept/u.test(line), '告诉怎么接手')

  ok(renderPendingHandoffs([]) === '', '没有交接时返回空串（不产生噪声）')

  // 时间稳定：连两次调用逐字节相同（否则整块快照每分钟重发，毁掉 DSH 的快照去重）
  const a = renderPendingHandoffs(pendingHandoffsFor(st.messages, 'agent:b', NOBODY, ['src/a/']))
  const b = renderPendingHandoffs(pendingHandoffsFor(st.messages, 'agent:b', NOBODY, ['src/a/']))
  ok(a === b, '渲染结果是时间稳定的（逐字节相同）')
}

// ── 多份时只列前三 + 报总数 ───────────────────────────────────────

console.log('# 多份交接')
{
  const st = init()
  for (let i = 0; i < 5; i++) {
    postOp(st, { holderId: 'agent:a', name: 'A' }, {
      body: FINAL_BODY, channel: 'general', kind: 'handoff',
      handoff: { status: 'final', items: [{ text: 'i' + i, status: 'unverified' }] },
    }, T)
  }
  const list = pendingHandoffsFor(st.messages, 'agent:b', NOBODY, [])
  ok(list.length === 5, '五份都能被挑出来', 'got ' + list.length)
  const line = renderPendingHandoffs(list)
  ok(/有 5 份/u.test(line), '报的是总数 5，不是截断后的 3')
  ok(/另有 2 份/u.test(line), '明确说明有折叠')
}

console.log('')
if (failed > 0) { console.log('FAILURES: ' + passed + ' passed, ' + failed + ' failed'); process.exit(1) }
console.log('ALL PASS: ' + passed + ' passed, 0 failed')
