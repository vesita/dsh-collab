import { createHarness } from './_harness.mjs'

// collab-readers-push.mjs
// 功能 D：锁上的读者反向注册（readers）+ 释放后的通知投递。
//
// **0.9.6 的载体变更（本文件的核心回归）**：通知不再经
//   · `sessionController.prompt`（旧主通道），也不再经
//   · `subagents.sendMessage`（0.8.4 的回退通道）。
// 这两个 API 都**只收 content**，消息由宿主代造，宿主写死
// `source: { kind: 'user', rpcId: 'dsh-collab-…' }` —— 实测转录里就是 `user/message` + `kind:'user'`，
// 在 GUI 里渲染成**用户气泡**（落进 next-step 收件箱还会升级成 steering 气泡，与真人共用
// UserStyleBubble 渲染器）。这违反 AGENTS.md §1「严禁冒充用户」。
// 新投递面只有一个：**进程内解析目标 agent**（`ctx.get('agents').get(sessionId)`），解析到就
// `agent.inject(msg)`；消息由**真实的** `@deepseek-ai/dsh-llm` 构造，来源显式非 user：
//   { kind: 'dsh-collab', form: 'notice', summary: boundContextSummary(…) }
// 客户端分流**只看 `source.kind`**（`dsh-client-ui-chat/lib/client.js:8757`，发生在收件箱分类之前），
// `kind !== 'user'` + `form:'notice'` + **非空 summary** ⇒ 独立可折叠的 ContextInjectionRow，不是气泡。
// 解析不到目标 agent 就**如实跳过**（`skipped.reason === 'agent-not-resolvable'`），绝不回退。
//
// 覆盖面：
//   1) 纯逻辑：registerReader / dropHolder / readersOf / sweep（0.8.3 起**不清理 readers**）；
//   2) 插件的 post-execute 会把"被通知者"反向登记进 claim.readers，且**不重复**；
//   3) 显式 op=release 之后向活着的 reader **inject** 一条通知；排除释放者；同一 (claimId, reader) 只投一次；
//   4) 安全硬约束：冷会话（agents.get 返回 undefined）**零投递**（既不 inject，也不碰旧通道）；
//   5) best-effort：inject 抛错 / 投递面缺失都不改变 release 的工具结果，且错误**不被抹平**；
//   6) agent/disposed（W7 起）**不释放未过期声明**、只把自己从所有 readers 摘掉，
//      并因此**不产生**"锁已释放"通知（没有发生释放事件）；只回收已过期的声明；
//   6b) dispose 不缩短租约：未到期声明在 dropHolder 之后、到期之前一直在，由 sweep 在 expiresAt 回收；
//   7) 可观测性：release 结果上的 notify { readers, pushed, pushedVia, skipped[{sessionId,reason,error?}] }
//      必须把"没有人需要通知"与"通知通道坏了"分开；pushedVia 反映真实通道（'inject'）；
//   8) **旧通道彻底删除**：`sessionController.prompt` 与 `subagents.sendMessage` 在整个文件的所有场景里
//      **零调用**（假服务在场并记录调用，所以"零"是一条非空断言）；旧 reason 取值
//      （prompt-failed / not-adjacent / subagent-failed）不再出现在任何 notify 里；
//   9) (a) 投递出去的**每一条**消息来源都显式非 user（kind/form + 非空 ≤120 字符 summary）；
//  10) (b) TOCTOU：判据说活着、投递时解析不到目标 agent -> 投递数 0 且 skipped 带 agent-not-resolvable；
//  11) (c) **负向对照**（手工执行，见下）：把 source 的 kind 改成 'user'（或恢复 controller.prompt）
//      ⇒ (a) 必须变红。RED 原文见交付报告。
//
// 明确不覆盖（无法在没有活部署时验证）：真实 agents 注册表的活性/对象语义、真实会话被 inject 后
// 是否真的进了 next-step 收件箱（那要活部署的会话日志）、真实 `agent.inject` 的同步性。下面的
// agents / sessionController / subagents 都是**假服务**，验证的是本插件侧的契约
// （调用时机 / 参数形状 / 记账 / 来源形状），不是"真机上一定能投到"。见文件末尾的说明与报告。
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
// 本文件已无任何"跳过"分支，因此不再解构 skip()：留着它就是死代码，且会暗示这里还有未验证项。
// 汇总行仍由 harness 打印 ", 0 skipped" —— 在没有跳过项时这是实话。
const { ok } = h

const CWD = '/fake/project/readers'
const HOUR = 3600 * 1000
const T0 = 1000000
const mkClaim = (o) => Object.assign({
  claimId: 'c_x', holderId: 'agent:owner', holderName: 'Owner', paths: ['src/x/'],
  mode: 'exclusive', ttlSec: 1800, expiresAt: T0 + 1800 * 1000, note: '', createdAt: T0
}, o)

/**
 * 全文件共享的投递账本（跨 harness）：每一条经 `agent.inject` 投出去的释放通知都在这里。
 * 末尾的 (a) 断言对**每一条**做来源形状检查 —— 这正是"投递出去的每条消息"的字面要求。
 */
const deliveries = []
/** 全文件共享的 notify 账本：末尾用它做"旧 reason 取值彻底消失"的全局扫描。 */
const allNotifies = []

/**
 * (a) 来源形状：客户端分流只看 `source.kind`（dsh-client-ui-chat/lib/client.js:6058），
 * 且 `form:'notice'` **必须带非空 summary**（否则退化成 opaque 行，client.js:795-800），
 * summary 上限 120 字符由 boundContextSummary 保证。
 */
const sourceShapeOk = (msg) => {
  const s = msg && msg.source
  return !!s && s.kind === 'dsh-collab' && s.form === 'notice' &&
    typeof s.summary === 'string' && s.summary.length > 0 && s.summary.length <= 120
}
const sourceShapeWhy = (msg) => JSON.stringify(msg && msg.source)
/** 旧通道（会冒充用户）的 reason 取值：0.9.6 起不再允许出现。 */
const RETIRED_REASONS = ['prompt-failed', 'not-adjacent', 'subagent-failed']

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

  // dropHolder（W7）：声明（claim）的生命周期**只由租约 expiresAt 决定** —— dispose 不是释放信号。
  // 只回收该 holder **已过期**的声明；未过期的原样保留（连同它自己的 readers）；
  // 仍然把 holderId 从**所有剩余** claim 的 readers 里摘掉。
  const st2 = init()
  st2.claims.push(mkClaim({ claimId: 'c_a', holderId: 'agent:X', paths: ['src/a/'], readers: ['agent:W'], expiresAt: T0 + 1800 * 1000 }))
  st2.claims.push(mkClaim({ claimId: 'c_exp', holderId: 'agent:X', paths: ['src/e/'], expiresAt: T0 - 1 }))
  st2.claims.push(mkClaim({ claimId: 'c_b', holderId: 'agent:Y', paths: ['src/b/'], readers: ['agent:X', 'agent:Z'] }))
  st2.claims.push(mkClaim({ claimId: 'c_c', holderId: 'agent:Z', paths: ['src/c/'], readers: ['agent:X'] }))
  const d = dropHolder(st2, 'agent:X', T0)
  // 取值一律先 find 再判空：负向对照（改回旧语义）时声明会被提前删掉，
  // 断言必须把每条都如实报出来，而不是在第一条上抛 TypeError 中断整个文件。
  const keptA = st2.claims.find(c => c.claimId === 'c_a')
  const keptB = st2.claims.find(c => c.claimId === 'c_b')
  const keptC = st2.claims.find(c => c.claimId === 'c_c')
  ok(d.ok === true && d.changed === true, 'dropHolder 改变状态')
  ok(!!keptA, '未过期声明**不**被释放（dispose 不缩短租约）', JSON.stringify(st2.claims.map(c => c.claimId)))
  ok(JSON.stringify(keptA && keptA.readers) === '["agent:W"]', '未过期声明连同它自己的 readers 原样保留', JSON.stringify(keptA && keptA.readers))
  ok(!st2.claims.some(c => c.claimId === 'c_exp'), '已过期声明被回收', JSON.stringify(st2.claims.map(c => c.claimId)))
  ok(d.data.released.length === 1 && d.data.released[0].claimId === 'c_exp', 'released 只含**真正被删掉**的声明（推送要用）', JSON.stringify(d.data.released.map(x => x.claimId)))
  ok(JSON.stringify(keptB && keptB.readers) === '["agent:Z"]', 'X 从 c_b 的 readers 里被摘掉', JSON.stringify(keptB && keptB.readers))
  ok(JSON.stringify(keptC && keptC.readers) === '[]', 'X 从 c_c 的 readers 里被摘掉', JSON.stringify(keptC && keptC.readers))
  const d2 = dropHolder(st2, 'agent:X', T0)
  ok(d2.changed === false, '再摘一次无变化（幂等）', JSON.stringify(d2.data))
  // 只摘 reader、不动任何声明的形态：changed 必须为 true（否则那一次 mutate 不会落盘）
  const st3 = init()
  st3.claims.push(mkClaim({ claimId: 'c_r', holderId: 'agent:Y', paths: ['src/r/'], readers: ['agent:X'], expiresAt: T0 + 1800 * 1000 }))
  const d3 = dropHolder(st3, 'agent:X', T0)
  ok(d3.changed === true && d3.data.released.length === 0, '只有 reader 可摘时 changed=true 且 released 为空', JSON.stringify(d3.data))
  ok(st3.claims.length === 1, '没有任何声明被回收', JSON.stringify(st3.claims.map(c => c.claimId)))
}

console.log('# dropHolder 不缩短租约：未到期声明在 dropHolder 之后、到期之前一直存活（租约是唯一回收机制）')
{
  // 与真实负载同构：一个还活着的 holder + 一条到期时刻已知的声明（默认 ttlSec=1800）。
  const s = init()
  const EXPIRY = T0 + 1800 * 1000
  s.claims.push(mkClaim({ claimId: 'c_alive', holderId: 'agent:LIVE', paths: ['src/a/'], expiresAt: EXPIRY }))
  const r = dropHolder(s, 'agent:LIVE', T0)
  ok(r.changed === false, '未到期 ⇒ dropHolder 一条声明都没删（changed=false）', JSON.stringify(r.data))
  ok(s.claims.some(c => c.claimId === 'c_alive'), 'dropHolder 之后声明仍在（dispose 不缩短租约）', JSON.stringify(s.claims.map(c => c.claimId)))
  const w1 = sweep(s, EXPIRY - 1)
  ok(w1.expiredClaims === 0 && s.claims.some(c => c.claimId === 'c_alive'), '到期前 1ms 的 sweep 也不会回收它', JSON.stringify(w1))
  const w2 = sweep(s, EXPIRY)
  ok(w2.expiredClaims === 1 && !s.claims.some(c => c.claimId === 'c_alive'), '恰好在 expiresAt 由 sweep 回收 —— 租约是唯一的回收机制', JSON.stringify(w2))
  // 安全侧后果（如实记录，不藏）：会话死亡后它的声明会一直占用到租约到期，
  // 期间其他会话必须 op=wait 或协商；op=heartbeat 仍是唯一的续租方式。
  // 也就是说"等待路径空闲"不再是可靠判据 —— 下面这条就是那条后果的可执行形式。
  const s2 = init()
  s2.claims.push(mkClaim({ claimId: 'c_dead_holder', holderId: 'agent:DEAD', paths: ['src/a/'], expiresAt: EXPIRY }))
  dropHolder(s2, 'agent:DEAD', T0)
  const stillBlocking = s2.claims.filter(c => c.mode === 'exclusive' && c.paths.some(p => p.startsWith('src/a')))
  ok(stillBlocking.length === 1, '安全侧后果：dispose 之后该路径仍被占用（他人必须 wait/协商，直到租约到期）', JSON.stringify(stillBlocking.map(c => c.claimId)))
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
// 2. 插件级：真实 ctx 上的反向注册与投递
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
 * @param opts.claims       预置 claims
 * @param opts.liveSessions agents.get 认为"活着"的 sessionId（默认给一个带 inject 的假 agent）
 * @param opts.agentObjects  指定 sessionId -> 现成的 agent 对象（断言对象同一性时用）
 * @param opts.agentsWithoutInject 活着的会话返回**没有 inject 面**的对象（受限宿主）
 * @param opts.injectThrows  假 agent 的 inject 抛错（验证失败被如实记下、不抹平）
 * @param opts.agentsVanishAfterProbe 第一次 agents.get（存活判据）返回活 agent，之后返回 undefined
 *        —— 复现 TOCTOU 竞态：(b) 解析不到目标 agent 时必须如实跳过
 * @param opts.withAgents    false = agents 服务缺失（投递面整个不在）
 * @param opts.agentsGetThrows agents.get 是否抛异常（存活判据本身坏了 — 基础设施故障）
 * @param opts.withController / withSubagents 是否提供**旧通道**的假服务（默认提供；
 *        它们在本文件里的用途只有一个：记录调用并断言**零调用**）
 */
async function makeHarness(opts = {}) {
  const store = new Map()
  const versions = new Map()
  const tools = []
  // 旧通道的观测点：本文件所有场景都必须保持 0（"绝不冒充用户"的可执行断言）。
  const prompts = []
  const sends = []
  // 新通道的观测点：经 agent.inject 投出去的释放通知。
  const injects = []
  const getCalls = new Map()
  const statePath = projectStateFile(CWD)
  if (opts.claims) {
    store.set(statePath, JSON.stringify({ schemaVersion: 1, seq: opts.claims.length, claims: opts.claims, messages: [], holders: [] }))
    versions.set(statePath, 1)
  }
  const ctx = new Context()
  const withAgents = opts.withAgents !== false
  const withController = opts.withController !== false
  const withSubagents = opts.withSubagents !== false
  for (const n of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'systemPrompt']) ctx.provide(n)
  if (withAgents) ctx.provide('agents')
  if (withController) ctx.provide('sessionController')
  if (withSubagents) ctx.provide('subagents')
  ctx.set('tools', { register: (t) => { tools.push(t); return () => {} } })
  ctx.set('timer', {
    timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    interval: () => () => {}
  })
  ctx.set('fs', makeFs(store, versions))
  ctx.set('sessions', { get: () => ({ header: { cwd: CWD } }) })
  ctx.set('sessionTitle', { get: () => ({ title: 'Push Worker' }) })
  /** 活着的读者会话返回的假 agent：inject 记录到本 harness + 全文件账本。 */
  const liveAgent = (id) => {
    if (opts.agentObjects && opts.agentObjects[id]) return opts.agentObjects[id]
    if (opts.agentsWithoutInject) return { id }
    return {
      id,
      inject: (message) => {
        if (opts.injectThrows) throw new Error('inject channel exploded')
        injects.push({ sessionId: id, message })
        deliveries.push({ sessionId: id, message })
      }
    }
  }
  if (withAgents) {
    ctx.set('agents', {
      currentInitiator: () => undefined,
      list: () => [],
      get: (id) => {
        if (opts.agentsGetThrows) throw new Error('agents registry exploded')
        const n = (getCalls.get(id) || 0) + 1
        getCalls.set(id, n)
        // TOCTOU：存活判据那次探测还能拿到 agent，真正投递时它已经没了。
        if (opts.agentsVanishAfterProbe && n > 1) return undefined
        return (opts.liveSessions || []).includes(id) ? liveAgent(id) : undefined
      }
    })
  }
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
    // 旧主通道的假件：**只记录调用**。任何一次调用都意味着"通知又开始冒充用户"，
    // 由各场景里的 `h.prompts.length === 0` 断言变红。
    ctx.set('sessionController', {
      prompt: async (request, _signal) => {
        prompts.push(request)
        return { accepted: true }
      },
      list: async () => ({ items: [] })
    })
  }
  if (withSubagents) {
    // 旧回退通道的假件：同样**只记录调用**，必须恒为 0。
    ctx.set('subagents', {
      sendMessage: async (sender, targetId, content, options) => {
        sends.push({ sender, targetId, content, options })
        return 'msg-' + sends.length
      }
    })
  }
  await ctx.plugin(collabPlugin)
  await settle()
  const readState = () => JSON.parse(store.get(statePath) || '{}')
  const writeState = (doc) => { store.set(statePath, JSON.stringify(doc)); versions.set(statePath, (versions.get(statePath) || 0) + 1) }
  const lock = tools.find((t) => t.name === 'collab_lock')
  // agentId 可以是字符串（构造一个 holder），也可以是**现成的 agent 对象**。
  const callLock = async (args, agentId) => {
    const agent = agentId && typeof agentId === 'object' ? agentId : { id: agentId, session: { header: { cwd: CWD } } }
    const res = await lock.execute(args, { agent })
    if (res && res.data && res.data.notify) allNotifies.push(res.data.notify)
    return res
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
  return { ctx, tools, lock, prompts, sends, injects, store, statePath, readState, writeState, callLock, post, contexts }
}

// ── agent.inject 捕获（访问通知）：第 3 节用它断言 access 通知的载体 ──
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
  ok(h.injects.length === 0, '休眠读者一条都没投（新通道也不会唤醒冷会话）', JSON.stringify(h.injects.length))
}

console.log('# 显式 op=release 之后向活着的 reader 投递（新通道：进程内解析 agent + inject）')
{
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', holderName: 'Owner', holderIdShort: undefined, paths: ['src/a/'], readers: ['agent:me', 'agent:ghost'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: ['me'] })
  const res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  ok(res.ok === true, 'release 本身成功', JSON.stringify(res))
  await settle()
  // 旧通道一次都没碰：它们是"宿主代造消息 → kind:'user' → 用户气泡"的来源。
  ok(h.prompts.length === 0 && h.sends.length === 0,
    '旧通道零调用（sessionController.prompt / subagents.sendMessage）',
    JSON.stringify({ prompts: h.prompts.length, sends: h.sends.length }))
  ok(h.injects.length === 1, '只向活着的 reader 投一条（冷会话 ghost 被丢弃）', JSON.stringify(h.injects.length))
  const inj = h.injects[0]
  ok(inj.sessionId === 'me', '投递目标是活着的读者会话（holderId 去掉 agent: 前缀）', String(inj.sessionId))
  // ---- (a) 来源形状：显式非 user，且 notice 带非空 ≤120 字符 summary ----
  const msg = inj.message
  const source = msg && msg.source
  ok(sourceShapeOk(msg), '(a) source 是 {kind:dsh-collab, form:notice}（客户端据此渲染成 notice 行，不是气泡）', sourceShapeWhy(msg))
  ok(!!source && typeof source.summary === 'string' && source.summary.length > 0 && source.summary.length <= 120,
    '(a) source.summary 是非空字符串且 ≤120 字符（缺它会退化成 opaque 行）', JSON.stringify(source && source.summary))
  ok(!!msg && msg.role === 'user' && Object.isFrozen(msg),
    '消息是冻结的 user 角色（role / id / 深冻结都由真实构造函数补）',
    JSON.stringify({ role: msg && msg.role, frozen: !!(msg && Object.isFrozen(msg)) }))
  ok(Array.isArray(msg.content) && msg.content.length === 1 && msg.content[0].type === 'text' && typeof msg.content[0].text === 'string',
    'content 是 [{type:text,text}] 形状（模型可见全文）', JSON.stringify(msg && msg.content))
  ok(noticeText(inj).includes('src/a/'), '通知文案点出被释放的路径', noticeText(inj))
  // 释放者的显示名走 hname()（sessionTitle 优先），与 claim 的 holderName 同源逻辑；
  // 本 harness 的 sessionTitle 固定返回 'Push Worker'。
  ok(noticeText(inj).includes('Push Worker'), '通知文案点出释放者（会话标题）', noticeText(inj))
  ok(noticeText(inj).includes('（独占）'), '通知正文用中文模式标签（W9 文案中文化；数据取值仍是 exclusive）', noticeText(inj))
  ok(res.data.released[0].readers.includes('agent:me'), 'release 结果里带回 readers（投递的输入）', JSON.stringify(res.data.released[0].readers))

  // ---- 推送结果可观测（notify）：ok / released / serverTime 的语义与形状必须原样保留 ----
  ok(res.ok === true && Array.isArray(res.data.released) && typeof res.data.serverTime === 'number',
    'ok/released/serverTime 的语义与形状不变', JSON.stringify({ ok: res.ok, released: Array.isArray(res.data.released), serverTime: typeof res.data.serverTime }))
  const n = res.data.notify
  ok(n && n.readers === 2, 'notify.readers = 该次涉及的去重读者总数', JSON.stringify(n))
  ok(n && JSON.stringify(n.pushed) === '["me"]', 'notify.pushed 含真正投递成功的 sessionId', JSON.stringify(n && n.pushed))
  ok(n && n.skipped.length === 1 && n.skipped[0].sessionId === 'ghost' && n.skipped[0].reason === 'not-live',
    '不活的读者进 notify.skipped 且 reason === not-live', JSON.stringify(n && n.skipped))
  ok(n && n.pushed.length + n.skipped.length === n.readers, '每个候选读者要么 pushed 要么 skipped（无静默丢失）',
    JSON.stringify(n && { readers: n.readers, pushed: n.pushed.length, skipped: n.skipped.length }))
  // pushedVia 反映**真实通道**：'inject'（不是已删除的 'session-controller' / 'subagents'）。
  ok(n && Array.isArray(n.pushedVia) && n.pushedVia.length === n.pushed.length,
    'pushedVia 与 pushed 等长（通道信息一一对应）', JSON.stringify(n && n.pushedVia))
  ok(n && JSON.stringify(n.pushedVia) === '[{"sessionId":"me","channel":"inject"}]',
    "pushedVia 标出真实通道 = 'inject'（进程内 agents 解析 + agent.inject）", JSON.stringify(n && n.pushedVia))
  // 有界性：claim 被 release 移除后 readers 一起消亡，不残留、不需额外 TTL。
  const afterDoc = h.readState()
  ok(afterDoc.claims.length === 0 && JSON.stringify(afterDoc.claims.flatMap(c => readersOf(c))) === '[]',
    'claim 被 release 移除后 readers 不残留', JSON.stringify(afterDoc.claims))
}

console.log('# (a) summary 由 boundContextSummary 截断：超长路径表也不会超过 120 字符')
{
  const long = mkClaim({
    claimId: 'c_long', holderId: 'agent:owner', holderName: 'Owner',
    paths: [
      'src/very/long/path/segment-A/aaaaaaaa/', 'src/very/long/path/segment-B/bbbbbbbb/',
      'src/very/long/path/segment-C/cccccccc/', 'src/very/long/path/segment-D/dddddddd/',
      'src/very/long/path/segment-E/eeeeeeee/'
    ],
    readers: ['agent:me'], expiresAt: Date.now() + HOUR
  })
  const h = await makeHarness({ claims: [long], liveSessions: ['me'] })
  await h.callLock({ op: 'release', claimId: 'c_long' }, 'owner')
  await settle()
  const s = h.injects[0] && h.injects[0].message && h.injects[0].message.source
  ok(h.injects.length === 1 && !!s && typeof s.summary === 'string' && s.summary.length > 0 && s.summary.length <= 120,
    '(a) 超长路径表下 summary 仍非空且 ≤120 字符（120 上限由 boundContextSummary 保证）',
    JSON.stringify({ len: s && s.summary.length, summary: s && s.summary }))
  ok(noticeText(h.injects[0]).length > 120,
    '对照：模型可见正文不受 120 限制（summary 只是折叠态的一句话）', String(noticeText(h.injects[0]).length))
}

console.log('# 旧通道整体删除：即使读者是"子代理路由托管"的会话也不再走 prompt/sendMessage')
{
  // 0.8.4 的场景：读者会话由子代理路由托管，`sessionController.prompt` 会被 DSH 结构化拒绝，
  // 当时据此改走 `subagents.sendMessage`。**两条都是宿主代造消息、来源被写成 kind:'user'**，
  // 所以现在整条链路删掉了：投递只走进程内 agents 解析 + inject，与"路由托管"无关。
  const claim = () => mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', holderName: 'Owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [claim()], liveSessions: ['me'] })
  const res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(res.ok === true, 'release 仍 ok:true', JSON.stringify(res && { ok: res.ok }))
  ok(h.prompts.length === 0, 'prompt 零调用（不再是投递面）', String(h.prompts.length))
  ok(h.sends.length === 0, 'subagents.sendMessage 零调用（旧回退通道已删除）', String(h.sends.length))
  ok(h.injects.length === 1, '投递照常发生（解析到活 agent 就 inject）', String(h.injects.length))
  ok(JSON.stringify(res.data.notify.pushedVia) === '[{"sessionId":"me","channel":"inject"}]',
    "记账标出真实通道 'inject'", JSON.stringify(res.data.notify.pushedVia))

  // 传**现成的 agent 对象**（对象同一性）：解析到就直接调它自己的 inject，绝不重建对象。
  const LIVE_ME = withInject('me')
  resetInject()
  const h2 = await makeHarness({ claims: [claim()], liveSessions: ['me'], agentObjects: { me: LIVE_ME } })
  const res2 = await h2.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(res2.ok === true, 'release 仍 ok:true（现成 agent 对象场景）', JSON.stringify(res2 && { ok: res2.ok }))
  ok(h2.prompts.length === 0 && h2.sends.length === 0, '旧通道仍然零调用', JSON.stringify({ prompts: h2.prompts.length, sends: h2.sends.length }))
  ok(injectLog.length === 1 && injectLog[0].agent === 'me',
    '投递给的是 agents 注册表里那个**现成 agent 对象**（不重建）', JSON.stringify(injectLog.map(e => e.agent)))
  ok(sourceShapeOk(injectLog[0] && injectLog[0].message), '(a) 该投递的来源形状同样正确', sourceShapeWhy(injectLog[0] && injectLog[0].message))

  // 幂等键 (claimId, reader)：投递成功过的一对，重新放回状态文件再释放也不再投。
  const restored = { schemaVersion: 1, seq: 1, claims: [claim()], messages: [], holders: [] }
  h.writeState(restored)
  const res3 = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(h.prompts.length === 0 && h.sends.length === 0 && h.injects.length === 1,
    '已投递过的 (claimId, reader) 不再重投，且旧通道仍然零调用',
    JSON.stringify({ injects: h.injects.length, prompts: h.prompts.length, sends: h.sends.length }))
  ok(res3.data.notify.skipped.length === 1 && res3.data.notify.skipped[0].reason === 'already-pushed',
    '第二次 release 如实报 already-pushed', JSON.stringify(res3.data.notify))
}

console.log('# (b) 解析不到目标 agent：投递数 0 + skipped.reason = agent-not-resolvable（如实跳过，绝不冒充）')
{
  // TOCTOU：存活判据（第一次 agents.get）看到 agent 活着，真正投递时（第二次 get）它已经不在了。
  // 旧实现在这里会掉头去 prompt / sendMessage —— 那正是"冒充用户"的来源。
  // 新实现必须**如实跳过**：投递数 0，skipped 里带明确的 agent-not-resolvable。
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', holderName: 'Owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: ['me'], agentsVanishAfterProbe: true })
  const res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(res.ok === true, 'release 本身仍然成功（投递失败是旁路）', JSON.stringify(res && { ok: res.ok }))
  ok(h.injects.length === 0, '(b) 解析不到目标 agent -> 投递数 0', JSON.stringify(h.injects.length))
  ok(h.prompts.length === 0 && h.sends.length === 0,
    '(b) 也**没有**回退到任何会冒充用户的旧通道', JSON.stringify({ prompts: h.prompts.length, sends: h.sends.length }))
  const n = res.data.notify
  ok(n && n.pushed.length === 0 && JSON.stringify(n.pushedVia) === '[]', '(b) 没有成功投递记录', JSON.stringify({ pushed: n && n.pushed, pushedVia: n && n.pushedVia }))
  ok(n && n.skipped.length === 1 && n.skipped[0].sessionId === 'me' && n.skipped[0].reason === 'agent-not-resolvable',
    "(b) skipped 里带新取值 'agent-not-resolvable'（如实跳过，不冒充）", JSON.stringify(n && n.skipped))
  ok(n && n.skipped[0].error === 'agent-not-resolvable', '(b) 该记录带同一句话的错误文本，便于排查', JSON.stringify(n && n.skipped[0].error))
  ok(n && n.pushed.length + n.skipped.length === n.readers, '(b) 候选读者仍然逐条记账（无静默丢失）', JSON.stringify(n))
}

console.log('# 投递面故障如实记账：agents 服务缺失 / agent 没有 inject 面 / inject 抛错')
{
  const claim = () => mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  // a) agents 服务整个缺失：**不是**"没人需要通知"，必须留在 skipped 里；也绝不回退到旧通道。
  const h = await makeHarness({ claims: [claim()], liveSessions: ['me'], withAgents: false })
  let threw = null, res = null
  try { res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner') } catch (e) { threw = e }
  await settle()
  ok(threw === null, 'agents 服务缺失时不抛', threw && String(threw.message))
  ok(h.injects.length === 0 && h.prompts.length === 0 && h.sends.length === 0, '一条都不投，也不碰旧通道', JSON.stringify({ injects: h.injects.length, prompts: h.prompts.length, sends: h.sends.length }))
  const n = res.data.notify
  ok(n && n.skipped.length === 1 && n.skipped[0].reason === 'inject-failed' && n.skipped[0].error === 'no-agents-service',
    '如实记 skipped（inject-failed / no-agents-service）', JSON.stringify(n.skipped))
  ok(n.pushed.length === 0 && JSON.stringify(n.pushedVia) === '[]', '没有任何成功投递记录', JSON.stringify(n.pushedVia))

  // b) 解析到的对象没有 inject 面（受限宿主）：只跳过，不另找通道。
  const h2 = await makeHarness({ claims: [claim()], liveSessions: ['me'], agentsWithoutInject: true })
  const res2 = await h2.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  const n2 = res2.data.notify
  ok(h2.injects.length === 0 && h2.prompts.length === 0 && h2.sends.length === 0, '没有 inject 面 -> 零投递、零旧通道调用', JSON.stringify({ injects: h2.injects.length, prompts: h2.prompts.length, sends: h2.sends.length }))
  ok(n2.skipped.length === 1 && n2.skipped[0].reason === 'inject-failed' && n2.skipped[0].error === 'agent-has-no-inject',
    '如实记 inject-failed / agent-has-no-inject', JSON.stringify(n2.skipped))

  // c) inject 自己抛错：错误**不许被抹平**（不退回 () => undefined 那种写法）。
  const h3 = await makeHarness({ claims: [claim()], liveSessions: ['me'], injectThrows: true })
  let threw3 = null, res3 = null
  try { res3 = await h3.callLock({ op: 'release', claimId: 'c_lock' }, 'owner') } catch (e) { threw3 = e }
  await settle()
  ok(threw3 === null, 'inject 抛错不冒泡到工具调用', threw3 && String(threw3.message))
  ok(res3 && res3.ok === true && res3.data.released.length === 1, 'inject 抛错时 release 仍 ok:true + released', JSON.stringify(res3 && { ok: res3.ok }))
  const n3 = res3.data.notify
  ok(n3 && n3.readers === 1 && n3.pushed.length === 0 && n3.skipped.length === 1 && n3.skipped[0].reason === 'inject-failed',
    'inject 抛错 -> reason === inject-failed 且 release 仍 ok:true', JSON.stringify(n3))
  ok(n3 && n3.skipped[0].error === 'inject channel exploded', 'skipped[].error 带回真实错误文本（不抹平）', JSON.stringify(n3 && n3.skipped[0].error))
}

console.log('# 安全硬约束：冷读者零投递（既不 inject，也不碰旧通道）')
{
  // readers 里只有一个"不活着"的会话 -> 一次投递都不能发。
  // 这条同时是"新通道不会唤醒冷会话"的论证：注册表里没有它，解析即失败，结构上没有投递面。
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:cold'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: [] })
  const res = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(res.ok === true, 'release 仍成功')
  ok(h.injects.length === 0, 'agents.get(sessionId) === undefined -> 绝不 inject', JSON.stringify(h.injects.length))
  ok(h.prompts.length === 0 && h.sends.length === 0, '旧通道同样零调用（它们会 resume 冷会话 / cold-resume）', JSON.stringify({ prompts: h.prompts.length, sends: h.sends.length }))
  // 这种"没有人被通知"必须是**可观测**的，而不是静默
  const n = res.data.notify
  ok(n && n.readers === 1 && n.pushed.length === 0, 'notify 如实报出"有 1 个候选读者、0 条投递"', JSON.stringify(n))
  ok(n && n.skipped.length === 1 && n.skipped[0].sessionId === 'cold' && n.skipped[0].reason === 'not-live',
    '冷会话带 reason === not-live 进 skipped（刻意不唤醒）', JSON.stringify(n && n.skipped))
}

console.log('# 排除释放者自己 / 同一 (claimId, reader) 只投一次')
{
  const foreign = mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:owner', 'agent:me'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], liveSessions: ['owner', 'me'] })
  const res0 = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(h.injects.length === 1 && h.injects[0].sessionId === 'me', '不投给释放者自己', JSON.stringify(h.injects.map(i => i.sessionId)))
  ok(res0.data.notify.readers === 1, '释放者自己不计入 notify.readers（候选读者只有 me）', JSON.stringify(res0.data.notify))

  // 把同一条 claim（同 claimId + 同 reader）重新放回状态文件再释放一次：
  // 这一对已经推过，必须**不再**推送（幂等键就是 (claimId, reader)）。
  const restored = { schemaVersion: 1, seq: 1, claims: [mkClaim({ claimId: 'c_lock', holderId: 'agent:owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })], messages: [], holders: [] }
  h.writeState(restored)
  const res2 = await h.callLock({ op: 'release', claimId: 'c_lock' }, 'owner')
  await settle()
  ok(res2.ok === true, '第二次 release 也成功')
  ok(h.injects.length === 1, '同一 (claimId, reader) 只投一次', JSON.stringify(h.injects.length))
  // 被去重挡下的那条也必须可见，reason 限于 already-pushed
  const n2 = res2.data.notify
  ok(n2 && n2.readers === 1 && n2.pushed.length === 0 && n2.skipped.length === 1 &&
     n2.skipped[0].sessionId === 'me' && n2.skipped[0].reason === 'already-pushed',
    '去重挡下的读者进 skipped 且 reason === already-pushed', JSON.stringify(n2))
}

console.log('# agent/disposed（W7）：不释放未过期声明 + 从所有 readers 摘掉 + 不产生"锁已释放"通知')
{
  // W7 实测过的锁安全缺陷就是在这里发生的：dispose 之后会话往往**恢复并继续干活**，
  // 它的对话历史里仍然"记得"自己持有这个路径。旧实现把声明提前删掉 ⇒ 别的会话
  // op=overview 看到路径空闲，两边都以为可以写。现在声明只由租约决定。
  const alive = mkClaim({ claimId: 'c_alive', holderId: 'agent:dead', holderName: 'Dead', paths: ['src/d/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })
  const other = mkClaim({ claimId: 'c_other', holderId: 'agent:owner', paths: ['src/o/'], readers: ['agent:dead', 'agent:me'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [alive, other], liveSessions: ['me'] })
  h.ctx.emit('agent/disposed', { agent: { id: 'dead' } })
  // 轮询等待异步 mutate 落定：判据是"reader 已被摘掉"（这正是本次 mutate 的可见效果）。
  for (let i = 0; i < 40; i++) {
    const d = h.readState()
    const o = (d.claims || []).find(c => c.claimId === 'c_other')
    if (o && Array.isArray(o.readers) && !o.readers.includes('agent:dead')) break
    await sleep(25)
  }
  const doc = h.readState()
  ok(doc.claims.some(c => c.claimId === 'c_alive'), 'disposed 的 holder 的**未过期**声明仍然在（dispose 不是释放信号）', JSON.stringify(doc.claims.map(c => c.claimId)))
  const own = doc.claims.find(c => c.claimId === 'c_alive')
  ok(own && JSON.stringify(own.readers) === '["agent:me"]', '未过期声明连同它自己的 readers 原样保留', JSON.stringify(own && own.readers))
  const remain = doc.claims.find(c => c.claimId === 'c_other')
  ok(remain && !remain.readers.includes('agent:dead'), 'disposed 的 holder 从其他 claim 的 readers 里被摘掉', JSON.stringify(remain && remain.readers))
  ok(remain && remain.readers.includes('agent:me'), '其他读者不受影响', JSON.stringify(remain && remain.readers))
  ok(h.injects.length === 0, '没有发生释放事件 ⇒ 不产生"锁已释放"通知（旧行为在这里说谎）', JSON.stringify(h.injects.length))
  // 新通道不需要"释放者的活 Agent 当 sender"这一约束在 release 路径上仍然成立；
  // 这里只能断言 disposed 路径**一条都没碰**旧通道。
  ok(h.prompts.length === 0 && h.sends.length === 0, 'disposed 路径也不碰旧通道', JSON.stringify({ prompts: h.prompts.length, sends: h.sends.length }))
}

console.log('# agent/disposed：已到期声明由 sweep 回收（不是被 dispose 释放），同样不产生通知')
{
  // mutate() 会先 sweep 掉所有过期声明 —— 到期回收的唯一机制是租约，dispose 只是顺手摘 reader。
  // 所以 agent/disposed 路径的 data.released **恒为空**，这条通道上不再存在"锁已释放"通知。
  const expired = mkClaim({ claimId: 'c_exp', holderId: 'agent:dead', paths: ['src/d/'], readers: ['agent:me'], expiresAt: Date.now() - 1000 })
  const other = mkClaim({ claimId: 'c_other', holderId: 'agent:owner', paths: ['src/o/'], readers: ['agent:dead', 'agent:me'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [expired, other], liveSessions: ['me'] })
  h.ctx.emit('agent/disposed', { agent: { id: 'dead' } })
  for (let i = 0; i < 40; i++) {
    const d = h.readState()
    const o = (d.claims || []).find(c => c.claimId === 'c_other')
    if (o && Array.isArray(o.readers) && !o.readers.includes('agent:dead')) break
    await sleep(25)
  }
  const doc = h.readState()
  ok(!doc.claims.some(c => c.claimId === 'c_exp'), '已到期声明被回收（由 sweep 完成）', JSON.stringify(doc.claims.map(c => c.claimId)))
  ok(doc.claims.some(c => c.claimId === 'c_other'), '他人的未到期声明不受影响', JSON.stringify(doc.claims.map(c => c.claimId)))
  ok(h.injects.length === 0, '到期回收没有事件源 ⇒ 也不投递（已知限制，见下一节）', JSON.stringify(h.injects.length))
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
  ok(h.injects.length === 0, '过期声明被 sweep 掉，但不会触发任何投递（无事件源，已知限制）', JSON.stringify(h.injects.length))
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
  const { installStore } = await import(path.join(ROOT, '../lib/store.js'))
  const { installTools } = await import(path.join(ROOT, '../lib/tools.js'))
  const { installPush } = await import(path.join(ROOT, '../lib/push.js'))
  const store = new Map()
  const versions = new Map()
  const statePath = projectStateFile(CWD)
  store.set(statePath, JSON.stringify({
    schemaVersion: 1, seq: 1,
    claims: [mkClaim({ claimId: 'c_boom', holderId: 'agent:owner', holderName: 'Owner', paths: ['src/a/'], readers: ['agent:me'], expiresAt: Date.now() + HOUR })],
    messages: [], holders: []
  }))
  versions.set(statePath, 1)
  const tools = []
  const ctx = new Context()
  for (const serviceName of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'agents']) ctx.provide(serviceName)
  ctx.set('tools', { register: (t) => { tools.push(t); return () => {} } })
  ctx.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} })
  ctx.set('fs', makeFs(store, versions))
  ctx.set('sessions', { get: () => ({ header: { cwd: CWD } }) })
  ctx.set('sessionTitle', { get: () => ({ title: 'Push Worker' }) })
  ctx.set('agents', { get: () => undefined })
  const storeApi = installStore(ctx)
  const push = installPush(ctx, storeApi)
  // 制造一个**在读者处理途中**抛出、且不被逐条兜住的异常：把存活判据整个打坏。
  // （真实的 livenessOf 自己 catch 的是 agents.get 抛错，那是 liveness-check-failed；
  //   这里越过它，直接命中 notifyReaders 的整体兜底 —— item 4 要检的正是那条兜底不静默截断。）
  storeApi.livenessOf = () => { throw new Error('liveness exploded') }
  installTools(ctx, storeApi, push)
  const lock = tools.find((t) => t.name === 'collab_lock')
  const res = await lock.execute({ op: 'release', claimId: 'c_boom' }, { agent: { id: 'owner', session: { header: { cwd: CWD } } } })
  const n = res && res.data && res.data.notify
  ok(res.ok === true, 'release 本身仍然成功（推送是旁路，兜底不得影响工具结果）', JSON.stringify(res && { ok: res.ok }))
  ok(n && n.readers === 1 && n.pushed.length === 0, '候选读者 1 人、成功投递 0 条', JSON.stringify(n))
  ok(n && n.pushed.length + n.skipped.length === 1,
    'item 4：pushed + skipped 与候选条数对得上（整体兜底不再静默截断）',
    JSON.stringify(n && { pushed: n.pushed, skipped: n.skipped }))
  ok(n && n.skipped.length === 1 && n.skipped[0].reason === 'internal',
    'item 4：兜底补记的是 reason=internal 的记录', JSON.stringify(n && n.skipped))
  ok(n && n.skipped.length === 1 && String(n.skipped[0].error || '').includes('liveness exploded'),
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

console.log('# 源码级：push.ts 不再出现旧通道（prompt / sendMessage）的调用面')
{
  const src = readFileSync(path.join(ROOT, '../src/push.ts'), 'utf8')
  // 注释里当然可以（也必须）解释为什么删掉它们 —— 这里只看**去掉注释后的代码**。
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  ok(!/\.prompt\s*\(/.test(code), 'push.ts 的代码里不再调用 .prompt(', JSON.stringify(code.match(/.{0,40}\.prompt\s*\(.{0,40}/) || null))
  ok(!/sendMessage\s*\(/.test(code), 'push.ts 的代码里不再调用 sendMessage(', JSON.stringify(code.match(/.{0,40}sendMessage\s*\(.{0,40}/) || null))
  ok(!/kind\s*:\s*['"]user['"]/.test(code), "push.ts 的代码里没有 kind:'user'（不冒充用户）", null)
  ok(/\.inject\s*\(/.test(code), 'push.ts 用 agent.inject 投递（逐事件、不唤醒）', null)
  ok(/from\s+'@deepseek-ai\/dsh-llm'/.test(code), '构造函数来自真实的 @deepseek-ai/dsh-llm（不手抄副本）', null)
}

// ════════════════════════════════════════════════════════════════════════
// 3. 通知载体：显式来源的 notice 经 agent.inject 逐事件投递（AGENTS.md §1 的可执行版本）
// ════════════════════════════════════════════════════════════════════════
// 访问通知（src/access.ts）是这套载体的范例；释放通知（src/push.ts）0.9.6 起与它同构。
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

  // (c) 通知真的经 agent.inject 投出，且来源显式（kind / form + 非空 summary）。
  ok(injectLog.length === 1, '命中后 agent.inject 恰好调用一次', 'injects=' + injectLog.length)
  const msg = injectLog[0] && injectLog[0].message
  ok(sourceShapeOk(msg), "inject 收到的消息 source 是 {kind:'dsh-collab', form:'notice', summary 非空}（(a) 同款判据）", sourceShapeWhy(msg))
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

// ════════════════════════════════════════════════════════════════════════
// 4. 全局断言：(a) 每条投递的来源形状 + 旧通道/旧 reason 的彻底消失
// ════════════════════════════════════════════════════════════════════════
console.log('# (a) 投递出去的**每一条**消息来源都显式非 user')
{
  ok(deliveries.length > 0, '(a) 本次至少投递过一条（否则下面的"每一条"是空断言）', 'deliveries=' + deliveries.length)
  const bad = deliveries.filter(d => !sourceShapeOk(d.message))
  ok(bad.length === 0,
    '(a) 每条投递的 source 都是 {kind:dsh-collab, form:notice} 且 summary 非空 ≤120',
    bad.map(d => d.sessionId + ' -> ' + sourceShapeWhy(d.message)).join(' | '))
  const texts = deliveries.map(d => noticeText(d))
  ok(texts.every(t => t.includes('[dsh-collab]')), '(a) 每条投递的正文都带 dsh-collab 前缀（可追溯）', JSON.stringify(texts.slice(0, 2)))
}

console.log('# 旧通道的 reason 取值不再出现在任何一次 notify 里')
{
  ok(allNotifies.length > 0, '本次至少收集到一次 notify（否则下面的扫描是空断言）', 'notifies=' + allNotifies.length)
  const seen = []
  for (const n of allNotifies) for (const s of (n.skipped || [])) if (RETIRED_REASONS.includes(s.reason)) seen.push(s.reason)
  ok(seen.length === 0, 'prompt-failed / not-adjacent / subagent-failed 已彻底不再产生', JSON.stringify(seen))
  const channels = []
  for (const n of allNotifies) for (const p of (n.pushedVia || [])) channels.push(p.channel)
  ok(channels.length > 0 && channels.every(c => c === 'inject'),
    "所有成功投递的 pushedVia.channel 都是 'inject'", JSON.stringify([...new Set(channels)]))
}

h.finish()
