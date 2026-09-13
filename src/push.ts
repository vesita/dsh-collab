// src/push.ts
// **功能 D：释放后的原生推送**（sessionController.prompt）**与子代理投递回退通道**
// （subagents.sendMessage，0.8.4），以及"会话结束即摘除读者"的生命周期钩子。
//
// 依赖：状态存取面（store）—— 存活闸门 livenessOf / 状态改写 mutate / 显示名 hname。
// 对外只暴露 notifyReaders：tools.ts 在 release 后调用它，agent/disposed 钩子也在本模块内。

import { randomUUID } from 'node:crypto'
import { readersOf, dropHolder } from './collab-core.js'
import type { PublishedClaim } from './collab-core.js'
import { sessionIdOf, SUBAGENT_ROUTING_REASON, SUBAGENT_ROUTING_MESSAGES } from './spec.js'
import type {
  AgentLike, CollabContext, NotifyOutcome, PushChannel, PushOutcome,
  SessionControllerService, SubagentSenderLike, SubagentsService
} from './contract.js'
import type { StateStore } from './store.js'

/** 推送面：installPush() 对外暴露的东西（tools.ts 用它挂 release 后的通知）。 */
export interface PushApi {
  /** 向受影响的读者推送"锁已释放"，并把结果带回来（绝不抛）。 */
  notifyReaders(
    released: PublishedClaim[],
    releaserHolderId: string,
    releaserName: string,
    releaserAgent?: AgentLike
  ): Promise<NotifyOutcome>
}

export function installPush(ctx: CollabContext, store: StateStore): PushApi {
  // ---- 功能 D：释放后的原生推送（sessionController.prompt） ----
  //      0.8.4 追加**子代理投递回退通道**（subagents.sendMessage）：当读者是"由 subagent
  //      路由托管的会话"时，原生 prompt 会被 DSH 结构性地拒绝，而 DSH 自己在错误里
  //      指示"改用 subagent 投递"（见 isSubagentRoutingRejection 的三条源码依据）。

  // 0.8.4：通道名（notify.pushedVia[].channel 用）。
  const CHANNEL_PROMPT: PushChannel = 'session-controller'
  const CHANNEL_SUBAGENT: PushChannel = 'subagents'

  // 同一 (claimId, reader) 只推一次。
  // 用 claimId -> Set<reader> 的两级结构，**不**把两者拼成一个字符串：claimId 由插件生成、
  // reader 由其他会话写进**共享状态文件**，任何分隔符拼接都不是单射 —— 例如旧式 '::' 拼接下
  //   ('c_1', 'agent::agent:B') 与 ('c_1::agent', 'agent:B')
  // 会撞成同一个键 'c_1::agent::agent:B'，于是第二对合法的释放通知被当成"已推过"静默丢弃。
  // 有界：**总对数**超过 PUSH_DEDUPE_MAX 时按插入顺序淘汰最旧的一对（与拆分前等价）。
  const pushedPairs = new Map<string, Set<string>>()
  const pushedOrder: Array<{ claimId: string; reader: string }> = []
  const PUSH_DEDUPE_MAX = 2000
  const PUSH_TIMEOUT_MS = 3000

  /** 标记"这一对已推过"；返回 false 表示已经推过，跳过。 */
  function markPushed(claimId: string, reader: string): boolean {
    const seen = pushedPairs.get(claimId)
    if (seen && seen.has(reader)) return false
    const group = seen || new Set<string>()
    if (!seen) pushedPairs.set(claimId, group)
    group.add(reader)
    pushedOrder.push({ claimId, reader })
    if (pushedOrder.length > PUSH_DEDUPE_MAX) {
      const oldest = pushedOrder.shift()
      if (oldest) {
        const evicted = pushedPairs.get(oldest.claimId)
        if (evicted) {
          evicted.delete(oldest.reader)
          if (evicted.size === 0) pushedPairs.delete(oldest.claimId)
        }
      }
    }
    return true
  }

  /** 释放通知文案（一次性推送，不需要时间稳定性，故不掺时刻）。 */
  function releaseNotice(c: PublishedClaim, releaserName: string): string {
    const paths = Array.isArray(c.paths) ? c.paths : []
    const shown = paths.slice(0, 3).join(' ') + (paths.length > 3 ? ' 等 ' + paths.length + ' 条' : '')
    return '[dsh-collab] ' + releaserName + ' 已释放 ' + shown + '（' + c.mode + '）。' +
      '你此前被登记为它的读者，这些路径不再由该会话占用。'
  }

  /** 单条推送：mode 由"会话是否在跑"决定（SessionSummary.running），判定不了就用 'queue'。 */
  async function pushOne(controller: SessionControllerService, sessionId: string, text: string): Promise<PushOutcome> {
    let mode: 'queue' | 'steer' = 'queue'
    try {
      if (typeof controller.list === 'function') {
        const ac = new AbortController()
        const listed = await controller.list({}, ac.signal)
        const row = listed && Array.isArray(listed.items) ? listed.items.find(x => x && x.sessionId === sessionId) : null
        if (row && row.running === true) mode = 'steer'
      }
    } catch (e) {
      mode = 'queue' // 判定不确定 → queue（安全侧：不会打断对方当前回合）
    }
    const ac = new AbortController()
    // 把**真实结果**带回来：0.8.2 用 `.then(() => undefined, () => undefined)` 抹平了错误，
    // 于是"没有人需要通知"和"通知通道坏了"在返回值上长得一模一样（这正是本次要修的观测盲区）。
    const attempt = Promise.resolve()
      .then(() => controller.prompt({
        requestId: 'dsh-collab-' + randomUUID(),
        sessionId,
        mode,
        content: [{ type: 'text', text }]
      }, ac.signal))
      .then(
        () => ({ ok: true }) as PushOutcome,
        (e) => {
          // 0.8.4：在**这里**就把"子代理路由托管"这个结构化判据留在返回值上，
          // 调用方（notifyReaders）据此决定要不要走回退 —— 不需要再去解析 error 文本。
          const fail: { ok: false; error: string; subagentRouting?: true } = { ok: false, error: describeError(e) }
          if (isSubagentRoutingRejection(e)) fail.subagentRouting = true
          return fail as PushOutcome
        }
      )
    // 超时与"prompt 真的返回失败"必须可区分：超时用 error === 'timeout' 标记。
    const guard = ctx.timer.timeout(PUSH_TIMEOUT_MS).then(() => {
      try { ac.abort() } catch (e) {}
      return { ok: false, error: 'timeout' } as PushOutcome
    })
    try {
      return await Promise.race([attempt, guard])
    } catch (e) {
      return { ok: false, error: describeError(e) } // 绝不冒泡：推送失败只影响通知本身
    }
  }

  /** 把任意抛出物转成一行可读文本（notify.skipped[].error 用）。 */
  function describeError(e: unknown): string {
    try {
      const m = e && typeof e === 'object' ? (e as { message?: unknown }).message : undefined
      if (typeof m === 'string' && m) return m
      return String(e)
    } catch (e2) {
      return 'unknown error'
    }
  }

  /** 结构化读一个抛出物的 code / message / details.reason（跨 realm 也不依赖 instanceof）。 */
  function errorFields(e: unknown): { code: string; message: string; reason: string } {
    const err = (e && typeof e === 'object' ? e : null) as
      | { code?: unknown; message?: unknown; details?: unknown }
      | null
    const code = err && typeof err.code === 'string' ? err.code : ''
    const message = err && typeof err.message === 'string' ? err.message : ''
    let reason = ''
    try {
      const d = err && err.details
      if (d && typeof d === 'object' && typeof (d as { reason?: unknown }).reason === 'string') {
        reason = (d as { reason: string }).reason
      }
    } catch (e2) {}
    return { code, message, reason }
  }

  /**
   * "该会话由子代理路由托管"这一条的**稳定判据**（0.8.4）。
   *
   * 为什么不能只看 `code === 'session/agent-busy'`：这个 code 在 DSH 里**不止一处**抛出，
   * 逐条源码依据（/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js）：
   *   - :137  `session "…" is owned by subagent routing`
   *            details { reason: 'use subagent delivery for this child session' }  ← 本插件要认的那条
   *   - :785  `prompt rejected`，details { reason: String(error) }
   *            ← **普通投递失败**也复用了同一个 code，这时走回退毫无意义（目标根本不是子代理子会话）
   *   - :1578 `subagent Sessions require their durable parent address`
   *            details { reason: 'use subagent delivery for this child session' }  ← 同属路由托管，回退同样正确
   * 而 `RemoteErrorDetailsMap['session/agent-busy'] = { readonly reason: string }`
   * （dsh-typert-protocol/lib/types/remote-error.d.ts 生成物，见 :1637 的声明串），
   * 所以判据做成**结构优先的两段式**：
   *   1) code === 'session/agent-busy'（结构化，绝不解析裸字符串当主判据）；
   *   2) details.reason === 'use subagent delivery for this child session'（结构化、稳定、由 DSH 自己给出）。
   * details 若在某个边界上丢失（宿主内它随实例重建，见 remote-error.js 的构造函数），
   * 再退一步比对 message 里两条**由 DSH 自己写死**的诊断串；两者都不会被普通
   * 'prompt rejected' 命中 —— 于是"别处也可能出现的 session/agent-busy"被安全排除：
   * 认不出就**不回退**（宁可少一次回退，也不把无关错误拿去做一次语义不同的投递）。
   */
  function isSubagentRoutingRejection(e: unknown): boolean {
    try {
      const { code, message, reason } = errorFields(e)
      if (code !== 'session/agent-busy') return false
      if (reason === SUBAGENT_ROUTING_REASON) return true
      return SUBAGENT_ROUTING_MESSAGES.some(s => message.includes(s))
    } catch (e2) {
      return false
    }
  }

  /**
   * 回退失败的分类（0.8.4）：只有**邻接前提不成立**才算 not-adjacent。
   * 依据 @deepseek-ai/dsh-subagent/lib/index.js 抛出的 SubagentError.code（HarnessError，code 是普通字段）：
   *   - :1742 UNAUTHORIZED `agent "X" is not a resident continuable child and cannot send to parent "Y"`
   *   - :967/:968 UNAUTHORIZED `… delivery requires the exact live parent agent` /
   *              `… belongs to another parent session`（:1887 coldResume → authorizeLineage 也走这里）
   *   - :1834/:1844 PARENT_UNAVAILABLE 直接父会话不活
   *   - :1883/:1889 NOT_RESUMABLE 目标不是可续子会话
   * **刻意排除** :1735 的 UNAUTHORIZED `message delivery requires the exact live sender agent`
   * —— 那是"发送者已不是活 Agent"，不是邻接问题，谎报成 not-adjacent 会误导排查方向，
   * 归入泛化的 subagent-failed。
   */
  function isNonAdjacentRejection(e: unknown): boolean {
    try {
      const { code, message } = errorFields(e)
      if (code === 'PARENT_UNAVAILABLE' || code === 'NOT_RESUMABLE') return true
      if (code !== 'UNAUTHORIZED') return false
      if (message.includes('not a resident continuable child')) return true
      if (message.includes('belongs to another parent session')) return true
      if (message.includes('delivery requires the exact live parent agent')) return true
      return false
    } catch (e2) {
      return false
    }
  }

  /**
   * 回退通道本身（0.8.4）：把同一条通知经 `ctx.subagents.sendMessage` 投给读者。
   * 契约（Inspect 实查 + 源码核对，见 SubagentsService 注释）：
   *   - sender 必须是该会话的**活 Agent**（这里是释放者的 `exec.agent`，**原对象**，不重建）；
   *   - 只能投给 sender 的直接父会话或直接可续子会话 —— 邻接是硬约束；
   *   - `signal` 用自建 AbortController；超时护栏与 prompt 通道同一套（PUSH_TIMEOUT_MS）。
   * 与 pushOne 一样绝不抛出：失败只体现为 skipped 里的 reason/error。
   */
  async function pushViaSubagents(
    subagents: SubagentsService,
    sender: SubagentSenderLike,
    sessionId: string,
    text: string
  ): Promise<PushOutcome> {
    const ac = new AbortController()
    const attempt = Promise.resolve()
      .then(() => subagents.sendMessage(sender, sessionId, [{ type: 'text', text }], { signal: ac.signal }))
      .then(
        () => ({ ok: true }) as PushOutcome,
        (e) => {
          const fail: { ok: false; error: string; notAdjacent?: true } = { ok: false, error: describeError(e) }
          if (isNonAdjacentRejection(e)) fail.notAdjacent = true
          return fail as PushOutcome
        }
      )
    const guard = ctx.timer.timeout(PUSH_TIMEOUT_MS).then(() => {
      try { ac.abort() } catch (e) {}
      return { ok: false, error: 'timeout' } as PushOutcome
    })
    try {
      return await Promise.race([attempt, guard])
    } catch (e) {
      return { ok: false, error: describeError(e) }
    }
  }

  /**
   * 回退通道的**前置闸**：拿不到释放者的活 Agent、或 `subagents` 服务不可用时，
   * 一次 `sendMessage` 都不发，直接以失败返回（调用方按 skipped 记账）。
   * 理由：`sendMessage` 的 sender 必须是 "exact live Agent"，用一个来路不明的 sender
   * 去尝试投递既不会成功，也可能命中"不存在的直接子会话 → cold-resume"那条副作用路径。
   * 安全侧：能不投就不投。
   */
  async function pushViaSubagentsIfPossible(
    subagents: SubagentsService | undefined,
    sender: SubagentSenderLike | undefined,
    sessionId: string,
    text: string
  ): Promise<PushOutcome> {
    if (!subagents || typeof subagents.sendMessage !== 'function') {
      return { ok: false, error: 'no-subagents-service' }
    }
    if (!sender) return { ok: false, error: 'no-live-sender-agent' }
    return pushViaSubagents(subagents, sender, sessionId, text)
  }

  /**
   * 向受影响的读者推送"锁已释放"，并**把结果带回来**（0.8.3 的可观测性修复）。
   * 硬约束（安全，全部保留，0.8.4 的回退通道**一条都没有放宽**）：
   *   - 只推给 `agents.get(sessionId)` 此刻**活着**的会话；冷会话**直接丢弃**，
   *     因为 prompt 的文档写明它会 "explicitly resuming its Session"，唤醒冷会话是不可接受的副作用；
   *     回退通道（`subagents.sendMessage`）的文档同样写明 "an absent direct child cold-resumes
   *     from persistence"，所以这道闸门**在两个通道之前**统一判定，回退一次都不会绕过它；
   *   - 排除释放者自己；同一 (claimId, reader) 只推一次（幂等键不变，回退成功也照样记账）；
   *   - 全部 best-effort：本函数绝不抛，任何失败也不改变 release 的返回。
   * 返回：每个候选读者要么进 pushed（pushedVia 里带上通道），要么带 reason 进 skipped，于是
   * "没有人需要通知"与"通知通道坏了"从结果上就能分辨，回退过没过也能分辨。
   *
   * `releaserAgent`（0.8.4）必须是**释放者的那个活 Agent 对象本身**（工具处理器里的 `exec.agent`）：
   * 回退通道用它当 sender，而 DSH 用 `ctx.agents.get(sender.id) !== sender` 做**对象同一性**判定
   * （dsh-subagent/lib/index.js:1735），所以这里只做**类型收窄**，绝不重建对象。
   * 拿不到它（例如 `agent/disposed` 路径上那个正在销毁的 agent）就**不回退**，如实记 skipped。
   */
  async function notifyReaders(
    released: PublishedClaim[],
    releaserHolderId: string,
    releaserName: string,
    releaserAgent?: AgentLike
  ): Promise<NotifyOutcome> {
    const out: NotifyOutcome = { readers: 0, pushed: [], skipped: [], pushedVia: [] }
    // 候选读者 = released 各 claim 上、能解析出 sessionId 且不是释放者的 (claim, reader)。
    // readersOf 已做归一（去重保序 + 过滤非字符串）。
    // 这三个变量**声明在 try 之外**：整体兜底 catch 要用它们把"尚未记账的候选"逐条补记进 skipped。
    const jobs: Array<{ claim: PublishedClaim; reader: string; sessionId: string }> = []
    const distinct = new Set<string>()
    let currentSessionId = ''
    try {
      const controller = ctx.get('sessionController') as SessionControllerService | undefined
      // 回退通道是**可选**服务：拿不到就不回退（不回退 ≠ 报错，见 pushViaSubagentsIfPossible）。
      const subagents = ctx.get('subagents') as SubagentsService | undefined
      // **原对象**，不是 { id } 的副本 —— 见上面的对象同一性说明。
      const sender: SubagentSenderLike | undefined =
        releaserAgent && typeof releaserAgent.id === 'string' && releaserAgent.id
          ? (releaserAgent as unknown as SubagentSenderLike)
          : undefined
      for (const c of released) {
        for (const reader of readersOf(c)) {
          if (!reader || reader === releaserHolderId) continue
          const sessionId = sessionIdOf(reader)
          if (!sessionId) continue // 非 agent holder（human:console 之类）没有会话可推
          jobs.push({ claim: c, reader, sessionId })
          distinct.add(sessionId)
        }
      }
      out.readers = distinct.size
      const canPush = !!controller && typeof controller.prompt === 'function'
      for (const job of jobs) {
        // 兜底 catch 用它在 skipped 里指出"抛在哪条候选上"。
        currentSessionId = job.sessionId
        if (!canPush) {
          // 通道整个缺失：这**不是**"没人需要通知"，必须留在 skipped 里（0.8.2 是静默 return）。
          // 0.8.4 刻意**不**因为"prompt 通道缺失"就改走回退：那会把"原生通道整个不在"
          // 这件基础设施问题伪装成一次正常的旁路投递。缺失照旧如实报。
          out.skipped.push({ sessionId: job.sessionId, reason: 'prompt-failed', error: 'no-session-controller' })
          continue
        }
        // 安全闸门：对**两个通道**统一生效，且在任何投递之前（冷会话绝不被唤醒 / cold-resume）。
        // 三态：'not-live' = 读者没在线（刻意不唤醒）；'failed' = 存活判据自己坏了（基础设施故障）。
        // 后者**不许**折叠成前者 —— 那会把"agents 服务或它的 get() 崩了"说成"读者没在线"，
        // 排查方向直接被带偏。如实记 distinct 的 reason。
        const liveness = store.livenessOf(job.sessionId)
        if (liveness.state === 'not-live') {
          out.skipped.push({ sessionId: job.sessionId, reason: 'not-live' }) // 刻意不唤醒
          continue
        }
        if (liveness.state === 'failed') {
          out.skipped.push({ sessionId: job.sessionId, reason: 'liveness-check-failed', error: liveness.error })
          continue
        }
        // 幂等键 (claimId, reader) 仍然**先**记账：回退成功/失败都不再重投。
        if (!markPushed(job.claim.claimId, job.reader)) {
          out.skipped.push({ sessionId: job.sessionId, reason: 'already-pushed' })
          continue
        }
        const text = releaseNotice(job.claim, releaserName)
        const r = await pushOne(controller as SessionControllerService, job.sessionId, text)
        if (r.ok) {
          out.pushed.push(job.sessionId)
          out.pushedVia.push({ sessionId: job.sessionId, channel: CHANNEL_PROMPT })
          continue
        }
        // 本仓库 tsconfig 是 strict:false，联合类型在属性访问处不做收窄（既有代码同样用 cast），
        // 所以这里显式取失败分支的字段。
        const rf = r as { error?: string; subagentRouting?: true }
        // 0.8.4 回退：**只**在结构化确认为"子代理路由托管"时尝试（普通 prompt 失败不走这里）。
        if (rf.subagentRouting === true) {
          const f = await pushViaSubagentsIfPossible(subagents, sender, job.sessionId, text)
          if (f.ok) {
            out.pushed.push(job.sessionId)
            out.pushedVia.push({ sessionId: job.sessionId, channel: CHANNEL_SUBAGENT })
          } else {
            const ff = f as { error?: string; notAdjacent?: true }
            out.skipped.push({
              sessionId: job.sessionId,
              // 邻接不成立是**诊断**（跨父会话的子代理），泛化回退失败是**通道**问题，分开记。
              reason: ff.notAdjacent === true ? 'not-adjacent' : 'subagent-failed',
              error: ff.error
            })
          }
          continue
        }
        out.skipped.push({ sessionId: job.sessionId, reason: 'prompt-failed', error: rf.error })
      }
    } catch (e) {
      // 整体兜底：推送链路的任何意外都不得影响 release 的返回；已收集到的部分照常返回。
      // 但**绝不允许静默截断**：兜底时按"尚未记账的候选读者"逐条补记 reason:'internal'
      // （带真实错误文本 + 当时正在处理的 sessionId），于是 pushed + skipped 永远能对上
      // 候选条数 —— "条数对不上"从此有解释，而不是凭空消失。
      const text = describeError(e)
      const accounted = out.pushed.length + out.skipped.length
      for (let i = accounted; i < jobs.length; i++) {
        out.skipped.push({
          sessionId: jobs[i].sessionId || currentSessionId,
          reason: 'internal',
          error: text
        })
      }
      // 兜底发生在候选收集阶段时 readers 还没被赋值：补上，免得 readers=0 与"没有读者"混淆。
      if (out.readers === 0 && distinct.size) out.readers = distinct.size
    }
    return out
  }

  ctx.on('agent/disposed', (payload: { agent?: { id?: string } }) => {
    try {
      const agent = payload && payload.agent
      if (!agent || !agent.id) return
      const h = 'agent:' + String(agent.id)
      // 功能 D：会话退出时既要释放它的声明，也要把它从**所有** claim 的 readers 里摘掉
      // （否则会向一个已经死掉的会话推送）。两件事在同一次 mutate 里完成。
      const holderId = h
      let releaserName = holderId
      try {
        releaserName = store.hname({ holderId, sessionId: String(agent.id), agent: agent as AgentLike }) || holderId
      } catch (e) {}
      store.mutate(s => dropHolder(s, holderId), String(agent.id), agent as AgentLike)
        .then(res => {
          if (res && res.ok === true && res.data && Array.isArray(res.data.released)) {
            // 0.8.4：这里**刻意不传第 4 个参数**（sender）。事件里的 agent 正在 disposed，
            // 不是回退契约要求的 "exact live Agent" —— 拿它当 sender 只会得到一次
            // UNAUTHORIZED，而且违背"拿不到活 Agent 就不回退"的约定。
            // 于是这条路径上的子代理读者会如实落到 skipped（prompt-failed / subagent-*），
            // 这一点由 notifyReaders 自己的记账保证（不是靠下面的兜底 catch 保证）。
            return notifyReaders(res.data.released as PublishedClaim[], holderId, releaserName)
          }
        })
        // 本路径**刻意保持静默**：dropHolder 写失败、或 notifyReaders 的异步拒绝，都不新增
        // "内部错误上报"通道（那是一条新特性，不在本次清理范围）。原实现这里套着一个空的
        // `try/catch`，紧挨着上面那句断言"读者会如实落到 skipped"的注释 —— 注释讲的是记账，
        // 实现却是一个空 catch（而且是死代码：notifyReaders 是 async 函数，调用它本身不会同步抛，
        // 异步拒绝走的是下面这个 .catch）。现在删掉死 catch，注释只保留为真的部分，矛盾消失。
        .catch(() => {})
    } catch (e) {}
  }, { global: true })

  return { notifyReaders }
}
