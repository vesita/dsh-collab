// tests/collab-write-merge.mjs
//
// 单元 C（载荷收敛）的**写路径**守卫：两个写者并发写同一份状态文件时不丢更新。
//
// 病根（2026-10 实测）：状态文件用 replaceIfVersion 写，而它是 probe → rename；串行化锁是
// 文件系统实例的**实例字段**（只在本进程内排队）⇒ 两个进程可以同时 probe 到同一个 version、
// 各自 rename 都成功，后写者静默覆盖先写者（64MB 内容拉开窗口 + 文件屏障对齐，**4/4 轮双成功**
// = 丢更新）。本单元不靠锁：写路径改成 读 → mergeDocs(盘上, 我的副本) → 应用本次 op → 写 →
// **写后验证** → 不一致就重读重合并重试。
//
// 覆盖：
//   1) 正题：A、B 各持一份、绕过版本守卫各自写盘（两次写都"成功"）⇒ 任一方做一次正常写后，
//      盘上**同时**含 A 与 B 的记录；
//   2) **负向对照**：把 merge 退回"后写覆盖"⇒ 同一场景确实丢掉对方的记录（可执行形式）；
//   3) release 终态化：A 释放后 B 拿旧副本合并回来，那条声明不再具备权威（list 不显示、
//      wait 不被它挡）；
//   4) 多写者留言：撞 seq 的留言一条不丢，用复合游标迭代读也不漏；
//   5) 写后验证真的在判：别人在我的写入之后盖了戳 ⇒ 我重读重合并重试（而不是宣布成功）。
//
// 运行：node tests/collab-write-merge.mjs

import { createHarness, readStateMerged } from './_harness.mjs'
import { createStateCore } from '../lib/state-core.js'
import * as pure from '../lib/collab-core.js'

const h = createHarness()
const { ok } = h

const show = (v) => {
  let s
  try { s = JSON.stringify(v) } catch (e) { s = String(v) }
  return s === undefined ? String(v) : (s.length > 220 ? s.slice(0, 220) + '…' : s)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const TARGET = '/state/proj.json'
const SIDE = '/state/proj.messages.json'
const holder = (n) => ({ holderId: 'agent:' + n, name: n })
const now = () => Date.now()

// ---------------------------------------------------------------- 假盘 + 写者视图
/** 一块共享的"盘"：文件内容 + 版本号（版本号就是 CAS 守卫比的那个值）。 */
function makeDisk () {
  const files = new Map()
  const versions = new Map()
  let v = 0
  return {
    files,
    versions,
    write: (p, text) => { files.set(p, text); versions.set(p, ++v); return v }
  }
}

/**
 * 一个写者进程看到的文件系统。
 *
 * @param opts.snapshot      读固定快照（模拟"我在对方写之前读到的盘"）；不给就读共享盘
 * @param opts.bypassGuard   true = 版本守卫**不生效**（照实测：两个写者同时 probe 成功、各自 rename 都成功）
 * @param opts.onWrite       每次写入时的回调（断言"确实写了两份"）
 */
function makeFs (disk, opts = {}) {
  const view = opts.snapshot || disk.files
  const versionOf = (p) => (opts.snapshot ? 1 : (disk.versions.get(p) || 1))
  return {
    resolve: async (p) => ({ displayPath: p, path: p }),
    stat: async (t) => (view.has(t.path) ? { version: versionOf(t.path) } : null),
    readText: async (t) => view.get(t.path) || '',
    writeText: async (t, content, o) => {
      if (!opts.bypassGuard && o && o.kind === 'replaceIfVersion') {
        const cur = disk.files.has(t.path) ? (disk.versions.get(t.path) || 1) : null
        if (cur === null || cur !== o.version) {
          const e = new Error('cannot write "' + t.path + '": file changed since it was read')
          e.code = 'FS_STALE_VERSION'
          throw e
        }
      }
      // onWrite 可以返回替换后的内容（负向对照用：模拟"别人在我的写入之后盖了戳"）。
      if (typeof opts.onWrite === 'function') {
        const replaced = opts.onWrite(t.path, content)
        if (typeof replaced === 'string') content = replaced
      }
      return { operation: 'create', version: disk.write(t.path, content) }
    },
    processPath: (t) => t.path
  }
}

/** 一个写者（= 一个 createStateCore 实例）。writerId 必须不同 —— 它就是记录的写者戳。 */
function makeStore (disk, writerId, opts = {}) {
  return createStateCore({
    fs: makeFs(disk, opts.fs || {}),
    core: opts.core || pure,
    now,
    writerId,
    targetFor: async () => ({
      cwd: '/proj',
      target: { displayPath: TARGET, path: TARGET },
      sidecar: { displayPath: SIDE, path: SIDE },
      stateDir: '/state',
      fileName: 'proj.json'
    }),
    legacyTargets: async () => [],
    liveProcsOf: () => null,
    selfProcToken: () => null,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    liveAgentHolderIds: () => null,
    log: () => {}
  })
}

/** 盘上的**逻辑状态**（主文件 + 留言旁挂合并，与实现的落盘布局同源）。 */
const onDisk = (disk) => readStateMerged((p) => disk.files.get(p), TARGET)
const claimIds = (disk) => onDisk(disk).claims.map((c) => c.claimId).sort()
const bodies = (disk) => onDisk(disk).messages.map((m) => m.body)
const expectId = (n, w) => 'c_' + n + '@' + w

// ════════════════════════════════════════════════════════════════════════
// 1. 正题：两个写者都"写成功"，任一方再做一次正常写 ⇒ 盘上两边都在
// ════════════════════════════════════════════════════════════════════════
console.log('# 1. 两个写者并发写盘（绕过版本守卫，两次都成功）后不丢更新')
{
  const disk = makeDisk()
  // B 在 A 写之前就把盘读进自己的视图（快照），并且写入**绕过版本守卫** —— 这正是实测现场。
  const emptySnapshot = new Map(disk.files)
  const A = makeStore(disk, 'wA')
  const B = makeStore(disk, 'wB', { fs: { snapshot: emptySnapshot, bypassGuard: true } })

  const ra = await A.mutate((s) => pure.claim(s, holder('A'), { paths: ['src/a/'] }, now), null)
  ok(ra.ok === true, 'A 的第一笔写成功', show(ra))
  ok(same(claimIds(disk), ['c_1@wA']), 'A 的记录在盘上', show(claimIds(disk)))

  const rb = await B.mutate((s) => pure.claim(s, holder('B'), { paths: ['src/b/'] }, now), null)
  ok(rb.ok === true, 'B 的第二笔写**也成功**（版本守卫被绕过 = 实测现场）', show(rb))
  ok(same(claimIds(disk), ['c_1@wB']),
    '病根复现：B 用自己那份（不含 A 的）覆盖了盘，A 的记录此刻确实不在盘上', show(claimIds(disk)))

  // 任一方做一次**正常写**：A 只声明了一条新路径，却必须把 B 的记录一起并回来。
  const ra2 = await A.mutate((s) => pure.claim(s, holder('A'), { paths: ['src/a2/'] }, now), null)
  ok(ra2.ok === true, 'A 的第二次（正常）写成功', show(ra2))
  ok(same(claimIds(disk), ['c_1@wA', 'c_1@wB', 'c_2@wA']),
    '盘上同时含 A 与 B 的记录（B 的那条没有被覆盖，A 的两条也在）', show(claimIds(disk)))
}

// ════════════════════════════════════════════════════════════════════════
// 2. 负向对照：把 merge 退回"后写覆盖" ⇒ 同一场景丢记录
// ════════════════════════════════════════════════════════════════════════
console.log('# 2. 负向对照（RED）：merge 退回"后写覆盖"，同一串操作必须丢掉 B 的记录')
{
  // `(a, b) => b` 就是"后写覆盖"：合并基取右操作数（= 我的副本），盘上的别人一概不见。
  const naive = { ...pure, mergeDocs: (a, b) => b }
  const disk = makeDisk()
  const emptySnapshot = new Map(disk.files)
  const A = makeStore(disk, 'wA', { core: naive })
  const B = makeStore(disk, 'wB', { fs: { snapshot: emptySnapshot, bypassGuard: true } })
  await A.mutate((s) => pure.claim(s, holder('A'), { paths: ['src/a/'] }, now), null)
  await B.mutate((s) => pure.claim(s, holder('B'), { paths: ['src/b/'] }, now), null)
  const ra2 = await A.mutate((s) => pure.claim(s, holder('A'), { paths: ['src/a2/'] }, now), null)
  ok(ra2.ok === true, '负向对照里 A 的正常写同样成功（失败的不是写盘）', show(ra2))
  const ids = claimIds(disk)
  ok(!ids.includes('c_1@wB') && same(ids, ['c_1@wA', 'c_2@wA']),
    '负向对照（RED）成立：后写覆盖下 B 的记录确实丢了（这就是第 1 节那条断言要挡的东西）', show(ids))
}

// ════════════════════════════════════════════════════════════════════════
// 3. release 终态化：A 释放后 B 拿旧副本合并回来，那条声明不再具备权威
// ════════════════════════════════════════════════════════════════════════
console.log('# 3. release 终态化：旧副本合并回来也翻不了案（list 不显示 / wait 不被挡）')
{
  const disk = makeDisk()
  const A = makeStore(disk, 'wA')
  const B = makeStore(disk, 'wB')
  await A.mutate((s) => pure.claim(s, holder('A'), { paths: ['src/x/'] }, now), null)
  // B 在自己的副本里也持有这条声明（它读过盘并写过一次）。
  await B.mutate((s) => pure.claim(s, holder('B'), { paths: ['src/y/'] }, now), null)

  const rel = await A.mutate((s) => pure.release(s, holder('A'), { claimId: 'c_1@wA' }, now), null)
  ok(rel.ok === true && rel.data.released.length === 1, 'A 释放了 src/x/', show(rel && rel.data && rel.data.released))
  const mid = onDisk(disk)
  ok(!mid.claims.some((c) => c.claimId === 'c_1@wA'), '释放后盘上 claims 里没有它', show(mid.claims.map(c => c.claimId)))
  ok(mid.released && mid.released['c_1@wA'] > 0, '盘上留了终态墓碑（claimId → max(原 expiresAt, 释放时刻 + ttl)）', show(mid.released))

  // B 拿**旧副本**（里面 src/x/ 还活着）做一次正常写。
  const rb = await B.mutate((s) => pure.claim(s, holder('B'), { paths: ['src/z/'] }, now), null)
  ok(rb.ok === true, 'B 的正常写成功', show(rb))
  const after = onDisk(disk)
  ok(!after.claims.some((c) => c.claimId === 'c_1@wA'),
    'B 的旧副本没有把已释放的声明复活（墓碑赢了 join）', show(after.claims.map(c => c.claimId)))
  ok(after.released && after.released['c_1@wA'] > 0, '墓碑仍在（权威失效这件事本身也被保留）', show(after.released))

  const listed = await B.list(null)
  ok(listed.ok === true && !listed.data.claims.some((c) => c.claimId === 'c_1@wA'),
    'list 不显示那条已释放的声明', show(listed.data.claims.map(c => c.claimId)))
  const waited = await B.waitFor({ paths: ['src/x/'], timeoutMs: 200 }, holder('B'), null)
  ok(waited.ok === true && waited.data.blockers.length === 0,
    'wait 不被那条已释放的声明挡住（它已经不再具备权威）', show(waited))
}

// ════════════════════════════════════════════════════════════════════════
// 4. 多写者留言：撞 seq 也不丢，复合游标迭代一条不漏
// ════════════════════════════════════════════════════════════════════════
console.log('# 4. 撞 seq 的留言一条不丢（复合游标迭代读）')
{
  const disk = makeDisk()
  const emptySnapshot = new Map(disk.files)
  const A = makeStore(disk, 'wA')
  const B = makeStore(disk, 'wB', { fs: { snapshot: emptySnapshot, bypassGuard: true } })
  for (let i = 1; i <= 3; i++) await A.mutate((s) => pure.post(s, holder('A'), { body: 'a' + i }, now), null)
  // B 从空快照出发 ⇒ 它自己的 seq 也从 1 开始 ⇒ **与 A 撞 seq**；写入绕过守卫，把 A 的覆盖掉。
  for (let i = 1; i <= 3; i++) await B.mutate((s) => pure.post(s, holder('B'), { body: 'b' + i }, now), null)
  ok(same(bodies(disk), ['b1', 'b2', 'b3']), 'B 覆盖后盘上只剩 B 的三条（病根复现）', show(bodies(disk)))

  // A 做一次正常写（发一条新留言）⇒ 合并把 B 的三条一起并回来。
  await A.mutate((s) => pure.post(s, holder('A'), { body: 'a4' }, now), null)
  const merged = onDisk(disk)
  const ids = merged.messages.map((m) => m.msgId)
  ok(ids.length === 7 && new Set(ids).size === 7, '两边的留言都在且 id 互不相同（3+3+1=7）', show(ids))
  ok(same(merged.messages.map((m) => m.body), ['a1', 'b1', 'a2', 'b2', 'a3', 'b3', 'a4']),
    '顺序是 (seq, writer) 全序（撞 seq 时按写者戳排：wA < wB）', show(merged.messages.map((m) => [m.seq, m.writer, m.body])))
  ok(same(ids, ['m_1@wA', 'm_1@wB', 'm_2@wA', 'm_2@wB', 'm_3@wA', 'm_3@wB', 'm_4@wA']),
    '撞 seq 的 id 靠写者戳分开（m_1@wA / m_1@wB …）', show(ids))

  // 用复合游标翻页：从 (1, "") 之后开始（seq>0 ⇒ forward 模式），每次 limit=2，
  // 按 nextCursor 迭代到 hasMore=false。注意 since=0 按既有契约是 **tail**（读最新），
  // 不是"从头 forward" —— 两者是 0.13.0 起就分明的两种模式，本单元没有改它。
  const seen = []
  let cursor = pure.cursorKey({ seq: 1, writer: '' })
  for (let i = 0; i < 10; i++) {
    const page = await A.msgs({ op: 'read', since: cursor, limit: 2 }, null)
    ok(page.ok === true, '按复合游标 read 成功', show(page))
    for (const m of page.data.messages) seen.push(m.msgId)
    if (!page.data.hasMore) break
    cursor = page.data.nextCursor
  }
  ok(same(seen, ids), '复合游标迭代一条不漏、不重（' + ids.length + ' 条）', show(seen))

  // 负向对照：纯数字游标（老语义 `seq > since`）在撞 seq 时漏一位写者。
  const numericSeen = []
  let numericCursor = 0
  for (let i = 0; i < 10; i++) {
    const page = await A.msgs({ op: 'read', since: numericCursor, limit: 2 }, null)
    const msgs = page.data.messages
    for (const m of msgs) numericSeen.push(m.msgId)
    numericCursor = msgs.length ? msgs[msgs.length - 1].seq : numericCursor
    if (!page.data.hasMore) break
  }
  ok(numericSeen.length < ids.length,
    '负向对照（RED）：纯数字游标只推进 seq，撞 seq 的那位写者被跳过（读到 ' + numericSeen.length + ' / ' + ids.length + ' 条）',
    show(numericSeen))
}

// ════════════════════════════════════════════════════════════════════════
// 5. 写后验证真的在判：别人在我的写入之后盖了戳 ⇒ 我重读重合并重试
// ════════════════════════════════════════════════════════════════════════
console.log('# 5. 写后验证：盘上的写者戳被人换掉 ⇒ 重读重合并重试（不是宣布成功）')
{
  const disk = makeDisk()
  // 第一次写入成功后，立刻把盘上的 writer 改成一个"别人"的戳（模拟后写者 rename 落在我之后）。
  let hijackOnce = true
  const A = makeStore(disk, 'wA', {
    fs: {
      onWrite: (p, content) => {
        if (hijackOnce && p === TARGET) {
          hijackOnce = false
          // 只改 writer 字段，其余内容不动（合法 JSON）—— 落盘的就是"别人盖的戳"。
          const doc = JSON.parse(content)
          doc.writer = 'wSOMEONE-ELSE'
          return JSON.stringify(doc)
        }
        return undefined
      }
    }
  })
  // 让"重试后的那一轮"写进去的仍是 A 的内容：onWrite 只劫持一次。
  const r = await A.mutate((s) => pure.claim(s, holder('A'), { paths: ['src/verify/'] }, now), null)
  ok(r.ok === true, 'op 最终成功（验证失败后重试）', show(r))
  ok(same(claimIds(disk), ['c_1@wA']), '重试后 A 的记录仍在盘上（没有被劫持吞掉）', show(claimIds(disk)))
  const doc = JSON.parse(disk.files.get(TARGET))
  ok(doc.writer === 'wA', '盘上的写者戳最终是 A 自己（写后验证会一直纠到这一点）', show(doc.writer))
}

// ════════════════════════════════════════════════════════════════════════
// 6. CLI ↔ 插件互相不丢更新（单元 D："CLI 先写、插件再写"这一半；
//    "插件先写、CLI 再写"那一半在 Rust 侧 test_cli_merge_keeps_plugin_update）
// ════════════════════════════════════════════════════════════════════════
console.log('# 6. CLI 先写、插件再写：插件的正常写必须把 CLI 的记录并回来')
{
  const disk = makeDisk()
  const A = makeStore(disk, 'wA')
  await A.mutate((s) => pure.claim(s, holder('A'), { paths: ['src/a/'] }, now), null)
  ok(claimIds(disk).length === 1, '插件先写了 src/a/', show(claimIds(disk)))

  // CLI 的一次整份原子替换（它先读、再改、再写：此刻盘上只剩 CLI 自己的记录）。
  const cliWriter = 'cli-7788'
  const cliDoc = {
    schemaVersion: 1,
    seq: 1,
    writer: cliWriter,
    claims: [{
      claimId: 'c_1@' + cliWriter, holderId: 'cli:user', holderName: 'CLI User', paths: ['src/cli/'],
      mode: 'exclusive', ttlSec: 1800, expiresAt: 9999999999999, createdAt: 1,
      note: '', readable: true, readers: [], seq: 1, writer: cliWriter
    }],
    messages: [],
    holders: [],
    released: {}
  }
  disk.write(TARGET, JSON.stringify(cliDoc))
  ok(claimIds(disk).length === 1 && claimIds(disk)[0] === 'c_1@' + cliWriter,
    '病根复现：CLI 的整份写覆盖了插件的记录（此刻盘上只有 CLI 的）', show(claimIds(disk)))

  // 插件做一次**正常写**：读盘（含 CLI 的记录）∪ 自己的副本 ⇒ 两边都并在盘上。
  const r = await A.mutate((s) => pure.claim(s, holder('A'), { paths: ['src/b/'] }, now), null)
  ok(r.ok === true, '插件的后续写成功', show(r))
  const after = onDisk(disk)
  const writers = new Set(after.claims.map((c) => c.writer))
  ok(after.claims.some((c) => c.writer === cliWriter), 'CLI 的记录被并回来（插件的写没有覆盖它）', show(after.claims.map((c) => [c.claimId, c.writer])))
  ok(writers.has('wA') && writers.has(cliWriter), '最终状态里插件与 CLI 的记录都在', show([...writers]))
}

console.log('# 6b. 负向对照（RED）：插件写路径不合并（整份取自己的副本）⇒ CLI 的记录丢')
{
  const disk = makeDisk()
  const A2 = makeStore(disk, 'wA2', { core: { ...pure, mergeDocs: (a, b) => b } })
  await A2.mutate((s) => pure.claim(s, holder('A2'), { paths: ['src/a/'] }, now), null)
  const cliWriter = 'cli-7788'
  disk.write(TARGET, JSON.stringify({
    schemaVersion: 1, seq: 1, writer: cliWriter,
    claims: [{
      claimId: 'c_1@' + cliWriter, holderId: 'cli:user', holderName: 'CLI User', paths: ['src/cli/'],
      mode: 'exclusive', ttlSec: 1800, expiresAt: 9999999999999, createdAt: 1,
      note: '', readable: true, readers: [], seq: 1, writer: cliWriter
    }],
    messages: [], holders: [], released: {}
  }))
  await A2.mutate((s) => pure.claim(s, holder('A2'), { paths: ['src/b/'] }, now), null)
  const after = onDisk(disk)
  ok(!after.claims.some((c) => c.writer === cliWriter),
    '负向对照（RED）成立：不合并的插件写把 CLI 的记录静默丢掉了', show(after.claims.map((c) => [c.claimId, c.writer])))
}

h.finish()
