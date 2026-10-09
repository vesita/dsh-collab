import { createHarness, readStateMerged } from './_harness.mjs'

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
  // 同类漂移的另一半：参数**集合**也必须与契约 JSON Schema 逐字一致。上面那条只看 mode 的枚举值，
  // 查不出"少了一个参数" —— 而动态形态先前正好缺 `readable`（包形态能收、动态形态静默拒收），
  // 这条差异此前没有任何检查。期望值从 SSOT 读，不在这里再抄一份。
  const schema = JSON.parse(readFileSync(path.join(ROOT, '../src/schema/collab.schema.json'), 'utf8'))
  const keysOf = (t) => (t && t.parameters && t.parameters.properties ? Object.keys(t.parameters.properties).sort() : [])
  const lockKeys = keysOf(lock)
  const lockContractKeys = Object.keys(schema.$defs.colabLockParams.properties).sort()
  ok(JSON.stringify(lockKeys) === JSON.stringify(lockContractKeys),
    'dynamic-form collab_lock advertises exactly the contract parameter set', JSON.stringify({ lockKeys, lockContractKeys }))
  const boardKeys = keysOf(tools.find((t) => t.name === 'collab_board'))
  const boardContractKeys = Object.keys(schema.$defs.colabBoardParams.properties).sort()
  ok(JSON.stringify(boardKeys) === JSON.stringify(boardContractKeys),
    'dynamic-form collab_board advertises exactly the contract parameter set', JSON.stringify({ boardKeys, boardContractKeys }))
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
  // 负向对照：刚建的空状态没有任何 stale 条目 ⇒ 名册说明**不许出现**（降级纪律，与 teamTasks 同源）
  ok(!('holdersNote' in r.data), 'no stale holder -> list adds no holdersNote', JSON.stringify(r.data.holdersNote))
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
  // 跨形态契约：expiredCount 是**数字**（0.13.0 起）。包形态曾把它换成 sweep() 的对象，
  // 两形态就此分叉而没有任何测试会红 —— 这里把"两形态都是数字"钉住。
  ok(typeof after.data.expiredCount === 'number',
    'list.expiredCount is a number (0.13.0 contract, same in both forms)', typeof after.data.expiredCount)

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
  // 名册被读成"过期锁"的实测现场（32 条 stale）：有 stale 条目就必须说明 holders 不是锁
  ok(typeof vis.data.holdersNote === 'string' && vis.data.holdersNote.includes('不是锁'),
    'stale holder present -> list explains that holders is a roster, not locks', JSON.stringify(vis.data.holdersNote))
  // 而静默 30h 的则已被回收（上面的 GHOST 断言）；两者并存正是分级的意义。
}

// ---------- 3b. 名册的**有界**返回（0.14.0，C）----------
// 现场实测：`list` 一次返回 56 行 / 约 10 KB 名册，而每步注入的态势摘要早就把 claims 压到
// 「3 条 × 2 路径」。这一格钉住"上限真的生效"且"截断可察觉"（holdersTotal 恒在）。
console.log('# roster is bounded in list output (0.14.0 C)')
{
  const listR = await call({ op: 'list' }, A)
  const sp = listR.data.statePath
  const doc = JSON.parse(store.get(sp))
  doc.holders = Array.from({ length: 15 }, (_, i) => ({
    holderId: 'agent:ROSTER' + i, name: 'r' + i, kind: 'agent',
    sessionId: 'r' + i, lastSeenAt: Date.now() - 60000 * (i + 1)
  }))
  store.set(sp, JSON.stringify(doc))
  const r = await call({ op: 'list' }, A)
  const hs = r.data.holders || []
  ok(hs.length === 12, 'list returns at most HOLDER_VIEW_LIMIT (12) rows', String(hs.length))
  ok(r.data.holdersTotal === 15, 'holdersTotal reports the full roster size so truncation is visible', String(r.data.holdersTotal))
  ok(hs[0] && hs[0].holderId === 'agent:ROSTER0', 'the bounded window keeps the most recent rows first', String(hs[0] && hs[0].holderId))
  ok(r.data.staleHolders === 0, 'rows inside the TTL are not reported stale (bounding does not lie about staleness)', String(r.data.staleHolders))
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

// ---------- 4b. 只读 op 与写 op 必须落在**同一个状态文件**上（agent 线程化） ----------
// 缺陷：外壳的只读 op（list / overview / status / wait / read）调用 load(agentId) 时
// **丢掉了 agent**，而写路径（mutate(..., agentId, agent)）传了。cwdOf(agentId, agent) 的
// 第一顺位锚点是 agent.session.header.cwd；sessions 服务缺席（或查不到该 id）时，丢了 agent
// 就等于丢掉了唯一可信的 cwd —— claim 落 <agent cwd 派生的文件名>、list 落 default-<hash>.json，
// 刚声明的锁在 list 里一条都看不到。包形态 store.ts 的 6 个 load 调用全都传 agent，这里对齐。
console.log('# read ops read the same state file writes wrote (agent threaded through)')
{
  const { projectStorageFileName } = await import(new URL('../lib/collab-core.js', import.meta.url))
  const map = new Map()
  const AGENT_CWD = '/fake/project/agent-anchored'
  const toolsLocal = []
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
      // **刻意不提供 sessions**：这正是"agent 是唯一可用锚点"的现场。
      if (name === 'sessionTitle') return { get: () => ({ title: 'Anchored Worker' }) }
      return undefined
    }
  }
  const pluginLocal = new Function('harness', 'ctx', hostCode)(
    { defineTool: (d) => d, registerTool: (_c, t) => { toolsLocal.push(t); return () => {} }, handle: () => () => {} }, ctxLocal)
  await pluginLocal.apply(ctxLocal)
  const lockLocal = toolsLocal.find((t) => t.name === 'collab_lock')
  const boardLocal = toolsLocal.find((t) => t.name === 'collab_board')
  const AG = { agent: { id: 'agent-cwd-anchored', session: { header: { cwd: AGENT_CWD } } } }
  const OTHER = { agent: { id: 'agent-other', session: { header: { cwd: AGENT_CWD } } } }
  const expected = path.join(FAKE_HOME, 'collab', 'projects', projectStorageFileName(AGENT_CWD))

  const claimR = await lockLocal.execute({ op: 'claim', paths: ['src/anchored/'], ttlSec: 600 }, AG)
  ok(claimR.ok === true, 'setup: claim 以 agent cwd 为锚点建档成功', JSON.stringify(claimR))
  const listR = await lockLocal.execute({ op: 'list' }, AG)
  ok(listR.data.statePath === expected,
    'list 的 statePath 与核心 projectStorageFileName(agent cwd) 一致（不再退到 default-*.json）', String(listR.data.statePath))
  const seen = (listR.data.claims || []).filter((c) => c.holderId === 'agent:agent-cwd-anchored' && c.paths.includes('src/anchored/'))
  ok(seen.length === 1, 'claim 之后 list 能看到那条声明（读写同一份状态文件）', JSON.stringify(listR.data.claims))
  const ovR = await lockLocal.execute({ op: 'overview' }, AG)
  ok(ovR.data.statePath === expected && ovR.data.totalClaims === 1,
    'overview 也在同一份状态文件上', JSON.stringify({ p: ovR.data.statePath, n: ovR.data.totalClaims }))
  const stR = await lockLocal.execute({ op: 'status', paths: ['src/anchored/'] }, AG)
  ok(stR.data.related.length === 1, 'status 读到的 related 来自同一份状态文件', JSON.stringify(stR.data))
  const wR = await lockLocal.execute({ op: 'wait', paths: ['src/anchored/'], timeoutMs: 200 }, OTHER)
  ok(wR.ok === false && wR.error === 'timeout', 'wait 在同一份状态文件里看到别人的独占声明', JSON.stringify(wR))
  await boardLocal.execute({ op: 'post', channel: 'anchored', body: 'hello' }, AG)
  const msR = await boardLocal.execute({ op: 'read', channel: 'anchored' }, AG)
  ok(msR.ok === true && (msR.data.messages || []).some((m) => m.body === 'hello'),
    'board read 也读同一份状态文件的留言', JSON.stringify(msR.data))
}

// ---------- 5. 态势摘要渲染：文档化具体文案 + 顺序确定性 ----------
// 为什么必须逐字节：摘要文本一旦变样，包形态与动态宿主形态就会给同一组占用注入不同的
// 快照文本 —— 而 DSH 正是按文本逐字节比较来做快照去重的。
// 内联进 hostCode 的核心与 lib/collab-core.js **逐字节同源**（由 tests/collab-inline-parity.mjs
// 的字节一致性断言守护），所以这里不再"抽内联副本再与核心逐输出对拍"——内联之后两边是同一份
// 代码，那种比对不可能失败。保留的是**能独立失败**的具体文案断言（文档化格式），以及下面
// 5b 那条真正跑通宿主注册链路的端到端断言。
console.log('# awareness digest: documented literals + order independence')
{
  const { renderDigest, clockUtc, modeLabel, holderHandle, holderLabel } = await import(new URL('../lib/collab-core.js', import.meta.url))

  ok(holderHandle('agent:one') === 'one', 'holderHandle: agent:<id> -> 前 8 字符', holderHandle('agent:one'))
  ok(holderHandle('agent:session-4942839c-x') === '4942839c', 'holderHandle: 剥掉 session- 前缀', holderHandle('agent:session-4942839c-x'))
  ok(holderHandle('human:console') === '', 'holderHandle: 非 agent: 前缀 -> 空串（渲染侧不附句柄）', holderHandle('human:console'))
  ok(holderLabel('agent:session-4942839c-x', 'Same') === 'Same#4942839c', 'holderLabel: 名字#句柄', holderLabel('agent:session-4942839c-x', 'Same'))
  ok(holderLabel('human:console', 'Same') === 'Same', 'holderLabel: 无句柄时不附 #', holderLabel('human:console', 'Same'))
  const LABELS = { exclusive: '独占', shared: '共享', read: '只读' }
  ok(['exclusive', 'shared', 'read'].every((m) => modeLabel(m) === LABELS[m]),
    'modeLabel: 三个合法 mode 的中文标签', JSON.stringify(['exclusive', 'shared', 'read'].map((m) => [m, modeLabel(m)])))

  // 固定绝对时刻，测试不依赖真实时钟；时钟秒数刻意非 0，证明输出被截到分钟。
  const T0 = Date.UTC(2026, 0, 2, 3, 4, 37)
  ok(clockUtc(T0) === '01-02 03:04Z', 'clockUtc: 固定绝对时刻 -> MM-DD HH:MMZ（秒被截掉）', clockUtc(T0))
  const mkClaim = (o) => Object.assign({
    claimId: 'c_x', holderId: 'agent:x', holderName: 'Worker X',
    paths: ['src/x/'], mode: 'exclusive', ttlSec: 1800,
    expiresAt: T0 + 1800 * 1000, note: '', createdAt: T0
  }, o)

  const c1 = mkClaim({ claimId: 'c_1', holderId: 'agent:one', holderName: 'One', paths: ['src/one/'] })
  const c2 = mkClaim({ claimId: 'c_2', holderId: 'agent:two', holderName: 'Two', paths: ['src/two/'], mode: 'shared', expiresAt: T0 + 900 * 1000, ttlSec: 900 })
  const c3 = mkClaim({ claimId: 'c_3', holderId: 'agent:three', holderName: 'Three', paths: ['src/three/'], mode: 'read', expiresAt: T0 + 3600 * 1000, ttlSec: 3600 })
  const c4 = mkClaim({ claimId: 'c_4', holderId: 'agent:four', holderName: 'Four', paths: ['src/four/'], expiresAt: T0 + 7200 * 1000, ttlSec: 7200 })
  const P = '[dsh-collab] 同项目其他会话当前占用：'
  const S = '。改动这些路径前请先执行 collab_lock op=wait 或用 collab_board 协商。'
  const fixtures = [
    ['single claim', [c1],
      'One#one（独占）占用 src/one/，租约 30 分（01-02 03:04Z–01-02 03:34Z）'],
    ['three claims (按 expiresAt 升序)', [c1, c2, c3],
      'Two#two（共享）占用 src/two/，租约 15 分（01-02 03:04Z–01-02 03:19Z）；' +
      'One#one（独占）占用 src/one/，租约 30 分（01-02 03:04Z–01-02 03:34Z）；' +
      'Three#three（只读）占用 src/three/，租约 60 分（01-02 03:04Z–01-02 04:04Z）'],
    ['more than three claims -> 折叠成计数', [c1, c2, c3, c4],
      'Two#two（共享）占用 src/two/，租约 15 分（01-02 03:04Z–01-02 03:19Z）；' +
      'One#one（独占）占用 src/one/，租约 30 分（01-02 03:04Z–01-02 03:34Z）；' +
      'Three#three（只读）占用 src/three/，租约 60 分（01-02 03:04Z–01-02 04:04Z）；另有 1 条'],
    ['claim with more than two paths -> 只列前 2 个 + 计数', [mkClaim({ claimId: 'c_p', paths: ['a/', 'b/', 'c/', 'd/'] })],
      'Worker X#x（独占）占用 a/ b/ 等 4 条，租约 30 分（01-02 03:04Z–01-02 03:34Z）'],
    ['claim missing holderName -> 回退到 holderId', [mkClaim({ claimId: 'c_n', holderId: 'agent:anon', holderName: undefined })],
      'agent:anon（独占）占用 src/x/，租约 30 分（01-02 03:04Z–01-02 03:34Z）'],
    ['empty claim set -> 只有前后缀', [], '']
  ]
  for (const [label, claims, body] of fixtures) {
    ok(renderDigest(claims) === P + body + S, 'renderDigest 文档化文案：' + label,
      JSON.stringify(renderDigest(claims)))
  }
  // 顺序确定性：打乱输入仍渲染成同一文本（状态文件里的插入顺序不该改变注入文本）。
  ok(renderDigest([c3, c1, c2]) === renderDigest([c1, c2, c3]), 'renderDigest 与输入顺序无关')
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
  // 本插件注册**多个** PromptContext（态势 130 + 委托纪律 131）。只记"最后一个"会让
  // awareness 的断言张冠李戴（delegation 后注册就会顶掉它）—— 所以按 name 索引、并保留全集。
  const registeredContexts = []
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
      if (name === 'systemPrompt') return { context: (c) => { registeredContexts.push(c); if (c.name === 'dsh-collab/awareness') captured = c; return () => {} } }
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

  // ---- 3. PromptContext 集合必须与包形态一致（name + order），纪律文本逐字节同源 ----
  // 缺陷：外壳此前只注册 order 130 的 awareness，整段不注册包形态 src/delegation.ts 的
  // order-131 委托纪律块，且没有任何文档或断言说明这个缺席。这里把"两形态集合一致"钉死。
  {
    const { DELEGATION_DISCIPLINE_TEXT } = await import(new URL('../lib/spec.js', import.meta.url))
    // 包形态：真 Cordis Context + 与 tests/collab-awareness.mjs 同款的假服务
    // （那套服务已被证明足以装载本插件，包括它注册的两个 PromptContext）。
    const cordis = await import('@deepseek-ai/cordis')
      .catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
    const pkgContexts = []
    const pstore = new Map()
    const pctx = new cordis.Context()
    for (const n of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'agents', 'systemPrompt']) pctx.provide(n)
    pctx.set('tools', { register: () => () => {} })
    pctx.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} })
    pctx.set('fs', {
      resolve: async (p) => ({ displayPath: p, path: p }),
      stat: async (t) => (pstore.has(t.path) ? { version: 1 } : null),
      readText: async (t) => pstore.get(t.path) || '',
      writeText: async (t, c) => { pstore.set(t.path, c) },
      processPath: (t) => t.path
    })
    pctx.set('sessions', { get: () => undefined })
    pctx.set('sessionTitle', { get: () => undefined })
    pctx.set('agents', { currentInitiator: () => undefined, list: () => [] })
    pctx.set('systemPrompt', { context: (c) => { pkgContexts.push(c); return () => {} } })
    const pkgPlugin = (await import(new URL('../lib/index.js', import.meta.url))).default
    await pctx.plugin(pkgPlugin)

    const key = (list) => list.map((c) => c.name + '@' + c.order).sort()
    ok(JSON.stringify(key(pkgContexts)) === JSON.stringify(['dsh-collab/awareness@130', 'dsh-collab/delegation@131']),
      '包形态注册 awareness@130 + delegation@131（对照基准）', JSON.stringify(key(pkgContexts)))
    ok(JSON.stringify(key(registeredContexts)) === JSON.stringify(key(pkgContexts)),
      '动态宿主形态注册的 PromptContext 集合与包形态一致（name + order）',
      JSON.stringify({ shell: key(registeredContexts), pkg: key(pkgContexts) }))

    const shellDelegation = registeredContexts.find((c) => c.name === 'dsh-collab/delegation')
    ok(!!shellDelegation && shellDelegation.order === 131 && typeof shellDelegation.text === 'function',
      '外壳注册了 order-131 的 dsh-collab/delegation PromptContext', JSON.stringify(shellDelegation && { name: shellDelegation.name, order: shellDelegation.order }))
    const shellText = shellDelegation ? shellDelegation.text() : null
    ok(shellText === DELEGATION_DISCIPLINE_TEXT,
      '外壳的纪律文本与 src/spec.ts 的 DELEGATION_DISCIPLINE_TEXT 逐字节相同（不是手抄副本）',
      'len shell=' + String(shellText && shellText.length) + ' len spec=' + String(DELEGATION_DISCIPLINE_TEXT.length))
    const pkgDelegation = pkgContexts.find((c) => c.name === 'dsh-collab/delegation')
    ok(!!pkgDelegation && pkgDelegation.text() === DELEGATION_DISCIPLINE_TEXT,
      '包形态的纪律文本同样等于 spec 常量（两形态同一个事实源）')
  }
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
  // 0.13.0：句柄结束 = 自动删除 —— 未过期声明也一并释放（本形态只做状态变更 + 审计留痕，不投递）。
  ok(own.length === 0, '未过期声明在 agent/disposed 之后被释放（句柄结束 = 自动删除）', JSON.stringify(claims.map((c) => c.claimId)))
  // 审计留痕在**留言旁挂**里（0.15.0，R2）：直接读主文件看不到它。
  const afterMerged = readStateMerged((p) => map.get(p), sp)
  ok((afterMerged.messages || []).some((m) => m.channel === 'agent:agent-dead-host' && String(m.body).includes('句柄已结束')),
    '留痕说明是句柄结束（不是"空闲超过 N 秒"）', JSON.stringify((afterMerged.messages || []).map((m) => m.channel)))
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

  // 1) running → idle：武装计时器，宽限期常量必须是 120 秒（0.9.11 从 15 调长）。
  status['agent-idle-host'] = 'idle'
  onStatus({ agent: { id: 'agent-idle-host' }, status: 'idle' })
  ok(timerRequests.length === 1 && timerRequests[0] === 120000,
    '宿主内联形态的宽限期常量是 120 秒', JSON.stringify(timerRequests))
  await new Promise((r) => setTimeout(r, 60))
  let doc = JSON.parse(map.get(sp))
  ok(!(doc.claims || []).some((c) => c.holderId === 'agent:agent-idle-host'),
    'idle 的会话在宽限到点后被释放（但别人不动）', JSON.stringify((doc.claims || []).map((c) => c.holderId)))
  ok((doc.claims || []).some((c) => c.holderId === 'agent:agent-busy-host'), 'running 的会话声明原样保留', JSON.stringify((doc.claims || []).map((c) => c.holderId)))
  // 审计留痕读**主文件 + 旁挂合并**的逻辑状态（0.15.0，R2 起留言在旁挂里）。
  const docMerged = readStateMerged((p) => map.get(p), sp)
  ok((docMerged.messages || []).length === 1 && docMerged.messages[0].channel === 'agent:agent-idle-host' && docMerged.messages[0].author === 'system:dsh-collab',
    '宿主形态同样在留言板留下审计留痕（channel=agent:<sessionId>）', JSON.stringify(docMerged.messages))

  // 2) 宽限期内恢复 running：撤销（状态零变化）。
  const beforeBusy = map.get(sp)
  status['agent-busy-host'] = 'idle'
  onStatus({ agent: { id: 'agent-busy-host' }, status: 'idle' })
  status['agent-busy-host'] = 'running'
  onStatus({ agent: { id: 'agent-busy-host' }, status: 'running' })
  await new Promise((r) => setTimeout(r, 60))
  ok(map.get(sp) === beforeBusy, '宿主形态：宽限期内恢复 running ⇒ 状态逐字节零变化', 'changed')
}

// ---------- G. 写门控（宿主形态）：他人 exclusive 覆盖目标 -> ask；切掉钩子 -> 放行 ----------
// 为什么必须在这里测：hostCode 的 ctx.on('tools/pre-execute') 接线是**另一份实现**
// （动态插件不接受 import）。inline-parity 只守卫纯函数同源，证明不了这个钩子真的挂到了
// Cordis 的事件总线上、也证明不了它就是"拦写"的来源。
//
// 载体：**真实 Cordis Context** + 真实的 `ctx.waterfall('tools/pre-execute', exec, next)` ——
// 与 dsh-tools 的派发形态同构（dsh-tools/lib/index.js:3223 就是这么调的）。
// 受限宿主把同一个 `on` 经 ctx 门面转发到真实 ctx（dsh-cordis-host-runner/lib/types/guard.js:569
// 的 CTX_VERBS 含 'on'；guard.js:746 的 guardedPlugin 把真实 ctx 交给 sandboxContext），
// 而作用域过滤对未打标签的监听器一律放行（dsh-scope/lib/index.js:327 scopeTarget）——
// 所以这里验的语义就是动态形态真跑起来时的语义。
console.log('# 写门控（宿主形态）：他人 exclusive 覆盖目标 -> ask；切掉钩子 -> 放行（负向对照）')
{
  const cordis = await import('@deepseek-ai/cordis')
    .catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
  const { Context } = cordis
  const { projectStorageFileName } = await import(new URL('../lib/collab-core.js', import.meta.url))

  const GATE_CWD = '/fake/project/host-gate'
  const GATE_STATE = path.join(FAKE_HOME, 'collab', 'projects', projectStorageFileName(GATE_CWD))
  const HOUR = 3600 * 1000
  const mkClaimG = (o) => Object.assign({
    claimId: 'c_g', holderId: 'agent:other', holderName: 'Other Session', paths: ['src/x/'],
    mode: 'exclusive', ttlSec: 1800, expiresAt: Date.now() + HOUR, note: '', createdAt: Date.now()
  }, o)

  /** 把一份 hostCode 装进真 Cordis Context；map 是该实例的状态文件。 */
  const bootGate = async (code) => {
    const map = new Map()
    const tools = []
    const harnessG = {
      defineTool: (def) => def,
      registerTool: (_ctx, tool) => { tools.push(tool); return () => {} },
      handle: () => () => {}
    }
    const ctx = new Context()
    for (const n of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'settings']) ctx.provide(n)
    ctx.set('tools', { register: () => () => {}, schemas: () => [], get: () => undefined })
    ctx.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} })
    ctx.set('fs', {
      resolve: (p, o) => makeTarget(path.isAbsolute(p) ? p : path.resolve(o && o.cwd ? o.cwd : process.cwd(), p)),
      stat: async (t) => (map.has(t.path) ? { version: 1, type: 'file' } : undefined),
      readText: async (t) => map.get(t.path) || '',
      writeText: async (t, c) => { map.set(t.path, c); return { operation: 'create', version: 1 } },
      processPath: (t) => t.path,
      listDir: async () => []
    })
    ctx.set('sessions', { get: () => ({ header: { cwd: GATE_CWD } }) })
    ctx.set('sessionTitle', { get: (s) => ({ title: s && s.id === 'agent-host-A' ? 'Host A' : 'Host Gate' }) })
    ctx.set('settings', { prepareDocument: async () => SETTINGS_DOC })
    const plugin = new Function('harness', 'ctx', code)(harnessG, ctx)
    await ctx.plugin(plugin)
    await new Promise((r) => setTimeout(r, 20))
    const lock = tools.find((t) => t.name === 'collab_lock')
    /** 驱动 pre-execute 瀑布（与 dsh-tools 的调用形态同构）。 */
    const pre = async (exec) => {
      let nextCalls = 0
      const decision = await ctx.waterfall('tools/pre-execute', exec, () => {
        nextCalls++
        return Promise.resolve({ kind: 'allow' })
      })
      return { decision, nextCalls }
    }
    return { ctx, map, tools, lock, pre }
  }

  const GA = { agent: { id: 'agent-host-A' } }
  const GB = { agent: { id: 'agent-host-B' } }
  // 注意：`ctx.waterfall` 收到的是 dsh-tools 的 ToolExecution，其 `agent` 就是 agent 对象本身；
  // 而 `lock.execute(args, e)` 收的是 { agent } 包装（外壳的 holderOf(e) 读 e.agent）。两者别混。
  const execOf = (name, args, agent) => ({ name, arguments: args, agent })

  const g = await bootGate(hostCode)
  ok(!!g.lock, '写门控实例：hostCode 仍注册出 collab_lock', JSON.stringify(g.tools.map((t) => t.name)))

  // A 独占 src/gate/（B 的写目标落在其中）。
  const gclaim = await g.lock.execute({ op: 'claim', paths: ['src/gate/'], mode: 'exclusive', ttlSec: 1800 }, GA)
  ok(gclaim.ok === true, 'setup：A 独占 src/gate/ 成功', JSON.stringify(gclaim))

  const w1 = await g.pre(execOf('write', { file_path: 'src/gate/x.ts', content: 'x' }, GB.agent))
  ok(w1.decision.kind === 'ask', '他人持有 exclusive 时，宿主形态的 write 被拦成 ask（本部署 ask = 拒绝）', JSON.stringify(w1.decision))
  ok(w1.nextCalls === 0, 'ask 时不调用 next()（不放行）', 'nextCalls=' + w1.nextCalls)
  const reason = String(w1.decision.reason || '')
  ok(reason.includes('src/gate/x.ts'), 'reason 含被拦的目标路径', reason)
  ok(reason.includes('（独占）'), 'reason 用中文模式标签', reason)
  ok(/\d{2}-\d{2} \d{2}:\d{2}Z–\d{2}-\d{2} \d{2}:\d{2}Z/.test(reason), 'reason 含绝对 UTC 租约窗口', reason)
  ok(!/剩\s*\d+\s*分/.test(reason), 'reason 不含倒计时', reason)

  const e1 = await g.pre(execOf('edit', { file_path: 'src/gate/x.ts', old_string: 'a', new_string: 'b' }, GB.agent))
  ok(e1.decision.kind === 'ask', 'edit 同样被拦', JSON.stringify(e1.decision))
  const abs1 = await g.pre(execOf('write', { file_path: GATE_CWD + '/src/gate/x.ts', content: 'x' }, GB.agent))
  ok(abs1.decision.kind === 'ask', '绝对路径归一后同样被拦', JSON.stringify(abs1.decision))

  // 0.14.0 修正 ①：相对路径**先按 cwd 解析**，所以 `../<项目名>/…` 必须落回项目内被抓到。
  // （旧实现直接 norm(raw)，`..` 被吃掉后不以项目根开头 ⇒ 判"项目外" ⇒ 放行。）
  const rel1 = await g.pre(execOf('write', { file_path: '../host-gate/src/gate/x.ts', content: 'x' }, GB.agent))
  ok(rel1.decision.kind === 'ask',
    '../<项目名>/… 按 cwd 解析后仍落在被占路径里 -> 拦（0.14.0 修的真绕过）', JSON.stringify(rel1.decision))

  // 0.14.0 修正 ②：目标就是**项目根**（'.' / 绝对 cwd 本身）取保守判据 —— 任何他人的未过期
  // exclusive 都算冲突，不能因为"relToProject 返回空串"就整类放行。
  const rootDot = await g.pre(execOf('write', { file_path: '.', content: 'x' }, GB.agent))
  ok(rootDot.decision.kind === 'ask', "目标为项目根（'.'）-> 保守判据拦下", JSON.stringify(rootDot.decision))
  const rootAbs = await g.pre(execOf('write', { file_path: GATE_CWD, content: 'x' }, GB.agent))
  ok(rootAbs.decision.kind === 'ask', '目标为绝对 cwd（项目根）同样被拦', JSON.stringify(rootAbs.decision))

  // 反向：自己的声明不拦自己；兄弟路径不受累；未知工具不拦。
  const own = await g.pre(execOf('write', { file_path: 'src/gate/x.ts', content: 'x' }, GA.agent))
  ok(own.decision.kind === 'allow' && own.nextCalls === 1, '持有者本人写自己的声明 -> 放行且 next() 恰好一次', JSON.stringify(own))
  const sibling = await g.pre(execOf('write', { file_path: 'src/other/x.ts', content: 'x' }, GB.agent))
  ok(sibling.decision.kind === 'allow' && sibling.nextCalls === 1, '他人声明在兄弟路径 -> 放行（窄口径，无假阳性）', JSON.stringify(sibling))
  const shellTool = await g.pre(execOf('bash', { command: 'echo hi > src/gate/x.ts' }, GB.agent))
  ok(shellTool.decision.kind === 'allow' && shellTool.nextCalls === 1,
    'shell 类工具不在路径表里 -> 放行（已知旁路，与包形态一致）', JSON.stringify(shellTool))

  // shared / read 声明不参与门控（与 claim() 的冲突判据、与包形态同源）。
  const share = await bootGate(hostCode)
  await share.lock.execute({ op: 'claim', paths: ['src/shared-only/'], mode: 'shared', ttlSec: 1800 }, GA)
  const shared = await share.pre(execOf('write', { file_path: 'src/shared-only/x.ts', content: 'x' }, GB.agent))
  ok(shared.decision.kind === 'allow' && shared.nextCalls === 1,
    '他人 shared 声明不拦写（声明共用）', JSON.stringify(shared))

  // 可读性：只有 exclusive + readable:false 才拦读。
  const rd = await bootGate(hostCode)
  await rd.lock.execute({ op: 'claim', paths: ['src/open/'], mode: 'exclusive', ttlSec: 1800 }, GA)
  await rd.lock.execute({ op: 'claim', paths: ['src/closed/'], mode: 'exclusive', readable: false, ttlSec: 1800 }, GA)
  const openRead = await rd.pre(execOf('read', { file_path: 'src/open/x.ts' }, GB.agent))
  ok(openRead.decision.kind === 'allow' && openRead.nextCalls === 1, 'readable 缺省（可读）-> 读取放行', JSON.stringify(openRead))
  const closedRead = await rd.pre(execOf('read', { file_path: 'src/closed/x.ts' }, GB.agent))
  ok(closedRead.decision.kind === 'ask', 'readable:false -> 读取也要审批', JSON.stringify(closedRead))
  ok(String(closedRead.decision.reason).includes('不可读'), 'reason 说明对方声明了不可读', String(closedRead.decision.reason))
  const gl = await rd.pre(execOf('glob', { pattern: '**/*.ts', path: 'src/closed/' }, GB.agent))
  ok(gl.decision.kind === 'ask', 'glob（path 参数）同样受可读性约束', JSON.stringify(gl.decision))
  const srView = await rd.pre(execOf('str_replace_editor', { command: 'view', path: 'src/closed/x.ts' }, GB.agent))
  ok(srView.decision.kind === 'ask', 'str_replace_editor command=view 是读 -> 受 readable:false 约束', JSON.stringify(srView.decision))
  const srCreate = await rd.pre(execOf('str_replace_editor', { command: 'create', path: 'src/open/x.ts', file_text: 'x' }, GB.agent))
  ok(srCreate.decision.kind === 'ask', 'str_replace_editor command=create 是写 -> 被拦', JSON.stringify(srCreate.decision))
  const imgRead = await rd.pre(execOf('read_image', { file_path: 'src/closed/a.png' }, GB.agent))
  ok(imgRead.decision.kind === 'ask', 'read_image 已登记（file_path）-> 受可读性约束', JSON.stringify(imgRead.decision))

  // 过期声明不拦（状态文件里直接改成已过期，绕开真实时钟）。
  const exp = await bootGate(hostCode)
  await exp.lock.execute({ op: 'claim', paths: ['src/old/'], mode: 'exclusive', ttlSec: 1800 }, GA)
  const expDoc = JSON.parse(exp.map.get(GATE_STATE))
  for (const c of expDoc.claims) c.expiresAt = Date.now() - 1000
  exp.map.set(GATE_STATE, JSON.stringify(expDoc))
  const gone = await exp.pre(execOf('write', { file_path: 'src/old/x.ts', content: 'x' }, GB.agent))
  ok(gone.decision.kind === 'allow' && gone.nextCalls === 1, '已过期的 exclusive 声明不拦写', JSON.stringify(gone))

  // ── 负向对照：把写门控那一整段切掉 ⇒ 同一个写调用必须放行 ──
  // 这条证明上面的 ask **来自这个钩子**，而不是别的什么（比如 fake ctx 自己造的决定）。
  const GB_MARK = '/*__COLLAB_GATE_BEGIN__*/'
  const GE_MARK = '/*__COLLAB_GATE_END__*/'
  const gi = hostCode.indexOf(GB_MARK)
  const gj = hostCode.indexOf(GE_MARK)
  ok(gi >= 0 && gj > gi, 'hostCode 含写门控区标记（负向对照的切割点）', 'i=' + gi + ' j=' + gj)
  const noGateCode = hostCode.slice(0, gi) + hostCode.slice(gj + GE_MARK.length)
  ok(noGateCode !== hostCode && noGateCode.length < hostCode.length, '切掉后源码确实变了', 'dlen=' + (hostCode.length - noGateCode.length))
  const ng = await bootGate(noGateCode)
  ok(!!ng.lock, '切掉门控后 hostCode 仍能装载并注册出 collab_lock（切的是完整语句，不破坏语法）')
  const ngDoc = JSON.parse(g.map.get(GATE_STATE))
  ng.map.set(GATE_STATE, JSON.stringify(ngDoc))
  const ngWrite = await ng.pre(execOf('write', { file_path: 'src/gate/x.ts', content: 'x' }, GB.agent))
  ok(ngWrite.decision.kind === 'allow' && ngWrite.nextCalls === 1,
    '（负向对照）切掉写门控钩子后，同一条被占路径的写**放行** —— 拦写确实来自这个钩子',
    JSON.stringify(ngWrite))
}

h.finish()
