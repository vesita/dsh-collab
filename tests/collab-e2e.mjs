#!/usr/bin/env node
/**
 * tests/collab-e2e.mjs — dsh-collab 状态目录路径 bug 的**端到端回归 harness**
 *
 * 目标契约（修复后）：状态目录 = ${DSH_HOME:-$HOME/.dsh}/collab/projects 的**绝对路径**。
 *   - 包形态  : src/index.ts -> lib/index.js（可用 node:os / process.env）
 *   - 动态宿主: lib/collab-plugin.host.js 的 hostCode（用 ctx.get('settings').prepareDocument()）
 *
 * 运行：node tests/collab-e2e.mjs            （可在任意 cwd 下运行）
 * 退出码：0 = 全部通过；1 = 有 FAIL。
 *
 * ── 探针同构性说明（关键）────────────────────────────────────────────────
 * 1) fs.resolve 精确复刻实测语义：
 *      以 '/' 开头            -> 绝对，原样
 *      否则                  -> path.resolve(opts?.cwd ?? process.cwd(), p)
 *      **绝不展开 '~'**（'~/.dsh/...' -> '<cwd>/~/.dsh/...'）
 * 2) 真实 FileSystem.resolve 的 d.ts 声明为 Promise<FsTarget>（见
 *    @deepseek-ai/dsh-fs/lib/types/index.d.ts），而 hostCode 形态历史上不 await 它。
 *    因此本 harness 的 resolve 返回一个 **thenable FileRef**：await 与同步取用都能工作，
 *    两种形态都能被同一套断言测到。
 * 3) 所有 stat/readText/writeText/processPath 都真实落在 mkdtemp 出来的磁盘临时目录上；
 *    writeText 支持 { kind:'createIfAbsent' } 与 { kind:'replaceIfVersion', version }，
 *    后者版本不匹配时抛 FS_STALE_VERSION（src/index.ts 的 mutate() 依赖它做乐观并发）。
 *
 * ── 隔离 ────────────────────────────────────────────────────────────────
 * 在 mkdtemp 临时根里设置 process.env.DSH_HOME / HOME 之后，才动态 import ../lib/index.js。
 * 不写 src/、不写 lib/、不跑 tsc。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { skippedOrRejected } from './_harness.mjs'

// ════════════════════════════════════════════════════════════════════════
// 0. 隔离环境
// ════════════════════════════════════════════════════════════════════════
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-e2e-'))
const DSH_HOME = path.join(TMP_ROOT, 'dshhome')
const FAKE_HOME = path.join(TMP_ROOT, 'fakehome')
fs.mkdirSync(DSH_HOME, { recursive: true })
fs.mkdirSync(FAKE_HOME, { recursive: true })
process.env.DSH_HOME = DSH_HOME
process.env.HOME = FAKE_HOME
// ⑪ 测试自己建的临时目录，测试自己清理（退出时）。只有失败路径保留**这一个**现场供排障。
let KEEP_SITE = true
process.on('exit', () => {
  if (KEEP_SITE) return
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) } catch { /* 清理失败不该掩盖测试结果 */ }
})
const START_CWD = process.cwd()
const EXPECTED_DIR = path.join(DSH_HOME, 'collab', 'projects')

// ════════════════════════════════════════════════════════════════════════
// 1. 真实落盘的 fake fs 服务（node:fs 后端）
// ════════════════════════════════════════════════════════════════════════
const fsVersions = new Map() // abs path -> version（模拟 DSH fs 的不透明版本号）
const versionOf = (p) => {
  let v = fsVersions.get(p)
  if (v === undefined) { v = 1; fsVersions.set(p, v) }
  return v
}
// 真实 ctx.fs（dsh-fs-local）抛 FsError：code 是**独立字段**，message 里不含 code。
// 这里必须逐字复制真实 message 与 code，否则被测的重试判据只会被"测试自造的错误串"喂饱 ——
// 那正是 P1：fake 编了 'FS_STALE_VERSION: …' 这种真实后端从不产生的文案，于是重试分支只活在测试里。
const fsError = (code, message) => {
  const e = new Error(message)
  e.code = code
  e.name = 'FsError'
  return e
}
const staleError = (p) => fsError('FS_STALE_VERSION', `cannot write "${p}": file changed since it was read`)
const notObservedError = (p) => fsError('FS_NOT_OBSERVED', `cannot overwrite existing "${p}" without reading it first`)

/** 同时可被 `await` 与同步取用的 FileRef。 */
function makeTarget(absPath, displayPath) {
  const plain = { displayPath, path: absPath }
  return {
    displayPath,
    path: absPath,
    then(onFulfilled, onRejected) { return Promise.resolve(plain).then(onFulfilled, onRejected) },
    catch(onRejected) { return Promise.resolve(plain).catch(onRejected) },
    finally(fn) { return Promise.resolve(plain).finally(fn) },
  }
}

const fsService = {
  // 真实语义复刻：'/' 开头原样；否则以 opts.cwd（缺省 process.cwd()）为基址；'~' 永不展开。
  resolve(p, opts) {
    const base = opts && typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : process.cwd()
    const raw = String(p)
    const abs = raw.startsWith('/') ? raw : path.resolve(base, raw)
    return makeTarget(abs, raw)
  },
  async stat(target) {
    const p = target && target.path
    if (typeof p !== 'string') return null
    try {
      if (!fs.statSync(p).isFile()) return null
    } catch { return null }
    return { version: versionOf(p) }
  },
  async readText(target) {
    return fs.readFileSync(target.path, 'utf8')
  },
  async writeText(target, content, opts) {
    const p = target.path
    const intent = (opts && opts.kind) || 'replace'
    let exists = false
    try { exists = fs.statSync(p).isFile() } catch { exists = false }
    if (intent === 'createIfAbsent') {
      if (fs.existsSync(p)) throw notObservedError(p)
    } else if (intent === 'replaceIfVersion') {
      if (!exists) throw staleError(p)
      const cur = versionOf(p)
      if (Number(opts.version) !== cur) {
        throw staleError(p)
      }
    }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content, 'utf8')
    if (exists) fsVersions.set(p, versionOf(p) + 1); else fsVersions.set(p, 1)
    return { version: versionOf(p) }
  },
  processPath(target) { return target.path },
}

// ════════════════════════════════════════════════════════════════════════
// 2. Cordis Context 骨架（照抄 tests/collab-integration.mjs 的 import 回退写法）
// ════════════════════════════════════════════════════════════════════════
const cordis = await import('@deepseek-ai/cordis')
  .catch(() => import(new URL('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js', import.meta.url)))
const { Context } = cordis

/** 造一个会话 cwd 固定、fs 真实落盘的 ctx；返回注册到的工具数组。 */
function makeCtx(sessionCwd, tools) {
  const ctx = new Context()
  for (const name of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'settings']) ctx.provide(name)
  ctx.set('tools', { register: (t) => tools.push(t) })
  ctx.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)) })
  ctx.set('fs', fsService)
  ctx.set('sessions', { get: (_id) => ({ header: { cwd: sessionCwd } }) })
  ctx.set('sessionTitle', { get: (_s) => ({ title: 'E2E Worker' }) })
  // 真实 dsh-settings-file 的 prepareDocument(): Promise<string>（d.ts:67），固定返回 <DSH_HOME>/settings.yaml
  ctx.set('settings', { prepareDocument: async () => path.join(DSH_HOME, 'settings.yaml') })
  return ctx
}

// ════════════════════════════════════════════════════════════════════════
// 3. 断言 / 结果收集框架
// ════════════════════════════════════════════════════════════════════════
class CheckFail extends Error {}
class KnownUnimplemented extends Error {}
/** 用例前置条件不满足（例如构建产物缺失）。**不是**静默通过：默认按 FAIL 记。 */
class Skipped extends Error {}

function expect(cond, msg, detail) {
  if (!cond) throw new CheckFail(msg + (detail ? '\n      ↳ ' + detail : ''))
}
const hasTildeSegment = (p) => /(^|[\\/])~([\\/]|$)/.test(String(p))
const TILDE_MSG = "statePath 含 '~' 路径段（~ 未展开的 bug 落点）"

const records = []
function printRecord(r) {
  const tag = r.status === 'PASS' ? 'PASS'
    : r.status === 'KNOWN' ? 'KNOWN-UNIMPLEMENTED'
      : r.status === 'SKIP' ? 'SKIPPED-UNVERIFIED'
        : 'FAIL'
  console.log(`[${r.id}] ${tag}  ${r.title}`)
  for (const n of r.notes) console.log('      · ' + n)
  if (r.err) console.log('      ✗ ' + String(r.err.message || r.err).split('\n').join('\n      '))
  if (r.known) console.log('      ! ' + r.known)
}
async function runTest(id, title, fn) {
  const notes = []
  let status = 'PASS', err = null, known = null
  try { await fn(notes) }
  catch (e) {
    if (e instanceof KnownUnimplemented) { status = 'KNOWN'; known = e.message }
    else if (e instanceof Skipped) {
      // ⑷ 跳过默认是**失败**：旧代码 `return` 会把"没测"记成 PASS。
      // 只有 COLLAB_ALLOW_SKIP=1 显式放行才记 SKIP（skippedOrRejected 会打"未验证"横幅）。
      if (skippedOrRejected('[' + id + '] ' + title + '：' + e.message)) { status = 'SKIP'; known = e.message }
      else { status = 'FAIL'; err = new Error('该用例未执行（未验证即失败）：' + e.message) }
    }
    else { status = 'FAIL'; err = e }
  }
  const rec = { id, title, status, notes, err, known }
  records.push(rec)
  printRecord(rec)
  console.log('')
  return rec
}

// ════════════════════════════════════════════════════════════════════════
// 4. 加载被测产物（必须在 env 设置之后）
// ════════════════════════════════════════════════════════════════════════
console.log('══ dsh-collab E2E harness ══')
console.log('tmpRoot       = ' + TMP_ROOT)
console.log('DSH_HOME      = ' + DSH_HOME)
console.log('HOME          = ' + FAKE_HOME)
console.log('启动 cwd       = ' + START_CWD)
console.log('期望状态目录    = ' + EXPECTED_DIR)
console.log('node          = ' + process.version)
console.log('')

let collabPlugin
try {
  const mod = await import(new URL('../lib/index.js', import.meta.url))
  collabPlugin = mod.default || mod
  const st = fs.statSync(new URL('../lib/index.js', import.meta.url))
  console.log('lib/index.js  = 已加载 (mtime ' + st.mtime.toISOString() + ', ' + st.size + ' bytes)')
} catch (e) {
  console.error('FATAL: 无法 import ../lib/index.js —— ' + String(e && e.stack || e))
  process.exit(1)
}
let projectStorageFileName = (cwd) => String(cwd || 'default').replace(/[^a-zA-Z0-9_-]/g, '_') + '.json'
try {
  const core = await import(new URL('../lib/collab-core.js', import.meta.url))
  if (typeof core.projectStorageFileName === 'function') projectStorageFileName = core.projectStorageFileName
} catch (e) {
  console.log('NOTE: lib/collab-core.js 不可用，文件名哈希回退到占位实现')
}

/** 新起一个插件实例（独立 ctx），返回 { ctx, tools, lock }。 */
async function newInstance(sessionCwd) {
  const tools = []
  const ctx = makeCtx(sessionCwd, tools)
  await ctx.plugin(collabPlugin)
  const lock = tools.find((t) => t.name === 'collab_lock')
  expect(!!lock, 'ctx.tools.register 未注册 collab_lock', '已注册: ' + JSON.stringify(tools.map((t) => t.name)))
  return { ctx, tools, lock, board: tools.find((t) => t.name === 'collab_board') }
}
const callLock = (lock, args, agentId) => lock.execute(args, { agent: { id: agentId } })

/** 跑一次 list，抽出 statePath（没有则用 stateDir）。 */
async function statePathOf(lock, agentId, op = 'list', extra = {}) {
  const res = await callLock(lock, Object.assign({ op }, extra), agentId)
  if (!res || res.ok !== true) {
    throw new CheckFail(`collab_lock ${op} 未成功`, '返回 = ' + JSON.stringify(res))
  }
  const sp = res.data && (res.data.statePath || res.data.stateDir)
  if (typeof sp !== 'string' || !sp) {
    throw new CheckFail(`list 返回里没有 statePath/stateDir`, 'data = ' + JSON.stringify(res.data))
  }
  return { sp, res }
}

const shared = {} // T5 -> T7 之间传递

// ════════════════════════════════════════════════════════════════════════
// 5. 用例
// ════════════════════════════════════════════════════════════════════════
await runTest('T1', 'statePath 是绝对路径、不含 ~、且不依赖进程 cwd', async (notes) => {
  const { lock } = await newInstance(path.join(TMP_ROOT, 'proj-main'))
  const { sp } = await statePathOf(lock, 'agent-t1')
  notes.push('statePath = ' + sp)
  expect(path.isAbsolute(sp), 'statePath 不是绝对路径', 'actual = ' + sp)
  expect(!hasTildeSegment(sp), TILDE_MSG, 'actual = ' + sp)
  const cwdCandidate = path.join(START_CWD, '.dsh', 'collab', 'projects')
  expect(!sp.startsWith(cwdCandidate + path.sep),
    'statePath 落在 <进程 cwd>/.dsh/collab/projects 下（旧 bug：跨 cwd 各写各的）',
    `actual = ${sp}\n      cwd 落点 = ${cwdCandidate}`)
  notes.push('cwd 落点对比 = ' + cwdCandidate + '（不应命中）')
})

await runTest('T2', 'DSH_HOME 生效：statePath 以 <tmp>/dshhome/collab/projects/ 开头', async (notes) => {
  const { lock } = await newInstance(path.join(TMP_ROOT, 'proj-main'))
  const { sp } = await statePathOf(lock, 'agent-t2')
  notes.push('statePath = ' + sp)
  notes.push('期望前缀   = ' + EXPECTED_DIR + path.sep)
  expect(sp.startsWith(EXPECTED_DIR + path.sep),
    'statePath 不在 DSH_HOME/collab/projects 下', `expected prefix = ${EXPECTED_DIR}${path.sep}\n      actual = ${sp}`)
})

await runTest('T3', 'cwd 无关性：两个不同进程 cwd 下算出的 statePath 必须完全相同', async (notes) => {
  const dirA = path.join(TMP_ROOT, 'cwd-a')
  const dirB = path.join(TMP_ROOT, 'cwd-b')
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })
  const { lock } = await newInstance(path.join(TMP_ROOT, 'proj-cwd'))
  let a, b
  try {
    process.chdir(dirA)
    a = (await statePathOf(lock, 'agent-t3')).sp
    process.chdir(dirB)
    b = (await statePathOf(lock, 'agent-t3')).sp
  } finally {
    process.chdir(START_CWD)
  }
  notes.push(`cwd=${dirA} -> ${a}`)
  notes.push(`cwd=${dirB} -> ${b}`)
  expect(a === b, '两个不同进程 cwd 下的 statePath 不相同（这正是原 bug 的判别点）',
    `cwdA -> ${a}\n      cwdB -> ${b}`)
})

await runTest('T4', '项目隔离：projA / projB 得到不同状态文件名，且哈希稳定', async (notes) => {
  const cwdA = path.join(TMP_ROOT, 'projA')
  const cwdB = path.join(TMP_ROOT, 'projB')
  const a1 = (await statePathOf((await newInstance(cwdA)).lock, 'agent-t4a')).sp
  const b1 = (await statePathOf((await newInstance(cwdB)).lock, 'agent-t4b')).sp
  const a2 = (await statePathOf((await newInstance(cwdA)).lock, 'agent-t4a')).sp
  notes.push('projA = ' + a1)
  notes.push('projB = ' + b1)
  notes.push('projA 二次 = ' + a2)
  expect(a1 !== b1, 'projA 与 projB 解析到同一个状态文件（项目隔离失效）', `A = ${a1}\n      B = ${b1}`)
  expect(path.basename(a1) !== path.basename(b1), '两个项目状态文件名相同（哈希未区分项目）',
    `A = ${path.basename(a1)}\n      B = ${path.basename(b1)}`)
  expect(a1 === a2, '同一 cwd 两次解析结果不稳定（哈希不稳定）', `first = ${a1}\n      second = ${a2}`)
})

await runTest('T5', '跨会话共享：同 cwd 两个 agent 共享状态；重叠路径 claim 得 conflict', async (notes) => {
  const cwd = path.join(TMP_ROOT, 'proj-shared')
  const { lock } = await newInstance(cwd)
  const c1 = await callLock(lock, { op: 'claim', paths: ['src/core/'], ttlSec: 300, note: 'e2e-T5' }, 'agent-1')
  expect(c1 && c1.ok === true, 'agent-1 的 claim 失败', '返回 = ' + JSON.stringify(c1))
  notes.push('agent-1 claimId = ' + (c1.data && c1.data.claim && c1.data.claim.claimId))

  const l2 = await callLock(lock, { op: 'list' }, 'agent-2')
  expect(l2 && l2.ok === true, 'agent-2 的 list 失败', '返回 = ' + JSON.stringify(l2))
  const seen = (l2.data.claims || []).some((c) => (c.paths || []).includes('src/core/'))
  notes.push('agent-2 看到的 claims = ' + JSON.stringify((l2.data.claims || []).map((c) => c.paths)))
  expect(seen, '会话 2 看不到会话 1 的 claim（跨会话可见性失效）',
    'claims = ' + JSON.stringify(l2.data.claims))

  const c2 = await callLock(lock, { op: 'claim', paths: ['src/core/module.ts'] }, 'agent-2')
  notes.push('agent-2 重叠 claim 返回 = ' + JSON.stringify({ ok: c2.ok, error: c2.error }))
  expect(c2 && c2.ok === false && c2.error === 'conflict',
    '重叠路径 claim 未返回 conflict', '返回 = ' + JSON.stringify(c2))

  shared.t5 = { cwd, statePath: l2.data.statePath || l2.data.stateDir, claimId: c1.data && c1.data.claim && c1.data.claim.claimId }
})

await runTest('T6', '读观测者不被挡：读模式 claim 成功；shared 仍 conflict', async (notes) => {
  const cwd = path.join(TMP_ROOT, 'proj-read')
  const { lock } = await newInstance(cwd)
  const c1 = await callLock(lock, { op: 'claim', paths: ['src/alpha/'], mode: 'exclusive', ttlSec: 300 }, 'agent-1')
  expect(c1 && c1.ok === true, 'agent-1 exclusive claim 失败', '返回 = ' + JSON.stringify(c1))

  const sh = await callLock(lock, { op: 'claim', paths: ['src/alpha/x.ts'], mode: 'shared' }, 'agent-2')
  notes.push('agent-2 shared 重叠 claim = ' + JSON.stringify({ ok: sh.ok, error: sh.error }))
  expect(sh && sh.ok === false && sh.error === 'conflict',
    'shared 模式对 exclusive 声明未返回 conflict', '返回 = ' + JSON.stringify(sh))

  const rd = await callLock(lock, { op: 'claim', paths: ['src/alpha/x.ts'], mode: 'read' }, 'agent-2')
  notes.push('agent-2 read 重叠 claim = ' + JSON.stringify({ ok: rd.ok, error: rd.error, message: rd.message }))
  if (rd && rd.ok === true) {
    notes.push('read 模式已实现且不被 exclusive 阻挡')
    return
  }
  if (rd && ['conflict', 'bad-request'].includes(rd.error)) {
    throw new KnownUnimplemented(
      `read 模式尚未实现（返回 error=${rd.error}）——记为已知未实现，不算 harness 失败；修复后应转 PASS`)
  }
  throw new CheckFail('read 模式返回了意料之外的形状', '返回 = ' + JSON.stringify(rd))
})

await runTest('T7', '磁盘落地可审计：statePath 指向真实 JSON，含 claims/messages/holders', async (notes) => {
  const { cwd, statePath } = shared.t5 || {}
  expect(!!statePath, 'T5 未留下 statePath，无法审计')
  const fresh = (await newInstance(cwd)).lock
  const again = (await statePathOf(fresh, 'agent-t7')).sp
  notes.push('T5 statePath = ' + statePath)
  notes.push('新实例解析  = ' + again)
  expect(again === statePath, '新插件实例对同一项目解析出不同状态文件', `T5 = ${statePath}\n      new = ${again}`)
  expect(fs.existsSync(statePath), 'statePath 在磁盘上不存在', 'path = ' + statePath)
  const raw = fs.readFileSync(statePath, 'utf8')
  let doc
  try { doc = JSON.parse(raw) } catch (e) {
    throw new CheckFail('statePath 内容不是合法 JSON', 'raw[0..200] = ' + raw.slice(0, 200))
  }
  expect(Array.isArray(doc.claims) && Array.isArray(doc.messages) && Array.isArray(doc.holders),
    '状态文档缺少 claims/messages/holders 数组', 'keys = ' + JSON.stringify(Object.keys(doc)))
  const mine = doc.claims.find((c) => c.holderId === 'agent:agent-1' && (c.paths || []).includes('src/core/'))
  expect(!!mine, '磁盘状态里没有 T5 那条 claim', 'claims = ' + JSON.stringify(doc.claims))
  notes.push('磁盘文件 ' + statePath + ' 合法，claims=' + doc.claims.length + ' messages=' + doc.messages.length + ' holders=' + doc.holders.length)
})

await runTest('T8', '老 `~` 目录迁移：预置旧落点数据后再 list', async (notes) => {
  const cwd = path.join(TMP_ROOT, 'proj-legacy')
  const fileName = projectStorageFileName(cwd)
  const legacyDoc = JSON.stringify({
    schemaVersion: 1, seq: 1,
    claims: [{
      claimId: 'c_legacy', holderId: 'agent:legacy', holderName: 'Legacy',
      paths: ['legacy/'], mode: 'exclusive', ttlSec: 1800,
      expiresAt: Date.now() + 3600 * 1000, note: 'legacy-e2e', createdAt: Date.now(),
    }],
    messages: [], holders: [],
  })
  // 两个历史落点都预置，形状与 paths.ts 的 legacyCollabDirs() 一一对应：
  //   [0] <进程 cwd>/.dsh/collab/projects   —— 旧版相对 cwd 落点
  //   [1] <HOME>/~/.dsh/collab/projects     —— 旧版 `~` 未展开落点（HOME 已被本 harness 指向 FAKE_HOME）
  // 注意：[0] 依赖进程 cwd，所以先把进程切进 TMP_ROOT 下的临时目录再预置，
  // 否则从仓库根跑测试会把 `~/` 目录写进仓库（这正是被测 bug 的形状）。
  const prevCwd = process.cwd()
  const t8cwd = path.join(TMP_ROOT, 't8-legacy-cwd')
  fs.mkdirSync(t8cwd, { recursive: true })
  process.chdir(t8cwd)
  const legacyDirs = [
    path.join(process.cwd(), '.dsh', 'collab', 'projects'),
    path.join(FAKE_HOME, '~', '.dsh', 'collab', 'projects'),
  ]
  for (const d of legacyDirs) {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, fileName), legacyDoc, 'utf8')
    notes.push('预置旧文件 = ' + path.join(d, fileName))
  }

  const { lock } = await newInstance(cwd)
  const { sp, res } = await statePathOf(lock, 'agent-t8')
  process.chdir(prevCwd)
  notes.push('list statePath = ' + sp)
  const readLegacy = ((res.data && res.data.claims) || []).some((c) => c.claimId === 'c_legacy')
  notes.push('是否读到 c_legacy = ' + readLegacy)

  expect(!hasTildeSegment(sp), TILDE_MSG, 'actual = ' + sp)
  // 硬断言：旧落点的数据必须真的被搬进来（此前的 OR 写法只要求 statePath 在 DSH_HOME 下，
  // 而修复后 statePath 必然满足后者，于是迁移即使完全没发生也会通过 —— 那是假阳性）。
  expect(readLegacy, '旧 `~` 落点的状态没有被迁移进来（readLegacy = false）',
    `readLegacy = ${readLegacy}\n      actual   = ${sp}\n      expected = ${EXPECTED_DIR}${path.sep}... 且能读到 c_legacy`)
  notes.push('→ 已从旧落点迁移，并读到 c_legacy')
})

await runTest('T9', 'hostCode 形态：状态目录绝对、不含 ~、且走 settings.prepareDocument', async (notes) => {
  let hostCode = null
  try {
    const mod = await import(new URL('../lib/collab-plugin.host.js', import.meta.url))
    hostCode = mod.hostCode
  } catch (e) {
    // ⑷ 不再静默 return（旧写法：直接 return ⇒ 该用例记 PASS ⇒ ALL PASS 却什么都没测）。
    // 默认 ⇒ FAIL；只有 COLLAB_ALLOW_SKIP=1 才记 SKIP + "未验证"横幅。
    throw new Skipped('lib/collab-plugin.host.js 不存在或不可加载：' + String(e && e.message || e))
  }
  assert.ok(typeof hostCode === 'string', 'hostCode 不是字符串')
  const st = fs.statSync(new URL('../lib/collab-plugin.host.js', import.meta.url))
  notes.push('hostCode 来源 mtime = ' + st.mtime.toISOString() + ' (' + st.size + ' bytes)')

  const hostCwd = path.join(TMP_ROOT, 'proj-host')
  const hostTools = []
  const services = {
    sessions: { get: (_id) => ({ header: { cwd: hostCwd } }) },
    sessionTitle: { get: (_s) => ({ title: 'Host E2E' }) },
    settings: { prepareDocument: async () => path.join(DSH_HOME, 'settings.yaml') },
  }
  const harness = {
    defineTool: (t) => t,
    registerTool: (_ctx, tool) => { hostTools.push(tool) },
  }
  const hostCtx = {
    fs: fsService,
    timer: { timeout: (ms) => new Promise((r) => setTimeout(r, ms)) },
    get: (n) => services[n],
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    on: () => () => {},
    tools: { register: (t) => hostTools.push(t) },
  }
  let plugin
  try {
    plugin = new Function('harness', 'ctx', hostCode)(harness, hostCtx)
  } catch (e) {
    throw new CheckFail('hostCode 无法被 new Function 构造（语法/执行错误）', String(e && e.stack || e))
  }
  expect(plugin && typeof plugin.apply === 'function', 'hostCode 未返回带 apply 的插件对象',
    'got = ' + JSON.stringify(plugin && Object.keys(plugin)))
  plugin.apply(hostCtx)

  const lock = hostTools.find((t) => t.name === 'collab_lock')
  expect(!!lock, 'hostCode 形态未注册 collab_lock', '已注册 = ' + JSON.stringify(hostTools.map((t) => t.name)))
  const res = await lock.execute({ op: 'list' }, { agent: { id: 'agent-host-1' } })
  if (!res || res.ok !== true) {
    throw new CheckFail('hostCode 形态 collab_lock list 未成功', '返回 = ' + JSON.stringify(res))
  }
  const sp = res.data && (res.data.statePath || res.data.stateDir)
  expect(typeof sp === 'string' && !!sp, 'hostCode 形态没有 statePath', 'data = ' + JSON.stringify(res.data))
  notes.push('hostCode statePath = ' + sp)

  expect(path.isAbsolute(sp), 'hostCode 形态 statePath 不是绝对路径', 'actual = ' + sp)
  expect(!hasTildeSegment(sp), TILDE_MSG, 'actual = ' + sp)
  // 契约延伸断言：settings 可用时，应走 prepareDocument()->dirname->/collab/projects，而不是退回会话 cwd 的 fallback。
  const underDshHome = sp.startsWith(EXPECTED_DIR + path.sep)
  notes.push('是否落在 ' + EXPECTED_DIR + ' = ' + underDshHome)
  expect(underDshHome,
    'hostCode 未走 settings.prepareDocument 分支（落到了 fallback / cwd 相对落点）',
    `actual   = ${sp}\n      expected = ${EXPECTED_DIR}${path.sep}...`)
})

// ════════════════════════════════════════════════════════════════════════
// 5.10 乐观并发：真实形状的 fs 报错必须触发重试
// ════════════════════════════════════════════════════════════════════════
await runTest('T10', '乐观并发：真实形状的 FS_STALE_VERSION / FS_NOT_OBSERVED 触发重试后成功', async (notes) => {
  const cwd = path.join(TMP_ROOT, 'proj-retry')
  const { lock } = await newInstance(cwd)
  const exec = { agent: { id: 'agent-retry' } }
  const first = await lock.execute({ op: 'claim', paths: ['retry/'], ttlSec: 600 }, exec)
  expect(first.ok === true, '首次 claim 应当成功', JSON.stringify(first))

  const origWrite = fsService.writeText
  let injectedStale = 0
  let injectedNotObserved = 0
  fsService.writeText = async (target, content, opts) => {
    // 模拟"读完之后、写之前别人改了文件"：真实后端抛 FsError（code 独立、message 不含 code）
    if (opts && opts.kind === 'replaceIfVersion' && injectedStale === 0) {
      injectedStale++
      throw staleError(target.path)
    }
    if (opts && opts.kind === 'createIfAbsent' && injectedNotObserved === 0) {
      injectedNotObserved++
      throw notObservedError(target.path)
    }
    return origWrite(target, content, opts)
  }
  let r
  try {
    r = await lock.execute({ op: 'claim', paths: ['retry/sub/'], ttlSec: 600 }, exec)
  } finally {
    fsService.writeText = origWrite
  }
  notes.push(`注入并发冲突：FS_STALE_VERSION x${injectedStale}、FS_NOT_OBSERVED x${injectedNotObserved}`)
  notes.push('重试后结果 = ' + JSON.stringify(r))
  expect(injectedStale === 1, '未能把并发冲突注入到 replaceIfVersion 路径', String(injectedStale))
  expect(r && r.ok === true, 'stale 之后的乐观重试应当最终成功，而不是返回 internal', JSON.stringify(r))
  expect(!(r && r.error === 'internal'), 'stale 冲突不应被当成 internal 错误抛出', JSON.stringify(r))
})

// ════════════════════════════════════════════════════════════════════════
// 6. 汇总
// ════════════════════════════════════════════════════════════════════════
const total = records.length
const pass = records.filter((r) => r.status === 'PASS').length
const fail = records.filter((r) => r.status === 'FAIL').length
const known = records.filter((r) => r.status === 'KNOWN').length
const skippedUnverified = records.filter((r) => r.status === 'SKIP').length

console.log('════════════════════ SUMMARY ════════════════')
console.log(`PASS ${pass}/${total}   FAIL ${fail}/${total}   KNOWN-UNIMPLEMENTED ${known}/${total}`
  + (skippedUnverified ? `   SKIPPED-UNVERIFIED ${skippedUnverified}/${total}` : ''))
if (fail) {
  console.log('\nFAILED:')
  for (const r of records.filter((x) => x.status === 'FAIL')) {
    console.log(`  [${r.id}] ${r.title}`)
    console.log('        ' + String(r.err.message).split('\n').join('\n        '))
  }
}
if (known) {
  console.log('\nKNOWN-UNIMPLEMENTED (非 harness 失败，修复后应转 PASS):')
  for (const r of records.filter((x) => x.status === 'KNOWN')) console.log(`  [${r.id}] ${r.known}`)
}
// ⑪ 退出时清理自己建的临时目录（成功路径必清）；失败时保留**唯一一个**现场，便于排障。
KEEP_SITE = fail > 0
console.log('\n临时目录（' + (KEEP_SITE ? '失败路径，保留现场' : '成功路径，已清理') + '）: ' + TMP_ROOT)
console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS')
process.exitCode = fail ? 1 : 0
