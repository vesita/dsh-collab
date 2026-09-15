import { createHarness } from './_harness.mjs'

// collab-hostcode-parity.mjs
// 动态宿主形态（hostCode）行为对拍测试。
//
// 为什么需要它：
//   1. 历史上的 `~/.dsh/collab/projects` bug 只存在于 hostCode 内联副本里，
//      而原有测试只驱动包形态（lib/index.js），结构上不可能发现它。
//   2. hostCode 与 collab-core.ts 是**两份实现**（动态插件不接受 import），
//      任何语义改动都可能只落在一边，造成静默漂移。
//
// 本测试把 hostCode 当字符串注入一个 fake ctx（含真实语义的 fs.resolve：
// 绝对路径原样通过、相对路径以 process.cwd() 为基址、**不展开 `~`**），
// 然后直接调用它注册出来的 collab_lock，断言路径与锁语义。
//
// 运行：node tests/collab-hostcode-parity.mjs
// 退出码非 0 表示失败。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const { hostCode } = await import(path.join(ROOT, '../lib/collab-plugin.host.js'))

const h = createHarness()
const { ok } = h

// ---------- fake fs：必须与真实 ctx.fs 的解析语义同构 ----------
const FAKE_HOME = path.join(os.tmpdir(), 'dsh-collab-hostcode-' + process.pid)
const SETTINGS_DOC = path.join(FAKE_HOME, 'settings.yaml')
const PROJECT_CWD = '/fake/project/alpha'

const store = new Map()
// 真实的 FileSystem.resolve 声明是 Promise<FsTarget>，但动态宿主里拿到的实测是
// **thenable FileRef**（既有 .displayPath/.targetKey 可直接读，也能被 await）。
// 0.3.3 的 hostCode 恰恰**不 await** 它，只靠这个形状工作 —— 所以 fake 必须同构，
// 否则测出来的失败是 fake 造的，不是真 bug。
const makeTarget = (abs) => {
  const t = { displayPath: abs, path: abs, targetKey: abs }
  // 注意：then 必须 resolve 成一个**不含 then** 的普通对象，否则 Promise.resolve(t)
  // 会再次调用 t.then，形成无限自吸收（会把进程 OOM 掉）。
  const plain = () => ({ displayPath: abs, path: abs, targetKey: abs })
  t.then = (onFulfilled, onRejected) => Promise.resolve(plain()).then(onFulfilled, onRejected)
  return t
}
const fs = {
  // 实测语义：绝对路径原样；相对路径以 opts.cwd ?? process.cwd() 为基址；**绝不做 ~ 展开**
  resolve: (p, opts) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(opts && opts.cwd ? opts.cwd : process.cwd(), p)
    return makeTarget(abs)
  },
  stat: async (t) => (store.has(t.path) ? { version: 1, type: 'file' } : undefined),
  readText: async (t) => store.get(t.path) || '',
  writeText: async (t, content) => { store.set(t.path, content); return { operation: 'create', version: 1 } },
  processPath: (t) => t.path,
  listDir: async () => []
}

const tools = []
const harness = {
  defineTool: (def) => def,
  registerTool: (_ctx, tool) => { tools.push(tool); return () => {} },
  handle: () => () => {}
}

const ctx = {
  fs,
  timer: { timeout: (ms) => new Promise((r) => setTimeout(r, ms)) },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  on: () => () => {},
  get: (name) => {
    if (name === 'settings') return { prepareDocument: async () => SETTINGS_DOC }
    if (name === 'sessions') return { get: () => ({ header: { cwd: PROJECT_CWD } }) }
    if (name === 'sessionTitle') return { get: () => ({ title: 'Parity Worker' }) }
    return undefined
  }
}

// ---------- 装载 hostCode ----------
console.log('# hostCode loads and registers tools')
let lock
try {
  const factory = new Function('harness', 'ctx', hostCode)
  const plugin = factory(harness, ctx)
  await plugin.apply(ctx)
  lock = tools.find((t) => t.name === 'collab_lock')
  ok(!!lock, 'hostCode registers collab_lock')
  ok(tools.some((t) => t.name === 'collab_board'), 'hostCode registers collab_board')
  // 跨形态断言：动态形态的 tool schema 必须与 collab-core 的 MODES（单一事实源）一致。
  // 之前正是这里漏了 read，导致插件自己注入的提示要求 mode=read、而 schema 拒绝它。
  const { MODES } = await import(new URL('../lib/collab-core.js', import.meta.url))
  const modeEnum = lock && lock.parameters && lock.parameters.properties && lock.parameters.properties.mode
    ? lock.parameters.properties.mode.enum : null
  ok(Array.isArray(modeEnum) && MODES.every((m) => modeEnum.includes(m)),
    'dynamic-form schema advertises every valid mode (incl. read)', JSON.stringify(modeEnum))
} catch (e) {
  ok(false, 'hostCode must load without throwing', String((e && e.stack) || e))
}
if (!lock) {
  console.log(`\nFAILURES: ${h.pass} passed, ${h.fail} failed`)
  process.exit(1)
}

const A = { agent: { id: 'agent-A' } }
const B = { agent: { id: 'agent-B' } }
const call = (args, exec) => lock.execute(args, exec)

// ---------- 1. 状态目录必须是绝对路径、无字面量 ~、与进程 cwd 无关 ----------
console.log('# state dir (regression: literal ~ and cwd-relative)')
{
  const r = await call({ op: 'list' }, A)
  const sp = r && r.data && r.data.statePath
  ok(!!sp, 'list returns statePath', JSON.stringify(r))
  const spStr = typeof sp === 'string' ? sp : ''
  ok(path.isAbsolute(spStr), 'statePath is absolute', String(sp))
  ok(!spStr.includes('~'), 'statePath contains no literal ~ segment', String(sp))
  ok(!spStr.startsWith(process.cwd() + path.sep), 'statePath is not anchored to the process cwd', String(sp))
  const expectedDir = path.join(FAKE_HOME, 'collab', 'projects')
  ok(spStr.startsWith(expectedDir + path.sep), 'statePath honours settings.prepareDocument() dirname', String(sp))
  if (r && r.data && 'stateDir' in r.data) {
    ok(r.data.stateDir === expectedDir, 'stateDir equals <dshHome>/collab/projects', String(r.data.stateDir))
  } else {
    fail++; console.log('  FAIL list should expose stateDir for auditability')
  }
}

// ---------- 2. read / shared / exclusive 三态语义 ----------
console.log('# mode semantics (read must not be blocked)')
{
  // A 独占
  const c1 = await call({ op: 'claim', paths: ['src/core/'], ttlSec: 600 }, A)
  ok(c1.ok === true, 'A exclusive claim ok')

  // B 只读：必须成功（历史 bug：read 被静默当作 exclusive 而冲突）
  const c2 = await call({ op: 'claim', paths: ['src/core/models/', 'src/readonly/'], mode: 'read', ttlSec: 600 }, B)
  ok(c2.ok === true, 'B read claim succeeds despite A exclusive', JSON.stringify(c2))
  ok(c2.ok === true && c2.data.claim.mode === 'read', 'B read claim is stored as mode=read')

  // 反向：已有 read 不阻塞他人 exclusive
  const c3 = await call({ op: 'claim', paths: ['src/core/other/'], mode: 'exclusive', ttlSec: 600 }, A)
  ok(c3.ok === true, 'existing read claim never blocks an exclusive claim')

  // shared 仍被 exclusive 挡住（回归保护）
  const c4 = await call({ op: 'claim', paths: ['src/core/models/'], mode: 'shared', ttlSec: 600 }, B)
  ok(c4.ok === false && c4.error === 'conflict', 'B shared claim still conflicts with A exclusive', JSON.stringify(c4))

  // wait 只把他人 exclusive 当 blocker：src/readonly/ 仅被 B 的 read 覆盖，应立即放行
  const w = await call({ op: 'wait', paths: ['src/readonly/'], timeoutMs: 300 }, B)
  ok(w.ok === true, 'wait ignores read/shared blockers', JSON.stringify(w))

  // 合并限定同一 mode：A 对 pq/ 声明 read、对 pq/sub/ 声明 exclusive，两条独立
  const c5 = await call({ op: 'claim', paths: ['pq/'], mode: 'read', ttlSec: 600 }, A)
  ok(c5.ok === true, 'A read claim on pq/ ok')
  const c6 = await call({ op: 'claim', paths: ['pq/sub/'], mode: 'exclusive', ttlSec: 600 }, A)
  ok(c6.ok === true && c6.data.claim.mode === 'exclusive', 'hostCode keeps exclusive as its own claim', JSON.stringify(c6))
  const listA = await call({ op: 'list' }, A)
  const aClaims = (listA.data.claims || []).filter((c) => c.holderId === 'agent:agent-A')
  const rd = aClaims.find((c) => c.mode === 'read' && c.paths.includes('pq/'))
  ok(!!rd && rd.paths.length === 1, 'hostCode read claim keeps only its own path', JSON.stringify(aClaims))
  // 关键回归：兄弟路径 pq/other/ 从未被独占，不得被子路径的 exclusive 连带锁上
  const sibling = await call({ op: 'claim', paths: ['pq/other/'], mode: 'exclusive', ttlSec: 600 }, B)
  ok(sibling.ok === true, 'hostCode sibling path is not blocked by the sub-path exclusive', JSON.stringify(sibling))
  // 子路径本身仍受保护
  const deep = await call({ op: 'claim', paths: ['pq/sub/deep/'], mode: 'exclusive', ttlSec: 600 }, B)
  ok(deep.ok === false && deep.error === 'conflict', 'hostCode exclusively claimed sub-path still blocks others', JSON.stringify(deep))
  // 未知 mode 显式拒绝
  const bad = await call({ op: 'claim', paths: ['pq/bad/'], mode: 'READ', ttlSec: 600 }, B)
  ok(bad.ok === false && bad.error === 'bad-request', 'hostCode rejects an unknown mode instead of guessing', JSON.stringify(bad))
}

// ---------- 3. holder TTL：陈旧 holder 必须被 sweep 回收 ----------
console.log('# stale holder pruning (regression: live pkg-9 kept 37h-old holders)')
{
  await call({ op: 'claim', paths: ['prune/'], ttlSec: 600 }, A)
  // 直接往状态文件里塞一个 30 小时前的孤儿 holder
  const listR = await call({ op: 'list' }, A)
  const sp = listR.data.statePath
  const doc = JSON.parse(store.get(sp))
  doc.holders.push({
    holderId: 'agent:GHOST', name: 'ghost', kind: 'agent',
    sessionId: 'GHOST', lastSeenAt: Date.now() - 30 * 3600 * 1000
  })
  store.set(sp, JSON.stringify(doc))

  const after = await call({ op: 'list' }, A)
  const ids = (after.data.holders || []).map((h) => h.holderId)
  ok(!ids.includes('agent:GHOST'), 'holder idle for 30h is pruned from list', JSON.stringify(ids))

  // 静默 2h 的 holder（无声明）必须**看得见**且 stale=true：
  // stale 用 1h 预警阈值，sweep 用 24h 回收阈值，两者分级，故产品路径上 stale 不是死信号。
  const sp2 = after.data.statePath
  const doc2 = JSON.parse(store.get(sp2))
  doc2.holders.push({
    holderId: 'agent:STALE-VISIBLE', name: 'stale visible', kind: 'agent',
    sessionId: 'SV', lastSeenAt: Date.now() - 2 * 3600 * 1000
  })
  store.set(sp2, JSON.stringify(doc2))
  const vis = await call({ op: 'list' }, A)
  const sv = (vis.data.holders || []).find((h) => h.holderId === 'agent:STALE-VISIBLE')
  ok(!!sv && sv.stale === true, 'holder idle 2h is reported with stale=true', JSON.stringify(sv))
  ok(vis.data.staleHolders >= 1, 'staleHolders counts it', String(vis.data.staleHolders))
  // 而静默 30h 的则已被回收（上面的 GHOST 断言）；两者并存正是分级的意义。
}

// ---------- 4. 退化路径：settings 不可用时落到项目内 .dsh-collab/ 并给出 warning ----------
console.log('# degraded path when settings.prepareDocument() is unavailable')
{
  const tools2 = []
  const store2 = new Map()
  const harness2 = {
    defineTool: (d) => d,
    registerTool: (_c, t) => { tools2.push(t); return () => {} },
    handle: () => () => {}
  }
  const fs2 = {
    resolve: (p, opts) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(opts && opts.cwd ? opts.cwd : process.cwd(), p)
      return makeTarget(abs)
    },
    stat: async (t) => (store2.has(t.path) ? { version: 1, type: 'file' } : undefined),
    readText: async (t) => store2.get(t.path) || '',
    writeText: async (t, c) => { store2.set(t.path, c); return { operation: 'create', version: 1 } },
    processPath: (t) => t.path,
    listDir: async () => []
  }
  const ctx2 = {
    fs: fs2,
    timer: { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: () => () => {},
    get: (name) => {
      // 刻意不提供 settings：模拟受限宿主里拿不到 DSH 用户目录
      if (name === 'sessions') return { get: () => ({ header: { cwd: PROJECT_CWD } }) }
      if (name === 'sessionTitle') return { get: () => ({ title: 'Degraded Worker' }) }
      return undefined
    }
  }
  const plugin2 = new Function('harness', 'ctx', hostCode)(harness2, ctx2)
  await plugin2.apply(ctx2)
  const lock2 = tools2.find((t) => t.name === 'collab_lock')
  ok(!!lock2, 'hostCode still registers collab_lock without settings service')
  const r = await lock2.execute({ op: 'list' }, A)
  const sp2 = r && r.data && r.data.statePath
  ok(typeof sp2 === 'string' && sp2.startsWith(PROJECT_CWD + '/.dsh-collab/'),
    'degraded statePath lives in the project-local .dsh-collab/', String(sp2))
  ok(/\.dsh-collab/.test(String(r.data && r.data.warning)), 'degraded mode reports a warning explaining the fallback', String(r.data && r.data.warning))
}

// ---------- 5. 态势摘要渲染：hostCode 内联版 vs collab-core（逐字节等价） ----------
// 为什么必须逐字节：摘要文本一旦两边不同，包形态与动态宿主形态就会给同一组占用注入
// 不同的快照文本 —— 而 DSH 正是按文本逐字节比较来做快照去重的。
console.log('# awareness digest: hostCode inline vs collab-core (byte-for-byte)')
{
  const { renderDigest, clockUtc, modeLabel } = await import(new URL('../lib/collab-core.js', import.meta.url))

  // 从 hostCode 源码里抽出真实函数体（不是复制品），注入它依赖的同源函数后执行。
  const extract = (fnName, scope = {}) => {
    const names = Object.keys(scope), vals = names.map((n) => scope[n])
    const decl = RegExp('function ' + fnName + '\\(([^)]*)\\) \\{([\\s\\S]*?)\\n    \\}', 'm').exec(hostCode)
    if (decl) return new Function(...names, 'return function ' + fnName + '(' + decl[1] + ') {' + decl[2] + '}')(...vals)
    const arrow = RegExp('const ' + fnName + ' = \\(([^)]*)\\) => \\{([\\s\\S]*?)\\n    \\}', 'm').exec(hostCode)
    if (arrow) return new Function(...names, 'return function ' + fnName + '(' + arrow[1] + ') {' + arrow[2] + '}')(...vals)
    throw new Error('cannot extract ' + fnName + ' from hostCode')
  }
  // 宿主内联的 MODE_LABELS 从真实源码抽出来，不手抄副本。
  const labelsDecl = /const MODE_LABELS = \{([^}]*)\}/.exec(hostCode)
  ok(!!labelsDecl, 'hostCode contains inline MODE_LABELS', String(labelsDecl))
  const hostModeLabels = labelsDecl ? new Function('return {' + labelsDecl[1] + '}')() : {}
  const hostModeLabel = extract('modeLabel', { MODE_LABELS: hostModeLabels })
  const hostClockUtc = extract('clockUtc')
  const hostRenderDigest = extract('renderDigest', { clockUtc: hostClockUtc, modeLabel: hostModeLabel })
  ok(['exclusive', 'shared', 'read'].every((m) => hostModeLabel(m) === modeLabel(m)),
    'hostCode modeLabel === collab-core modeLabel for all three modes',
    JSON.stringify(['exclusive', 'shared', 'read'].map((m) => [hostModeLabel(m), modeLabel(m)])))

  // 固定绝对时刻，测试不依赖真实时钟；时钟秒数刻意非 0，证明输出被截到分钟。
  const T0 = Date.UTC(2026, 0, 2, 3, 4, 37)
  const mkClaim = (o) => Object.assign({
    claimId: 'c_x', holderId: 'agent:x', holderName: 'Worker X',
    paths: ['src/x/'], mode: 'exclusive', ttlSec: 1800,
    expiresAt: T0 + 1800 * 1000, note: '', createdAt: T0
  }, o)

  const c1 = mkClaim({ claimId: 'c_1', holderId: 'agent:one', holderName: 'One', paths: ['src/one/'] })
  const c2 = mkClaim({ claimId: 'c_2', holderId: 'agent:two', holderName: 'Two', paths: ['src/two/'], mode: 'shared', expiresAt: T0 + 900 * 1000, ttlSec: 900 })
  const c3 = mkClaim({ claimId: 'c_3', holderId: 'agent:three', holderName: 'Three', paths: ['src/three/'], mode: 'read', expiresAt: T0 + 3600 * 1000, ttlSec: 3600 })
  const c4 = mkClaim({ claimId: 'c_4', holderId: 'agent:four', holderName: 'Four', paths: ['src/four/'], expiresAt: T0 + 7200 * 1000, ttlSec: 7200 })
  const three = [c1, c2, c3]
  const fixtures = [
    ['single claim', [c1]],
    ['three claims', three],
    ['more than three claims', [c1, c2, c3, c4]],
    ['claim with more than two paths', [mkClaim({ claimId: 'c_p', paths: ['a/', 'b/', 'c/', 'd/'] })]],
    ['claim missing holderName', [mkClaim({ claimId: 'c_n', holderId: 'agent:anon', holderName: undefined })]],
    ['shuffled input order', [c3, c1, c2]],
    ['empty claim set', []]
  ]
  for (const [label, claims] of fixtures) {
    const h = hostRenderDigest(claims)
    const c = renderDigest(claims)
    ok(h === c, 'hostCode renderDigest === collab-core renderDigest: ' + label,
      'host=' + JSON.stringify(h) + ' core=' + JSON.stringify(c))
  }
  ok(hostClockUtc(T0) === clockUtc(T0), 'hostCode clockUtc === collab-core clockUtc',
    'host=' + hostClockUtc(T0) + ' core=' + clockUtc(T0))
  // 顺序确定性：打乱输入仍渲染成同一文本（两形态都如此）
  ok(hostRenderDigest([c3, c1, c2]) === hostRenderDigest([c1, c2, c3]), 'hostCode digest is order-independent')
  ok(renderDigest([c3, c1, c2]) === renderDigest([c1, c2, c3]), 'collab-core digest is order-independent')
  // 具体文案断言：确认两侧比较的是**真实输出**，而不是两个空串/同一退化物
  const sample = renderDigest([c1, c2])
  ok(sample.includes('One（独占）占用 src/one/，租约 30 分（01-02 03:04Z–01-02 03:34Z）'),
    'core digest renders the documented absolute-window format', sample)
  ok(hostRenderDigest([c1, c2]) === sample, 'hostCode digest equals that exact literal too', hostRenderDigest([c1, c2]))
}

// ---------- 5b. 端到端：真正注册出来的 dsh-collab/awareness provider ----------
// 上面比的是"抽取出来的函数"；这里再走一遍完整链路（注册 → 读盘 → 缓存 → text()），
// 确认宿主实际会注入的那段文本与 collab-core 的 renderDigest 一模一样。
console.log('# registered awareness provider emits exactly collab-core renderDigest')
{
  const { renderDigest } = await import(new URL('../lib/collab-core.js', import.meta.url))
  const e2eStore = new Map()
  const e2eTools = []
  let captured = null
  const ME = { id: 'agent-e2e-me', session: { header: { cwd: PROJECT_CWD } } }
  const harnessE = {
    defineTool: (def) => def,
    registerTool: (_ctx, tool) => { e2eTools.push(tool); return () => {} },
    handle: () => () => {}
  }
  const fsE = {
    resolve: (p, opts) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(opts && opts.cwd ? opts.cwd : process.cwd(), p)
      return makeTarget(abs)
    },
    stat: async (t) => (e2eStore.has(t.path) ? { version: 1, type: 'file' } : undefined),
    readText: async (t) => e2eStore.get(t.path) || '',
    writeText: async (t, c) => { e2eStore.set(t.path, c); return { operation: 'create', version: 1 } },
    processPath: (t) => t.path,
    listDir: async () => []
  }
  const ctxE = {
    fs: fsE,
    timer: { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: () => () => {},
    get: (name) => {
      if (name === 'settings') return { prepareDocument: async () => SETTINGS_DOC }
      if (name === 'sessions') return { get: () => ME.session }
      if (name === 'sessionTitle') return { get: () => ({ title: 'E2E Worker' }) }
      if (name === 'agents') return { currentInitiator: () => ME, list: () => [ME] }
      if (name === 'systemPrompt') return { context: (c) => { captured = c; return () => {} } }
      return undefined
    }
  }
  const pluginE = new Function('harness', 'ctx', hostCode)(harnessE, ctxE)
  await pluginE.apply(ctxE)
  ok(!!captured && captured.name === 'dsh-collab/awareness', 'e2e: hostCode registers the awareness PromptContext')

  const e2eLock = e2eTools.find((t) => t.name === 'collab_lock')
  const listE = await e2eLock.execute({ op: 'list' }, A)
  const sp = listE.data.statePath
  const t = Date.now()
  const seeded = [{
    claimId: 'c_foreign', holderId: 'agent-someone-else', holderName: 'Other Session',
    paths: ['src/backend/'], mode: 'exclusive', ttlSec: 1800,
    expiresAt: t + 25 * 60 * 1000, note: '', createdAt: t
  }]
  e2eStore.set(sp, JSON.stringify({ schemaVersion: 1, seq: 0, claims: seeded, messages: [], holders: [] }))

  const expected = renderDigest(seeded)
  let text = ''
  for (let i = 0; i < 60 && text !== expected; i++) {
    captured.text()                                  // 触发/读取（fire-and-forget 刷新）
    await new Promise((r) => setTimeout(r, 25))
    text = captured.text()
  }
  ok(text === expected, 'e2e: injected text is exactly collab-core renderDigest output',
    'injected=' + JSON.stringify(text) + ' expected=' + JSON.stringify(expected))
}

// ---------- 动态形态镜像：损坏自愈/迁移失败同样不许谎报（与包形态 store.ts 对齐） ----------
// 为什么必须在这里测：hostCode 的 load() 是**另一份实现**（动态插件不接受 import）。
// 只修包形态的话，动态形态用户仍会被 warning 谎报"已备份/已重新初始化"。
{
  console.log('# hostCode: corrupt-state warnings must not lie (mirror of store.ts)')
  const boot = async (fsImpl, cwd) => {
    const toolsLocal = []
    const ctxLocal = {
      fs: fsImpl,
      timer: { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} },
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
      on: () => () => {},
      get: (name) => {
        if (name === 'settings') return { prepareDocument: async () => SETTINGS_DOC }
        if (name === 'sessions') return { get: () => ({ header: { cwd } }) }
        if (name === 'sessionTitle') return { get: () => ({ title: 'Corrupt Worker' }) }
        return undefined
      }
    }
    const pluginLocal = new Function('harness', 'ctx', hostCode)({ defineTool: (d) => d, registerTool: (_c, t) => { toolsLocal.push(t); return () => {} }, handle: () => () => {} }, ctxLocal)
    await pluginLocal.apply(ctxLocal)
    return toolsLocal.find((t) => t.name === 'collab_lock')
  }
  const healFs = (map, opts = {}) => ({
    resolve: (p, o) => {
      const abs = path.isAbsolute(p) ? p : path.resolve(o && o.cwd ? o.cwd : process.cwd(), p)
      return makeTarget(abs)
    },
    stat: async (t) => (map.has(t.path) ? { version: 1 } : undefined),
    readText: async (t) => map.get(t.path) || '',
    writeText: async (t, content, o) => {
      if (opts.failAllWrites) throw new Error('disk on fire')
      if (opts.failReplace && o && o.kind === 'replaceIfVersion') throw new Error('reset exploded')
      map.set(t.path, content)
      return { operation: 'create', version: 1 }
    },
    processPath: (t) => t.path,
    listDir: async () => []
  })
  const warnOf = async (lockLocal, agent) => {
    const r = await lockLocal.execute({ op: 'list' }, agent)
    return { r, w: String((r && r.data && r.data.warning) || '') }
  }

  // (a) 备份与重置全失败：不得出现成功措辞，且必须报出失败原因
  {
    const map = new Map()
    const lockLocal = await boot(healFs(map, { failAllWrites: true }), '/fake/host/corrupt-a')
    const r0 = await lockLocal.execute({ op: 'list' }, A)
    map.set(r0.data.statePath, 'not-json{{{')
    const { w } = await warnOf(lockLocal, A)
    ok(w.includes('状态文件损坏'), 'hostCode: corrupt state is still surfaced', JSON.stringify(w))
    ok(!/；\s*备份：/.test(w), 'hostCode: a failed backup must NOT be reported as "backup: <path>"', JSON.stringify(w))
    ok(!w.includes('已重新初始化'), 'hostCode: a failed reset must NOT be reported as "reinitialized"', JSON.stringify(w))
    ok(/备份失败：disk on fire/.test(w), 'hostCode: warning states the backup failure and its cause', JSON.stringify(w))
    ok(/重新初始化失败：disk on fire/.test(w), 'hostCode: warning states the reset failure and its cause', JSON.stringify(w))
    ok(/原始损坏内容仍留在磁盘上/.test(w), 'hostCode: warning tells where the corrupt content now lives', JSON.stringify(w))
    ok(map.get(r0.data.statePath) === 'not-json{{{', 'hostCode: original corrupt bytes are left on disk')
  }
  // (b) 只有重置失败：备份路径如实给出，同时不得宣称"已重新初始化"
  {
    const map = new Map()
    const lockLocal = await boot(healFs(map, { failReplace: true }), '/fake/host/corrupt-b')
    const r0 = await lockLocal.execute({ op: 'list' }, A)
    const key = r0.data.statePath
    map.set(key, 'not-json{{{')
    const { w } = await warnOf(lockLocal, A)
    const backupKeys = [...map.keys()].filter((k) => k.includes('.corrupt-'))
    ok(backupKeys.length === 1 && map.get(backupKeys[0]) === 'not-json{{{', 'hostCode: the backup really holds the corrupt bytes', JSON.stringify(backupKeys))
    ok(w.includes('备份：' + backupKeys[0]), 'hostCode: a successful backup still reports its real path', JSON.stringify(w))
    ok(!w.includes('已重新初始化') && /重新初始化失败：reset exploded/.test(w), 'hostCode: the failed reset is reported honestly', JSON.stringify(w))
  }
  // (c) 回归：全成功时文案与此前逐字一致（只允许失败时改文案）
  {
    const map = new Map()
    const lockLocal = await boot(healFs(map), '/fake/host/corrupt-c')
    const r0 = await lockLocal.execute({ op: 'list' }, A)
    const key = r0.data.statePath
    map.set(key, 'not-json{{{')
    const { w } = await warnOf(lockLocal, A)
    ok(/^状态文件损坏；已重新初始化；备份：/.test(w), 'hostCode: 全成功时的 warning 措辞（中文）', JSON.stringify(w))
    ok(!w.includes('失败'), 'hostCode: no failure wording on the success path', JSON.stringify(w))
  }
  // (d) 旧状态文件迁移写入失败必须留痕
  {
    const cwd = '/fake/host/legacy-fail'
    const legacyPath = path.join(cwd, '.dsh-collab.json')
    const legacyDoc = JSON.stringify({ schemaVersion: 1, seq: 0, claims: [], messages: [], holders: [] })
    const map = new Map([[legacyPath, legacyDoc]])
    const fsImpl = {
      resolve: (p, o) => makeTarget(path.isAbsolute(p) ? p : path.resolve(o && o.cwd ? o.cwd : process.cwd(), p)),
      stat: async (t) => (map.has(t.path) ? { version: 1 } : undefined),
      readText: async (t) => map.get(t.path) || '',
      writeText: async () => { throw new Error('migrate write exploded') },
      processPath: (t) => t.path,
      listDir: async () => []
    }
    const lockLocal = await boot(fsImpl, cwd)
    const { w } = await warnOf(lockLocal, A)
    ok(/旧落点迁移失败：migrate write exploded/.test(w), 'hostCode: a failed legacy migration is surfaced as 「旧落点迁移失败：<cause>」', JSON.stringify(w))
    ok(map.get(legacyPath) === legacyDoc, 'hostCode: a failed migration leaves the legacy file untouched')
  }
}

// ---------- 6. agent/disposed 的真实接线：宿主形态也不因 dispose 释放未过期声明（W7） ----------
// inline-parity 逐输出对拍的是**从 hostCode 抽出来的函数体**，它证明不了 disposed 钩子真的把
// 「当前的 now()」传了进去（若传成 Infinity / 未来时刻，就会退回"dispose 释放一切"的锁安全缺陷）。
// 这里捕获**真实注册**的 agent/disposed 处理器并触发它，断言状态文件里的未过期声明纹丝不动，
// 而该 holder 的 reader 登记仍被摘掉。
console.log('# agent/disposed wiring: an unexpired claim survives dispose (W7)')
{
  const map = new Map()
  const toolsLocal = []
  // 事件 -> 处理器**数组**：Cordis 允许同一事件挂多个监听器，假 ctx 也必须如此。
  // 曾经这里是 `handlers.set(ev, fn)`（单槽）—— 第二个监听器会静默顶掉第一个，
  // 于是"dispose 摘 reader"的行为看起来坏掉，实际是测试脚手架吞了处理器。
  const handlers = new Map()
  const onEvent = (ev, fn) => { const list = handlers.get(ev) || []; list.push(fn); handlers.set(ev, list); return () => {} }
  const firstHandler = (ev) => (handlers.get(ev) || [])[0]
  const fsLocal = {
    resolve: (p, o) => makeTarget(path.isAbsolute(p) ? p : path.resolve(o && o.cwd ? o.cwd : process.cwd(), p)),
    stat: async (t) => (map.has(t.path) ? { version: 1 } : undefined),
    readText: async (t) => map.get(t.path) || '',
    writeText: async (t, c) => { map.set(t.path, c); return { operation: 'create', version: 1 } },
    processPath: (t) => t.path,
    listDir: async () => []
  }
  const ctxLocal = {
    fs: fsLocal,
    timer: { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: onEvent,
    get: (name) => {
      if (name === 'settings') return { prepareDocument: async () => SETTINGS_DOC }
      if (name === 'sessions') return { get: () => ({ header: { cwd: '/fake/host/dispose' } }) }
      if (name === 'sessionTitle') return { get: () => ({ title: 'Dispose Worker' }) }
      return undefined
    }
  }
  const pluginLocal = new Function('harness', 'ctx', hostCode)(
    { defineTool: (d) => d, registerTool: (_c, t) => { toolsLocal.push(t); return () => {} }, handle: () => () => {} }, ctxLocal)
  await pluginLocal.apply(ctxLocal)
  const lockLocal = toolsLocal.find((t) => t.name === 'collab_lock')
  const disposed = firstHandler('agent/disposed')
  ok(typeof disposed === 'function', 'hostCode registers an agent/disposed handler', typeof disposed)
  // 同一事件上的**多个**监听器必须都活着（dropHolder 一个 + 自动释放的 disarm 一个）：
  // 这条同时守护测试脚手架本身，防止它退回单槽把真实处理器吞掉。
  ok((handlers.get('agent/disposed') || []).length >= 2,
    'agent/disposed 上的多个监听器都保留下来（单槽假 ctx 会静默顶掉）',
    JSON.stringify((handlers.get('agent/disposed') || []).length))

  const DEAD = { agent: { id: 'agent-dead-host' } }
  const r = await lockLocal.execute({ op: 'claim', paths: ['src/host-dispose/'], ttlSec: 600 }, DEAD)
  ok(r.ok === true, 'setup: the doomed holder owns an unexpired claim', JSON.stringify(r && r.data && r.data.claim))
  const sp = (await lockLocal.execute({ op: 'list' }, DEAD)).data.statePath
  // 另一个 holder 的声明把这个 holder 登记成 reader：dispose 只该把它从 readers 里摘掉。
  const doc = JSON.parse(map.get(sp))
  doc.claims.push({
    claimId: 'c_other_readers', holderId: 'agent:other', holderName: 'Other', paths: ['src/other/'],
    mode: 'exclusive', ttlSec: 600, expiresAt: Date.now() + 600000, note: '', createdAt: Date.now(),
    readable: true, readers: ['agent:agent-dead-host', 'agent:keep']
  })
  map.set(sp, JSON.stringify(doc))

  disposed({ agent: { id: 'agent-dead-host' } })
  let after = JSON.parse(map.get(sp))
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 20))
    after = JSON.parse(map.get(sp))
    const o = (after.claims || []).find((c) => c.claimId === 'c_other_readers')
    if (o && Array.isArray(o.readers) && !o.readers.includes('agent:agent-dead-host')) break
  }
  const claims = after.claims || []
  const own = claims.filter((c) => c.holderId === 'agent:agent-dead-host')
  ok(own.length === 1, '未过期声明在 agent/disposed 之后仍然存在（dispose 不是释放信号）', JSON.stringify(claims.map((c) => c.claimId)))
  ok(own.length === 1 && own[0].expiresAt > Date.now(), '保留下来的正是那条未到期声明（租约没有被缩短）', JSON.stringify(own.map((c) => c.expiresAt)))
  const other = claims.find((c) => c.claimId === 'c_other_readers')
  ok(!!other && !other.readers.includes('agent:agent-dead-host'), 'dispose 仍把这个 holder 从其他 claim 的 readers 摘掉', JSON.stringify(other && other.readers))
  ok(!!other && other.readers.includes('agent:keep'), '其他读者不受影响', JSON.stringify(other && other.readers))
}

// ---------- N. op=reap（0.9.8，宿主内联形态的行为对拍）----------
// 包形态的完整覆盖在 tests/collab-reap.mjs；这里只钉宿主内联副本的**行为**：
// 默认 dry-run 不改状态、confirm:true 只删活体名单外的、活着的 holder 一条不动。
console.log('# op=reap (host inline form): dry-run default / confirm removes only non-live holders')
{
  const map = new Map()
  const toolsLocal = []
  const LIVE = ['agent-lived', 'agent-reaper']
  const injects = []
  const ctxLocal = {
    fs: {
      resolve: (p, o) => makeTarget(path.isAbsolute(p) ? p : path.resolve(o && o.cwd ? o.cwd : process.cwd(), p)),
      stat: async (t) => (map.has(t.path) ? { version: 1 } : undefined),
      readText: async (t) => map.get(t.path) || '',
      writeText: async (t, c) => { map.set(t.path, c); return { operation: 'create', version: 1 } },
      processPath: (t) => t.path,
      listDir: async () => []
    },
    timer: { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: () => () => {},
    get: (name) => {
      if (name === 'settings') return { prepareDocument: async () => SETTINGS_DOC }
      if (name === 'sessions') return { get: () => ({ header: { cwd: '/fake/host/reap' } }) }
      if (name === 'sessionTitle') return { get: (s) => ({ title: s && s.id === 'agent-reaper' ? 'Reaper' : 'Host Worker' }) }
      if (name === 'agents') return {
        currentInitiator: () => undefined,
        list: () => LIVE.map((id) => ({ id })),
        get: (id) => (LIVE.includes(id) ? { id, inject: (m) => injects.push({ id, m }) } : undefined)
      }
      return undefined
    }
  }
  const pluginLocal = new Function('harness', 'ctx', hostCode)(
    { defineTool: (d) => d, registerTool: (_c, t) => { toolsLocal.push(t); return () => {} }, handle: () => () => {} }, ctxLocal)
  await pluginLocal.apply(ctxLocal)
  const lockLocal = toolsLocal.find((t) => t.name === 'collab_lock')
  const REAPER = { agent: { id: 'agent-reaper' } }
  const DEAD = { agent: { id: 'agent-dead' } }
  const LIVED = { agent: { id: 'agent-lived' } }
  await lockLocal.execute({ op: 'claim', paths: ['src/dead/'], ttlSec: 600 }, DEAD)
  await lockLocal.execute({ op: 'claim', paths: ['src/lived/'], ttlSec: 600 }, LIVED)
  await lockLocal.execute({ op: 'claim', paths: ['src/reaper/'], ttlSec: 600 }, REAPER)
  const sp = (await lockLocal.execute({ op: 'list' }, REAPER)).data.statePath
  // 把三条声明都"变老"（1000 秒前创建），但仍未到期 —— 只有不在 LIVE 里的那条该被回收。
  const doc = JSON.parse(map.get(sp))
  for (const c of doc.claims) { c.createdAt = Date.now() - 1000 * 1000 }
  map.set(sp, JSON.stringify(doc))
  const before = map.get(sp)

  const dry = await lockLocal.execute({ op: 'reap' }, REAPER)
  ok(dry.ok === true && dry.data.dryRun === true, '宿主 reap 默认 dry-run', JSON.stringify(dry && dry.data && dry.data.dryRun))
  const cand = (dry.data && dry.data.candidates) || []
  ok(cand.length === 1 && cand[0].holderId === 'agent:agent-dead', '宿主 dry-run 只列不在 agents.list() 里的那条', JSON.stringify(cand.map((c) => c.holderId)))
  ok(map.get(sp) === before, '宿主 dry-run 后状态零变化（逐字节）')

  const conf = await lockLocal.execute({ op: 'reap', confirm: true }, REAPER)
  ok(conf.ok === true && conf.data.dryRun === false && conf.data.reaped.length === 1 && conf.data.reaped[0].holderId === 'agent:agent-dead',
    '宿主 confirm:true 只回收那条僵尸声明', JSON.stringify(conf && conf.data && conf.data.reaped && conf.data.reaped.map((c) => c.holderId)))
  const ids = (JSON.parse(map.get(sp)).claims || []).map((c) => c.holderId).sort()
  ok(JSON.stringify(ids) === JSON.stringify(['agent:agent-lived', 'agent:agent-reaper']),
    '宿主 confirm:true 后活着的与自己的一条都没动', JSON.stringify(ids))
}

// ---------- N+1. 循环终止自动释放（0.9.10，宿主内联形态的行为对拍）----------
// 为什么必须在这里测：hostCode 的 agent/status 接线是**另一份实现**（动态插件不接受 import），
// inline-parity 只逐输出对拍了纯函数 releaseOnLoopEnd，证明不了钩子真把「当前 now()」与
// 「holder 自己的 sessionId」传了进去，也证明不了宽限期常量真的是 15 秒。
// 这里把真实注册的 agent/status 处理器抓出来触发，并用**立即 resolve 的假计时器**记录请求的
// 毫秒数（真等 15 秒不现实），断言：未过期声明被释放 + 留言板留痕 + running 会取消。
console.log('# agent/status wiring (host inline form): idle releases after the 15s grace')
{
  const map = new Map()
  const toolsLocal = []
  const handlers = new Map()
  const onEvent = (ev, fn) => { const list = handlers.get(ev) || []; list.push(fn); handlers.set(ev, list); return () => {} }
  const firstHandler = (ev) => (handlers.get(ev) || [])[0]
  const timerRequests = []
  const LIVE = ['agent-idle-host', 'agent-busy-host']
  const status = { 'agent-idle-host': 'running', 'agent-busy-host': 'running' }
  const ctxLocal = {
    fs: {
      resolve: (p, o) => makeTarget(path.isAbsolute(p) ? p : path.resolve(o && o.cwd ? o.cwd : process.cwd(), p)),
      stat: async (t) => (map.has(t.path) ? { version: 1 } : undefined),
      readText: async (t) => map.get(t.path) || '',
      writeText: async (t, c) => { map.set(t.path, c); return { operation: 'create', version: 1 } },
      processPath: (t) => t.path,
      listDir: async () => []
    },
    // 假计时器：立即 resolve（不能真等 15 秒），但把请求的毫秒数记下来。
    timer: { timeout: (ms) => { timerRequests.push(ms); return Promise.resolve() }, interval: () => () => {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: onEvent,
    get: (name) => {
      if (name === 'settings') return { prepareDocument: async () => SETTINGS_DOC }
      if (name === 'sessions') return { get: () => ({ header: { cwd: '/fake/host/loop-end' } }) }
      if (name === 'sessionTitle') return { get: (s) => ({ title: 'Host ' + (s && s.id ? s.id : '?') }) }
      if (name === 'agents') return {
        currentInitiator: () => undefined,
        list: () => LIVE.map((id) => ({ id, status: status[id] })),
        get: (id) => (LIVE.includes(id) ? { id, status: status[id] } : undefined)
      }
      return undefined
    }
  }
  const pluginLocal = new Function('harness', 'ctx', hostCode)(
    { defineTool: (d) => d, registerTool: (_c, t) => { toolsLocal.push(t); return () => {} }, handle: () => () => {} }, ctxLocal)
  await pluginLocal.apply(ctxLocal)
  const lockLocal = toolsLocal.find((t) => t.name === 'collab_lock')
  const IDLE = { agent: { id: 'agent-idle-host' } }
  const BUSY = { agent: { id: 'agent-busy-host' } }
  const onStatus = firstHandler('agent/status')
  ok(typeof onStatus === 'function', 'hostCode registers an agent/status handler', typeof onStatus)

  await lockLocal.execute({ op: 'claim', paths: ['src/host-loop-end/'], ttlSec: 600 }, IDLE)
  await lockLocal.execute({ op: 'claim', paths: ['src/host-busy/'], ttlSec: 600 }, BUSY)
  const sp = (await lockLocal.execute({ op: 'list' }, IDLE)).data.statePath
  timerRequests.length = 0

  // 1) running → idle：武装计时器，宽限期常量必须是 15 秒。
  status['agent-idle-host'] = 'idle'
  onStatus({ agent: { id: 'agent-idle-host' }, status: 'idle' })
  ok(timerRequests.length === 1 && timerRequests[0] === 15000,
    '宿主内联形态的宽限期常量是 15 秒', JSON.stringify(timerRequests))
  await new Promise((r) => setTimeout(r, 60))
  let doc = JSON.parse(map.get(sp))
  ok(!(doc.claims || []).some((c) => c.holderId === 'agent:agent-idle-host'),
    'idle 的会话在宽限到点后被释放（但别人不动）', JSON.stringify((doc.claims || []).map((c) => c.holderId)))
  ok((doc.claims || []).some((c) => c.holderId === 'agent:agent-busy-host'), 'running 的会话声明原样保留', JSON.stringify((doc.claims || []).map((c) => c.holderId)))
  ok((doc.messages || []).length === 1 && doc.messages[0].channel === 'agent:agent-idle-host' && doc.messages[0].author === 'system:dsh-collab',
    '宿主形态同样在留言板留下审计留痕（channel=agent:<sessionId>）', JSON.stringify(doc.messages))

  // 2) 宽限期内恢复 running：撤销（状态零变化）。
  const beforeBusy = map.get(sp)
  status['agent-busy-host'] = 'idle'
  onStatus({ agent: { id: 'agent-busy-host' }, status: 'idle' })
  status['agent-busy-host'] = 'running'
  onStatus({ agent: { id: 'agent-busy-host' }, status: 'running' })
  await new Promise((r) => setTimeout(r, 60))
  ok(map.get(sp) === beforeBusy, '宿主形态：宽限期内恢复 running ⇒ 状态逐字节零变化', 'changed')
}

h.finish()
