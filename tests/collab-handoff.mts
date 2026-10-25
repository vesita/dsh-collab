// tests/collab-handoff.mts —— 结构化交接的四条不变量
//
// 每条都对应一次真实的踩坑（2026-10-25 那次跨会话协同）：
//   ① final 必须带定稿标记 —— 否则接手方在纯文本里分不清"写完了"与"被切断"
//   ② done 必须有负向对照 —— 那次一条名为 postpones 的用例从没调用过被测函数
//   ③ blocked 必须给 reason —— 否则接手方不知道该绕开还是该等
//   ④ measured 必须有 evidence —— 那次审计结论我实测后发现不成立
//
// 全部在 post() 里**挡回**而不是降级：降级会让"我测过了""我做完了"变成
// 可以随口说的话，而接手方没有任何办法分辨。

import { init, HANDOFF_FINAL_MARK, HANDOFF_MAX_ITEMS, HANDOFF_ITEM_TEXT_MAX_CHARS } from '../lib/collab-core.js'
import { mergeDocs, normalizeDoc } from '../lib/collab-core.js'

let passed = 0
let failed = 0
function ok(cond: unknown, name: string, detail?: string) {
  if (cond) { passed++; console.log('  ok  ' + name) }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  <-- ' + detail : '')) }
}
const T = () => 5000
const H = { holderId: 'agent:a', name: 'A' }

// `post` 从 collab-ops 导出（核心只放纯逻辑，操作面在 ops）
const ops = await import('../lib/collab-ops.js')
const postOp = ops.post

function badRequest(result) {
  return result && result.ok === false && result.data && result.data.error === 'bad-request'
}

const FINAL_BODY = '正文若干\n\n' + HANDOFF_FINAL_MARK

// ── 缺省行为不变（向后兼容是硬要求）────────────────────────────────

console.log('# 缺省 kind=note：老写法逐字节不变')
{
  const st = init()
  const before = JSON.stringify(st.messages)
  const r = postOp(st, H, { body: 'hello' }, T)
  ok(r.ok === true, 'post 成功')
  const m = st.messages[st.messages.length - 1]
  ok(m.kind === undefined, 'note 不写 kind 字段（落盘形状与老版本一致）', JSON.stringify(m.kind))
  ok(m.handoff === undefined, 'note 不带 handoff')
  ok(before === '[]', '起始状态是空数组')
}

// ── 不变量 ①：final 必须带定稿标记 ─────────────────────────────────

console.log('# ① final 必须带定稿标记')
{
  const items: any = [{ text: '做了一件事', status: 'unverified' }]
  const missing = postOp(init(), H, { body: '没有标记', kind: 'handoff', handoff: { status: 'final', items } }, T)
  ok(badRequest(missing), 'final 但末行没有标记 ⇒ 挡回', JSON.stringify(missing?.data))
  ok(String(missing.data.message).includes(HANDOFF_FINAL_MARK), '报错里说明了该写什么标记')

  const wrongLast = postOp(init(), H, { body: HANDOFF_FINAL_MARK + '\n多一行', kind: 'handoff', handoff: { status: 'final', items } }, T)
  ok(badRequest(wrongLast), 'final 但标记不在末行 ⇒ 挡回')

  const good = postOp(init(), H, { body: FINAL_BODY, kind: 'handoff', handoff: { status: 'final', items } }, T)
  ok(good.ok === true, 'final 且末行是标记 ⇒ 写入成功')

  // draft 不要求标记
  const draft = postOp(init(), H, { body: '还在写', kind: 'handoff', handoff: { status: 'draft', items } }, T)
  ok(draft.ok === true, 'draft 不要求定稿标记')
}

// ── 不变量 ②：done 必须有负向对照 ─────────────────────────────────

console.log('# ② done 必须有负向对照')
{
  const noNc = postOp(init(), H, {
    body: FINAL_BODY, kind: 'handoff',
    handoff: { status: 'final', items: [{ text: '修好了', status: 'done' }] },
  }, T)
  ok(badRequest(noNc), 'done 但没有 negativeControl ⇒ 挡回')
  ok(String(noNc.data.message).includes('unverified'), '报错里指出可以改用 unverified')

  const halfNc = postOp(init(), H, {
    body: FINAL_BODY, kind: 'handoff',
    handoff: { status: 'final', items: [{ text: '修好了', status: 'done', negativeControl: { command: 'rm x' } }] },
  }, T)
  ok(badRequest(halfNc), 'negativeControl 缺 became ⇒ 也挡回')

  const withNc = postOp(init(), H, {
    body: FINAL_BODY, kind: 'handoff',
    handoff: { status: 'final', items: [{ text: '修好了', status: 'done', negativeControl: { command: 'sed -i …', became: '3 failed' } }] },
  }, T)
  ok(withNc.ok === true, 'done + 完整负向对照 ⇒ 写入成功')

  // unverified 不需要负向对照（这正是三值而不是布尔的意义）
  const unverified = postOp(init(), H, {
    body: FINAL_BODY, kind: 'handoff',
    handoff: { status: 'final', items: [{ text: '改了但没验', status: 'unverified' }] },
  }, T)
  ok(unverified.ok === true, 'unverified 不要求负向对照')
}

// ── 不变量 ③：blocked 必须给 reason ───────────────────────────────

console.log('# ③ blocked 必须给 reason')
{
  const noReason = postOp(init(), H, {
    body: FINAL_BODY, kind: 'handoff',
    handoff: { status: 'final', items: [{ text: '没做', status: 'blocked' }] },
  }, T)
  ok(badRequest(noReason), 'blocked 但没 reason ⇒ 挡回')

  const withReason = postOp(init(), H, {
    body: FINAL_BODY, kind: 'handoff',
    handoff: { status: 'final', items: [{ text: '没做', status: 'blocked', reason: '等上游合入' }] },
  }, T)
  ok(withReason.ok === true, 'blocked + reason ⇒ 写入成功')
}

// ── 不变量 ④：measured 必须有 evidence ────────────────────────────

console.log('# ④ measured 必须有 evidence')
{
  const noEvidence = postOp(init(), H, {
    body: FINAL_BODY, kind: 'handoff',
    handoff: { status: 'final', items: [{ text: 'x', status: 'unverified', claim: { strength: 'measured' } }] },
  }, T)
  ok(badRequest(noEvidence), 'measured 但没有 evidence ⇒ 挡回')
  ok(/evidence/u.test(String(noEvidence.data.message)), '报错里指出了缺 evidence')

  const withEvidence = postOp(init(), H, {
    body: FINAL_BODY, kind: 'handoff',
    handoff: { status: 'final', items: [{ text: 'x', status: 'unverified', claim: { strength: 'measured', evidence: 'npm test → 0 failed' } }] },
  }, T)
  ok(withEvidence.ok === true, 'measured + evidence ⇒ 写入成功')

  // inferred 不需要 evidence（它本来就是"没测，只是推断"）
  const inferred = postOp(init(), H, {
    body: FINAL_BODY, kind: 'handoff',
    handoff: { status: 'final', items: [{ text: 'x', status: 'unverified', claim: { strength: 'inferred' } }] },
  }, T)
  ok(inferred.ok === true, 'inferred 不要求 evidence')
}

// ── 其他挡回路径 ──────────────────────────────────────────────────

console.log('# 其他非法输入也要挡回，不静默忽略')
{
  // 负向测试故意传非法类型（运行时有人不按 TS 契约调用时，必须挡回而不是崩溃）。
  // 加 `as any` 是为了不让负向测试代码自身报类型错。
  ok(badRequest(postOp(init(), H, { body: 'x', kind: 'nonsense' as any }, T)), '未知 kind ⇒ 挡回')
  ok(badRequest(postOp(init(), H, { body: 'x', handoff: { status: 'final', items: [] } as any }, T)),
    'kind 不是 handoff 却带了 handoff ⇒ 挡回（否则写入也读不到）')
  ok(badRequest(postOp(init(), H, { body: 'x', kind: 'handoff' }, T)), 'handoff 缺内容 ⇒ 挡回')
  ok(badRequest(postOp(init(), H, { body: 'x', kind: 'handoff', handoff: { status: 'nonsense' as any, items: [] } }, T)),
    '非法 status ⇒ 挡回')
  ok(badRequest(postOp(init(), H, { body: 'x', kind: 'handoff', handoff: { status: 'draft', items: 'nope' as any } }, T)),
    'items 不是数组 ⇒ 挡回')
  ok(badRequest(postOp(init(), H, { body: 'x', kind: 'handoff', handoff: { status: 'draft', items: [{}] as any } }, T)),
    '事项缺 text ⇒ 挡回')
  ok(badRequest(postOp(init(), H, {
    body: 'x', kind: 'handoff',
    handoff: { status: 'draft', items: [{ text: 'y'.repeat(HANDOFF_ITEM_TEXT_MAX_CHARS + 1), status: 'unverified' }] },
  }, T)), '事项 text 超长 ⇒ 挡回')
  ok(badRequest(postOp(init(), H, {
    body: 'x', kind: 'handoff',
    handoff: { status: 'draft', items: Array.from({ length: HANDOFF_MAX_ITEMS + 1 }, (_, i) => ({ text: 'i' + i, status: 'unverified' })) },
  }, T)), '事项条数超上限 ⇒ 挡回')
}

// ── 被挡回的 post 一个字都不落盘 ──────────────────────────────────

console.log('# 被挡回的 post 不写盘')
{
  const st = init()
  const seqBefore = st.seq
  const msgsBefore = st.messages.length
  postOp(st, H, { body: '没有标记', kind: 'handoff', handoff: { status: 'final', items: [] } }, T)
  ok(st.seq === seqBefore, 'seq 未被消耗')
  ok(st.messages.length === msgsBefore, '留言未新增')
  ok(st.holders.length === 0, '名册也未新增（holder() 没跑）')
}

// ── 落盘形状与合并 ────────────────────────────────────────────────

console.log('# 落盘形状 + 合并保持代数律')
{
  const st = init()
  postOp(st, H, {
    body: FINAL_BODY, kind: 'handoff',
    handoff: {
      status: 'final',
      items: [
        { text: '做完了', status: 'done', negativeControl: { command: 'c', became: 'b' } },
        { text: '没做', status: 'blocked', reason: 'r' },
      ],
    },
  }, T)
  const m = st.messages[st.messages.length - 1]
  ok(m.kind === 'handoff', 'kind 落盘')
  ok(m.handoff.status === 'final', 'status 落盘')
  ok(m.handoff.items.length === 2, 'items 落盘')
  ok(m.handoff.items[0].negativeControl.became === 'b', 'negativeControl 落盘')

  // 幂等 + 交换：同一份含交接的文档
  const a = normalizeDoc(st)
  ok(JSON.stringify(mergeDocs(a, a)) === JSON.stringify(a), 'merge(a,a) === a（含 handoff）')
  ok(JSON.stringify(mergeDocs(a, init())) === JSON.stringify(mergeDocs(init(), a)), '与空文档合并满足交换律')
}

// ── 并发接手只留一个 ──────────────────────────────────────────────

console.log('# 并发接手：acceptedBy 有值者胜（只留一个）')
{
  const base = init()
  postOp(base, H, {
    body: FINAL_BODY, kind: 'handoff',
    handoff: { status: 'final', items: [{ text: 'x', status: 'unverified' }] },
  }, T)
  const msgId = base.messages[base.messages.length - 1].msgId

  // 两个副本各自被不同接手者接受
  const left = normalizeDoc(base)
  const right = normalizeDoc(base)
  left.messages[0].handoff.acceptedBy = 'agent:zzz'
  left.messages[0].handoff.acceptedAt = 6000
  right.messages[0].handoff.acceptedBy = 'agent:aaa'
  right.messages[0].handoff.acceptedAt = 7000

  const merged = mergeDocs(left, right)
  const handoff = merged.messages[0].handoff
  ok(typeof handoff.acceptedBy === 'string' && handoff.acceptedBy !== '',
    'acceptedBy 收敛到一个确定值', JSON.stringify(handoff.acceptedBy))
  ok(JSON.stringify(mergeDocs(left, right)) === JSON.stringify(mergeDocs(right, left)),
    '接手合并满足交换律')
  ok(handoff.acceptedAt !== undefined, 'acceptedAt 与 acceptedBy 同源存在')
  ok(msgId !== '', '前提：交接条目有 msgId')

  // 交接状态单调：draft 合上 final 得到 final
  const draftDoc = normalizeDoc(base)
  draftDoc.messages[0].handoff.status = 'draft'
  const finalDoc = normalizeDoc(base)
  const up = mergeDocs(draftDoc, finalDoc)
  ok(up.messages[0].handoff.status === 'final', 'draft ∪ final = final（只前进）')
}

// ── handoff-accept 的五条约束 ─────────────────────────────────────

console.log('# handoff-accept 约束')
{
  const st = init()
  postOp(st, { holderId: 'agent:author', name: 'Author' }, {
    body: FINAL_BODY, kind: 'handoff',
    handoff: { status: 'final', items: [{ text: 'x', status: 'unverified' }] },
  }, T)
  const targetId = st.messages[st.messages.length - 1].msgId

  // 1) 缺 replyTo ⇒ 挡回
  const noReply = postOp(st, { holderId: 'agent:taker', name: 'Taker' }, {
    body: '接了', kind: 'handoff-accept',
  }, T)
  ok(badRequest(noReply), '缺 replyTo ⇒ 挡回')

  // 2) 目标不存在 ⇒ 404
  const notFound = postOp(st, { holderId: 'agent:taker', name: 'Taker' }, {
    body: '接了', kind: 'handoff-accept', replyTo: 'm_9999',
  }, T)
  ok(notFound.ok === false && notFound.data.error === 'not-found', '目标不存在 ⇒ not-found')

  // 3) 自己接自己的交接 ⇒ 挡回（毫无意义）
  const selfAccept = postOp(st, { holderId: 'agent:author', name: 'Author' }, {
    body: '接了', kind: 'handoff-accept', replyTo: targetId,
  }, T)
  ok(badRequest(selfAccept), '接自己写的不允许')

  // 4) 目标还是草稿 ⇒ 挡回（只有 final 允许接）
  const draftSt = init()
  postOp(draftSt, { holderId: 'agent:author', name: 'Author' }, {
    body: '草稿正文', kind: 'handoff',
    handoff: { status: 'draft', items: [{ text: 'x', status: 'unverified' }] },
  }, T)
  const draftId = draftSt.messages[draftSt.messages.length - 1].msgId
  const acceptDraft = postOp(draftSt, { holderId: 'agent:taker', name: 'Taker' }, {
    body: '接了', kind: 'handoff-accept', replyTo: draftId,
  }, T)
  ok(badRequest(acceptDraft), '接草稿不允许（只有 final 允许接）')

  // 5) 正常接手 ⇒ 成功，且目标交接的 acceptedBy 被置位
  const okAccept = postOp(st, { holderId: 'agent:taker', name: 'Taker' }, {
    body: '接了', kind: 'handoff-accept', replyTo: targetId,
  }, T)
  ok(okAccept.ok === true, '正常接手 ⇒ 成功')
  const target = st.messages.find((m) => m.msgId === targetId)
  ok(target.handoff.acceptedBy === 'agent:taker', '目标交接的 acceptedBy 被置位')
  ok(target.handoff.acceptedAt === 5000, 'acceptedAt 被置位')

  // 6) 重复接手 ⇒ 冲突（已被接手的不能再接）
  const dupAccept = postOp(st, { holderId: 'agent:another', name: 'Another' }, {
    body: '我也想接', kind: 'handoff-accept', replyTo: targetId,
  }, T)
  ok(dupAccept.ok === false && dupAccept.data.error === 'conflict', '已被接手的不允许重复接手')
}

console.log('')
if (failed > 0) { console.log('FAILURES: ' + passed + ' passed, ' + failed + ' failed'); process.exit(1) }
console.log('ALL PASS: ' + passed + ' passed, 0 failed')
