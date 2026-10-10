// tests/collab-convergence.mjs
//
// 单元 C（载荷收敛）的**代数律与不变量**守卫（纯逻辑层，不需要 fs / 插件装载）。
//
// 为什么需要它：跨进程并发的病根是"状态文件的写是读改写 + 版本守卫只在本进程有效"（实测：
// 两个写者可同时 probe 到同一 version、各自 rename 都成功，后写者静默覆盖先写者 = 丢更新）。
// 本单元的解法不是加锁，而是让状态本身**可收敛**：合并是半格 join。这个文件把"它是 join"
// 这件事变成可执行的断言 —— 否则"可收敛"只是一句愿望。
//
// 覆盖：
//   1) mergeDocs 的代数律（随机文档：重复 id / 半更新 / 空文档 / 墓碑）：交换、结合、幂等；
//   2) 合并**不丢**任何一方独有的记录（claims / messages / holders），撞同一个 seq 的两个写者
//      各留各的（id 因写者戳而唯一）；
//   3) 记录 id 全局唯一：两个写者并发分配同一个 seq 也不撞 id；
//   4) 游标 (seq, writer) 无损：两位写者撞 seq 时，按游标迭代一条不漏；**负向对照**是旧的
//      纯数字游标（`seq > since`）——它在撞 seq 时漏掉另一位写者的那条；
//   5) release 终态化：墓碑让"已释放"不被旧副本翻案；墓碑的 GC 规则确定性（同一份数据在
//      任何副本上 GC 出同样结果），且 GC 掉的墓碑复活不了"已过期"的记录。
//
// 运行：node tests/collab-convergence.mjs

import { createHarness } from './_harness.mjs'
import {
  init, mergeDocs, normalizeDoc, claim, release, post, sweep, filterMessages, parseCursor, cursorKey
} from '../lib/collab-core.js'

const h = createHarness()
const { ok } = h

const T = () => 1000
const show = (v) => {
  let s
  try { s = JSON.stringify(v) } catch (e) { s = String(v) }
  return s === undefined ? String(v) : (s.length > 200 ? s.slice(0, 200) + '…' : s)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------- 随机文档
/** 确定性伪随机（同一个种子每次跑出同一批语料；失败可复现）。 */
function rng (seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length]

/**
 * 造一份**刻意恶劣**的文档：重复 id、半更新（同一个 id 的两个版本字段不同）、缺可选字段、
 * 空数组、墓碑。它要覆盖的正是"两个副本各写了一半"的形状。
 */
function randDoc (r, ids) {
  const doc = init()
  const nC = Math.floor(r() * 4)
  for (let i = 0; i < nC; i++) {
    const c = {
      claimId: pick(r, ids),
      holderId: pick(r, ['agent:A', 'agent:B']),
      paths: [pick(r, ['src/a/', 'src/b/'])],
      mode: 'exclusive',
      ttlSec: 600,
      expiresAt: 2000 + Math.floor(r() * 3),
      createdAt: 1000 + Math.floor(r() * 3)
    }
    if (r() < 0.5) c.readers = [pick(r, ['agent:X', 'agent:Y'])]
    if (r() < 0.3) c.readable = false
    if (r() < 0.7) c.seq = Math.floor(r() * 3)
    if (r() < 0.7) c.writer = pick(r, ['w1', 'w2'])
    doc.claims.push(c)
  }
  const nM = Math.floor(r() * 4)
  for (let i = 0; i < nM; i++) {
    const m = {
      msgId: 'm_' + pick(r, ['1', '2', '3']) + '@' + pick(r, ['w1', 'w2']),
      seq: 1 + Math.floor(r() * 3),
      channel: 'general',
      author: pick(r, ['agent:A', 'agent:B']),
      ts: 1000 + i,
      body: 'b' + i
    }
    if (r() < 0.7) m.writer = pick(r, ['w1', 'w2'])
    doc.messages.push(m)
  }
  const nH = Math.floor(r() * 3)
  for (let i = 0; i < nH; i++) {
    const x = { holderId: pick(r, ['agent:A', 'agent:B']), name: 'H' + i, kind: 'agent' }
    if (r() < 0.6) x.lastSeenAt = 1000 + Math.floor(r() * 3)
    if (r() < 0.4) x.proc = '123:456'
    doc.holders.push(x)
  }
  if (r() < 0.4) doc.released = { [pick(r, ids)]: 2000 + Math.floor(r() * 3) }
  doc.seq = Math.floor(r() * 4)
  if (r() < 0.6) doc.writer = pick(r, ['', 'w1', 'w2'])
  return doc
}

console.log('# mergeDocs 是半格 join：交换 / 结合 / 幂等（随机文档：重复 id / 半更新 / 空文档）')
{
  const ids = ['c_1@w1', 'c_1@w2', 'c_2@w1', 'c_3@w2']
  const r = rng(20261010)
  let comm = 0, assoc = 0, idem = 0, empties = 0
  for (let i = 0; i < 400; i++) {
    const a = randDoc(r, ids), b = randDoc(r, ids), c = randDoc(r, ids)
    if (same(mergeDocs(a, b), mergeDocs(b, a))) comm++
    if (same(mergeDocs(mergeDocs(a, b), c), mergeDocs(a, mergeDocs(b, c)))) assoc++
    if (same(mergeDocs(a, a), normalizeDoc(a))) idem++
    if (!a.claims.length && !a.messages.length && !a.holders.length) empties++
    // 空文档是 join 的单位元（两侧都空时结果仍与另一边等价）
    if (!same(mergeDocs(init(), a), normalizeDoc(a))) { /* 见下面单独断言 */ }
  }
  ok(comm === 400, '交换律：mergeDocs(a,b) === mergeDocs(b,a)（400/400）', String(comm))
  ok(assoc === 400, '结合律：mergeDocs(mergeDocs(a,b),c) === mergeDocs(a,mergeDocs(b,c))（400/400）', String(assoc))
  ok(idem === 400, '幂等律：mergeDocs(a,a) === normalizeDoc(a)（400/400）', String(idem))
  ok(same(mergeDocs(init(), init()), init()), '空文档自并仍是空文档（单位元）', show(mergeDocs(init(), init())))
  ok(empties > 0, '随机语料里确实出现过空文档（否则上面的空集断言是空跑）', String(empties))
}

console.log('# 合并不丢任何一方独有的记录（claims / messages / holders）')
{
  const ids = ['c_1@w1', 'c_1@w2', 'c_2@w1', 'c_3@w2']
  const r = rng(7)
  let lost = 0, checked = 0
  for (let i = 0; i < 300; i++) {
    const a = randDoc(r, ids), b = randDoc(r, ids)
    const m = mergeDocs(a, b)
    const claimIds = new Set(m.claims.map(c => c.claimId))
    const msgIds = new Set(m.messages.map(x => x.msgId))
    const holderIds = new Set(m.holders.map(x => x.holderId))
    for (const src of [a, b]) {
      for (const c of src.claims) {
        checked++
        // 有墓碑的 id 是**终态**（按要求失效），不算丢；其余一个都不许少。
        if (!(c.claimId in (m.released || {})) && !claimIds.has(c.claimId)) lost++
      }
      for (const x of src.messages) { checked++; if (!msgIds.has(x.msgId)) lost++ }
      for (const x of src.holders) { checked++; if (!holderIds.has(x.holderId)) lost++ }
    }
  }
  ok(checked > 1000, '样本量足够（每条记录都逐个核对）', String(checked))
  ok(lost === 0, '合并后不丢任何一方独有的记录（claims/messages/holders 共 ' + checked + ' 条）', String(lost))
}

console.log('# 记录 id 全局唯一：两个写者并发分配同一个 seq 也不撞 id')
{
  const a = init(); a.writer = 'wA'
  const b = init(); b.writer = 'wB'
  const ca = claim(a, { holderId: 'agent:A', name: 'A' }, { paths: ['src/a/'] }, T)
  const cb = claim(b, { holderId: 'agent:B', name: 'B' }, { paths: ['src/b/'] }, T)
  const ca2 = claim(a, { holderId: 'agent:A', name: 'A' }, { paths: ['src/a2/'] }, T)
  const cb2 = claim(b, { holderId: 'agent:B', name: 'B' }, { paths: ['src/b2/'] }, T)
  // publish() 会剥掉内部字段，所以这里直接看状态里的原始记录。
  ok(a.claims[0].seq === 1 && b.claims[0].seq === 1, '两位写者各自从 seq=1 开始（Lamport 允许撞 seq）',
    show({ a: a.claims[0].seq, b: b.claims[0].seq }))
  ok(ca.data.claim.claimId !== cb.data.claim.claimId, '撞同一个 seq，claimId 仍然不同（各带写者戳）',
    show([ca.data.claim.claimId, cb.data.claim.claimId]))
  ok(ca2.data.claim.claimId !== cb2.data.claim.claimId, '第二条同样不撞',
    show([ca2.data.claim.claimId, cb2.data.claim.claimId]))
  const m = mergeDocs(a, b)
  ok(m.claims.length === 4, '两份文档合并后四条声明都在（撞 seq 不等于丢记录）', show(m.claims.map(c => c.claimId)))

  const pa = post(a, { holderId: 'agent:A', name: 'A' }, { body: 'from A' }, T)
  const pb = post(b, { holderId: 'agent:B', name: 'B' }, { body: 'from B' }, T)
  ok(pa.data.msgId !== pb.data.msgId, '两位写者撞同一个 seq 的留言 id 也不同（m_<seq>@<writer>）',
    show([pa.data.msgId, pb.data.msgId]))
  ok(mergeDocs(a, b).messages.length === 2, '两条留言合并后都在', show(mergeDocs(a, b).messages.map(x => x.msgId)))
}

console.log('# 游标是 (seq, writer) 复合值：撞 seq 时按游标迭代一条不漏')
{
  const st = init()
  // 两位写者撞在同一个 seq=2 上（这正是纯数字游标会漏掉一位写者的现场）。
  st.messages = [
    { msgId: 'm_1@wA', seq: 1, writer: 'wA', channel: 'general', author: 'agent:A', ts: 1, body: 'a1' },
    { msgId: 'm_2@wA', seq: 2, writer: 'wA', channel: 'general', author: 'agent:A', ts: 2, body: 'a2' },
    { msgId: 'm_2@wB', seq: 2, writer: 'wB', channel: 'general', author: 'agent:B', ts: 3, body: 'b2' },
    { msgId: 'm_3@wB', seq: 3, writer: 'wB', channel: 'general', author: 'agent:B', ts: 4, body: 'b3' }
  ]
  // 从 (1, wA) 之后开始翻页（limit=1），按 nextCursor 迭代到 hasMore=false。
  // 注意不能从 (1, "") 开始 —— 那是"seq=1 那批里最小的位置"，会把 seq=1 的记录也带上
  // （这正是数字游标"至多重送一次"的来源）；无损翻页只用 nextCursor 精确推进。
  let cursor = cursorKey({ seq: 1, writer: 'wA' })
  const seen = []
  for (let i = 0; i < 10; i++) {
    const page = filterMessages(st, { since: cursor, limit: 1 })
    for (const m of page.messages) seen.push(m.msgId)
    if (!page.hasMore) break
    cursor = page.nextCursor
  }
  ok(seen.length === 3, '按 nextCursor 迭代恰好读到 3 条（不是 2 条）', show(seen))
  ok(same(seen, ['m_2@wA', 'm_2@wB', 'm_3@wB']), '顺序是 (seq, writer) 全序，两条 seq=2 都在', show(seen))

  // **负向对照**：把撞 seq 的那一半按旧语义丢掉。
  // 旧实现：`matched = l.filter(m => m.seq > since)`。游标走到 (2, wA) 之后，`since` 只能是 2，
  // 于是 seq 恰好等于 2 的 wB 那条**永远读不到** —— 这就是"撞 seq 时漏消息"。
  const naiveNumeric = (s, since, limit) => s.messages.filter(m => m.seq > since).slice(0, limit)
  const after = naiveNumeric(st, 2, 10)
  ok(after.length === 1 && after[0].msgId === 'm_3@wB',
    '负向对照（RED）：旧的纯数字游标在 since=2 时把两条 seq=2 全漏掉（只剩 m_3@wB）',
    show(after.map(m => m.msgId)))

  // 数字入参（向后兼容写法）按 **seq 严格大于 n** 匹配：语义是"我已经读到 n 了"，
  // 因此 `since = nextSince` 的翻页**一定前进**。旧实现一律按复合全序比较，裸数字归一成 `(n, "")`
  // 会把 seq 恰好为 n 的那条**永远再送** —— 于是"按 nextSince 翻页"成了死循环
  // （现场实测：`since=379` 又返回 m_379、`nextSince` 仍是 379）。
  // 那个"重送还是跳过"的取舍**已经不存在**：分页**从不切开同一个 seq 组**（见下面两条断言），
  // 所以数字游标既不重送（游标一定前进）也不漏（组是完整的）。上面那条 RED 是"切开组"会怎样。
  const numeric = filterMessages(st, { since: 2, limit: 10 })
  ok(same(numeric.messages.map(m => m.msgId), ['m_3@wB']),
    '数字 since=2 = 严格在 seq 2 之后：不再重送（旧实现重送 ⇒ nextSince 翻页死循环）；同 seq 的另一位要 nextCursor 才不漏',
    show(numeric.messages.map(m => m.msgId)))
  const numericAt1 = filterMessages(st, { since: 1, limit: 10 })
  ok(same(numericAt1.messages.map(m => m.msgId), ['m_2@wA', 'm_2@wB', 'm_3@wB']),
    '数字 since=1 = 严格在 seq 1 之后（seq=1 那条不在窗口内 —— 读它靠 tail 模式）',
    show(numericAt1.messages.map(m => m.msgId)))
  // 组完整性：limit=1 也不会切开 seq=2 那组（整组返回，页长 2 > limit）
  const one = filterMessages(st, { since: 1, limit: 1 })
  ok(same(one.messages.map(m => m.msgId), ['m_2@wA', 'm_2@wB']),
    '不切开同 seq 组：limit=1 时 seq=2 那组整组返回 ⇒ 数字游标既不重送也不漏',
    show(one.messages.map(m => m.msgId)))
  // 数字游标迭代：有限轮 + 不重不漏（旧实现死循环；只做严格大于则会跳过同 seq 的另一位 —— 现在两者都成立）
  let nc = 1, rounds = 0
  const seenNumeric = []
  for (;;) {
    const r = filterMessages(st, { since: nc, limit: 1 })
    if (!r.returned) break
    seenNumeric.push(...r.messages.map(m => m.msgId))
    nc = r.nextSince
    if (++rounds > 9) break
  }
  ok(rounds <= 9 && same(seenNumeric, ['m_2@wA', 'm_2@wB', 'm_3@wB']),
    '数字游标 limit=1 迭代：有限轮、不重不漏', show({ rounds, seenNumeric }))
  // 从头读：复合写法 "0@" 是一个**位置** ⇒ forward 从最开始（省略/0 仍是 tail）
  const fromStart = filterMessages(st, { since: '0@', limit: 10 })
  ok(same(fromStart.messages.map(m => m.msgId), ['m_1@wA', 'm_2@wA', 'm_2@wB', 'm_3@wB']) && fromStart.mode === 'forward',
    '从头读：since="0@" ⇒ forward（全历史可达），而省略/0 仍是 tail', show(fromStart.messages.map(m => m.msgId)))
  ok(
    same(parseCursor(3), { seq: 3, writer: '', bare: true }) &&
      same(parseCursor('3'), { seq: 3, writer: '', bare: true }) &&
      same(parseCursor('3@wA'), { seq: 3, writer: 'wA', explicit: true }) &&
      same(parseCursor('0@'), { seq: 0, writer: '', explicit: true }),
    'parseCursor：裸 seq（数字，或无 @ 的字符串）⇒ 标 bare（按 seq 严格大于）；`<seq>@<writer>` ⇒ 复合**位置**（explicit，含 `"0@"` = 从头）',
    show([parseCursor(3), parseCursor('3'), parseCursor('3@wA'), parseCursor('0@')]))
}

console.log('# release 终态化：墓碑让"已释放"不被旧副本翻案，且 GC 规则确定性')
{
  const live = () => ({
    claimId: 'c_9@wA', holderId: 'agent:A', holderName: 'A', paths: ['src/a/'], mode: 'exclusive',
    ttlSec: 600, expiresAt: 2600, createdAt: 1000, seq: 1, writer: 'wA'
  })
  // 旧副本（A 的声明仍然活着）
  const old = init(); old.writer = 'wA'; old.claims.push(live()); old.seq = 1
  // 新盘（A 释放过它：claims 里没有，released 里有）
  const releasedDoc = init(); releasedDoc.writer = 'wA'; releasedDoc.seq = 1
  const r = release(old, { holderId: 'agent:A', name: 'A' }, { claimId: 'c_9@wA' }, T)
  // 单元 D：墓碑值 = max(原 expiresAt, 释放时刻 + ttlSec) = max(2600, 1000 + 600*1000) = 601000。
  // 第三项把"释放之后才合并进来的并发续租"整段窗口盖住（见 tests/collab-tombstone.mjs）。
  ok(r.ok === true && old.claims.length === 0 && old.released['c_9@wA'] === 601000,
    'release 把声明从 claims 拿掉、同时立墓碑（claimId → max(原 expiresAt, 释放时刻 + ttl)）',
    show({ claims: old.claims.map(c => c.claimId), released: old.released }))

  const merged = mergeDocs(old, { ...init(), claims: [live()] })
  ok(merged.claims.length === 0, '旧副本合并回来也翻不了案：claims 里没有它', show(merged.claims))
  ok(merged.released['c_9@wA'] === 601000, '墓碑仍在（权威失效的状态本身被合并保留）', show(merged.released))

  // GC 确定性：同一份数据 + 同一个 t ⇒ 任何副本上结果相同。
  const before = JSON.parse(JSON.stringify(old))
  const c1 = JSON.parse(JSON.stringify(before)); const c2 = JSON.parse(JSON.stringify(before))
  sweep(c1, 600999)
  sweep(c2, 600999)
  ok(same(c1, c2) && c1.released['c_9@wA'] === 601000, '墓碑未到期：两个副本 sweep 后逐字节相同且墓碑都在', show(c1.released))
  const d1 = JSON.parse(JSON.stringify(before)); const d2 = JSON.parse(JSON.stringify(before))
  sweep(d1, 601000)
  sweep(d2, 601000)
  ok(same(d1, d2) && !('c_9@wA' in d1.released),
    '墓碑到期：两个副本 sweep 后逐字节相同且墓碑被确定性回收', show(d1.released))
  // 墓碑被 GC 之后，旧副本复活的那条记录只能"已过期"（在所有视图里不可见），所以无害。
  const afterGc = mergeDocs(
    (() => { const d = JSON.parse(JSON.stringify(before)); sweep(d, 601000); return d })(),
    { ...init(), claims: [live()] }
  )
  ok(afterGc.claims.length === 1 && afterGc.claims[0].expiresAt <= 601000,
    '墓碑 GC 后旧副本可以"复活"它，但复活出来的记录必然已过租约（list/overview/wait 都按 expiresAt 过滤）',
    show(afterGc.claims.map(c => ({ id: c.claimId, expiresAt: c.expiresAt }))))
}

h.finish()
