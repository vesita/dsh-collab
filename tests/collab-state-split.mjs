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
//   3) 字节预算：与条数上限取先到者、丢最旧、`swept.droppedMessages` 如实报数；
//   4) 两形态同构 + `otherProjects` 不把旁挂文件当成一个项目。
//
// 运行：node tests/collab-state-split.mjs

import { createHarness, readStateMerged, sidecarPathOf } from './_harness.mjs'
import path from 'node:path'
import os from 'node:os'

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

// 5. 默认常量与文档口径一致（防空口说白话）
ok(MAX_MESSAGES === 2000, 'MAX_MESSAGES 仍是 2000', String(MAX_MESSAGES))
ok(MAX_MESSAGES_BYTES === 256 * 1024, 'MAX_MESSAGES_BYTES == 256 KiB', String(MAX_MESSAGES_BYTES))

h.finish()
