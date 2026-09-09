// collab-pure-logic.mjs
// 纯逻辑回归测试。import 自 src/collab-core.mjs（唯一事实源），而非复制。
// 运行：node tests/collab-pure-logic.mjs
// 额外对拍：从 src/collab-plugin.host.js 提取 norm/cleanName 源码并 eval，
//          与核心库做行为对比，防止内联版与核心库漂移。
import { readFileSync } from 'node:fs'
import {
  norm, ov, cleanName, init, publish, expire, sweep, HOLDER_TTL_MS, holder, claim, release, heartbeat,
  post, overview, related, filterMessages, blockers,
} from '../src/collab-core.mjs'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  ok  ' + label) } else { fail++; console.log('  FAIL ' + label) } }
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
import { hashProjectKey, projectStorageFileName } from '../src/collab-core.mjs'
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

// ===== 9. 宿主源码一致性对拍（hostCode 内联版 vs 核心库） =====
console.log('# hostCode inline vs core (drift guard)')
{
  const { hostCode } = await import('../src/collab-plugin.host.js')
  // 兼容函数声明 (function norm(...) {) 与箭头函数 (const norm = (...) => {)
  const extract = fnName => {
    const decl = RegExp('function ' + fnName + '\\(([^)]*)\\) \\{([\\s\\S]*?)\\n    \\}', 'm').exec(hostCode)
    if (decl) return new Function('return function ' + fnName + '(' + decl[1] + ') {' + decl[2] + '}')()
    const arrow = RegExp('const ' + fnName + ' = \\(([^)]*)\\) => \\{([\\s\\S]*?)\\n    \\}', 'm').exec(hostCode)
    if (arrow) return new Function('return function ' + fnName + '(' + arrow[1] + ') {' + arrow[2] + '}')()
    throw new Error('cannot extract ' + fnName + ' from hostCode')
  }
  const hn = extract('norm'), hc = extract('cleanName')
  for (const p of ['src/backend/', './src/backend', 'C:\\src', 'src/foo', 'src/foobar', 'a//b/c']) {
    ok(hn(p) === norm(p), 'hostCode norm matches core: ' + p)
  }
  for (const s of ['  a   b ', 'x'.repeat(40), ''] ) {
    ok(hc(s) === cleanName(s), 'hostCode cleanName matches core: len ' + s.length)
  }
  // sweep 内联版与核心库行为一致（默认上限 2000 条）
  const hs = extract('sweep')
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

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
