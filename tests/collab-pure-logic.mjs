import { createHarness } from './_harness.mjs'

// collab-pure-logic.mjs
// 纯逻辑回归测试。import 自 lib/collab-core.js（唯一事实源），而非复制。
// 运行：node tests/collab-pure-logic.mjs
// 额外对拍：从 lib/collab-plugin.host.js 提取 norm/cleanName 源码并 eval，
//          与核心库做行为对比，防止内联版与核心库漂移。
import { readFileSync } from 'node:fs'
import {
  norm, ov, cleanName, init, publish, expire, sweep, HOLDER_TTL_MS, holder, claim, release, heartbeat,
  post, overview, related, filterMessages, blockers, holderView, holderFresh, MODES,
} from '../lib/collab-core.js'

const h = createHarness()
const { ok } = h
const t0 = 1000000
const T = () => t0

// ===== 1. norm/ov 基本路径语义 =====
console.log('# norm/ov')
ok(norm('src/backend/') === 'src/backend/', 'norm: trailing slash kept')
ok(norm('./src/backend/models') === 'src/backend/models', 'norm: strip ./')
ok(norm('C:\\src') === 'C:/src', 'norm: windows backslash -> slash')
ok(norm('src/foo') !== 'src/foobar', 'norm: src/foo vs src/foobar distinct (segment aware)')
ok(ov('src/backend/', 'src/backend/models/') === true, 'ov: dir -> child overlap')
ok(ov('src/backend/', 'src/backend') === true, 'ov: dir/path form')
ok(ov('src/foo', 'src/foobar') === false, 'ov: non-overlap segment boundary')

// ===== 1.1 数据外置存储文件名生成 =====
console.log('# projectStorageFileName')
import { hashProjectKey, projectStorageFileName } from '../lib/collab-core.js'
ok(typeof hashProjectKey('/home/vesita/my-project') === 'string', 'hashProjectKey returns string')
ok(projectStorageFileName('/home/vesita/coding/my/dsh-collab').startsWith('dsh-collab-'), 'storage name prefix matches dir basename')
ok(projectStorageFileName('/home/vesita/coding/my/dsh-collab').endsWith('.json'), 'storage name ends with .json')
ok(projectStorageFileName('/a/b/c') !== projectStorageFileName('/a/b/d'), 'distinct projects yield distinct storage names')

// ===== 2. cleanName =====
console.log('# cleanName')
ok(cleanName('  a   b \t ') === 'a b', 'cleanName: collapse whitespace')
ok((cleanName('x'.repeat(40))).length === 25, 'cleanName: truncates to 24+ellipsis')

// ===== 3. claim：短租约警告 / 合并 / 冲突（核心库签名） =====
console.log('# claim (core): warning / merge / conflict')
{
  const st = init()
  const r = claim(st, { holderId: 'agent:test', name: 'tester' }, { paths: ['src/x/'], ttlSec: 30 }, T)
  ok(r.ok === true && r.data.claim.ttlSec === 30, 'claim stores ttl 30')
  ok(typeof r.data.warning === 'string' && r.data.warning.includes('short-lease') && r.data.warning.includes('30'), 'warning present for ttl<60')
  ok(r.data.merged === false, 'fresh claim not merged')
  const r2 = claim(st, { holderId: 'agent:test', name: 'tester' }, { paths: ['src/x/sub/'], ttlSec: 30 }, T)
  ok(r2.data.merged === true, 'same-holder merge detected')
  ok(r2.data.warning.includes('已并入'), 'merge reflected in warning')
  ok(st.claims.length === 1, 'merge keeps single claim')
}
{
  const st = init(); claim(st, { holderId: 'agent:b', name: 'B' }, { paths: ['src/core/'], ttlSec: 1800 }, T)
  let conflict = null
  try { claim(st, { holderId: 'agent:c', name: 'C' }, { paths: ['src/core/models/'] }, T) } catch (e) { conflict = e }
  ok(conflict && conflict.collabConflict && conflict.conflicts[0].holderId === 'agent:b', 'foreign exclusive overlap -> conflict')
  ok(conflict && conflict.conflicts[0].suggestedAction !== undefined, 'conflict provides suggestedAction')
  ok(conflict && typeof conflict.conflicts[0].remainingSec === 'number', 'conflict provides remainingSec')
}
{
  const st = init(); claim(st, { holderId: 'agent:b', name: 'B' }, { paths: ['src/core/'], mode: 'shared' }, T)
  let conflict = null
  try { claim(st, { holderId: 'agent:c', name: 'C' }, { paths: ['src/core/models/'] }, T) } catch (e) { conflict = e }
  ok(conflict === null, 'shared never conflicts (claim succeeds)')
}
ok(claim(init(), { holderId: 'agent:x' }, {}, T).data.error === 'bad-request', 'claim: no paths -> bad-request')

// ===== 4. release / heartbeat（权限 + 按路径释放） =====
console.log('# release / heartbeat')
{
  const st = init(); claim(st, { holderId: 'agent:a', name: 'A' }, { paths: ['src/a/', 'src/a/sub/'] }, T)
  const c = st.claims[0]
  const forbidden = release(st, { holderId: 'agent:z', name: 'Z' }, { claimId: c.claimId }, T)
  ok(forbidden.data.error === 'forbidden', 'release: non-holder -> forbidden')
  const byPath = release(st, { holderId: 'agent:a', name: 'A' }, { paths: ['src/a/'] }, T)
  ok(byPath.ok === true, 'release by path ok')
  ok(st.claims.length === 0, 'release clears claim')
  const hb = heartbeat(st, { holderId: 'agent:a', name: 'A' }, { claimId: c.claimId }, T)
  ok(hb.data.error === 'not-found', 'heartbeat missing claim -> not-found')
}

// ===== 5. post / filterMessages =====
console.log('# board: post / read')
{
  const st = init(); const p = post(st, { holderId: 'agent:a', name: 'A' }, { body: 'hello', channel: 'general' }, () => 5000)
  ok(p.ok === true && st.messages.length === 1, 'post adds message')
  const f = filterMessages(st, { since: 0, limit: 50 })
  ok(f.returned === 1 && f.messages[0].channel === 'general', 'read returns message')
  const f2 = filterMessages(st, { since: st.messages[0].seq })
  ok(f2.returned === 0, 'read since seq -> none')
  ok(post(st, { holderId: 'agent:a', name: 'A' }, { body: '  ' }, T).data.error === 'bad-request', 'post empty body -> bad-request')
}

// ===== 6. overview / related =====
console.log('# overview / related')
{
  const st = init()
  claim(st, { holderId: 'agent:a', name: 'A' }, { paths: ['src/a/', 'src/b/'] }, T)
  claim(st, { holderId: 'agent:b', name: 'B' }, { paths: ['src/c/'] }, T)
  const o = overview(st)
  ok(o.totalClaims === 2 && o.holders.length === 2, 'overview: 2 claims / 2 holders')
  ok(o.holders.find(h => h.holderId === 'agent:a').paths.length === 2, 'overview: flattens holder A paths')
  const rel = related(st, ['src/b/'])
  ok(rel.length === 1 && rel[0].holderId === 'agent:a', 'related: matches prefix overlap')
  // 混合模式聚合
  const st2 = init()
  claim(st2, { holderId: 'agent:m', name: 'M' }, { paths: ['src/x/'], mode: 'exclusive' }, T)
  claim(st2, { holderId: 'agent:m', name: 'M' }, { paths: ['src/y/'], mode: 'shared' }, T)
  const o2 = overview(st2)
  ok(o2.holders[0].mode === 'mixed', 'overview: mixed exclusive/shared aggregates to mixed')
}

// ===== 7. expire / sweep：到期清理与状态膨胀上限 =====
console.log('# expire / sweep')
{
  const st = init(); claim(st, { holderId: 'agent:a', name: 'A' }, { paths: ['src/a/'], ttlSec: 100 }, () => 1000)
  ok(expire(st, 999) === 0, 'expire: live claim retained when checked in past')
  ok(expire(st, 1e12) === 1 && st.claims.length === 0, 'expire: deep-future expires all')
}
{
  // 留言保留最近 N 条
  const st = init()
  for (let i = 0; i < 10; i++) post(st, { holderId: 'agent:a', name: 'A' }, { body: 'm' + i }, () => 1000 + i)
  const swept = sweep(st, 2000, { maxMessages: 4 })
  ok(swept.droppedMessages === 6 && st.messages.length === 4, 'sweep: caps messages to maxMessages')
  ok(st.messages[0].body === 'm6' && st.messages[3].body === 'm9', 'sweep: keeps the newest messages')
}
{
  // 陈旧 holder 回收，活跃声明持有者保留
  const st = init()
  claim(st, { holderId: 'agent:live', name: 'Live' }, { paths: ['src/live/'], ttlSec: 90000 }, () => 1000)
  st.holders.push({ holderId: 'agent:ghost', name: 'Ghost', lastSeenAt: 0 })
  const swept = sweep(st, HOLDER_TTL_MS + 500)
  ok(swept.prunedHolders === 1, 'sweep: prunes stale holder')
  ok(st.holders.some(h => h.holderId === 'agent:live'), 'sweep: keeps holder with a live claim')
}
{
  // filterMessages 增加 total/latestSeq
  const st = init()
  for (let i = 0; i < 5; i++) post(st, { holderId: 'agent:a', name: 'A' }, { body: 'x' + i }, () => 1000)
  const f = filterMessages(st, { limit: 2 })
  ok(f.returned === 2 && f.total === 5 && f.latestSeq === 5, 'filterMessages: total/latestSeq reported')
}

// ===== 8. blockers（wait 使用） =====
console.log('# blockers')
{
  const st = init(); claim(st, { holderId: 'agent:b', name: 'B' }, { paths: ['src/core/'], ttlSec: 100 }, () => 1000)
  const bl = blockers(st, 1000, { holderId: 'agent:c' }, ['src/core/models/'])
  ok(bl.length === 1 && bl[0].holderId === 'agent:b', 'blockers: foreign exclusive overlap blocks')
  const blNone = blockers(st, 1000, { holderId: 'agent:b' }, ['src/other/'])
  ok(blNone.length === 0, 'blockers: non-overlap path -> none')
}

// ===== 8.1 mode=read：只读观测，不排他也不被挡 =====
console.log('# mode=read semantics')
{
  // read 不被他人 exclusive 挡住（问题 1 主修复）
  const st = init(); claim(st, { holderId: 'agent:owner', name: 'Owner' }, { paths: ['src/core/'] }, T)
  let conflict = null, r = null
  try { r = claim(st, { holderId: 'agent:reader', name: 'Reader' }, { paths: ['src/core/models/'], mode: 'read' }, T) } catch (e) { conflict = e }
  ok(conflict === null && r && r.ok === true, 'read claim succeeds despite foreign exclusive')
  ok(r && r.data.claim.mode === 'read', 'read claim stored with mode read')
  ok(st.claims.length === 2, 'read coexists with exclusive claim')
}
{
  // shared 仍被 exclusive 挡住（回归保护，保持现状）
  const st = init(); claim(st, { holderId: 'agent:owner', name: 'Owner' }, { paths: ['src/core/'] }, T)
  let conflict = null
  try { claim(st, { holderId: 'agent:obs', name: 'Obs' }, { paths: ['src/core/models/'], mode: 'shared' }, T) } catch (e) { conflict = e }
  ok(conflict !== null && conflict.collabConflict === true, 'shared claim still blocked by foreign exclusive (regression)')
}
{
  // read 不阻塞任何人：已有 read 时他人 exclusive 仍成功
  const st = init(); claim(st, { holderId: 'agent:reader', name: 'Reader' }, { paths: ['src/core/'], mode: 'read' }, T)
  let conflict = null, r = null
  try { r = claim(st, { holderId: 'agent:writer', name: 'Writer' }, { paths: ['src/core/models/'] }, T) } catch (e) { conflict = e }
  ok(conflict === null && r && r.ok === true, 'existing read claim never blocks an exclusive claim')
  ok(r && r.data.claim.mode === 'exclusive', 'exclusive claim stays exclusive next to read')
}
{
  // 未知/畸形 mode 必须被显式拒绝，而不是替调用方猜一个（猜成 exclusive 会静默升级为最强锁）
  for (const bad of ['bogus', 'READ', 'Exclusive', 42, {}]) {
    const r = claim(init(), { holderId: 'agent:n' }, { paths: ['src/n/'], mode: bad }, T)
    ok(r.ok === false && r.data.error === 'bad-request', 'unknown mode rejected with bad-request: ' + JSON.stringify(bad))
  }
  for (const good of ['exclusive', 'shared', 'read']) {
    ok(claim(init(), { holderId: 'agent:n' }, { paths: ['src/n/'], mode: good }, T).data.claim.mode === good, 'mode accepted: ' + good)
  }
  ok(claim(init(), { holderId: 'agent:n' }, { paths: ['src/n/'] }, T).data.claim.mode === 'exclusive', 'omitted mode defaults to exclusive')
  ok(MODES.join(',') === 'exclusive,shared,read', 'MODES lists the three valid modes')
}
{
  // read 声明本身的 merge / heartbeat / release 生命周期
  const st = init()
  const r1 = claim(st, { holderId: 'agent:reader', name: 'Reader' }, { paths: ['src/ro/'], mode: 'read' }, T)
  const r2 = claim(st, { holderId: 'agent:reader', name: 'Reader' }, { paths: ['src/ro/sub/'], mode: 'read' }, T)
  ok(r1.ok === true && r2.data.merged === true && st.claims.length === 1, 'read claim merges like other modes')
  ok(st.claims[0].mode === 'read' && st.claims[0].paths.length === 2, 'merged read claim keeps read mode and all paths')
  const hb = heartbeat(st, { holderId: 'agent:reader', name: 'Reader' }, { claimId: st.claims[0].claimId }, T)
  ok(hb.ok === true && hb.data.expiresAt > t0, 'read claim heartbeat extends lease')
  const rel = release(st, { holderId: 'agent:reader', name: 'Reader' }, { claimId: st.claims[0].claimId }, T)
  ok(rel.ok === true && st.claims.length === 0, 'read claim release ok')
}
// ===== 8.1b 合并限定同一 mode：既不改写模式，也不放大作用域 =====
console.log('# merge is scoped to the same mode')
{
  // 不同 mode 各成一条声明，互不改写
  const st = init()
  claim(st, { holderId: 'agent:m', name: 'M' }, { paths: ['src/'] }, T)
  claim(st, { holderId: 'agent:m', name: 'M' }, { paths: ['src/sub/'], mode: 'read' }, T)
  ok(st.claims.length === 2, 'different modes stay as separate claims')
  const ex = st.claims.find(c => c.mode === 'exclusive')
  const rd = st.claims.find(c => c.mode === 'read')
  ok(!!ex && ex.paths.length === 1 && ex.paths[0] === 'src/', 'exclusive claim keeps only its own path')
  ok(!!rd && rd.paths.length === 1 && rd.paths[0] === 'src/sub/', 'read claim keeps only its own path')
  // 这里 src/other/ 落在独占的 src/ 之内，被挡是**正确**语义（前缀覆盖）
  let cov = null
  try { claim(st, { holderId: 'agent:x', name: 'X' }, { paths: ['src/other/'] }, T) } catch (e) { cov = e }
  ok(cov !== null, 'path under an exclusive parent is covered (prefix semantics)')

  // 关键回归（P5）：read 父路径 + exclusive 子路径时，
  // 兄弟路径 src/other/ **从未被独占**，不得被连带锁上。
  const st3 = init()
  claim(st3, { holderId: 'agent:o', name: 'O' }, { paths: ['src/'], mode: 'read' }, T)
  claim(st3, { holderId: 'agent:o', name: 'O' }, { paths: ['src/sub/'], mode: 'exclusive' }, T)
  ok(st3.claims.length === 2, 'read parent + exclusive child stay separate')
  let b3 = null
  try { claim(st3, { holderId: 'agent:x', name: 'X' }, { paths: ['src/other/'] }, T) } catch (e) { b3 = e }
  ok(b3 === null, 'sibling src/other/ is not blocked by the sub-path exclusive')
  let b4 = null
  try { claim(st3, { holderId: 'agent:x', name: 'X' }, { paths: ['src/sub/deep/'] }, T) } catch (e) { b4 = e }
  ok(b4 !== null, 'the exclusively claimed sub-path still blocks others')

  // 同 mode 之间仍然合并
  const st2 = init()
  claim(st2, { holderId: 'agent:n', name: 'N' }, { paths: ['src/'] }, T)
  claim(st2, { holderId: 'agent:n', name: 'N' }, { paths: ['src/sub/'] }, T)
  ok(st2.claims.length === 1 && st2.claims[0].paths.length === 2, 'same-mode claims still merge and collect both paths')
}

// ===== 8.2 holders 不会把 read/shared 当 blocker =====
console.log('# blockers ignore read/shared')
{
  const st = init()
  claim(st, { holderId: 'agent:x', name: 'X' }, { paths: ['src/core/'] }, T)
  claim(st, { holderId: 'agent:y', name: 'Y' }, { paths: ['src/shared/'], mode: 'shared' }, T)
  claim(st, { holderId: 'agent:z', name: 'Z' }, { paths: ['src/read/'], mode: 'read' }, T)
  const bl = blockers(st, t0, { holderId: 'agent:new' }, ['src/core/', 'src/shared/', 'src/read/'])
  ok(bl.length === 1 && bl[0].holderId === 'agent:x', 'blockers: only exclusive counts, read/shared ignored')
}

// ===== 8.3 holderView：谁还活着（问题 2 修复） =====
console.log('# holderView')
{
  const st = init()
  const t = 1000
  claim(st, { holderId: 'agent:live', name: 'Live' }, { paths: ['src/live/'], ttlSec: 1800 }, () => t)
  st.holders.push({ holderId: 'agent:warm', name: 'Warm', kind: 'human', lastSeenAt: t - 10000 })
  st.holders.push({ holderId: 'agent:stale', name: 'Stale', kind: 'human', lastSeenAt: t - 120000 })
  const hv = holderView(st, t, { holderTtlMs: 60000 })
  ok(hv.holders.length === 3, 'holderView: returns all holders')
  ok(hv.holders.map(h => h.holderId).join(',') === 'agent:live,agent:warm,agent:stale', 'holderView: sorted by lastSeenAt desc')
  const live = hv.holders.find(h => h.holderId === 'agent:live')
  ok(live.active === true && live.stale === false && live.ageSec === 0, 'holderView: live claimant is active & not stale')
  const warm = hv.holders.find(h => h.holderId === 'agent:warm')
  ok(warm.active === false && warm.stale === false && warm.ageSec === 10, 'holderView: recently seen non-claimant is not stale')
  const stale = hv.holders.find(h => h.holderId === 'agent:stale')
  ok(stale.active === false && stale.stale === true && stale.ageSec === 120, 'holderView: idle holder past ttl is stale')
  ok(hv.staleHolders === 1, 'holderView: staleHolders counts stale only')
}
// ===== 8.3b 时钟偏移：lastSeenAt 落在未来
console.log('# future-dated holder (clock skew)')
{
  const t = 1000000
  ok(holderFresh(t - 1000, t) === true, 'holderFresh: 1s ago is fresh')
  ok(holderFresh(t + 1000, t) === true, 'holderFresh: 1s in the future is still fresh (small skew tolerated)')
  ok(holderFresh(t + 10 * 60 * 1000, t) === false, 'holderFresh: 10min in the future is not fresh (bogus timestamp)')
  ok(holderFresh(t - 25 * 3600 * 1000, t) === false, 'holderFresh: 25h ago is not fresh')
  const st = init()
  st.holders.push({ holderId: 'agent:future', name: 'Future', kind: 'agent', lastSeenAt: t + 10 * 60 * 1000 })
  const hv = holderView(st, t)
  ok(hv.holders[0].stale === true, 'holderView: far-future lastSeenAt is reported stale')
  const swept = sweep(st, t)
  ok(swept.prunedHolders === 1 && st.holders.length === 0, 'sweep: far-future holder is reclaimed instead of living forever')
}

// ===== 9. 宿主源码一致性对拍（hostCode 内联版 vs 核心库） =====
console.log('# hostCode inline vs core (drift guard)')
{
  const { hostCode } = await import('../lib/collab-plugin.host.js')
  // 兼容函数声明 (function norm(...) {) 与箭头函数 (const norm = (...) => {)
  // scope 用于注入被抽取函数所依赖的其他内联函数（如 sweep 依赖 holderFresh）。
  const extract = (fnName, scope = {}) => {
    const names = Object.keys(scope), vals = names.map(n => scope[n])
    const decl = RegExp('function ' + fnName + '\\(([^)]*)\\) \\{([\\s\\S]*?)\\n    \\}', 'm').exec(hostCode)
    if (decl) return new Function(...names, 'return function ' + fnName + '(' + decl[1] + ') {' + decl[2] + '}')(...vals)
    const arrow = RegExp('const ' + fnName + ' = \\(([^)]*)\\) => \\{([\\s\\S]*?)\\n    \\}', 'm').exec(hostCode)
    if (arrow) return new Function(...names, 'return function ' + fnName + '(' + arrow[1] + ') {' + arrow[2] + '}')(...vals)
    throw new Error('cannot extract ' + fnName + ' from hostCode')
  }
  const hn = extract('norm'), hc = extract('cleanName')
  for (const p of ['src/backend/', './src/backend', 'C:\\src', 'src/foo', 'src/foobar', 'a//b/c']) {
    ok(hn(p) === norm(p), 'hostCode norm matches core: ' + p)
  }
  for (const s of ['  a   b ', 'x'.repeat(40), ''] ) {
    ok(hc(s) === cleanName(s), 'hostCode cleanName matches core: len ' + s.length)
  }
  // holderFresh 内联版与核心库行为一致（含未来时间戳的时钟偏移容忍）
  const hhf = extract('holderFresh')
  for (const [ls, t] of [[999000, 1000000], [1001000, 1000000], [1000000 + 600000, 1000000], [1000000 - 25 * 3600 * 1000, 1000000]]) {
    ok(hhf(ls, t) === holderFresh(ls, t), 'hostCode holderFresh matches core: lastSeenAt=' + ls)
  }
  // sweep 内联版与核心库行为一致（默认上限 2000 条；holder 回收判据共用 holderFresh）
  const hs = extract('sweep', { holderFresh: hhf })
  const mk = () => {
    const s = init()
    for (let i = 0; i < 2100; i++) post(s, { holderId: 'agent:a', name: 'A' }, { body: 'm' + i }, () => 1000)
    s.holders.push({ holderId: 'ghost', name: 'Ghost', lastSeenAt: 0 })
    return s
  }
  const coreState = mk(), hostState = mk()
  const coreSwept = sweep(coreState, 1000 + HOLDER_TTL_MS + 1)
  const hostSwept = hs(hostState, 1000 + HOLDER_TTL_MS + 1)
  ok(JSON.stringify(coreSwept) === JSON.stringify(hostSwept), 'hostCode sweep returns the same diagnostics as core')
  ok(JSON.stringify(coreState) === JSON.stringify(hostState), 'hostCode sweep mutates state identically to core')
}

h.finish()
