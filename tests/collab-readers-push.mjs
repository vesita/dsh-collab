import { createHarness } from './_harness.mjs'

// collab-readers-push.mjs
// 功能 D：锁上的读者反向注册（readers）+ 释放后的原生推送（sessionController.prompt）
//         + 0.8.4 的子代理投递回退通道（subagents.sendMessage）。
//
// 覆盖面：
//   1) 纯逻辑：registerReader / dropHolder / readersOf / sweep（0.8.3 起**不清理 readers**）；
//   2) 插件的 post-execute 会把"被通知者"反向登记进 claim.readers，且**不重复**；
//   3) 显式 op=release 之后向活着的 reader 会话推送；排除释放者；同一 (claimId, reader) 只推一次；
//   4) 安全硬约束：冷会话（agents.get 返回 undefined）**两个通道都零调用**（prompt 会 resume，
//      subagents.sendMessage 会对"缺席的直接子会话"cold-resume，绝不允许）；
//   5) best-effort：prompt 抛错 / 超时 / sessionController 缺失都不改变 release 的工具结果；
//   6) agent/disposed 既释放声明、也把自己从所有 readers 摘掉；
//   7) 0.8.3 的可观测性：release 结果上的 notify { readers, pushed, skipped[{sessionId,reason,error?}] }
//      必须把"没有人需要通知"与"通知通道坏了"分开；0.8.3 的三种 reason 语义一字未改；
//   8) 0.8.4 回退通道：prompt 以 **session/agent-busy + details.reason = 'use subagent delivery
//      for this child session'** 被拒时改走 subagents.sendMessage；成功记入 pushed 并在
//      pushedVia 标出通道；不邻接 -> reason 'not-adjacent'；其它回退失败 -> 'subagent-failed'；
//      服务缺失 / 拿不到活 Agent -> 一次都不尝试；**非路由**的 prompt 失败（含同 code 的
//      'prompt rejected'）不触发回退；
//   9) 通知**载体**：不再**手抄** UserMessage 构造函数、也不再有副本（AGENTS.md §1「严禁冒充用户」）
//      —— 构造一律走真实的 `@deepseek-ai/dsh-llm`，只是 source 必须显式非 user；
//      `src/plugin-message.ts` 与 `lib/plugin-message.js` 都已删除；post-execute 的决策对象上
//      **没有** additionalContexts 键、且**原样返回 downstream**；通知改由 `agent.inject` 逐事件
//      投递一条**显式标注来源**的 notice（`source = {kind:'plugin', plugin:'dsh-collab',
//      form:'notice', summary}`）—— 客户端按 `source.kind !== 'user'` 渲染成 **notice 行、
//      不是用户气泡**，`summary` 缺失才会退化成 opaque 行。
//
// 明确不覆盖（无法在没有活部署时验证）：真实 sessionController.prompt 的端到端投递、
// **真实 subagents.sendMessage 的端到端投递**（邻接判定、cold-resume、sender 同一性都只有
// DSH 自己那份实现说了算）、真实 agents 注册表的活性语义、真实会话被 steer/queue 后的行为、
// 以及"agent.inject 的消息真的进了 next-step 收件箱"（那要活部署的会话日志）。下面的 subagents、
// systemPrompt 与 agent 上的 inject 都是**假服务**，验证的是本插件侧的契约
// （调用时机 / 参数形状 / 记账 / 注册形状），不是"真机上一定能投到"。见文件末尾的说明与报告。
//
// 运行：node tests/collab-readers-push.mjs

import path from 'node:path'
import os from 'node:os'
import { readFileSync, existsSync } from 'node:fs'

const cordis = await import('@deepseek-ai/cordis').catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
const { Context } = cordis

const ROOT = path.dirname(new URL(import.meta.url).pathname)
process.env.DSH_HOME = path.join(os.tmpdir(), 'collab-readers-' + process.pid)
delete process.env.DSH_COLLAB_NO_PROMPT_HINT

const core = await import(path.join(ROOT, '../lib/collab-core.js'))
const { projectStateFile } = await import(path.join(ROOT, '../lib/paths.js'))
const mod = await import(path.join(ROOT, '../lib/index.js'))
const collabPlugin = mod.default
const { sessionIdOf } = mod
const { registerReader, dropHolder, readersOf, sweep, init } = core

const h = createHarness({ skipped: true })
// 本文件已无任何"跳过"分支（真身对拍随 src/plugin-message.ts 一起删除了），
// 因此不再解构 skip()：留着它就是死代码，且会暗示这里还有未验证项。
// 汇总行仍由 harness 打印 ", 0 skipped" —— 在没有跳过项时这是实话。
const { ok } = h

const CWD = '/fake/project/readers'
const HOUR = 3600 * 1000
const T0 = 1000000
const mkClaim = (o) => Object.assign({
  claimId: 'c_x', holderId: 'agent:owner', holderName: 'Owner', paths: ['src/x/'],
  mode: 'exclusive', ttlSec: 1800, expiresAt: T0 + 1800 * 1000, note: '', createdAt: T0
}, o)

// ════════════════════════════════════════════════════════════════════════
// 1. 纯逻辑
// ════════════════════════════════════════════════════════════════════════
console.log('# registerReader / dropHolder / readersOf')
{
  const st = init()
  st.claims.push(mkClaim({ claimId: 'c_1', paths: ['src/a/'] }))
  st.claims.push(mkClaim({ claimId: 'c_2', paths: ['src/b/'] }))

  const r1 = registerReader(st, 'c_1', 'agent:B')
  ok(r1.ok === true && r1.changed === true, '第一次登记改变状态', JSON.stringify(r1.data))
  ok(JSON.stringify(st.claims[0].readers) === '["agent:B"]', 'reader 被写进 claim.readers', JSON.stringify(st.claims[0].readers))
  const r2 = registerReader(st, 'c_1', 'agent:B')
  ok(r2.ok === true && r2.changed === false && r2.data.reason === 'already', '同一 holder 重复登记不改变状态', JSON.stringify(r2.data))
  ok(st.claims[0].readers.length === 1, '不产生重复项', JSON.stringify(st.claims[0].readers))
  registerReader(st, 'c_1', 'agent:C')
  registerReader(st, 'c_2', 'agent:B')
  ok(JSON.stringify(st.claims[0].readers) === '["agent:B","agent:C"]', '多个 reader 保序追加', JSON.stringify(st.claims[0].readers))
  const r3 = registerReader(st, 'c_nope', 'agent:B')
  ok(r3.ok === true && r3.changed === false && r3.data.reason === 'no-claim', 'claim 不存在时不报错也不改状态', JSON.stringify(r3.data))

  // 老状态文件里 readers 缺失/有脏值
  st.claims[1].readers = ['agent:B', 'agent:B', 42, '', null, 'agent:D']
  ok(JSON.stringify(readersOf(st.claims[1])) === '["agent:B","agent:D"]', 'readersOf 归一：去重 + 过滤非字符串', JSON.stringify(readersOf(st.claims[1])))
  const r4 = registerReader(st, 'c_2', 'agent:B')
  ok(r4.changed === false, '脏 readers 里已有的 holder 也算已登记')

  // dropHolder：释放自己的声明 + 从**所有** claim 的 readers 摘掉
  const st2 = init()
  st2.claims.push(mkClaim({ claimId: 'c_a', holderId: 'agent:X', paths: ['src/a/'] }))
  st2.claims.push(mkClaim({ claimId: 'c_b', holderId: 'agent:Y', paths: ['src/b/'], readers: ['agent:X', 'agent:Z'] }))
  st2.claims.push(mkClaim({ claimId: 'c_c', holderId: 'agent:Z', paths: ['src/c/'], readers: ['agent:X'] }))
  const d = dropHolder(st2, 'agent:X')
  ok(d.ok === true && d.changed === true, 'dropHolder 改变状态')
  ok(!st2.claims.some(c => c.holderId === 'agent:X'), 'X 自己的声明被释放', JSON.stringify(st2.claims.map(c => c.claimId)))
  ok(d.data.released.length === 1 && d.data.released[0].claimId === 'c_a', 'released 里带回被释放的声明（推送要用）')
  ok(JSON.stringify(st2.claims.find(c => c.claimId === 'c_b').readers) === '["agent:Z"]', 'X 从 c_b 的 readers 里被摘掉')
  ok(JSON.stringify(st2.claims.find(c => c.claimId === 'c_c').readers) === '[]', 'X 从 c_c 的 readers 里被摘掉')
  const d2 = dropHolder(st2, 'agent:X')
  ok(d2.changed === false, '再摘一次无变化（幂等）')
}

console.log('# sweep 不清理 readers（0.8.3：读者只由真正的"结束"信号移除）')
{
  const mk = () => {
    const s = init()
    s.claims.push(mkClaim({ claimId: 'c_1', paths: ['src/a/'], readers: ['agent:LIVE', 'agent:DEAD', 'agent:DEAD2'] }))
    return s
  }
  // 0.8.2 的真缺陷：sweep 曾按 liveness 判据清 readers，而 agents.get() 对
  // **已休眠但可唤回**的会话返回 undefined。于是"只是空闲、并未结束"的读者
  // 会在下一次任意写路径上被删掉，该 claim 释放时已无人可推 —— 静默丢通知。
  // 下面两条就是这条缺陷的**反面断言**。
  const s2 = mk()
  const w2 = sweep(s2, T0)
  ok(JSON.stringify(readersOf(s2.claims[0])) === '["agent:LIVE","agent:DEAD","agent:DEAD2"]',
    'sweep 之后读者登记原样保留（含 agents.get() 为 undefined 的休眠读者）', JSON.stringify(s2.claims[0].readers))
  ok(w2.prunedHolders === 0 && w2.expiredClaims === 0 && w2.droppedMessages === 0,
    'sweep 的诊断计数不含任何 reader 清理', JSON.stringify(w2))
  ok(!('prunedReaders' in w2), 'SweepResult 里不再有会误导人的 prunedReaders 字段', Object.keys(w2).join(','))
  // 即使有人（老代码 / 外部调用）塞进 liveHolders 判据，也一个 reader 都不清：
  // 该选项已从纯逻辑层删除，传进来的第三参不做任何 reader 相关工作。
  const s4 = mk()
  sweep(s4, T0, { liveHolders: (id) => id === 'agent:LIVE' })
  ok(JSON.stringify(readersOf(s4.claims[0])) === '["agent:LIVE","agent:DEAD","agent:DEAD2"]',
    '注入 liveness 判据也不清读者（选项已删除，传了也只是被忽略）', JSON.stringify(s4.claims[0].readers))
  // 有界性：不新增 TTL / 上限 —— readers 挂在 claim 上，claim 一走 readers 随之消亡。
  const s5 = init()
  s5.claims.push(mkClaim({ claimId: 'c_expired', paths: ['src/a/'], readers: ['agent:A', 'agent:B'], expiresAt: T0 - 1 }))
  const w5 = sweep(s5, T0)
  ok(w5.expiredClaims === 1 && s5.claims.length === 0, '过期 claim 被 sweep 移除', JSON.stringify(s5.claims))
  ok(JSON.stringify(s5.claims.flatMap(c => readersOf(c))) === '[]',
    'claim 移除后 readers 不再占用空间（有界性，无需额外 TTL/上限）', JSON.stringify(s5.claims))
  // readers 缺失时不炸
  const s3 = init()
  s3.claims.push(mkClaim({ claimId: 'c_1', paths: ['src/a/'] }))
  const w3 = sweep(s3, T0)
  ok(w3.prunedHolders === 0, '老状态文件缺 readers 字段时不计数也不抛')
}

// ════════════════════════════════════════════════════════════════════════
// 2. 插件级：真实 ctx 上的反向注册与推送
// ════════════════════════════════════════════════════════════════════════
const settle = () => new Promise((r) => setTimeout(r, 25))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeFs(store, versions) {
  return {
    resolve: async (p) => ({ displayPath: p, path: p }),
    stat: async (t) => (store.has(t.path) ? { version: versions.get(t.path) || 1 } : null),
    readText: async (t) => store.get(t.path) || '',
    writeText: async (t, c, o) => {
      if (o && o.kind === 'replaceIfVersion') {
        const cur = store.has(t.path) ? (versions.get(t.path) || 1) : null
        if (cur === null || cur !== o.version) {
          const e = new Error('cannot write "' + t.path + '": file changed since it was read')
          e.code = 'FS_STALE_VERSION'
          throw e
        }
      }
      store.set(t.path, c)
      versions.set(t.path, (versions.get(t.path) || 0) + 1)
    },
    processPath: (t) => t.path
  }
}

/**
 * 真实 RemoteError 的形状（dsh-typert-protocol/lib/types/remote-error.js:9-33）：
 * code / details / isDSHRemoteError 都是**普通字段**，识别按字段而不是 instanceof。
 */
const remoteError = (code, message, details) => {
  const e = new Error(message)
  e.code = code
  e.details = details
  e.isDSHRemoteError = true
  e.name = 'RemoteError'
  return e
}
/**
 * "该会话由子代理路由托管"那条拒绝：文案与 details 逐字取自
 * dsh-api-session-controller/lib/index.js:137，与主 AI 在活进程里实测到的 release 返回同文本。
 */
const routingRejection = (sessionId) => remoteError(
  'session/agent-busy',
  'session "' + sessionId + '" is owned by subagent routing',
  { reason: 'use subagent delivery for this child session' }
)
/**
 * **同一个 code** 的另一处抛出（dsh-api-session-controller/lib/index.js:785）：
 * 普通投递失败也叫 session/agent-busy，但 details.reason 不是那条路由指示。
 * 这是"只看 code 会误判"的活证据。
 */
const busyPlainRejection = () => remoteError('session/agent-busy', 'prompt rejected', { reason: 'Error: inbox closed' })
/** dsh-subagent 的 SubagentError 形状（HarnessError 子类：code 是普通字段，dsh-llm/lib/index.js:121）。 */
const subagentError = (code, message) => {
  const e = new Error(message)
  e.code = code
  e.name = 'SubagentError'
  return e
}

/**
 * @param opts.claims       预置 claims
 * @param opts.liveSessions agents.get 认为"活着"的 sessionId
 * @param opts.sessionRows  sessionController.list 返回的行（running 判定）
 * @param opts.promptThrows prompt 是否抛普通错误
 * @param opts.promptRouting prompt 是否抛"子代理路由托管"拒绝（code + details.reason）
 * @param opts.promptRoutingNoDetails 同上，但**丢掉 details**（只剩 message 兜底判据）
 * @param opts.promptBusyPlain prompt 是否抛同 code 但 reason 非路由的拒绝（index.js:785 分支）
 * @param opts.sendFails    subagents.sendMessage 抛出的错误
 * @param opts.sendHangs    subagents.sendMessage 永不 resolve（验证回退超时护栏）
 * @param opts.withController 是否提供 sessionController
 * @param opts.withSubagents  是否提供 subagents（默认提供；false = 服务缺失）
 * @param opts.agentsGetThrows agents.get 是否抛异常（存活判据本身坏了 — 基础设施故障）
 * @param opts.timerThrowsWhenArmed ctx.timer.timeout 在 armTimer() 之后是否抛异常
 *        （在**读者处理途中**制造一个未预期异常，用来验证 notifyReaders 的整体兜底会不会记账）
 */
async function makeHarness(opts = {}) {
  const store = new Map()
  const versions = new Map()
  const tools = []
  const prompts = []
  const sends = []
  const timerState = { armed: false }
  const statePath = projectStateFile(CWD)
  if (opts.claims) {
    store.set(statePath, JSON.stringify({ schemaVersion: 1, seq: opts.claims.length, claims: opts.claims, messages: [], holders: [] }))
    versions.set(statePath, 1)
  }
  const ctx = new Context()
  const withController = opts.withController !== false
  const withSubagents = opts.withSubagents !== false
  for (const n of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'agents', 'systemPrompt']) ctx.provide(n)
  if (withController) ctx.provide('sessionController')
  if (withSubagents) ctx.provide('subagents')
  ctx.set('tools', { register: (t) => { tools.push(t); return () => {} } })
  ctx.set('timer', {
    timeout: (ms) => {
      // 只在显式 arm 之后抛：插件装载期与其它 op 的 timer 调用不受影响。
      if (opts.timerThrowsWhenArmed && timerState.armed) throw new Error('timer service exploded')
      return new Promise((r) => setTimeout(r, ms))
    },
    interval: () => () => {}
  })
  ctx.set('fs', makeFs(store, versions))
  ctx.set('sessions', { get: () => ({ header: { cwd: CWD } }) })
  ctx.set('sessionTitle', { get: () => ({ title: 'Push Worker' }) })
  ctx.set('agents', {
    currentInitiator: () => undefined,
    list: () => [],
    get: (id) => {
      if (opts.agentsGetThrows) throw new Error('agents registry exploded')
      return (opts.liveSessions || []).includes(id) ? { id } : undefined
    }
  })
  // 假 systemPrompt：只记录注册进来的运行时上下文段（与 tests/collab-awareness.mjs、
  // tests/collab-skill.mjs 的假服务同形），disposer 从活集合里摘掉该段。
  // 本文件只关心**注册形状**（名称 / order），不在这里跑 text() 的取用逻辑
  // （那属于 collab-access-gate.mjs）。
  const contexts = new Map()
  ctx.set('systemPrompt', {
    context: (c) => {
      contexts.set(c.name, c)
      return () => { if (contexts.get(c.name) === c) contexts.delete(c.name) }
    }
  })
  if (withController) {
    ctx.set('sessionController', {
      prompt: async (request, _signal) => {
        prompts.push(request)
        if (opts.promptRouting) throw routingRejection(request.sessionId)
        if (opts.promptRoutingNoDetails) throw remoteError('session/agent-busy', 'session "' + request.sessionId + '" is owned by subagent routing', undefined)
        if (opts.promptBusyPlain) throw busyPlainRejection()
        if (opts.promptThrows) throw new Error('prompt rejected')
        if (opts.promptHangs) return new Promise(() => {}) // 永不 resolve：用于验证超时分支
        return { accepted: true }
      },
      list: async () => ({ items: (opts.sessionRows || []).slice() })
    })
  }
  if (withSubagents) {
    // 假 subagents：只记录调用并复现契约里的失败形状。真实邻接判定在 DSH 那份实现里，
    // 这里**不假装**验证了它。
    ctx.set('subagents', {
      sendMessage: async (sender, targetId, content, options) => {
        sends.push({ sender, targetId, content, options })
        if (opts.sendFails) throw opts.sendFails
        if (opts.sendHangs) return new Promise(() => {})
        return 'msg-' + sends.length
      }
    })
  }
  await ctx.plugin(collabPlugin)
  await settle()
  const readState = () => JSON.parse(store.get(statePath) || '{}')
  const writeState = (doc) => { store.set(statePath, JSON.stringify(doc)); versions.set(statePath, (versions.get(statePath) || 0) + 1) }
  const lock = tools.find((t) => t.name === 'collab_lock')
  // agentId 可以是字符串（构造一个 holder），也可以是**现成的 agent 对象**
  // （0.8.4 用它断言回退 sender 的对象同一性：sendMessage 要求 sender 是 registry 里的同一对象）。
  const callLock = (args, agentId) => {
    const agent = agentId && typeof agentId === 'object' ? agentId : { id: agentId, session: { header: { cwd: CWD } } }
    return lock.execute(args, { agent })
  }
  /** 驱动 post-execute 瀑布：返回 { decision, downstream, nextCalls }（与 collab-access-gate.mjs 同形）。 */
  const post = async (exec, downstream = { kind: 'accept' }) => {
    const produced = { ...downstream }
    let nextCalls = 0
    const decision = await ctx.waterfall('tools/post-execute', exec, produced, () => {
      nextCalls++
      return Promise.resolve(produced)
    })
    return { decision, downstream: produced, nextCalls }
  }
  return { ctx, tools, lock, prompts, sends, store, statePath, readState, writeState, callLock, post, contexts, armTimer: () => { timerState.armed = true } }
}

// ── agent.inject 捕获：通知载体（`form:'notice'` 的显式来源消息）的观测点 ──
// 第 3 节用它断言"通知真的逐事件经 agent.inject 投出、且来源显式非 user"。
// 第 2 节只关心 readers 反向登记，不看 inject。
let injectLog = []
const resetInject = () => { injectLog = [] }
/** 从 inject 记录里取正文（防御性：拿不到就返回空串，让断言失败而不是抛）。 */
const noticeText = (entry) => (entry && entry.message && entry.message.content && entry.message.content[0] && entry.message.content[0].text) || ''
/** 带记录器的假 agent：inject 把每次调用记进 injectLog。 */
const withInject = (id) => ({ id, session: { header: { cwd: CWD } }, inject: (m) => injectLog.push({ agent: id, message: m }) })

const AGENT_ME = withInject('me')
const readExec = (filePath, agent = AGENT_ME) => ({ name: 'read', arguments: { file_path: filePath }, agent })

console.log('# 通知 = 反向注册：被通知的 agent 进入 claim.readers，且不重复')
{
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', holderName: 'Owner', paths: ['src/a/'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: ['me'] })
  await h.post(readExec('src/a/1'))
  await settle()
  ok(JSON.stringify(h.readState().claims[0].readers) === '["agent:me"]', '访问命中后读者被登记', JSON.stringify(h.readState().claims[0].readers))
  // 换一个路径触发**新的**通知签名（去重不会吞掉这次投递）：
  // 命中同一 claim，登记仍是同一 holder —— 不得产生重复项。
  await h.post(readExec('src/a/2'))
  await settle()
  ok(JSON.stringify(h.readState().claims[0].readers) === '["agent:me"]', '同一 claim 同一 agent 不重复登记', JSON.stringify(h.readState().claims[0].readers))
  // 另一个 agent 命中同一 claim -> 追加
  await h.post(readExec('src/a/3', { id: 'other', session: { header: { cwd: CWD } } }))
  await settle()
  ok(JSON.stringify(h.readState().claims[0].readers) === '["agent:me","agent:other"]', '不同 agent 各自登记一次', JSON.stringify(h.readState().claims[0].readers))
}

console.log('# 回归：休眠读者的登记在"任意写路径"的 sweep 之后必须仍然存在（0.8.3 真缺陷）')
{
  // reader 是 agent:idle —— 它**空闲**（agents.get('idle') === undefined）但**并未结束**。
  // 0.8.2 的 mutate() 把这个 liveness 判据注入 sweep()，于是在**任意写路径**上就把这条
  // 登记删了；等 owner 释放 c_lock 时 released[0].readers 已经是空的，谁也通知不到。
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', holderName: 'Owner', paths: ['src/a/'],
    readers: ['agent:idle'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: [] }) // idle 不活
  // 一次与 c_lock 完全无关的写路径 —— 正是"下一次任意写"的那个时刻
  const w = await h.callLock({ op: 'claim', paths: ['src/z/'], ttlSec: 600 }, 'writer')
  ok(w.ok === true, '写路径本身成功', JSON.stringify(w && { ok: w.ok }))
  const doc = h.readState()
  const still = doc.claims.find((c) => c.claimId === 'c_lock')
  ok(still && JSON.stringify(readersOf(still)) === '["agent:idle"]',
    'agents.get() 为 undefined 的休眠读者，其登记在一次无关写路径的 sweep 之后仍然存在',
    JSON.stringify(still && still.readers))
  // 现在 owner 释放这条 claim：休眠读者**不得被唤醒**（not-live），但必须出现在 notify 里；
  // 0.8.2 在这里连读者都已不存在（readers 空 -> 谁都没被通知，且悄无声息）。
  const rel = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  ok(rel.ok === true && Array.isArray(rel.data.released) && rel.data.released.length === 1,
    'release 成功', JSON.stringify(rel && { ok: rel.ok }))
  ok(JSON.stringify(rel.data.released[0].readers) === '["agent:idle"]',
    'release 结果里仍带着那个休眠读者（0.8.2 这里是 []）', JSON.stringify(rel.data.released[0].readers))
  ok(rel.data.notify.readers === 1 && rel.data.notify.pushed.length === 0 &&
     rel.data.notify.skipped.length === 1 && rel.data.notify.skipped[0].reason === 'not-live',
    'notify 如实报出"有 1 个休眠读者、0 条投递"', JSON.stringify(rel.data.notify))
}

console.log('# 显式 op=release 之后向活着的 reader 推送')
{
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', holderName: 'Owner', holderIdShort: undefined, paths: ['src/a/'], readers: ['agent:me', 'agent:ghost'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: ['me'] })
  const res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  ok(res.ok === true, 'release 本身成功', JSON.stringify(res))
  await settle()
  ok(h.prompts.length === 1, '只向活着的 reader 推一条（冷会话 ghost 被丢弃）', JSON.stringify(h.prompts.length))
  const p = h.prompts[0]
  ok(p.sessionId === 'me', 'sessionId 是被通知的会话（holderId 去掉 agent: 前缀）', String(p.sessionId))
  ok(p.mode === 'queue' || p.mode === 'steer', "mode 是 'queue' 或 'steer'", String(p.mode))
  ok(typeof p.requestId === 'string' && p.requestId.startsWith('dsh-collab-'), 'requestId 带插件前缀', String(p.requestId))
  ok(Array.isArray(p.content) && p.content.length === 1 && p.content[0].type === 'text' && typeof p.content[0].text === 'string',
    'content 是 [{type:text,text}] 形状', JSON.stringify(p.content))
  ok(p.content[0].text.includes('src/a/'), '通知文案点出被释放的路径', p.content[0].text)
  // 释放者的显示名走 hname()（sessionTitle 优先），与 claim 的 holderName 同源逻辑；
  // 本 harness 的 sessionTitle 固定返回 'Push Worker'。
  ok(p.content[0].text.includes('Push Worker'), '通知文案点出释放者（会话标题）', p.content[0].text)
  ok(res.data.released[0].readers.includes('agent:me'), 'release 结果里带回 readers（推送的输入）', JSON.stringify(res.data.released[0].readers))

  // ---- 0.8.3：推送结果可观测（notify） ----
  // ok / released / serverTime 的语义与形状必须原样保留，notify 只是**追加**字段。
  ok(res.ok === true && Array.isArray(res.data.released) && typeof res.data.serverTime === 'number',
    'ok/released/serverTime 的语义与形状不变', JSON.stringify({ ok: res.ok, released: Array.isArray(res.data.released), serverTime: typeof res.data.serverTime }))
  const n = res.data.notify
  ok(n && n.readers === 2, 'notify.readers = 该次涉及的去重读者总数', JSON.stringify(n))
  ok(n && JSON.stringify(n.pushed) === '["me"]', 'notify.pushed 含真正投递成功的 sessionId', JSON.stringify(n && n.pushed))
  ok(n && n.skipped.length === 1 && n.skipped[0].sessionId === 'ghost' && n.skipped[0].reason === 'not-live',
    '不活的读者进 notify.skipped 且 reason === not-live', JSON.stringify(n && n.skipped))
  ok(n && n.pushed.length + n.skipped.length === n.readers, '每个候选读者要么 pushed 要么 skipped（无静默丢失）',
    JSON.stringify(n && { readers: n.readers, pushed: n.pushed.length, skipped: n.skipped.length }))
  // ---- 0.8.4：pushedVia 是**追加**字段，既有字段/取值一字未改 ----
  ok(n && Array.isArray(n.pushedVia) && n.pushedVia.length === n.pushed.length,
    'pushedVia 与 pushed 等长（通道信息一一对应，0.8.4 追加）', JSON.stringify(n && n.pushedVia))
  ok(n && JSON.stringify(n.pushedVia) === '[{"sessionId":"me","channel":"session-controller"}]',
    '未走回退的投递在 pushedVia 里标为 session-controller', JSON.stringify(n && n.pushedVia))
  // 有界性：claim 被 release 移除后 readers 一起消亡，不残留、不需额外 TTL。
  const afterDoc = h.readState()
  ok(afterDoc.claims.length === 0 && JSON.stringify(afterDoc.claims.flatMap(c => readersOf(c))) === '[]',
    'claim 被 release 移除后 readers 不残留', JSON.stringify(afterDoc.claims))
}

console.log('# 0.8.4 回退通道：prompt 被"子代理路由托管"拒绝 -> subagents.sendMessage 重投')
{
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', holderName: 'Owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: ['me'], promptRouting: true })
  // 传**现成的 agent 对象**：回退契约要求 sender 是 "exact live Agent"，
  // DSH 用 `ctx.agents.get(sender.id) !== sender` 做对象同一性判定，所以这里能断言同一性。
  const AGENT_OWNER = { id: 'owner', session: { header: { cwd: CWD } } }
  const res = await h.callLock({ op: 'release', claimId: 'c_lock' }, AGENT_OWNER)
  await settle()
  ok(res.ok === true && Array.isArray(res.data.released) && res.data.released.length === 1,
    'release 仍 ok:true 且 released 原样', JSON.stringify({ ok: res.ok, released: res.data.released.length }))
  ok(h.prompts.length === 1, '先走原生 prompt 一次', String(h.prompts.length))
  ok(h.sends.length === 1, '被路由拒绝后，回退通道恰好调用一次', String(h.sends.length))
  const s = h.sends[0]
  ok(s.sender === AGENT_OWNER, 'sender 是释放者那个**活 Agent 对象本身**（同一性，绝不重建）',
    JSON.stringify(s.sender && s.sender.id) + ' same=' + String(s.sender === AGENT_OWNER))
  ok(s.sender && s.sender.id === 'owner', 'sender.id === 释放者', JSON.stringify(s.sender && s.sender.id))
  ok(s.targetId === 'me', 'targetId === 读者 sessionId（holderId 去掉 agent: 前缀）', String(s.targetId))
  ok(Array.isArray(s.content) && s.content.length === 1 && s.content[0].type === 'text' && typeof s.content[0].text === 'string',
    'content 是 [{type:text,text}] 形状', JSON.stringify(s.content))
  ok(s.content[0].text === h.prompts[0].content[0].text, '两个通道投的是**同一条**通知文案', s.content[0].text)
  ok(s.content[0].text.includes('src/a/'), '回退文案点出被释放的路径', s.content[0].text)
  ok(s.options && typeof s.options === 'object' && s.options.signal && typeof s.options.signal.aborted === 'boolean',
    'options.signal 是 AbortSignal（自建 AbortController）', JSON.stringify(s.options && Object.keys(s.options)))
  const n = res.data.notify
  ok(JSON.stringify(n.pushed) === '["me"]', '回退成功记入成功侧 pushed', JSON.stringify(n.pushed))
  ok(JSON.stringify(n.pushedVia) === '[{"sessionId":"me","channel":"subagents"}]',
    'pushedVia 可区分地标出通道 = subagents', JSON.stringify(n.pushedVia))
  ok(n.skipped.length === 0, '回退成功时没有 skipped', JSON.stringify(n.skipped))
  ok(n.pushed.length === n.pushedVia.length, 'pushed 与 pushedVia 等长')
  // 幂等键 (claimId, reader)：回退成功过的一对，重新放回状态文件再释放也不再投。
  h.writeState({ schemaVersion: 1, seq: 1, claims: [mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })], messages: [], holders: [] })
  const res2 = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(h.prompts.length === 1 && h.sends.length === 1, '回退成功过的 (claimId, reader) 不再重投',
    JSON.stringify({ prompts: h.prompts.length, sends: h.sends.length }))
  ok(res2.data.notify.skipped.length === 1 && res2.data.notify.skipped[0].reason === 'already-pushed',
    '第二次 release 如实报 already-pushed', JSON.stringify(res2.data.notify))
}

console.log('# 0.8.4 回退失败分类：不邻接 -> not-adjacent；其它 -> subagent-failed')
{
  const claim = () => mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:sib'], expiresAt: Date.now() + HOUR })
  // 文案逐字取自 dsh-subagent/lib/index.js:968 / :1887（authorizeLineage：durable 父不是 sender）
  const h = await makeHarness({
    claims: [claim()], liveSessions: ['sib'], promptRouting: true,
    sendFails: subagentError('UNAUTHORIZED', 'subagent "sib" belongs to another parent session')
  })
  const res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(res.ok === true, '回退失败不影响 release 的 ok:true')
  ok(h.sends.length === 1, '回退确实被尝试过一次', String(h.sends.length))
  const n = res.data.notify
  ok(n.pushed.length === 0 && JSON.stringify(n.pushedVia) === '[]', '没有成功投递（pushed/pushedVia 都空）', JSON.stringify({ pushed: n.pushed, pushedVia: n.pushedVia }))
  ok(n.skipped.length === 1 && n.skipped[0].sessionId === 'sib' && n.skipped[0].reason === 'not-adjacent',
    '跨父会话的子代理读者 -> reason === not-adjacent（如实记录，不静默）', JSON.stringify(n.skipped))
  ok(n.skipped[0].error === 'subagent "sib" belongs to another parent session', 'skipped[].error 带回真实文案', JSON.stringify(n.skipped[0].error))

  // PARENT_UNAVAILABLE（:1834/:1844）：直接父会话不活 -> 同属邻接前提不成立
  const h2 = await makeHarness({
    claims: [claim()], liveSessions: ['sib'], promptRouting: true,
    sendFails: subagentError('PARENT_UNAVAILABLE', 'direct parent is not live; the message was not delivered')
  })
  const res2 = await h2.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(res2.data.notify.skipped[0].reason === 'not-adjacent', 'PARENT_UNAVAILABLE 也算 not-adjacent', JSON.stringify(res2.data.notify.skipped))

  // NOT_RESUMABLE（:1883/:1889）：目标不是可续子会话 -> 邻接前提不成立
  const h3 = await makeHarness({
    claims: [claim()], liveSessions: ['sib'], promptRouting: true,
    sendFails: subagentError('NOT_RESUMABLE', 'subagent "sib" has no supported continuation state and cannot be resumed; choose a different target')
  })
  const res3 = await h3.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(res3.data.notify.skipped[0].reason === 'not-adjacent', 'NOT_RESUMABLE 也算 not-adjacent', JSON.stringify(res3.data.notify.skipped))

  // UNAUTHORIZED 但说的是"发送者已不是活 Agent"（:1735）—— **不是**邻接问题，
  // 谎报成 not-adjacent 会把人带去排查邻接，所以归入 subagent-failed。
  const h4 = await makeHarness({
    claims: [claim()], liveSessions: ['sib'], promptRouting: true,
    sendFails: subagentError('UNAUTHORIZED', 'message delivery requires the exact live sender agent')
  })
  const res4 = await h4.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(res4.data.notify.skipped[0].reason === 'subagent-failed',
    "sender 不活（不是邻接问题）-> subagent-failed，不谎报 not-adjacent", JSON.stringify(res4.data.notify.skipped))
}

console.log('# 0.8.4 回退前置闸：subagents 服务缺失 / 拿不到活 Agent -> 零 sendMessage 调用、不抛')
{
  const claim = () => mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  // a) 服务缺失
  const h = await makeHarness({ claims: [claim()], liveSessions: ['me'], promptRouting: true, withSubagents: false })
  let threw = null, res = null
  try { res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner') } catch (e) { threw = e }
  await settle()
  ok(threw === null, 'subagents 服务缺失时不抛', threw && String(threw.message))
  ok(h.sends.length === 0, 'subagents 服务缺失 -> 一次都不尝试回退', JSON.stringify(h.sends.length))
  const n = res.data.notify
  ok(n.skipped.length === 1 && n.skipped[0].reason === 'subagent-failed' && n.skipped[0].error === 'no-subagents-service',
    '如实记 skipped（subagent-failed / no-subagents-service）', JSON.stringify(n.skipped))
  ok(n.pushed.length === 0 && JSON.stringify(n.pushedVia) === '[]', '没有任何成功投递记录', JSON.stringify(n.pushedVia))

  // b) agent/disposed 路径拿不到"活 Agent"（那个 agent 正在销毁）
  const dead = mkClaim({ claimId: 'c_dead', holderId: 'agent:dead', holderName: 'Dead', paths: ['src/d/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  const h2 = await makeHarness({ claims: [dead], liveSessions: ['me'], promptRouting: true })
  h2.ctx.emit('agent/disposed', { agent: { id: 'dead' } })
  for (let i = 0; i < 40 && h2.prompts.length === 0; i++) await sleep(25)
  await settle()
  ok(h2.prompts.length === 1, 'disposed 路径仍然尝试了原生 prompt', String(h2.prompts.length))
  ok(h2.sends.length === 0, '拿不到活 Agent -> 零 sendMessage 调用（不回退、也不 cold-resume）', JSON.stringify(h2.sends.length))
}

console.log('# 0.8.4 回归：非"子代理路由"的 prompt 失败一律不触发回退')
{
  const claim = () => mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  // a) 普通 Error（没有 code）
  const h = await makeHarness({ claims: [claim()], liveSessions: ['me'], promptThrows: true })
  const res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(h.prompts.length === 1 && h.sends.length === 0, '普通 prompt 失败 -> 零回退调用', JSON.stringify({ prompts: h.prompts.length, sends: h.sends.length }))
  ok(res.data.notify.skipped[0].reason === 'prompt-failed', '仍记 prompt-failed（0.8.3 语义不变）', JSON.stringify(res.data.notify.skipped))

  // b) **同一个 code**，但 details.reason 不是路由指示（index.js:785 的真实分支：普通投递失败）
  const h2 = await makeHarness({ claims: [claim()], liveSessions: ['me'], promptBusyPlain: true })
  const res2 = await h2.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(h2.prompts.length === 1 && h2.sends.length === 0,
    "session/agent-busy 但 reason 非路由（'prompt rejected'）-> 不回退", JSON.stringify({ prompts: h2.prompts.length, sends: h2.sends.length }))
  ok(res2.data.notify.skipped[0].reason === 'prompt-failed' && res2.data.notify.skipped[0].error === 'prompt rejected',
    '如实报 prompt-failed + 真实文案', JSON.stringify(res2.data.notify.skipped))

  // c) details 万一丢失：message 是 DSH 自己写死的路由诊断 -> 兜底判据仍应回退
  const h3 = await makeHarness({ claims: [claim()], liveSessions: ['me'], promptRoutingNoDetails: true })
  const res3 = await h3.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(h3.sends.length === 1, 'details 丢失但 message 含 "owned by subagent routing" -> 仍回退', JSON.stringify(h3.sends.length))
  ok(JSON.stringify(res3.data.notify.pushedVia) === '[{"sessionId":"me","channel":"subagents"}]', '兜底判据下也正确标注通道', JSON.stringify(res3.data.notify.pushedVia))
}

console.log('# 0.8.4 安全闸门回归：读者不活 -> prompt 与 sendMessage 双双零调用（绝不 cold-resume）')
{
  // 把 prompt 设成"路由拒绝"：如果闸门失守，读者会先撞上路由拒绝、再触发一次回退 ——
  // 而 subagents.sendMessage 对"缺席的直接子会话"会 cold-resume，这条断言就是那道闸。
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:cold'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: [], promptRouting: true })
  const res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(res.ok === true, 'release 仍成功')
  ok(h.prompts.length === 0, '冷读者：prompt 零调用', JSON.stringify(h.prompts.length))
  ok(h.sends.length === 0, '冷读者：subagents.sendMessage 零调用（防止 cold-resume），单独断言', JSON.stringify(h.sends.length))
  const n = res.data.notify
  ok(n.skipped.length === 1 && n.skipped[0].sessionId === 'cold' && n.skipped[0].reason === 'not-live',
    'reason 仍是 not-live（既有取值语义不变）', JSON.stringify(n.skipped))
}

console.log('# 0.8.4 回退通道与 prompt 通道同一套超时护栏')
{
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: ['me'], promptRouting: true, sendHangs: true })
  const t0 = Date.now()
  let threw = null, res = null
  try { res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner') } catch (e) { threw = e }
  const took = Date.now() - t0
  ok(threw === null, '回退超时不冒泡到工具调用', threw && String(threw.message))
  ok(res && res.ok === true, '回退超时时 release 仍 ok:true', JSON.stringify(res && { ok: res.ok }))
  ok(h.sends.length === 1, '回退确实被尝试', String(h.sends.length))
  const n = res.data.notify
  ok(n.skipped.length === 1 && n.skipped[0].reason === 'subagent-failed' && n.skipped[0].error === 'timeout',
    "回退超时 -> subagent-failed + error 'timeout'", JSON.stringify(n.skipped))
  ok(took >= 3000 && took < 15000, '确实等满了推送超时窗口才判定（不是立刻放弃）', String(took) + 'ms')
}

console.log('# 安全硬约束：冷会话零调用')
{
  // readers 里只有一个"不活着"的会话 -> 一次 prompt 都不能发
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:cold'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: [] })
  const res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(res.ok === true, 'release 仍成功')
  ok(h.prompts.length === 0, 'agents.get(sessionId) === undefined -> 绝不调用 prompt（冷会话不得被唤醒）', JSON.stringify(h.prompts))
  // 0.8.3：这种"没有人被通知"必须是**可观测**的，而不是静默
  const n = res.data.notify
  ok(n && n.readers === 1 && n.pushed.length === 0, 'notify 如实报出"有 1 个候选读者、0 条投递"', JSON.stringify(n))
  ok(n && n.skipped.length === 1 && n.skipped[0].sessionId === 'cold' && n.skipped[0].reason === 'not-live',
    '冷会话带 reason === not-live 进 skipped（刻意不唤醒）', JSON.stringify(n && n.skipped))
}

console.log('# 排除释放者自己 / 同一 (claimId, reader) 只推一次')
{
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:owner', 'agent:me'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: ['owner', 'me'] })
  const res0 = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(h.prompts.length === 1 && h.prompts[0].sessionId === 'me', '不推给释放者自己', JSON.stringify(h.prompts.map(p => p.sessionId)))
  ok(res0.data.notify.readers === 1, '释放者自己不计入 notify.readers（候选读者只有 me）', JSON.stringify(res0.data.notify))

  // 把同一条 claim（同 claimId + 同 reader）重新放回状态文件再释放一次：
  // 这一对已经推过，必须**不再**推送（幂等键就是 (claimId, reader)）。
  const restored = { schemaVersion: 1, seq: 1, claims: [mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })], messages: [], holders: [] }
  h.writeState(restored)
  const res2 = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(res2.ok === true, '第二次 release 也成功')
  ok(h.prompts.length === 1, '同一 (claimId, reader) 只推一次', JSON.stringify(h.prompts.length))
  // 0.8.3：被去重挡下的那条也必须可见，reason 限于 already-pushed
  const n2 = res2.data.notify
  ok(n2 && n2.readers === 1 && n2.pushed.length === 0 && n2.skipped.length === 1 &&
     n2.skipped[0].sessionId === 'me' && n2.skipped[0].reason === 'already-pushed',
    '去重挡下的读者进 skipped 且 reason === already-pushed', JSON.stringify(n2))
}

console.log('# mode：跑着的会话用 steer，其余 queue')
{
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:run'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: ['run'], sessionRows: [{ sessionId: 'run', running: true }] })
  await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(h.prompts.length === 1 && h.prompts[0].mode === 'steer', 'SessionSummary.running === true -> steer', JSON.stringify(h.prompts.map(p => p.mode)))

  const h2 = await makeHarness({ claims: [mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:idle'], expiresAt: Date.now() + HOUR })], liveSessions: ['idle'], sessionRows: [{ sessionId: 'idle', running: false }] })
  await h2.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(h2.prompts.length === 1 && h2.prompts[0].mode === 'queue', 'running === false -> queue', JSON.stringify(h2.prompts.map(p => p.mode)))

  // list 缺失 -> 判定不了 -> queue
  const h3 = await makeHarness({ claims: [mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:x'], expiresAt: Date.now() + HOUR })], liveSessions: ['x'] })
  delete h3.ctx.get('sessionController').list
  await h3.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(h3.prompts.length === 1 && h3.prompts[0].mode === 'queue', 'list() 不可用 -> 退回 queue（判定不确定时用 queue）', JSON.stringify(h3.prompts.map(p => p.mode)))
}

console.log('# best-effort：prompt 抛错 / sessionController 缺失都不影响 release 结果')
{
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: ['me'], promptThrows: true })
  let threw = null, res = null
  try { res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner') } catch (e) { threw = e }
  await settle()
  ok(threw === null, 'prompt 抛错不会冒泡到工具调用', threw && String(threw.message))
  ok(res && res.ok === true && res.data.released.length === 1, 'prompt 抛错时 release 仍返回 ok:true + released', JSON.stringify(res && { ok: res.ok }))
  ok(h.prompts.length === 1, '确实尝试推送过（不是没走到）', String(h.prompts.length))
  // 0.8.3：失败必须带回**真实错误**（0.8.2 把它抹平成 undefined，与"没人可推"无法区分）
  const n = res.data.notify
  ok(n && n.readers === 1 && n.pushed.length === 0 && n.skipped.length === 1 &&
     n.skipped[0].sessionId === 'me' && n.skipped[0].reason === 'prompt-failed',
    'prompt 抛错 -> reason === prompt-failed 且 release 仍 ok:true', JSON.stringify(n))
  ok(n && n.skipped[0].error === 'prompt rejected', 'skipped[].error 带回真实错误文本（不再抹平）', JSON.stringify(n && n.skipped[0].error))

  const h2 = await makeHarness({ claims: [mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })], liveSessions: ['me'], withController: false })
  let threw2 = null, res2 = null
  try { res2 = await h2.callLock({ op: 'release', claimId: 'c_lock' }, 'owner') } catch (e) { threw2 = e }
  ok(threw2 === null, 'sessionController 缺失时不抛', threw2 && String(threw2.message))
  ok(res2 && res2.ok === true, 'sessionController 缺失时 release 照常成功', JSON.stringify(res2 && { ok: res2.ok }))
  const n2 = res2.data.notify
  ok(n2 && n2.readers === 1 && n2.skipped.length === 1 && n2.skipped[0].reason === 'prompt-failed' &&
     n2.skipped[0].error === 'no-session-controller',
    '通道整个缺失时读者仍在 skipped 里（不是静默 return）', JSON.stringify(n2))
}

console.log('# 超时：prompt 永不 resolve -> reason 仍是 prompt-failed，但 error 区分出 timeout')
{
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: ['me'], promptHangs: true })
  const t0 = Date.now()
  let threw = null, res = null
  try { res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner') } catch (e) { threw = e }
  const took = Date.now() - t0
  ok(threw === null, '超时不会冒泡到工具调用', threw && String(threw.message))
  ok(res && res.ok === true, '超时时 release 仍 ok:true', JSON.stringify(res && { ok: res.ok }))
  const n = res.data.notify
  ok(n && n.readers === 1 && n.pushed.length === 0 && n.skipped.length === 1 && n.skipped[0].reason === 'prompt-failed',
    '超时的读者进 skipped 且 reason === prompt-failed', JSON.stringify(n))
  ok(n && n.skipped[0].error === 'timeout', '超时用 error === timeout 与"prompt 真的失败"区分', JSON.stringify(n && n.skipped[0].error))
  ok(took >= 3000 && took < 15000, '确实等满了推送超时窗口才判定（不是立刻放弃）', String(took) + 'ms')
}

console.log('# agent/disposed：释放声明 + 从所有 readers 摘掉 + 向读者推送')
{
  const dead = mkClaim({ claimId: 'c_dead', holderId: 'agent:dead', holderName: 'Dead', paths: ['src/d/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  const other = mkClaim({ claimId: 'c_other', holderId: 'agent:owner', paths: ['src/o/'], readers: ['agent:dead', 'agent:me'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [dead, other], liveSessions: ['me'] })
  h.ctx.emit('agent/disposed', { agent: { id: 'dead' } })
  // 轮询等待异步 mutate + 推送落定
  for (let i = 0; i < 40 && h.prompts.length === 0; i++) await sleep(25)
  const doc = h.readState()
  ok(!doc.claims.some(c => c.claimId === 'c_dead'), 'disposed 的 holder 自己的声明被释放', JSON.stringify(doc.claims.map(c => c.claimId)))
  const remain = doc.claims.find(c => c.claimId === 'c_other')
  ok(remain && !remain.readers.includes('agent:dead'), 'disposed 的 holder 从其他 claim 的 readers 里被摘掉', JSON.stringify(remain && remain.readers))
  ok(remain && remain.readers.includes('agent:me'), '其他读者不受影响', JSON.stringify(remain && remain.readers))
  ok(h.prompts.length === 1, '被释放声明的读者（me）收到一条推送', JSON.stringify(h.prompts.length))
  ok(h.prompts[0] && h.prompts[0].sessionId === 'me', '推送目标是活着的读者会话', JSON.stringify(h.prompts.map(p => p.sessionId)))
  ok(h.prompts[0] && h.prompts[0].content[0].text.includes('src/d/'), '推送文案点出被释放的路径', h.prompts[0] && h.prompts[0].content[0].text)
}

console.log('# 已知限制：TTL 自然到期不推送（没有事件源）')
{
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() - 1000 })
  const h = await makeHarness({ claims: [foreign], liveSessions: ['me'] })
  const res = await h.callLock({ op: 'list' }, 'me')
  await h.callLock({ op: 'overview' }, 'me')
  await h.callLock({ op: 'status', paths: ['src/a/'] }, 'me')
  await settle()
  ok(res.ok === true, 'list 正常返回')
  ok(h.prompts.length === 0, '过期声明被 sweep 掉，但不会触发任何推送（无事件源，已知限制）', JSON.stringify(h.prompts.length))
  ok(Array.isArray(res.data.claims) && res.data.claims.length === 0, '过期声明在视图里已被清理', JSON.stringify(res.data && res.data.claims && res.data.claims.length))
  // 只读路径（list/overview/status）只做内存态清理、不回写磁盘；下一次写路径才会落盘。
  // 这里如实断言这个**已知行为**，而不是假装磁盘也被清了。
  h.writeState(h.readState())
  const after = await h.callLock({ op: 'claim', paths: ['src/z/'], ttlSec: 600 }, 'me')
  ok(after.ok === true, '写路径仍然可用')
  ok(h.readState().claims.every((c) => c.expiresAt > Date.now()), '下一次写盘时过期声明被落盘清理')
}

// ════════════════════════════════════════════════════════════════════════
// 2.5 内部故障必须可解释：兜底记账 / 存活判据三态 / tools.ts 兜底形状
// ════════════════════════════════════════════════════════════════════════
console.log('# 推送链路的整体兜底：读者处理途中抛异常必须记账（item 4）')
{
  const foreign = mkClaim({ claimId: 'c_boom', holderId: 'agent:owner', holderName: 'Owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  // timer.timeout 在 arm 之后抛：这条异常发生在**读者处理途中**（pushOne 里建超时护栏那一步），
  // 真缺陷下它会被整体兜底静默吞掉 —— 于是 readers=1 却 pushed+skipped=0，无人能解释。
  const hb = await makeHarness({ claims: [foreign], liveSessions: ['me'], timerThrowsWhenArmed: true })
  hb.armTimer()
  const res = await hb.callLock({ op: 'release', claimId: 'c_boom' }, 'owner')
  const n = res && res.data && res.data.notify
  ok(res.ok === true, 'release 本身仍然成功（推送是旁路，兜底不得影响工具结果）', JSON.stringify(res && { ok: res.ok }))
  ok(n && n.readers === 1 && n.pushed.length === 0, '候选读者 1 人、成功投递 0 条', JSON.stringify(n))
  ok(n && n.pushed.length + n.skipped.length === 1,
    'item 4：pushed + skipped 与候选条数对得上（整体兜底不再静默截断）',
    JSON.stringify(n && { pushed: n.pushed, skipped: n.skipped }))
  ok(n && n.skipped.length === 1 && n.skipped[0].reason === 'internal',
    'item 4：兜底补记的是 reason=internal 的记录', JSON.stringify(n && n.skipped))
  ok(n && n.skipped.length === 1 && String(n.skipped[0].error || '').includes('timer service exploded'),
    'item 4：internal 记录带真实错误文本', JSON.stringify(n && n.skipped))
}

console.log('# tools.ts 的 release 兜底：内部错误与「没有读者」必须可区分（item 5 / item 7）')
{
  const { installStore } = await import(path.join(ROOT, '../lib/store.js'))
  const { installTools } = await import(path.join(ROOT, '../lib/tools.js'))
  const { installPush } = await import(path.join(ROOT, '../lib/push.js'))
  // 直接装 store + tools，并把 notifyReaders 换成**必抛**的假实现：
  // 这是唯一能命中 releaseWithNotify 兜底 catch 的路径（真实 notifyReaders 已经自己记账、不再抛）。
  const boot = async (readerList, pushFactory) => {
    const store = new Map()
    const versions = new Map()
    const statePath = projectStateFile(CWD)
    store.set(statePath, JSON.stringify({
      schemaVersion: 1, seq: 1,
      claims: [mkClaim({ claimId: 'c_x', holderId: 'agent:owner', holderName: 'Owner', paths: ['src/a/'], readers: readerList, expiresAt: Date.now() + HOUR })],
      messages: [], holders: []
    }))
    versions.set(statePath, 1)
    const tools = []
    const ctx = new Context()
    for (const serviceName of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle']) ctx.provide(serviceName)
    ctx.set('tools', { register: (t) => { tools.push(t); return () => {} } })
    ctx.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} })
    ctx.set('fs', makeFs(store, versions))
    ctx.set('sessions', { get: () => ({ header: { cwd: CWD } }) })
    ctx.set('sessionTitle', { get: () => ({ title: 'Push Worker' }) })
    const storeApi = installStore(ctx)
    installTools(ctx, storeApi, pushFactory(ctx, storeApi))
    return tools.find((t) => t.name === 'collab_lock')
  }
  const release = (lock) => lock.execute({ op: 'release', claimId: 'c_x' }, { agent: { id: 'owner', session: { header: { cwd: CWD } } } })
  const lockBoom = await boot(['agent:me'], () => ({ notifyReaders: async () => { throw new Error('notify exploded') } }))
  const a = await release(lockBoom)
  const an = a && a.data && a.data.notify
  ok(a.ok === true, 'notifyReaders 抛错时 release 结果本身不变', JSON.stringify(a && { ok: a.ok }))
  ok(an && an.skipped.length === 1 && an.skipped[0].reason === 'internal' && String(an.skipped[0].error).includes('notify exploded'),
    'item 5：兜底形状是「带错误文本的 internal 记录」，而不是空的 { readers: 0, skipped: [] }', JSON.stringify(an))
  // 对照：真的没有读者时，真实 notifyReaders 仍返回空汇总（不得因为"加了一条 internal"而误报）
  const lockEmpty = await boot([], (c, s) => installPush(c, s))
  const b = await release(lockEmpty)
  const bn = b && b.data && b.data.notify
  ok(bn && bn.readers === 0 && bn.pushed.length === 0 && bn.skipped.length === 0 && bn.pushedVia.length === 0,
    'item 5 对照：真的没有读者时汇总仍为空（readers=0 / skipped=[]）', JSON.stringify(bn))
  ok(an && bn && !(an.readers === bn.readers && an.pushed.length === bn.pushed.length && an.skipped.length === bn.skipped.length),
    'item 5：内部错误与「没有读者」在返回值上可区分（不再逐字同形）', JSON.stringify({ internalError: an, noReaders: bn }))
}

console.log('# 存活判据三态：agents.get 抛异常 ≠ 读者没在线（item 6）')
{
  const foreign = mkClaim({ claimId: 'c_live', holderId: 'agent:owner', holderName: 'Owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  const hf = await makeHarness({ claims: [foreign], agentsGetThrows: true })
  const res = await hf.callLock({ op: 'release', claimId: 'c_live' }, 'owner')
  const n = res && res.data && res.data.notify
  ok(n && n.readers === 1 && n.pushed.length === 0, '判据坏了也一条都不推（安全侧不变）', JSON.stringify(n && { readers: n.readers, pushed: n.pushed }))
  ok(n && n.skipped.length === 1 && n.skipped[0].reason === 'liveness-check-failed',
    'item 6：agents.get 抛异常时记 reason=liveness-check-failed', JSON.stringify(n && n.skipped))
  ok(n && n.skipped.length === 1 && n.skipped[0].reason !== 'not-live',
    'item 6：基础设施故障**不得**被折叠成 not-live（谎报"读者没在线"）', JSON.stringify(n && n.skipped))
  ok(n && String(n.skipped[0].error || '').includes('agents registry exploded'),
    'item 6：第三态带真实错误文本', JSON.stringify(n && n.skipped))
  // 对照：读者真的没在线（agents.get 返回 undefined）仍是 not-live，且不带 error
  const coldClaim = mkClaim({ claimId: 'c_cold', holderId: 'agent:owner', holderName: 'Owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  const hg = await makeHarness({ claims: [coldClaim], liveSessions: [] })
  const cold = await hg.callLock({ op: 'release', claimId: 'c_cold' }, 'owner')
  const cn = cold && cold.data && cold.data.notify
  ok(cn && cn.skipped.length === 1 && cn.skipped[0].reason === 'not-live' && cn.skipped[0].error === undefined,
    'item 6 对照：会话确实没在线时仍是 not-live（既有取值语义不变）', JSON.stringify(cn && cn.skipped))
}

console.log('# 源码级：agent/disposed 路径的注释与实现必须一致（item 8）')
{
  const src = readFileSync(path.join(ROOT, '../src/push.ts'), 'utf8')
  const start = src.indexOf("ctx.on('agent/disposed'")
  const region = start >= 0 ? src.slice(start) : ''
  ok(region.length > 0, '定位到 agent/disposed 处理器区块（扫描本身有效）', 'start=' + start)
  // 原缺陷：`.then(res => { try { … } catch (e) {} })`，注释却讲该路径会如实记账。
  // 这里断言那层**死 catch** 已经不在（notifyReaders 是 async，调用点不会同步抛）。
  const thenStart = region.indexOf('.then(res => {')
  const thenEnd = region.indexOf('.catch(() => {})')
  const thenBody = thenStart >= 0 && thenEnd > thenStart ? region.slice(thenStart, thenEnd) : ''
  ok(thenBody.length > 0 && !/\btry\s*\{/.test(thenBody),
    'item 8：agent/disposed 的 .then 回调里不再有空的 try/catch（死 catch 已删）',
    JSON.stringify(thenBody.slice(0, 120)))
  ok(!/不静默[\s\S]{0,600}?catch\s*\(\w+\)\s*\{\s*\}/.test(region),
    'item 8：区块内不存在「注释宣称不静默 + 紧跟空 catch」的自相矛盾')
  ok(/刻意保持静默/.test(region), 'item 8：该路径的静默被显式写成"刻意保持静默"（注释与实现对齐）')
}

console.log('# 源码级：releaseWithNotify 兜底里不再有「不可能抛」的嵌套 try/catch（item 7）')
{
  const src = readFileSync(path.join(ROOT, '../src/tools.ts'), 'utf8')
  const start = src.indexOf('async function releaseWithNotify')
  const end = src.indexOf('const boardHandler')
  const region = start >= 0 && end > start ? src.slice(start, end) : ''
  ok(region.length > 0, '定位到 releaseWithNotify 区块（扫描本身有效）', 'start=' + start)
  const catchIdx = region.indexOf('} catch (e) {')
  const stop = region.indexOf('return res', catchIdx)
  const catchBody = catchIdx >= 0 && stop > catchIdx ? region.slice(catchIdx, stop) : ''
  ok(catchBody.length > 0, '定位到兜底 catch 的函数体', JSON.stringify(catchBody.slice(0, 80)))
  ok(catchBody.length > 0 && !/\btry\s*\{/.test(catchBody),
    'item 7：兜底 catch 内不再嵌套 try/catch（给普通对象赋字段不可能抛，纯复制粘贴）',
    JSON.stringify(catchBody.slice(0, 160)))
}

// ════════════════════════════════════════════════════════════════════════
// 3. 通知载体：显式来源的 notice 经 agent.inject 逐事件投递（AGENTS.md §1 的可执行版本）
// ════════════════════════════════════════════════════════════════════════
// 旧机制在这里与真实 @deepseek-ai/dsh-llm 的 createUserMessage 现场对拍。真身对拍已随
// 副本（src/plugin-message.ts）一起删除 —— 现在没有"我们的消息实现"可以对拍了，
// 于是这一节改为断言**新载体**的契约：来源显式非 user 的 notice + agent.inject 逐事件投递。
console.log('# 通知载体：手抄的消息副本已删除，通知经 agent.inject 投递 form:notice 的显式来源消息')
{
  // (a) 副本本身**必须不存在**：留着它就会有人再用一次。
  ok(!existsSync(path.join(ROOT, '../lib/plugin-message.js')), '构建产物 lib/plugin-message.js 不存在（副本不许复活）')
  ok(!existsSync(path.join(ROOT, '../src/plugin-message.ts')), '源码 src/plugin-message.ts 不存在（副本不许复活）')

  // (b) post-execute 的决策对象上没有 additionalContexts 键，且**原样返回 downstream 本身**。
  const foreign = mkClaim({ claimId: 'c_carrier', holderId: 'agent:owner', holderName: 'Owner', paths: ['src/a/'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: ['me'] })
  resetInject()
  const { decision, downstream } = await h.post(readExec('src/a/1'))
  ok(decision && !Object.prototype.hasOwnProperty.call(decision, 'additionalContexts'),
    'post-execute 的决策对象上没有 additionalContexts 键', Object.keys(decision || {}).join(','))
  ok(decision === downstream && decision.kind === 'accept',
    'post-execute **原样返回 downstream 本身**（===，不改工具结果）', JSON.stringify(decision))

  // (c) 通知真的经 agent.inject 投出，且来源显式（kind / plugin / form + 非空 summary）。
  ok(injectLog.length === 1, '命中后 agent.inject 恰好调用一次', 'injects=' + injectLog.length)
  const msg = injectLog[0] && injectLog[0].message
  const source = msg && msg.source
  ok(!!source && source.kind === 'plugin' && source.plugin === 'dsh-collab' && source.form === 'notice',
    "inject 收到的消息 source 是 {kind:'plugin', plugin:'dsh-collab', form:'notice'}", JSON.stringify(source))
  ok(!!source && typeof source.summary === 'string' && source.summary.length > 0,
    'source.summary 是非空字符串（notice 缺它会退化成 opaque 行）', JSON.stringify(source && source.summary))
  ok(!!msg && msg.role === 'user' && Object.isFrozen(msg),
    '消息是冻结的 user 角色（role / id / 深冻结都由构造函数补）',
    JSON.stringify({ role: msg && msg.role, frozen: !!(msg && Object.isFrozen(msg)) }))
  ok(noticeText(injectLog[0]).includes('src/a/'), '正文点出被占路径', JSON.stringify(noticeText(injectLog[0])))

  // (d) 载体**不是** systemPrompt 上下文段：假 systemPrompt 是活的（awareness 段被它接住），
  //     所以"没有 access 段"是一条**非空**断言。
  ok(h.contexts.has('dsh-collab/awareness'), '假 systemPrompt 确实接住了其它上下文段（否则下一条是空断言）',
    JSON.stringify([...h.contexts.keys()]))
  ok(!h.contexts.has('dsh-collab/access'), '**不再**注册 dsh-collab/access 上下文段（载体已换）',
    JSON.stringify([...h.contexts.keys()]))
}

h.finish()
