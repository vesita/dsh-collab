// tests/collab-tombstone.mjs
//
// 单元 D 的墓碑守卫（纯逻辑层）：
//
//   1) **墓碑值取上界**：墓碑值 = max(现有值, claim.expiresAt, 释放时刻 + ttlSec)。
//      堵的边角：一条**并发续租**在释放之后才被合并进来，它的 expiresAt 大于原 expiresAt；
//      只取原值的话，墓碑按自己的到期被 GC 之后那条声明会**重新具备权威**。
//      正题断言"墓碑 GC 之后那条声明仍不具备权威"，负向对照是"只取原 expiresAt ⇒ 复活成权威"。
//   2) **墓碑表有界**：按 (墓碑值, claimId) 保留最大的 MAX_RELEASED 条、丢最旧的；
//      规则只看数据 ⇒ 两个副本 GC 出同样结果（收敛）。负向对照是"保留最小的 N 条"
//      ——它会把最新的墓碑丢掉，从而让一条本该死透的声明复活。
//
// 运行：node tests/collab-tombstone.mjs

import { createHarness } from './_harness.mjs'
import { init, mergeDocs, normalizeDoc, release, sweep, MAX_RELEASED } from '../lib/collab-core.js'

const h = createHarness()
const { ok } = h

const show = (v) => {
  let s
  try { s = JSON.stringify(v) } catch (e) { s = String(v) }
  return s === undefined ? String(v) : (s.length > 240 ? s.slice(0, 240) + '…' : s)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const HOLDER = { holderId: 'agent:A', name: 'A' }
const CID = 'c_1@wA'
// 一条 ttl=10s 的声明，原租约在 10000 到期。
const baseClaim = (o = {}) => Object.assign({
  claimId: CID, holderId: 'agent:A', holderName: 'A', paths: ['src/a/'], mode: 'exclusive',
  ttlSec: 10, expiresAt: 10000, createdAt: 0, note: '', readable: true, readers: [], seq: 1, writer: 'wA'
}, o)

// ════════════════════════════════════════════════════════════════════════
// 1. 墓碑值取上界：释放时刻 + ttl 盖住"释放之后才合并进来的并发续租"
// ════════════════════════════════════════════════════════════════════════
console.log('# 1. 墓碑值 = max(原 expiresAt, 释放时刻 + ttl)：并发续租翻不了案')
{
  const d = init(); d.claims.push(baseClaim())
  const r = release(d, HOLDER, { claimId: CID }, () => 1000)
  ok(r.ok === true && d.released[CID] === 11000,
    '释放于 t=1000（ttl=10s）⇒ 墓碑值 11000 = max(10000, 1000+10000)',
    show({ released: d.released }))

  // 并发续租：另一个进程在 t=500 续租（expiresAt = 500+10000 = 10500 > 原 10000），
  // 它的副本在释放之后才被合并进来。
  const renewed = baseClaim({ expiresAt: 10500 })
  const replica = init(); replica.claims.push(renewed)

  // 正题：在"旧墓碑会被 GC、而续租那条还没到期"的窗口里 sweep，墓碑必须还在。
  const before = JSON.parse(JSON.stringify(d))
  sweep(before, 10200)
  ok(before.released[CID] === 11000, 'sweep(10200) 之后墓碑仍在（11000 > 10200）', show(before.released))
  const merged = mergeDocs(before, replica)
  ok(merged.claims.length === 0,
    '正题：并发续租（exp=10500 > 原 exp=10000）合并进来后仍不具备权威（墓碑 11000 赢了 join）',
    show({ claims: merged.claims.map((c) => [c.claimId, c.expiresAt]), released: merged.released }))

  // 墓碑按自己的值被确定性回收之后，那条续租也已经过期（10500 <= 11000）⇒ 仍无权威。
  const afterGcDoc = JSON.parse(JSON.stringify(d)); sweep(afterGcDoc, 11000)
  ok(!(CID in afterGcDoc.released), 'sweep(11000) 丢掉了墓碑（值 <= t）', show(afterGcDoc.released))
  const afterGc = normalizeDoc(mergeDocs(afterGcDoc, replica))
  ok(afterGc.claims.length === 1 && afterGc.claims[0].expiresAt === 10500 && afterGc.claims[0].expiresAt <= 11000,
    '墓碑 GC 后那条续租确实"复活"进 claims，但它已过期（10500 <= 11000，所有视图按 expiresAt 过滤）',
    show(afterGc.claims.map((c) => [c.claimId, c.expiresAt])))

  // 负向对照（RED）：退回"墓碑值 = 原 expiresAt"（= 10000）⇒ 在同一个窗口里墓碑先被 GC，
  // 那条续租（10500）重新具备权威。
  const oldTombstone = init(); oldTombstone.released[CID] = 10000
  const oldAfter = JSON.parse(JSON.stringify(oldTombstone))
  sweep(oldAfter, 10200)
  const oldMerged = normalizeDoc(mergeDocs(oldAfter, replica))
  ok(!(CID in oldAfter.released) && oldMerged.claims.length === 1 && oldMerged.claims[0].expiresAt === 10500,
    '负向对照（RED）成立：只取原 expiresAt 时，墓碑在 10200 被 GC、续租的声明复活成权威',
    show({ released: oldAfter.released, claims: oldMerged.claims.map((c) => [c.claimId, c.expiresAt]) }))
}

// ════════════════════════════════════════════════════════════════════════
// 2. 墓碑表有界：确定性地上限，丢最旧、留最新
// ════════════════════════════════════════════════════════════════════════
console.log('# 2. 墓碑表有界（MAX_RELEASED）：确定性、只看数据、丢最旧')
{
  ok(Number.isInteger(MAX_RELEASED) && MAX_RELEASED >= 1024,
    'MAX_RELEASED 是一个写进注释的上限（' + MAX_RELEASED + '）', show(MAX_RELEASED))

  const total = MAX_RELEASED + 5
  const idsOf = (i) => 'c_' + i + '@wA'
  const build = (ascending) => {
    const d = init()
    const order = [...Array(total).keys()]
    if (!ascending) order.reverse()
    for (const i of order) d.released[idsOf(i)] = 1000 + i
    return d
  }
  const a = build(true); const b = build(false)
  sweep(a, 0); sweep(b, 0)
  ok(Object.keys(a.released).length === MAX_RELEASED,
    '超过上限后只保留 MAX_RELEASED 条（' + Object.keys(a.released).length + '）', show(Object.keys(a.released).length))
  // 规则只看数据（不看插入顺序）：两个副本保留的**键集合与值**相同。
  // 落盘时由 normalizeDoc 把墓碑键排成规范序，所以先规范化再逐字节比较（与实现同源）。
  ok(same(normalizeDoc(a), normalizeDoc(b)),
    '规则只看数据：升序与降序插入同一组墓碑，规范化后逐字节相同',
    show({ a: Object.keys(normalizeDoc(a).released).length, b: Object.keys(normalizeDoc(b).released).length }))
  ok(same(Object.keys(a.released).sort(), Object.keys(b.released).sort()),
    '两个副本保留的是同一组 claimId', show(Object.keys(a.released).length))

  // 被丢的是最旧的 5 条（值最小），保留的是最大的 MAX_RELEASED 条。
  const dropped = []
  for (let i = 0; i < 5; i++) if (!(idsOf(i) in a.released)) dropped.push(i)
  const keptTop = idsOf(total - 1) in a.released && idsOf(total - 5) in a.released
  ok(dropped.length === 5 && keptTop,
    '丢的是值最小的 5 条（' + JSON.stringify(dropped) + '），最大的几条都留着', show(Object.keys(a.released).length))

  // 负向对照（RED）：把规则改成"保留最小的 N 条"⇒ 最新的墓碑被丢，被它镇住的声明复活成权威。
  const keepSmallest = (rel, t) => {
    const out = { ...rel }
    for (const id of Object.keys(out)) if (!(Number(out[id]) > t)) delete out[id]
    const ids = Object.keys(out)
    if (ids.length > MAX_RELEASED) {
      ids.sort((x, y) => ((Number(out[x]) || 0) - (Number(out[y]) || 0)) || (x < y ? -1 : 1))
      for (const id of ids.slice(MAX_RELEASED)) delete out[id]
    }
    return out
  }
  const newestId = idsOf(total - 1)
  const newestExp = 1000 + (total - 1)
  const wrong = keepSmallest(build(true).released, 0)
  const replica = init()
  replica.claims.push(baseClaim({ claimId: newestId, expiresAt: newestExp }))
  const wrongMerged = normalizeDoc(mergeDocs(Object.assign(init(), { released: wrong }), replica))
  ok(!(newestId in wrong),
    '负向对照（RED）成立：保留最小 N 条时，最新（值最大）的那条墓碑被丢掉', show(newestId))
  ok(wrongMerged.claims.length === 1 && wrongMerged.claims[0].claimId === newestId,
    '负向对照（RED）：被最新墓碑镇住的声明因此复活成权威（正确的"丢最旧"不会这样）',
    show(wrongMerged.claims.map((c) => c.claimId)))
}

h.finish()
