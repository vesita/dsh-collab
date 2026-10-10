import { createHarness } from './_harness.mjs'

// collab-pure-logic.mjs
// 纯逻辑回归测试。import 自 lib/collab-core.js（唯一事实源），而非复制。
// 运行：node tests/collab-pure-logic.mjs
// 额外守卫：lib/collab-plugin.host.js 内联的核心与 lib/collab-core.js 逐字节同源，
//          防止两形态漂移（见文件末尾 §9）。
import { readFileSync } from 'node:fs'
import {
  norm, ov, cleanName, init, publish, expire, sweep, HOLDER_TTL_MS, holder, claim, release, heartbeat,
  post, overview, related, filterMessages, blockers, holderView, holderFresh, MODES, reap,
  MESSAGE_BODY_MAX_CHARS, pushAudience,
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
  // 0.14.0「允许协商」：**请求 exclusive 时，已在场的 shared 也构成冲突**。
  // 旧实现无条件跳过 `c.mode === 'shared'` ⇒ 后来的 exclusive 被**静默批准**，随后原先
  // shared 持有者的写入被门控硬拒（本部署 ask == deny），而"冲突"双方都没看见。
  const st = init(); claim(st, { holderId: 'agent:b', name: 'B' }, { paths: ['src/core/'], mode: 'shared' }, T)
  let conflict = null
  try { claim(st, { holderId: 'agent:c', name: 'C' }, { paths: ['src/core/models/'] }, T) } catch (e) { conflict = e }
  ok(conflict !== null && conflict.collabConflict === true,
    'exclusive over foreign shared -> conflict（允许协商，不再静默抢占）')
  ok(conflict && conflict.conflicts[0].holderId === 'agent:b' && conflict.conflicts[0].mode === 'shared',
    '冲突里如实报出对方是 shared（协商对象与它的模式都看得见）',
    conflict && conflict.conflicts[0] ? JSON.stringify(conflict.conflicts[0]) : 'null')
}
{
  // 反向对照 1：**请求 shared** 与已在场的 shared 不冲突 —— 共享方互不挡死（0.9.x 语义保持）。
  const st = init(); claim(st, { holderId: 'agent:b', name: 'B' }, { paths: ['src/core/'], mode: 'shared' }, T)
  let conflict = null
  try { claim(st, { holderId: 'agent:c', name: 'C' }, { paths: ['src/core/models/'], mode: 'shared' }, T) } catch (e) { conflict = e }
  ok(conflict === null, 'shared over shared -> 不冲突（两个共享方互不挡死）')
}
{
  // 反向对照 2：shared 被他人 exclusive 挡住 —— 这是 shared 的定义，钉住别退化。
  const st = init(); claim(st, { holderId: 'agent:b', name: 'B' }, { paths: ['src/core/'], mode: 'exclusive' }, T)
  let conflict = null
  try { claim(st, { holderId: 'agent:c', name: 'C' }, { paths: ['src/core/models/'], mode: 'shared' }, T) } catch (e) { conflict = e }
  ok(conflict !== null && conflict.collabConflict === true, 'shared over foreign exclusive -> conflict')
}
{
  // 反向对照 3：read 纯观测，既不挡人也不被挡。
  const st = init(); claim(st, { holderId: 'agent:b', name: 'B' }, { paths: ['src/core/'], mode: 'shared' }, T)
  let conflict = null
  try { claim(st, { holderId: 'agent:c', name: 'C' }, { paths: ['src/core/models/'], mode: 'read' }, T) } catch (e) { conflict = e }
  ok(conflict === null, 'read over foreign shared -> 不冲突')
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
  // 0.13.0：投递诚实性 + mentions 已移除（@ 谁都不等于通知谁；显式挡回，不静默忽略）
  const p2 = post(init(), { holderId: 'agent:a', name: 'A' }, { body: 'hi' }, T)
  ok(p2.data.delivered === false, 'post 如实回 delivered:false（本板没有投递面）')
  ok(typeof p2.data.deliveryNote === 'string' && p2.data.deliveryNote.includes('不投递') && p2.data.deliveryNote.includes('不唤醒'),
    'post 回 deliveryNote 说明不投递/不唤醒', String(p2.data.deliveryNote))
  const stM = init()
  const p3 = post(stM, { holderId: 'agent:a', name: 'A' }, { body: 'hi', mentions: ['agent:b'] }, T)
  ok(p3.ok === false && p3.data.error === 'bad-request' && String(p3.data.message).includes('mentions 已移除'),
    'post 收到 mentions ⇒ bad-request（fail-loud，不静默忽略）', JSON.stringify(p3.data))
  ok(stM.messages.length === 0, '被挡回时**不写入**消息（调用方去掉 mentions 重发即可）')
  const stNo = init()
  post(stNo, { holderId: 'agent:a', name: 'A' }, { body: 'hi' }, T)
  ok(!('mentions' in stNo.messages[0]), '新消息不再带 mentions 字段（契约里已移除）')

  // ---- M2b item 2：单条 body 的字符上限（只封条数 = 大小任意大；超限必须挡回、不许截断）----
  {
    const at = init()
    const r = post(at, { holderId: 'agent:a', name: 'A' }, { body: 'z'.repeat(MESSAGE_BODY_MAX_CHARS) }, T)
    ok(r.ok === true && at.messages.length === 1, 'post：**恰好等于上限**的 body 通过（边界含）', JSON.stringify({ ok: r.ok, n: at.messages.length }))
    ok(at.messages[0].body.length === MESSAGE_BODY_MAX_CHARS, 'post：边界内的 body 原文落盘（未被截断）', String(at.messages[0].body.length))
  }
  {
    const over = init()
    const r = post(over, { holderId: 'agent:a', name: 'A' }, { body: 'z'.repeat(MESSAGE_BODY_MAX_CHARS + 1) }, T)
    ok(r.ok === false && r.data.error === 'bad-request', 'post：超过上限 ⇒ bad-request（不静默截断）', JSON.stringify(r.data))
    ok(String(r.data.message).includes(String(MESSAGE_BODY_MAX_CHARS)) && String(r.data.message).includes('没有写入'),
      'post：报错文案点明上限与"没有写入"', String(r.data.message))
    ok(over.messages.length === 0 && over.holders.length === 0, 'post：被挡回时消息与名册行**一个字都不写**', JSON.stringify({ messages: over.messages.length, holders: over.holders.length }))
  }
  {
    // 中文/多字节按**字符**计（与 SSOT 的 maxLength 同口径；UTF-16 单元对星平面字符更严，只会更早拒）。
    const mb = init()
    const r = post(mb, { holderId: 'agent:a', name: 'A' }, { body: '中'.repeat(MESSAGE_BODY_MAX_CHARS) }, T)
    ok(r.ok === true, 'post：多字节字符同样按字符数封顶（与 JSON Schema maxLength 同口径）')
  }
  {
    // SSOT 与核心同值：schema 的 maxLength 就是这里的常量，不许两处各写一个数。
    const schema = JSON.parse(readFileSync(new URL('../src/schema/collab.schema.json', import.meta.url), 'utf8'))
    const maxLength = schema.$defs.Message.properties.body.maxLength
    ok(maxLength === MESSAGE_BODY_MAX_CHARS, 'SSOT Message.body.maxLength == collab-core MESSAGE_BODY_MAX_CHARS', JSON.stringify({ schema: maxLength, core: MESSAGE_BODY_MAX_CHARS }))
  }
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
  // filterMessages 增加 total/latestSeq（0.13.0 再补 mode/hasMore/nextSince/earliestSeq）
  const st = init()
  for (let i = 0; i < 5; i++) post(st, { holderId: 'agent:a', name: 'A' }, { body: 'x' + i }, () => 1000)
  const f = filterMessages(st, { limit: 2 })
  ok(f.returned === 2 && f.total === 5 && f.latestSeq === 5, 'filterMessages: total/latestSeq reported')
  ok(f.mode === 'tail' && f.messages.map(m => m.body).join(',') === 'x3,x4', 'filterMessages: 不给 since = tail（最新 limit 条，追平用）', JSON.stringify(f.messages.map(m => m.body)))
  ok(f.hasMore === true && f.nextSince === 5 && f.earliestSeq === 1, 'filterMessages: tail 报 hasMore/nextSince/earliestSeq', JSON.stringify({ hasMore: f.hasMore, nextSince: f.nextSince, earliestSeq: f.earliestSeq }))
  // forward：给了游标就从游标**往后**读，旧→新，不重不漏
  const g1 = filterMessages(st, { since: 1, limit: 2 })
  ok(g1.mode === 'forward' && g1.messages.map(m => m.body).join(',') === 'x1,x2', 'filterMessages: since>0 = forward（从游标往后，旧→新）', JSON.stringify(g1.messages.map(m => m.body)))
  const g2 = filterMessages(st, { since: g1.nextSince, limit: 2 })
  ok(g2.messages.map(m => m.body).join(',') === 'x3,x4' && g2.hasMore === false, 'filterMessages: 按 nextSince 翻页不重不漏（第二页即最后一页）')
  const g3 = filterMessages(st, { since: 99 })
  ok(g3.returned === 0 && g3.hasMore === false && g3.nextSince === 99, 'filterMessages: 游标越界 → 空集且 nextSince 原样回传（游标不跳段）')
  // 旧语义（slice(-limit)）在 since>0 时会静默丢中段：这一条就是那个回归门禁
  const big = init()
  for (let i = 0; i < 10; i++) post(big, { holderId: 'agent:a', name: 'A' }, { body: 'y' + i }, () => 1000)
  const p1 = filterMessages(big, { since: 1, limit: 3 })
  ok(p1.messages.map(m => m.body).join(',') === 'y1,y2,y3', 'filterMessages: since>0 时取的是游标后最早 3 条（旧实现取最新 3 条 ⇒ 中间 4 条永久丢）', JSON.stringify(p1.messages.map(m => m.body)))
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

// ===== 9. 宿主形态的内联核心与 lib/collab-core.js 同源（drift guard） =====
// 动态形态不再手写纯逻辑：lib/collab-plugin.host.js 由 scripts/build-host.mjs 把
// lib/collab-core.js 剥掉顶层 `export ` 后内联进 src/host-shell.js 的核心标记处。
// 这里守住"内联的那一段与构建出来的核心逐字节相同"—— 两形态不漂移的根。
// 不再抽函数体做同义反复的行为对拍（内联后就是同一份代码）；宿主真实 I/O 的端到端断言在
// tests/collab-hostcode-parity.mjs 与 tests/collab-e2e.mjs，本文件只留这一条源头守卫。
console.log('# hostCode inlines lib/collab-core.js byte-for-byte (drift guard)')
{
  const { hostCode } = await import('../lib/collab-plugin.host.js')
  const coreSrc = readFileSync(new URL('../lib/collab-core.js', import.meta.url), 'utf8')
  const coreStripped = coreSrc.replace(/^export /gm, '')
  const BEGIN = '/*__COLLAB_CORE_BEGIN__*/'
  const END = '/*__COLLAB_CORE_END__*/'
  const bi = hostCode.indexOf(BEGIN), ei = hostCode.indexOf(END)
  ok(bi >= 0 && ei > bi, 'hostCode 有核心内联区（BEGIN/END 标记）', 'begin=' + bi + ' end=' + ei)
  const region = (bi >= 0 && ei > bi) ? hostCode.slice(bi + BEGIN.length + 1, ei) : ''
  ok(region.length > 0, '核心内联区非空', 'len=' + region.length)
  ok(region === coreStripped, '内联核心与 lib/collab-core.js 去 export 后逐字节一致',
    'region=' + region.length + ' coreStripped=' + coreStripped.length)
  ok(!/^\s*(export|import)\s/m.test(region), '内联核心不含顶层 export/import（否则 new Function 装不起来）')
}

// ===== 会话家族（血缘）豁免（0.9.11，C1）=====
// 正负对照都要有：既要证明"自家人放行"，也要证明"外人一个都没放开"。
console.log('# 会话家族（血缘）豁免')
{
  const mkParent = () => {
    const st = init()
    claim(st, { holderId: 'agent:parent', name: '父会话' }, { paths: ['src/deploy/'] }, T)
    return st
  }
  const child = { holderId: 'agent:child', name: '子代理', family: ['agent:child', 'agent:parent'] }
  const stranger = { holderId: 'agent:stranger', name: '陌生会话', family: ['agent:stranger'] }

  // 正：子代理带着血缘 claim 父会话已独占的路径 → 放行
  const st1 = mkParent()
  const r1 = claim(st1, child, { paths: ['src/deploy/installer/'] }, T)
  ok(r1.ok === true, '子代理 claim 父会话已独占的路径：放行', JSON.stringify(r1.data && r1.data.error))
  ok(st1.claims.length === 2, '两条声明并存（各自持有，不是合并）', JSON.stringify(st1.claims.map(c => c.holderId)))

  // 负 1：无血缘的第三方 → 仍然 conflict
  const st2 = mkParent()
  let threw2 = null
  try { claim(st2, stranger, { paths: ['src/deploy/installer/'] }, T) } catch (e) { threw2 = e }
  ok(!!threw2 && threw2.collabConflict === true, '无血缘的第三方：仍然抛 conflict（没放开外人）')

  // 负 2：血缘缺省 → 退化为 0.9.10 的语义（自家人不认）
  const st3 = mkParent()
  let threw3 = null
  try { claim(st3, { holderId: 'agent:child' }, { paths: ['src/deploy/installer/'] }, T) } catch (e) { threw3 = e }
  ok(!!threw3 && threw3.collabConflict === true, '血缘缺省：仍是 conflict（缺省 = 旧语义）')

  // 反向：父会话去占自家子代理已占的路径
  const st4 = init()
  claim(st4, { holderId: 'agent:child', name: '子代理' }, { paths: ['src/child/'] }, T)
  const r4 = claim(st4, { holderId: 'agent:parent', name: '父会话', family: ['agent:parent', 'agent:child'] }, { paths: ['src/child/'] }, T)
  ok(r4.ok === true, '父会话 claim 自家子代理已占的路径：放行')

  // wait/blockers 同源：家族成员不算阻塞，外人照旧算
  const st5 = mkParent()
  ok(blockers(st5, t0, child, ['src/deploy/']).length === 0, 'blockers 不把自家父会话算成阻塞')
  ok(blockers(st5, t0, stranger, ['src/deploy/']).length === 1, 'blockers 对陌生会话仍然算阻塞')

  // 血缘不落盘：holder() 只写已知字段
  ok(st1.holders.every((x) => x.family === undefined), 'holders 表里不出现 family 字段（血缘不落盘）')
}

// ===== reap 级联清 holders（0.9.11，C4）=====
console.log('# reap 级联清 holders')
{
  const mkZombie = () => {
    const st = init()
    const old = T() - 3600 * 1000
    const mk = (claimId, holderId, p) => ({ claimId, holderId, holderName: holderId, paths: [p], mode: 'exclusive', ttlSec: 1800, expiresAt: T() + 600000, createdAt: old, readable: true, readers: [] })
    st.claims.push(mk('c_z', 'agent:zombie', 'src/z/'))
    st.claims.push(mk('c_live', 'agent:live', 'src/l/'))
    st.claims.push(mk('c_me', 'agent:me', 'src/m/'))
    for (const id of ['agent:zombie', 'agent:live', 'agent:me']) st.holders.push({ holderId: id, name: id, kind: 'agent', sessionId: id.slice(6), lastSeenAt: T() })
    return st
  }
  const live = ['agent:live', 'agent:me']
  const st = mkZombie()
  const dry = reap(st, { holderId: 'agent:me' }, { confirm: false, olderThanSec: 600 }, live, T())
  ok(dry.changed === false && st.holders.length === 3, 'dry-run 不动 holders', JSON.stringify(st.holders.length))
  ok(Array.isArray(dry.data.candidateHolders) && dry.data.candidateHolders.join(',') === 'agent:zombie',
    'dry-run 报出将被摘掉的残留 holder', JSON.stringify(dry.data.candidateHolders))

  const done = reap(st, { holderId: 'agent:me' }, { confirm: true, olderThanSec: 600 }, live, T())
  ok(st.claims.length === 2, '只回收僵尸声明', JSON.stringify(st.claims.map(c => c.claimId)))
  ok(Array.isArray(done.data.reapedHolders) && done.data.reapedHolders.join(',') === 'agent:zombie',
    'confirm 后级联摘掉僵尸 holder', JSON.stringify(done.data.reapedHolders))
  ok(st.holders.map(x => x.holderId).sort().join(',') === 'agent:live,agent:me',
    'holders 表同步变短（活体与自己都留着）', JSON.stringify(st.holders.map(x => x.holderId)))

  // 活体检查不可用 ⇒ 一个也不收，holders 也不动
  const st2 = init()
  st2.claims.push({ claimId: 'c_z2', holderId: 'agent:zombie2', paths: ['src/z2/'], mode: 'exclusive', ttlSec: 1800, expiresAt: T() + 600000, createdAt: T() - 3600 * 1000, readable: true, readers: [] })
  st2.holders.push({ holderId: 'agent:zombie2', name: 'Z2', kind: 'agent', sessionId: 'zombie2', lastSeenAt: T() })
  const r = reap(st2, { holderId: 'agent:me' }, { confirm: true, olderThanSec: 600 }, null, T())
  ok(r.changed === false && st2.holders.length === 1, '活体检查不可用：一个也不收，holders 不动', JSON.stringify(st2.holders.length))
}

// ===== 10. 广播推送的受众（pushAudience，单元 F）=====
// 受众是**频道到持有人集合**的纯投影：general = 全部持有人、path:<p> = 声明重叠者，都排除自己。
// 它必须**确定性**（排序输出）—— 受众集合进一次性令牌的载荷，顺序不定会让"受众是否变过"失真。
console.log('# pushAudience（单元 F 广播受众）')
{
  const st = init()
  st.holders.push({ holderId: 'agent:a', name: 'A', kind: 'agent', sessionId: 'a', lastSeenAt: t0 })
  st.holders.push({ holderId: 'agent:b', name: 'B', kind: 'agent', sessionId: 'b', lastSeenAt: t0 })
  st.holders.push({ holderId: 'agent:me', name: 'Me', kind: 'agent', sessionId: 'me', lastSeenAt: t0 })
  const mk = (holderId, paths, expiresAt = t0 + 600000) => ({ claimId: 'c_' + holderId + paths.join(','), holderId, holderName: holderId, paths, mode: 'exclusive', ttlSec: 1800, expiresAt, createdAt: t0, readable: true, readers: [] })
  st.claims.push(mk('agent:a', ['src/a/x/']))
  st.claims.push(mk('agent:b', ['src/a/y/sub/']))  // 后代 ⇒ 与 src/a/ 重叠
  st.claims.push(mk('agent:b', ['src/b/']))

  const gen = pushAudience(st, 'general', 'agent:me', t0)
  ok(gen.kind === 'general' && JSON.stringify(gen.holderIds) === '["agent:a","agent:b"]',
    'general = 全部持有人、排除自己、按 holderId 排序', JSON.stringify(gen))

  const p = pushAudience(st, 'path:src/a/', 'agent:me', t0)
  ok(p.kind === 'path' && p.path === 'src/a/' && JSON.stringify(p.holderIds) === '["agent:a","agent:b"]',
    'path:src/a/ = 声明重叠者（含后代 src/a/y/sub/）', JSON.stringify(p))

  const pB = pushAudience(st, 'path:src/b/', 'agent:me', t0)
  ok(JSON.stringify(pB.holderIds) === '["agent:b"]', 'path:src/b/ 只含 b（a 的声明不重叠）', JSON.stringify(pB))

  const self = pushAudience(st, 'path:src/a/x/', 'agent:a', t0)
  ok(self.holderIds.length === 0, 'path 受众同样排除投递方自己', JSON.stringify(self))

  const other = pushAudience(st, 'agent:someone', 'agent:me', t0)
  ok(other.kind === 'unsupported-channel' && other.holderIds.length === 0 && other.reason === 'channel-has-no-audience-rule',
    '非 general / path: 的频道没有受众规则（返回空 + 原因）', JSON.stringify(other))

  const badPath = pushAudience(st, 'path:', 'agent:me', t0)
  ok(badPath.kind === 'path' && badPath.reason === 'empty-path' && badPath.holderIds.length === 0,
    'path: 没给路径 ⇒ 空受众 + empty-path', JSON.stringify(badPath))

  // 过期声明不进受众
  const stExp = init()
  stExp.holders.push({ holderId: 'agent:old', name: 'Old', kind: 'agent', sessionId: 'old', lastSeenAt: t0 })
  stExp.claims.push(mk('agent:old', ['src/a/'], t0 - 1))
  ok(pushAudience(stExp, 'path:src/a/', 'agent:me', t0).holderIds.length === 0,
    '过期声明不进受众', JSON.stringify(pushAudience(stExp, 'path:src/a/', 'agent:me', t0)))
}

h.finish()
