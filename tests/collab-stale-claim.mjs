// tests/collab-stale-claim.mjs
//
// 守护 0.2.14 的**废弃登记**判据（`staleHolderIds` + sweep 的第二条回收入口）。
//
// 要解决的问题（实测现场）：一条声明由进程 A 写下，A 被 SIGKILL；会话随后被重新载入，
// 于是 oracle 说它 live。原判据要求「oracle not-live **且** 进程章已死」，两条永远凑不齐
// —— 那条锁既进不了 sweep、也不进 reap 候选，在盘上挂了 7 天。
//
// 新判据：进程章已死 **且** 该登记闲置 ≥ 阈值（默认 7 天）⇒ 按确证死亡处理。
// 本文件把它的每一条边界都钉成一对正/负例，**负向对照**是重点（判据只缩不放）：
//   1) 正例：oracle live + 进程章死 + 闲置超阈值 ⇒ 声明被回收并**立墓碑**；
//   2) 负向：闲置没到阈值 ⇒ 不收（"刚换进程、正要接着干"的窗口）；
//   3) 负向：进程章还活着（在 liveProcs 里）⇒ 不收，闲置再久也不收；
//   4) 负向：liveProcs 不可用（null / 非 Set）⇒ 不收（fail-closed）；
//   5) 负向：没有 `now` ⇒ 不收（纯逻辑不隐式读时钟）；
//   6) 负向：`staleClaimMs: 0` = 关闭判据 ⇒ 不收；
//   7) 正例：老声明没有自己的进程章，回落名册行那一枚（死章）⇒ 照样收；
//   8) 回归：老口径（oracle not-live + 进程章死）在**闲置判据关闭时**依然生效；
//   9) 名册行：回收后无声明、进程章已死 ⇒ 一并淘汰；
//  10) `staleHolderIds` 自身：判据不可用时返回空集。
//
// 运行：node tests/collab-stale-claim.mjs   退出码非 0 即失败

import { sweep, staleHolderIds, DEFAULT_STALE_CLAIM_MS } from '../lib/collab-core.js'

let passed = 0
const failures = []

function ok(cond, msg, detail) {
  if (cond) {
    passed++
    console.log('  ok  ' + msg)
  } else {
    const text = '  FAIL: ' + msg + (detail === undefined ? '' : ' (' + JSON.stringify(detail) + ')')
    console.error(text)
    failures.push(text)
  }
}

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const DEAD = '11111:100'      // 已不存在的进程
const ALIVE = '22222:200'     // 活着的进程

/** 一份最小状态：一条声明 + 对应的名册行。 */
function doc({ claimProc = DEAD, holderProc = DEAD, createdAt = NOW - 8 * DAY, lastSeenAt = NOW - 8 * DAY } = {}) {
  const claim = {
    claimId: 'c_7@w1',
    holderId: 'agent:s1',
    paths: ['src/'],
    mode: 'exclusive',
    createdAt,
    seq: 7,
    writer: 'w1'
  }
  if (claimProc) claim.proc = claimProc
  const holder = { holderId: 'agent:s1', name: 'S', kind: 'agent', lastSeenAt }
  if (holderProc) holder.proc = holderProc
  return { schemaVersion: 1, seq: 7, writer: 'w1', claims: [claim], messages: [], holders: [holder], released: {} }
}

/** 默认判据环境：进程章 DEAD 已死，oracle 说 live（这正是"锁永久挂住"的那个形态）。 */
const opts = (extra = {}) => ({
  liveProcs: new Set([ALIVE]),
  liveness: () => 'live',
  now: NOW,
  ...extra
})

console.log('— 1) 正例：oracle live + 进程章死 + 闲置超阈值 ⇒ 回收并立墓碑')
{
  const s = doc()
  const r = sweep(s, opts())
  ok(r.prunedClaims === 1, '回收了 1 条声明', r)
  ok(s.claims.length === 0, '声明已从 claims 拿掉')
  ok(s.released['c_7@w1'] === 7, '立了墓碑（值为该声明的 Lamport seq）', s.released)
  ok(s.holders.length === 0, '名册行一并淘汰（无声明 + 进程章已死）', s.holders)
}

console.log('— 2) 负向：闲置没到阈值 ⇒ 不收')
{
  const s = doc({ createdAt: NOW - 2 * DAY, lastSeenAt: NOW - 2 * DAY })
  const r = sweep(s, opts())
  ok(r.prunedClaims === 0, '2 天闲置不收', r)
  ok(s.claims.length === 1, '声明仍在')
}

console.log('— 3) 负向：进程章还活着 ⇒ 闲置再久也不收')
{
  const s = doc({ claimProc: ALIVE, holderProc: ALIVE, createdAt: NOW - 400 * DAY, lastSeenAt: NOW - 400 * DAY })
  const r = sweep(s, opts())
  ok(r.prunedClaims === 0, '活进程的声明不收（跨进程安全）', r)
  ok(s.claims.length === 1, '声明仍在')
  ok(s.holders.length === 1, '名册行仍在')
}

console.log('— 4) 负向：进程判据不可用 ⇒ 不收（fail-closed）')
{
  for (const live of [null, undefined, ['11111:100']]) {
    const s = doc()
    const r = sweep(s, opts({ liveProcs: live }))
    ok(r.prunedClaims === 0, 'liveProcs=' + JSON.stringify(live) + ' 时一条也不收', r)
    ok(s.claims.length === 1, '声明仍在（liveProcs=' + JSON.stringify(live) + '）')
  }
}

console.log('— 5) 负向：没有 now ⇒ 不收')
{
  const s = doc()
  const r = sweep(s, opts({ now: undefined }))
  ok(r.prunedClaims === 0, '闲置判据不可用时无法判定 ⇒ 不收', r)
  ok(s.claims.length === 1, '声明仍在')
}

console.log('— 6) 负向：staleClaimMs = 0（关闭判据）⇒ 不收')
{
  const s = doc()
  const r = sweep(s, opts({ staleClaimMs: 0 }))
  ok(r.prunedClaims === 0, '关闭后可被视为废弃的登记也不收', r)
  ok(s.claims.length === 1, '声明仍在')
  ok(staleHolderIds(s, opts({ staleClaimMs: 0 })).size === 0, 'staleHolderIds 同样为空')
}

console.log('— 7) 正例：老声明没有自己的进程章，回落名册行那一枚')
{
  const s = doc({ claimProc: null })
  const r = sweep(s, opts())
  ok(r.prunedClaims === 1, '用名册行的死章判定，照样回收', r)
  ok(s.claims.length === 0, '声明已回收')
  // 负向对照：名册行也没有章 ⇒ 证据不足 ⇒ 不收
  const s2 = doc({ claimProc: null, holderProc: null })
  const r2 = sweep(s2, opts())
  ok(r2.prunedClaims === 0, '两处都没有进程章 ⇒ 不收（证据不足）', r2)
  ok(s2.claims.length === 1, '声明仍在')
}

console.log('— 8) 回归：老口径（oracle not-live + 进程章死）在闲置判据关闭时依然生效')
{
  const s = doc({ createdAt: NOW - 1000, lastSeenAt: NOW - 1000 })
  const r = sweep(s, { liveProcs: new Set([ALIVE]), liveness: () => 'not-live', now: NOW, staleClaimMs: 0 })
  ok(r.prunedClaims === 1, 'oracle 说 not-live ⇒ 照旧回收（不看闲置时长）', r)
  // 负向：oracle 说 live 且刚写下 ⇒ 不收
  const s2 = doc({ createdAt: NOW - 1000, lastSeenAt: NOW - 1000 })
  const r2 = sweep(s2, { liveProcs: new Set([ALIVE]), liveness: () => 'live', now: NOW, staleClaimMs: 0 })
  ok(r2.prunedClaims === 0, 'oracle 说 live 且没闲置 ⇒ 不收', r2)
}

console.log('— 9) 默认阈值是 7 天，且边界按「≥」判')
{
  ok(DEFAULT_STALE_CLAIM_MS === 7 * DAY, '默认阈值 7 天', DEFAULT_STALE_CLAIM_MS)
  const justBefore = doc({ createdAt: NOW - DEFAULT_STALE_CLAIM_MS + 1, lastSeenAt: NOW - DEFAULT_STALE_CLAIM_MS + 1 })
  ok(sweep(justBefore, opts()).prunedClaims === 0, '差 1ms 到阈值 ⇒ 不收')
  const onEdge = doc({ createdAt: NOW - DEFAULT_STALE_CLAIM_MS, lastSeenAt: NOW - DEFAULT_STALE_CLAIM_MS })
  ok(sweep(onEdge, opts()).prunedClaims === 1, '正好到阈值 ⇒ 收')
}

console.log('— 10) staleHolderIds 自身：判据不可用 ⇒ 空集')
{
  const s = doc()
  ok(staleHolderIds(s, {}).size === 0, '什么都不给 ⇒ 空集')
  ok(staleHolderIds(s, { liveProcs: new Set([ALIVE]), now: NOW }).size === 1, '给齐判据 ⇒ 命中一条')
}

console.log('')
if (failures.length) {
  console.error(`✗ ${failures.length} 项失败 / ${passed + failures.length} 项`)
  for (const f of failures) console.error(f)
  process.exit(1)
}
console.log(`✓ 全部 ${passed} 项通过`)
