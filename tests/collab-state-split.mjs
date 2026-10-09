// tests/collab-state-split.mjs
//
// R2（0.15.0）：状态文件的**磁盘布局** —— 主文件 + 留言旁挂（两形态同构）+ 留言字节预算。
//
// 为什么需要它：`src/store.ts`（包形态）与 `src/host-shell.js`（动态外壳）各有一份 load/mutate，
// 而"留言搬去旁挂"这件事只改一边就会让两个形态对同一个项目读写**不同格式** —— 比不做更糟。
// 所以这里同时驱动两形态，并逐条钉住：
//   1) 迁移：旧布局（主文件里带 messages）跑一次操作后 ⇒ 主文件没有 messages 键、
//      旁挂存在且**一条不漏**、`op=read` 迁移前后返回一致；
//   2) 写放大：锁操作只写主文件（KB 级），**不碰**旁挂 —— 并打印改前/改后的实测字节数；
//   3) 字节预算：与条数上限取先到者、丢最旧、`swept.droppedMessages` 如实报数（两形态都报）；
//   4) 两形态同构 + `otherProjects` 不把旁挂文件当成一个项目；
//   5) 混合版本不丢留言：主文件与旁挂**都有** messages 时按 msgId 求并集（0.15.0 R2 残留修）；
//   6) 损坏备份的保留份数对**旁挂**同样生效（主文件与旁挂各一份命名空间）；
//   7) 两形态等价：同一串操作后磁盘布局与逻辑状态逐个相同（时间戳/进程章/显示名按环境面归一化）。
//
// 运行：node tests/collab-state-split.mjs

import { createHarness, readStateMerged, sidecarPathOf } from './_harness.mjs'
import path from 'node:path'
import os from 'node:os'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'

const cordis = await import('@deepseek-ai/cordis').catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
const { Context } = cordis
import collabPlugin from '../lib/index.js'
import { projectStateFile, collabDir } from '../lib/paths.js'
import { MAX_MESSAGES, MAX_MESSAGES_BYTES, init, sweep } from '../lib/collab-core.js'

// 隔离：状态目录指到临时 DSH_HOME。paths.ts 在**调用时**读 process.env，故 import 后设置也生效。
const FAKE_HOME = path.join(os.tmpdir(), 'dsh-collab-split-' + process.pid)
process.env.DSH_HOME = FAKE_HOME

const h = createHarness()
const { ok } = h

const CWD = '/test/split/alpha'
const STATE = projectStateFile(CWD)
const SIDE = sidecarPathOf(STATE)
const SETTINGS_DOC = path.join(FAKE_HOME, 'settings.yaml')
const A = { agent: { id: 'agent-A' } }

const B = (n) => Buffer.byteLength(n, 'utf8')
const msg = (i, body) => ({ msgId: 'm_' + i, seq: i, channel: 'general', author: 'agent:x', ts: 1000 + i, body: body === undefined ? ('msg-' + i) : body })
const msgsOf = (n, body) => Array.from({ length: n }, (_, k) => msg(k + 1, body))

// ---------- 假 fs（包形态）：记账每次 writeText 的**字节数**与目标路径 ----------
function makeFs (initial) {
  const store = new Map(initial || [])
  const versions = new Map()
  const writes = []
  let v = 0
  return {
    store, versions, writes,
    fs: {
      resolve: async (p) => ({ displayPath: p, path: p }),
      stat: async (t) => (store.has(t.path) ? { version: versions.get(t.path) || 1 } : null),
      readText: async (t) => store.get(t.path) || '',
      writeText: async (t, content, o) => {
        store.set(t.path, content)
        versions.set(t.path, ++v)
        writes.push({ path: t.path, bytes: B(content), kind: (o && o.kind) || null })
        return { operation: 'create', version: v }
      },
      processPath: (t) => t.path,
      listDir: async (d) => {
        const dir = typeof d === 'string' ? d : d.path
        return [...store.keys()]
          .filter((k) => path.dirname(k) === dir)
          .map((k) => ({ name: path.basename(k), type: 'file', target: { displayPath: k, path: k } }))
      }
    }
  }
}

async function bootPackaged (env) {
  const c = new Context()
  for (const n of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle']) c.provide(n)
  const tools = []
  c.set('tools', { register: (t) => { tools.push(t); return () => {} } })
  c.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} })
  c.set('fs', env.fs)
  c.set('sessions', { get: () => ({ header: { cwd: CWD } }) })
  c.set('sessionTitle', { get: () => ({ title: 'Split Worker' }) })
  await c.plugin(collabPlugin)
  return { lock: tools.find((t) => t.name === 'collab_lock'), board: tools.find((t) => t.name === 'collab_board') }
}

// ---------- 假 ctx（动态外壳形态）：fs.resolve 语义与真实一致 ----------
function makeHostHarness (store) {
  const versions = new Map()
  const writes = []
  let v = 0
  const makeTarget = (abs) => {
    const t = { displayPath: abs, path: abs, targetKey: abs }
    const plain = () => ({ displayPath: abs, path: abs, targetKey: abs })
    t.then = (f, r) => Promise.resolve(plain()).then(f, r)
    return t
  }
  const fs = {
    resolve: (p, o) => makeTarget(path.isAbsolute(p) ? p : path.resolve(o && o.cwd ? o.cwd : process.cwd(), p)),
    stat: async (t) => (store.has(t.path) ? { version: versions.get(t.path) || 1, type: 'file' } : undefined),
    readText: async (t) => store.get(t.path) || '',
    writeText: async (t, content, o) => {
      store.set(t.path, content)
      versions.set(t.path, ++v)
      writes.push({ path: t.path, bytes: B(content), kind: (o && o.kind) || null })
      return { operation: 'create', version: v }
    },
    processPath: (t) => t.path,
    listDir: async (d) => {
      const dir = typeof d === 'string' ? d : d.path
      return [...store.keys()]
        .filter((k) => path.dirname(k) === dir)
        .map((k) => ({ name: path.basename(k), type: 'file', target: makeTarget(k) }))
    }
  }
  const tools = []
  const harness = {
    defineTool: (def) => def,
    registerTool: (_ctx, tool) => { tools.push(tool); return () => {} },
    handle: () => () => {}
  }
  const ctx = {
    fs,
    timer: { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: () => () => {},
    get: (name) => {
      if (name === 'settings') return { prepareDocument: async () => SETTINGS_DOC }
      if (name === 'sessions') return { get: () => ({ header: { cwd: CWD } }) }
      if (name === 'sessionTitle') return { get: () => ({ title: 'Host Worker' }) }
      return undefined
    }
  }
  return { fs, writes, tools, harness, ctx }
}

const HOST_CODE = (await import('../lib/collab-plugin.host.js')).hostCode

// ════════════════════════════════════════════════════════════════════════
// 1. 迁移：旧布局（主文件里带 messages）→ 第一次写盘搬进旁挂，一条不丢
// ════════════════════════════════════════════════════════════════════════
console.log('# 1. 迁移：主文件带 messages 的旧布局')
{
  const LEGACY_MSGS = [
    msg(1, '第一条：正常留言'),
    { msgId: 'm_2', seq: 2, channel: 'agent:agent-x', author: 'system:dsh-collab', ts: 1001, body: '第二条：system:dsh-collab 的自动释放审计留痕' },
    msg(3, '第三条：CJK 与 emoji ✅ 一起验证')
  ]
  const legacy = { schemaVersion: 1, seq: 3, claims: [], holders: [], messages: LEGACY_MSGS }
  const env = makeFs([[STATE, JSON.stringify(legacy)]])
  const { lock, board } = await bootPackaged(env)

  const readBefore = await board.execute({ op: 'read', limit: 200 }, A)
  ok(readBefore.ok === true, '迁移前 op=read 成功', JSON.stringify(readBefore))
  const idsBefore = readBefore.data.messages.map((m) => m.msgId)

  const claim = await lock.execute({ op: 'claim', paths: ['src/core/'], ttlSec: 600 }, A)
  ok(claim.ok === true, '旧布局上跑一次 claim 成功（迁移就发生在这一次写盘）', JSON.stringify(claim))

  const mainRaw = env.store.get(STATE)
  const main = JSON.parse(mainRaw)
  ok(!('messages' in main), '迁移后主文件里**没有** messages 键', Object.keys(main).join(','))
  ok(JSON.stringify(Object.keys(main)) === JSON.stringify(['schemaVersion', 'seq', 'claims', 'holders']),
    '主文件恰是 {schemaVersion, seq, claims, holders}', JSON.stringify(Object.keys(main)))
  ok(Array.isArray(main.claims) && main.claims.length === 1, '声明仍在主文件里', JSON.stringify(main.claims.length))

  ok(env.store.has(SIDE), '留言旁挂文件已生成', SIDE)
  const side = JSON.parse(env.store.get(SIDE) || '{}')
  ok(Array.isArray(side.messages) && side.messages.length === LEGACY_MSGS.length,
    '旁挂条数 == 迁移前条数（' + LEGACY_MSGS.length + '）', String(side.messages && side.messages.length))
  ok(JSON.stringify(side.messages) === JSON.stringify(LEGACY_MSGS),
    '旁挂内容与迁移前**逐字节一致**（一条都没丢、没改写）')

  const readAfter = await board.execute({ op: 'read', limit: 200 }, A)
  ok(JSON.stringify(readAfter.data.messages.map((m) => m.msgId)) === JSON.stringify(idsBefore),
    'op=read 迁移前后返回一致', JSON.stringify({ before: idsBefore, after: readAfter.data.messages.map((m) => m.msgId) }))
  ok(JSON.stringify(readAfter.data.messages) === JSON.stringify(LEGACY_MSGS), 'op=read 的内容也逐字节一致')
  ok(JSON.stringify(readStateMerged((p) => env.store.get(p), STATE).messages) === JSON.stringify(LEGACY_MSGS),
    '主文件 + 旁挂合并出来的逻辑状态 == 迁移前')
}

// ════════════════════════════════════════════════════════════════════════
// 2. 写放大：垫大留言（约 240 KB）后跑一次 claim —— 只写主文件，旁挂一个字节都不动
//    （垫到**低于**字节预算：否则 claim 自己会顺手截断留言，那是第 3 条的事，不是这一条）
// ════════════════════════════════════════════════════════════════════════
console.log('# 2. 写放大：一次 claim 的实测写盘字节数')
{
  const PAD_BODY = 'x'.repeat(2000)
  const padMsgs = []
  let padBytes = 0
  for (let i = 1; padBytes < 240 * 1024; i++) {
    const m = msg(i, PAD_BODY)
    padMsgs.push(m)
    padBytes += B(JSON.stringify(m))
  }
  ok(padBytes <= MAX_MESSAGES_BYTES, '留言垫到 ' + padBytes + ' B（< 预算 ' + MAX_MESSAGES_BYTES + ' B），claim 不会触发截断')

  // 稳态：主文件不含 messages，留言在旁挂（就是迁移之后的布局）。
  const env = makeFs([
    [STATE, JSON.stringify({ schemaVersion: 1, seq: padMsgs.length, claims: [], holders: [] })],
    [SIDE, JSON.stringify({ schemaVersion: 1, seq: padMsgs.length, messages: padMsgs })]
  ])
  const { lock } = await bootPackaged(env)

  env.writes.length = 0
  const r = await lock.execute({ op: 'claim', paths: ['src/big/'], ttlSec: 600 }, A)
  ok(r.ok === true, 'claim 成功', JSON.stringify(r))
  const sideWrites = env.writes.filter((w) => w.path === SIDE)
  const mainWrites = env.writes.filter((w) => w.path === STATE)

  ok(sideWrites.length === 0, 'claim **没有**重写旁挂文件（0 次写）', JSON.stringify(sideWrites))
  ok(mainWrites.length === 1, 'claim 只写主文件一次', JSON.stringify(env.writes.map((w) => [path.basename(w.path), w.bytes])))
  ok(mainWrites[0].bytes < 4096, '主文件写入量是 KB 级（' + mainWrites[0].bytes + ' B < 4096）', String(mainWrites[0].bytes))
  ok(env.store.get(SIDE) === JSON.stringify({ schemaVersion: 1, seq: padMsgs.length, messages: padMsgs }),
    '旁挂文件内容逐字节未变')
  ok(readStateMerged((p) => env.store.get(p), STATE).messages.length === padMsgs.length, '逻辑状态里留言仍齐')

  // 改前/改后对照：旧布局把整份状态写在一个文件里，所以"改前"的每次 claim 写入量
  // = 主文件那一半 + 旁挂那一半（= 旧代码 JSON.stringify(整份 state) 的字节数）。
  const beforeLayoutBytes = B(env.store.get(STATE)) + B(env.store.get(SIDE))
  console.log('  实测（留言 ' + padMsgs.length + ' 条 / ' + padBytes + ' B）：')
  console.log('    改前（单文件布局，同一次 claim）= ' + beforeLayoutBytes + ' B')
  console.log('    改后（主文件 + 旁挂）        = ' + mainWrites[0].bytes + ' B + 0 B = ' + mainWrites[0].bytes + ' B')
  console.log('    降幅 = ' + ((1 - mainWrites[0].bytes / beforeLayoutBytes) * 100).toFixed(1) + '%')
}

// ════════════════════════════════════════════════════════════════════════
// 3. 字节预算：与条数上限取先到者、丢最旧、如实报数
// ════════════════════════════════════════════════════════════════════════
console.log('# 3. 硬上限：条数 + 字节（纯函数 sweep）')
{
  const msgs = msgsOf(300, 'y'.repeat(2000))
  const s = init()
  s.seq = 300
  s.messages = msgs
  const budget = 100 * 1024
  const r = sweep(s, Date.now(), { maxMessagesBytes: budget })
  const keptBytes = s.messages.reduce((n, m) => n + B(JSON.stringify(m)), 0)
  ok(s.messages.length < msgs.length, '超预算 ⇒ 确实丢了留言（' + msgs.length + ' → ' + s.messages.length + '）')
  ok(r.droppedMessages === msgs.length - s.messages.length, 'sweep 返回值如实报数', JSON.stringify(r))
  ok(keptBytes <= budget, '留下来的总量守住预算（' + keptBytes + ' ≤ ' + budget + '）')
  ok(s.messages[s.messages.length - 1].msgId === 'm_300', '**最新**的一条还在', s.messages[s.messages.length - 1].msgId)
  ok(s.messages[0].msgId !== 'm_1', '**最旧**的被丢掉', s.messages[0].msgId)
  // 剩多少条必须以字节算得出来（不是靠猜）：+1 条就会超预算。
  const nextBytes = B(JSON.stringify(msgs[msgs.length - s.messages.length - 1]))
  ok(keptBytes + nextBytes > budget, '再留一条就会超预算（边界正好卡住）', String(keptBytes + nextBytes) + ' > ' + budget)

  // 条数上限优先于字节：条数先到就先按条数截（同一个方向）。
  const s2 = init()
  s2.messages = msgsOf(10, 'z')
  const r2 = sweep(s2, Date.now(), { maxMessages: 4, maxMessagesBytes: 1024 * 1024 })
  ok(s2.messages.length === 4 && r2.droppedMessages === 6, '条数上限照旧生效（10 → 4）', JSON.stringify(r2))
}

// 3b. 端到端：默认预算下 `post` 顺手截断，并把 swept 报进返回值
console.log('# 3b. 端到端：默认 MAX_MESSAGES_BYTES 下 post 的截断与报数')
{
  const big = msgsOf(40, 'w'.repeat(8000))          // 40 × ~8.1 KB ≈ 324 KB > 256 KB
  const env = makeFs([
    [STATE, JSON.stringify({ schemaVersion: 1, seq: big.length, claims: [], holders: [] })],
    [SIDE, JSON.stringify({ schemaVersion: 1, seq: big.length, messages: big })]
  ])
  const { board } = await bootPackaged(env)
  const post = await board.execute({ op: 'post', channel: 'general', body: '最新的那条' }, A)
  ok(post.ok === true, 'post 成功', JSON.stringify(post))
  ok(post.data.swept && post.data.swept.droppedMessages > 0,
    'post 的返回值如实带上 swept.droppedMessages', JSON.stringify(post.data.swept))
  const merged = readStateMerged((p) => env.store.get(p), STATE)
  const keptBytes = merged.messages.reduce((n, m) => n + B(JSON.stringify(m)), 0)
  ok(keptBytes <= MAX_MESSAGES_BYTES, '落盘后的留言总量守住默认预算（' + keptBytes + ' ≤ ' + MAX_MESSAGES_BYTES + '）')
  ok(merged.messages[merged.messages.length - 1].body === '最新的那条', '最新那条（本次 post）在')
  ok(merged.messages.every((m) => m.body !== 'w'.repeat(8000)) || merged.messages.filter((m) => m.body === 'w'.repeat(8000)).length < 40,
    '最旧的那批被丢掉')
  const mainKeys = Object.keys(JSON.parse(env.store.get(STATE)))
  ok(!mainKeys.includes('messages'), '截断结果落在旁挂，主文件仍无 messages 键', mainKeys.join(','))
}

// ════════════════════════════════════════════════════════════════════════
// 4. 两形态同构 + otherProjects 不把旁挂当项目
// ════════════════════════════════════════════════════════════════════════
console.log('# 4a. 动态外壳形态写出同构布局')
{
  const LEGACY_MSGS = [msg(1, 'host-1'), msg(2, 'host-2')]
  const store = new Map([[STATE, JSON.stringify({ schemaVersion: 1, seq: 2, claims: [], holders: [], messages: LEGACY_MSGS })]])
  const { writes, tools, harness, ctx } = makeHostHarness(store)
  const factory = new Function('harness', 'ctx', HOST_CODE)
  await factory(harness, ctx).apply(ctx)
  const lock = tools.find((t) => t.name === 'collab_lock')
  const board = tools.find((t) => t.name === 'collab_board')
  ok(!!lock && !!board, 'hostCode 注册出 collab_lock / collab_board')

  const readBefore = await board.execute({ op: 'read', limit: 200 }, A)
  const claim = await lock.execute({ op: 'claim', paths: ['src/host/'], ttlSec: 600 }, A)
  ok(claim.ok === true, '外壳形态 claim 成功', JSON.stringify(claim))
  const main = JSON.parse(store.get(STATE))
  ok(!('messages' in main), '外壳形态：主文件里**没有** messages 键（与包形态同构）', Object.keys(main).join(','))
  ok(JSON.stringify(Object.keys(main)) === JSON.stringify(['schemaVersion', 'seq', 'claims', 'holders']),
    '外壳形态：主文件恰是 {schemaVersion, seq, claims, holders}', JSON.stringify(Object.keys(main)))
  ok(store.has(SIDE), '外壳形态：留言旁挂文件已生成')
  const side = JSON.parse(store.get(SIDE) || '{}')
  ok(JSON.stringify(side.messages) === JSON.stringify(LEGACY_MSGS), '外壳形态：旁挂内容与迁移前逐字节一致')
  const readAfter = await board.execute({ op: 'read', limit: 200 }, A)
  ok(JSON.stringify(readAfter.data.messages) === JSON.stringify(readBefore.data.messages),
    '外壳形态：op=read 迁移前后一致')

  // 稳态下外壳的锁操作也不碰旁挂
  writes.length = 0
  const hb = await lock.execute({ op: 'heartbeat', claimId: claim.data.claim.claimId }, A)
  ok(hb.ok === true, '外壳形态 heartbeat 成功', JSON.stringify(hb))
  ok(writes.filter((w) => w.path === SIDE).length === 0, '外壳形态：锁操作（heartbeat）不重写旁挂', JSON.stringify(writes.map((w) => path.basename(w.path))))
}

console.log('# 4b. otherProjects 不把 *.messages.json 当成一个项目')
{
  const OTHER = path.join(collabDir(), 'otherproj-deadbeef0000.json')
  const OTHER_SIDE = sidecarPathOf(OTHER)
  const t = Date.now()
  const env = makeFs([
    [STATE, JSON.stringify({ schemaVersion: 1, seq: 0, claims: [], holders: [] })],
    [OTHER, JSON.stringify({
      schemaVersion: 1, seq: 5, holders: [],
      claims: [{ claimId: 'c_other', holderId: 'agent:other', holderName: 'Other', paths: ['src/x/'], mode: 'exclusive', ttlSec: 600, expiresAt: t + 600000, createdAt: t, readable: true, readers: [] }]
    })],
    [OTHER_SIDE, JSON.stringify({ schemaVersion: 1, seq: 5, messages: msgsOf(3) })]
  ])
  const { lock } = await bootPackaged(env)
  const ov = await lock.execute({ op: 'overview' }, A)
  ok(ov.ok === true, 'overview 成功', JSON.stringify(ov).slice(0, 200))
  const others = ov.data.otherProjects || []
  ok(others.length === 1, '旁挂文件没有被当成第二个项目（otherProjects 长度 1）', JSON.stringify(others.map((o) => o.file)))
  ok(others.length === 1 && others[0].file === path.basename(OTHER), '列出的正是那个真项目文件', JSON.stringify(others.map((o) => o.file)))
  ok(others.every((o) => !o.file.endsWith('.messages.json')), '没有任何一条是 *.messages.json')

  // 负向对照：把旁挂也伪装成"有活跃声明"，确认排除靠的是**文件名判据**而不是"它恰好没有声明"。
  const env2 = makeFs([
    [STATE, JSON.stringify({ schemaVersion: 1, seq: 0, claims: [], holders: [] })],
    [STATE.replace(/\.json$/, '.messages.json'), JSON.stringify({
      schemaVersion: 1, seq: 5, messages: [],
      claims: [{ claimId: 'c_trap', holderId: 'agent:trap', holderName: 'Trap', paths: ['src/y/'], mode: 'exclusive', ttlSec: 600, expiresAt: t + 600000, createdAt: t, readable: true, readers: [] }]
    })]
  ])
  const { lock: lock2 } = await bootPackaged(env2)
  const ov2 = await lock2.execute({ op: 'overview' }, A)
  ok((ov2.data.otherProjects || []).length === 0,
    '旁挂文件里就算塞了活跃声明也不出现在 otherProjects（排除是文件名判据）',
    JSON.stringify((ov2.data.otherProjects || []).map((o) => o.file)))
}

// ════════════════════════════════════════════════════════════════════════
// 4c. 加载期留言**并集**（0.15.0 R2 残留修）：主文件与旁挂交替写也不丢
//     旧行为"以主文件为准"会在下次写盘时把旁挂那份整批覆盖掉 —— 这一节的断言各自能独立失败。
// ════════════════════════════════════════════════════════════════════════
console.log('# 4c. 混合版本：主文件 [m1,m2] + 旁挂 [m2,m3] ⇒ 并集 [m1,m2,m3]')
{
  const m = (i, body) => ({ msgId: 'm_' + i, seq: i, channel: 'general', author: 'agent:x', ts: 1000 + i, body: body })
  const mainDoc = { schemaVersion: 1, seq: 3, claims: [], holders: [], messages: [m(1, 'main-1'), m(2, 'main-2')] }
  const sideDoc = { schemaVersion: 1, seq: 3, messages: [m(2, 'side-2'), m(3, 'side-3')] }
  const env = makeFs([[STATE, JSON.stringify(mainDoc)], [SIDE, JSON.stringify(sideDoc)]])
  const { lock, board } = await bootPackaged(env)

  const before = await board.execute({ op: 'read', limit: 200 }, A)
  const idsBefore = before.data.messages.map((x) => x.msgId)
  ok(JSON.stringify(idsBefore) === JSON.stringify(['m_1', 'm_2', 'm_3']),
    '两边的留言按 msgId 求并集、按 seq 升序（不是"主文件说了算"）', JSON.stringify(idsBefore))
  const dup = before.data.messages.find((x) => x.msgId === 'm_2')
  ok(dup && dup.body === 'main-2',
    '同 msgId 以主文件那一份为准（内容应逐字节相同，这里只钉住确定的取值）',
    JSON.stringify(before.data.messages.map((x) => x.body)))

  const claim = await lock.execute({ op: 'claim', paths: ['src/union/'], ttlSec: 600 }, A)
  ok(claim.ok === true, '混合布局上跑一次写操作成功（迁移就发生在这一次写盘）', JSON.stringify(claim))
  const mainAfter = JSON.parse(env.store.get(STATE))
  ok(!('messages' in mainAfter), '迁移后主文件里没有 messages 键', Object.keys(mainAfter).join(','))
  const sideAfter = JSON.parse(env.store.get(SIDE) || '{}')
  ok(JSON.stringify((sideAfter.messages || []).map((x) => x.msgId)) === JSON.stringify(['m_1', 'm_2', 'm_3']),
    '迁移把**并集**完整搬进旁挂（旧行为会在这里丢掉旁挂那份 m_3）',
    JSON.stringify((sideAfter.messages || []).map((x) => x.msgId)))
  const after = await board.execute({ op: 'read', limit: 200 }, A)
  ok(JSON.stringify(after.data.messages.map((x) => x.msgId)) === JSON.stringify(idsBefore),
    '迁移后 op=read 与迁移前一致（一条都没丢）', JSON.stringify(after.data.messages.map((x) => x.msgId)))
}

// ════════════════════════════════════════════════════════════════════════
// 4d. 旁挂的损坏备份也纳入保留份数（主文件与旁挂各一份命名空间，同一规则）
// ════════════════════════════════════════════════════════════════════════
console.log('# 4d. 损坏备份保留最近 3 份（主文件 + 旁挂）')
{
  // 真的在状态目录里造文件：prune 的删除原语是 node:fs 的 rm，只认绝对路径。
  const REAL_DIR = collabDir()
  mkdirSync(REAL_DIR, { recursive: true })
  const mainName = path.basename(STATE)
  const sideName = path.basename(SIDE)
  const stamps = [1000, 2000, 3000, 4000, 5000]
  const realPath = (name, s) => path.join(REAL_DIR, name + '.corrupt-' + s)
  for (const s of stamps) {
    writeFileSync(realPath(mainName, s), 'x')
    writeFileSync(realPath(sideName, s), 'x')
  }
  const foreign = path.join(REAL_DIR, 'someone-else.json.corrupt-9999')
  writeFileSync(foreign, 'x')

  const listDirReal = async () => readdirSync(REAL_DIR)
    .map((n) => ({ name: n, type: 'file', target: { displayPath: path.join(REAL_DIR, n), path: path.join(REAL_DIR, n) } }))
  const store = new Map([[STATE, 'not-json{{{'], [SIDE, 'not-json{{{']])
  const versions = new Map()
  let v = 0
  const fsImpl = {
    resolve: async (p) => ({ displayPath: p, path: p }),
    stat: async (t) => (store.has(t.path) ? { version: versions.get(t.path) || 1 } : null),
    readText: async (t) => store.get(t.path) || '',
    writeText: async (t, c) => { store.set(t.path, c); versions.set(t.path, ++v); return { operation: 'create', version: v } },
    processPath: (t) => t.path,
    listDir: listDirReal
  }
  const { lock } = await bootPackaged({ fs: fsImpl })
  const r = await lock.execute({ op: 'list' }, A)
  ok(r.ok === true, '损坏主文件 + 损坏旁挂上跑一次 list 成功（自愈而非砖化）',
    JSON.stringify(r.data && r.data.warning))
  const kept = (name) => stamps.filter((s) => existsSync(realPath(name, s)))
  ok(JSON.stringify(kept(mainName)) === JSON.stringify([3000, 4000, 5000]),
    '主文件的 .corrupt-* 只保留最近 3 份', JSON.stringify(kept(mainName)))
  ok(JSON.stringify(kept(sideName)) === JSON.stringify([3000, 4000, 5000]),
    '旁挂的 .corrupt-* 也只保留最近 3 份（旧行为一份都不清）', JSON.stringify(kept(sideName)))
  ok(existsSync(foreign), '不符合自己命名规则的备份一个都不动（someone-else.json.corrupt-9999）')
}

// ════════════════════════════════════════════════════════════════════════
// 4e. 外壳形态也报 swept（留言被字节预算截断时，"截断发生了"必须可见）
// ════════════════════════════════════════════════════════════════════════
console.log('# 4e. 外壳形态：截断在返回值里可见（swept）')
{
  const big = msgsOf(40, 'w'.repeat(8000))
  const store = new Map([
    [STATE, JSON.stringify({ schemaVersion: 1, seq: big.length, claims: [], holders: [] })],
    [SIDE, JSON.stringify({ schemaVersion: 1, seq: big.length, messages: big })]
  ])
  const { tools, harness, ctx } = makeHostHarness(store)
  await new Function('harness', 'ctx', HOST_CODE)(harness, ctx).apply(ctx)
  const board = tools.find((t) => t.name === 'collab_board')
  const post = await board.execute({ op: 'post', channel: 'general', body: '外壳最新一条' }, A)
  ok(post.ok === true, '外壳形态 post 成功', JSON.stringify(post).slice(0, 120))
  ok(post.data && post.data.swept && post.data.swept.droppedMessages > 0,
    '外壳形态的返回值如实带上 swept.droppedMessages（旧行为一个字都不报）',
    JSON.stringify(post.data && post.data.swept))
  const merged = readStateMerged((p) => store.get(p), STATE)
  ok(merged.messages.length < big.length, '最旧的那批确实被丢掉（' + big.length + ' → ' + merged.messages.length + '）')
  ok(merged.messages[merged.messages.length - 1].body === '外壳最新一条', '最新那条（本次 post）在')
}

// ════════════════════════════════════════════════════════════════════════
// 4f. 两形态等价：同一串操作（claim → post → release → list）后，磁盘布局与逻辑状态一致
// ════════════════════════════════════════════════════════════════════════
console.log('# 4f. 两形态等价（claim → post → release → list）')
{
  const readMergedOf = (map) => () => readStateMerged((p) => map.get(p), STATE)
  const seqOps = async (lock, board, readState) => {
    const claim = await lock.execute({ op: 'claim', paths: ['src/eq/'], mode: 'exclusive', ttlSec: 600, note: 'eq' }, A)
    const claimId = claim.data && claim.data.claim && claim.data.claim.claimId
    const afterClaim = readState()
    const post = await board.execute({ op: 'post', channel: 'general', body: '等价性检查' }, A)
    const afterPost = readState()
    const rel = await lock.execute({ op: 'release', claimId: claimId }, A)
    const list = await lock.execute({ op: 'list' }, A)
    return { claim, claimId, post, rel, list, afterClaim, afterPost }
  }

  const pEnv = makeFs([])
  const { lock: pLock, board: pBoard } = await bootPackaged(pEnv)
  const pRun = await seqOps(pLock, pBoard, readMergedOf(pEnv.store))
  ok(pRun.claim.ok === true && pRun.post.ok === true && pRun.rel.ok === true && pRun.list.ok === true,
    '包形态：claim → post → release → list 全部成功',
    JSON.stringify([pRun.claim.ok, pRun.post.ok, pRun.rel.ok, pRun.list.ok]))

  const hStore = new Map()
  const hHarnessPack = makeHostHarness(hStore)
  await new Function('harness', 'ctx', HOST_CODE)(hHarnessPack.harness, hHarnessPack.ctx).apply(hHarnessPack.ctx)
  const hLock = hHarnessPack.tools.find((t) => t.name === 'collab_lock')
  const hBoard = hHarnessPack.tools.find((t) => t.name === 'collab_board')
  const hRun = await seqOps(hLock, hBoard, readMergedOf(hStore))
  ok(hRun.claim.ok === true && hRun.post.ok === true && hRun.rel.ok === true && hRun.list.ok === true,
    '外壳形态：claim → post → release → list 全部成功',
    JSON.stringify([hRun.claim.ok, hRun.post.ok, hRun.rel.ok, hRun.list.ok]))

  // ---- 磁盘布局一致 ----
  const pKeys = Object.keys(JSON.parse(pEnv.store.get(STATE)))
  const hKeys = Object.keys(JSON.parse(hStore.get(STATE)))
  ok(JSON.stringify(pKeys) === JSON.stringify(['schemaVersion', 'seq', 'claims', 'holders']),
    '包形态主文件键集合恰是 {schemaVersion, seq, claims, holders}', JSON.stringify(pKeys))
  ok(JSON.stringify(hKeys) === JSON.stringify(pKeys),
    '外壳形态主文件键集合与包形态逐个相同', JSON.stringify({ pkg: pKeys, host: hKeys }))
  ok(!pKeys.includes('messages') && !hKeys.includes('messages'), '两形态的主文件都不含 messages')
  const pSide = JSON.parse(pEnv.store.get(SIDE) || '{}')
  const hSide = JSON.parse(hStore.get(SIDE) || '{}')
  ok(pEnv.store.has(SIDE) && hStore.has(SIDE), '两形态都生成了留言旁挂文件')
  ok((pSide.messages || []).length === (hSide.messages || []).length,
    '两形态旁挂的留言条数相同', JSON.stringify({ pkg: (pSide.messages || []).length, host: (hSide.messages || []).length }))
  ok((pSide.messages || []).length === 1, '旁挂里就是本次 post 的那一条', String((pSide.messages || []).length))

  // ---- 逻辑状态一致（时间戳、进程章与显示名按环境面归一化：它们本来就是注入的差异） ----
  const norm = (doc) => ({
    schemaVersion: doc.schemaVersion,
    seq: doc.seq,
    claims: (doc.claims || []).map((c) => ({
      claimId: c.claimId, holderId: c.holderId, paths: c.paths, mode: c.mode, ttlSec: c.ttlSec,
      readable: c.readable, createdAtType: typeof c.createdAt, expiresAtType: typeof c.expiresAt
    })),
    messages: (doc.messages || []).map((x) => ({ msgId: x.msgId, seq: x.seq, channel: x.channel, author: x.author, body: x.body, replyTo: x.replyTo || null })),
    holders: (doc.holders || []).map((x) => x.holderId).sort()
  })
  const pMid = norm(pRun.afterPost)
  const hMid = norm(hRun.afterPost)
  ok(pMid.claims.length === 1 && hMid.claims.length === 1,
    'post 之后两形态都持有同一条声明（比较的是非空状态，不是空集合的假相等）',
    JSON.stringify({ pkg: pMid.claims.length, host: hMid.claims.length }))
  ok(JSON.stringify(pMid) === JSON.stringify(hMid),
    '两形态的逻辑状态一致（claim+post 后的声明/留言/名册）',
    'pkg=' + JSON.stringify(pMid) + ' host=' + JSON.stringify(hMid))
  const pEnd = norm(readMergedOf(pEnv.store)())
  const hEnd = norm(readMergedOf(hStore)())
  ok(JSON.stringify(pEnd) === JSON.stringify(hEnd),
    'release + list 之后两形态的逻辑状态仍一致', 'pkg=' + JSON.stringify(pEnd) + ' host=' + JSON.stringify(hEnd))

  // 名册行的**唯一**环境差异：包形态盖进程章（proc），外壳形态给不出（受限宿主无进程身份）。
  const pHolder = readMergedOf(pEnv.store)().holders[0]
  const hHolder = readMergedOf(hStore)().holders[0]
  const stripEnv = (row) => { const o = {}; for (const k of Object.keys(row)) if (k !== 'proc' && k !== 'lastSeenAt' && k !== 'name') o[k] = row[k]; return o }
  ok(JSON.stringify(stripEnv(pHolder)) === JSON.stringify(stripEnv(hHolder)),
    '名册行除 proc / lastSeenAt / name 外逐字段相同',
    JSON.stringify({ pkg: stripEnv(pHolder), host: stripEnv(hHolder) }))
  ok(pRun.claim.data.claim.holderName === 'Split Worker' && hRun.claim.data.claim.holderName === 'Host Worker',
    '两形态的 holderName 各来自自己的 sessionTitle 服务（环境面，不参与上面的等价断言）',
    JSON.stringify([pRun.claim.data.claim.holderName, hRun.claim.data.claim.holderName]))
  ok(pRun.list.data.claims.length === hRun.list.data.claims.length &&
    pRun.list.data.holdersTotal === hRun.list.data.holdersTotal &&
    pRun.list.data.seq === hRun.list.data.seq,
    'list 视图的 claims 条数 / holdersTotal / seq 一致',
    JSON.stringify({
      pkg: [pRun.list.data.claims.length, pRun.list.data.holdersTotal, pRun.list.data.seq],
      host: [hRun.list.data.claims.length, hRun.list.data.holdersTotal, hRun.list.data.seq]
    }))
}

// 5. 默认常量与文档口径一致（防空口说白话）
ok(MAX_MESSAGES === 2000, 'MAX_MESSAGES 仍是 2000', String(MAX_MESSAGES))
ok(MAX_MESSAGES_BYTES === 256 * 1024, 'MAX_MESSAGES_BYTES == 256 KiB', String(MAX_MESSAGES_BYTES))

h.finish()
