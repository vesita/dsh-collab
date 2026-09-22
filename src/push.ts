// src/push.ts
// **功能 D：释放后的通知投递 —— 逐事件经 `agent.inject` 投一条显式来源的 notice**，
// 以及"会话结束即摘除读者"的生命周期钩子。
//
// 为什么换掉旧通道（0.8.4 的 `sessionController.prompt` 与 `subagents.sendMessage` 已删除）：
//   两个 API 都**只收 content**，消息由宿主代造，宿主写死 `source: { kind: 'user', rpcId: 'dsh-collab-…' }`
//   —— 实测转录里就是 `user/message` + `kind:'user'`，在 GUI 里渲染成**用户气泡**
//   （落进 next-step 收件箱还会升级成 steering 气泡，与真人输入共用同一个 UserStyleBubble 渲染器）。
//   这直接违反 AGENTS.md §1「严禁冒充用户」。旧注释里"插件无法改变来源"的结论是错的：
//   自己构造消息（来源显式非 user）再 `agent.inject` 就能既投出去又不冒充。
//
// 现在的投递面**只有一个**：
//   1) 在**本进程内**解析目标 agent —— `ctx.get('agents')` 的 `get(id: SessionId): Agent | undefined`；
//   2) 解析到就 `agent.inject(msg)`（契约 `inject(message: UserMessage): void`，
//      `dsh-agent/lib/types/runtime-types.d.ts:209`；实现是
//      `send(message, "next-step", wakeup=false)`，`dsh-agent-loop/lib/index.js:795`
//      —— 进入下一步但**不唤醒** driver，不打断对方回合）；
//   3) 解析不到就**如实跳过**（`skipped.reason = 'agent-not-resolvable'`），
//      **绝不回退**到任何会冒充用户的通道。
//
// 消息由**真实的** `@deepseek-ai/dsh-llm`（peer + dev 依赖）构造，source 显式非 user：
//   { kind: 'dsh-collab', form: 'notice', summary: boundContextSummary(…) }
// 客户端的分流**只看 `source.kind`**，且发生在收件箱分类**之前**
// （`dsh-client-ui-chat/lib/client.js:8757`）：`kind !== 'user'` + `form:'notice'` + **非空 summary**
// ⇒ 渲染成独立可折叠的 `ContextInjectionRow`，**无论投进哪个收件箱都不是气泡**。
// `summary` 必须非空，否则会退化成 opaque 行（`client.js:825-831`）；120 字符上限由
// `boundContextSummary` 保证。**不许**手抄构造函数副本（AGENTS.md 明令）。
//
// 依赖：状态存取面（store）—— 存活闸门 livenessOf / 状态改写 mutate / 显示名 hname。
// 对外只暴露 notifyReaders：tools.ts 在 release 后调用它，agent/disposed 钩子也在本模块内。

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { readersOf, dropHolder, modeLabel } from './collab-core.js'
import type { PublishedClaim } from './collab-core.js'
import { sessionIdOf, LOOP_END_GRACE_SEC_DEFAULT } from './spec.js'
import type {
  AgentLike, AgentsLookupService, CollabContext, LoopEndReleaseOutcome, NotifyOutcome, PushChannel, PushOutcome
} from './contract.js'
import type { StateStore } from './store.js'

/** 推送面：installPush() 对外暴露的东西（tools.ts 用它挂 release 后的通知）。 */
export interface PushApi {
  /** 向受影响的读者推送"锁已释放"（或 op=reap 的"占用已被回收"），并把结果带回来（绝不抛）。 */
  notifyReaders(
    released: PublishedClaim[],
    releaserHolderId: string,
    releaserName: string,
    releaserAgent?: AgentLike,
    action?: 'release' | 'reap' | 'auto',
    graceSec?: number
  ): Promise<NotifyOutcome>
  /**
   * 循环终止自动释放（0.9.10）的告知：**两个群体分别投递**（见 contract 的 LoopEndReleaseOutcome）：
   *   1. 读者（正等这些路径的会话）—— 与 release 同一条投递面，只是文案说"自动释放"；
   *   2. 被释放的会话本人 —— 一条"你的锁已被自动释放，重新开工前请重新 claim"的告知。
   * 第二条约等于本功能的**安全阀**：会话恢复后不会以为自己还持锁。
   */
  notifyLoopEndRelease(
    released: PublishedClaim[],
    holderId: string,
    holderName: string,
    graceSec: number
  ): Promise<LoopEndReleaseOutcome>
  /**
   * 一次性 **advisory** notice（0.11.0 的团队写域交叉预警）：直接投给**给定的活 Agent**。
   * 与 notifyReaders 共用同一条诚实投递面（`agent.inject` + 显式来源 `dsh-collab/notice`），
   * 不新造通道、绝不冒充用户。**绝不抛**：拿不到 agent / 没有 inject 面 / inject 抛错都如实返回。
   */
  pushNotice(agent: AgentLike | undefined, text: string, label: string): PushOutcome
}

export function installPush(ctx: CollabContext, store: StateStore): PushApi {
  // ---- 功能 D：释放后的通知投递（agent.inject + form:'notice'）----
  // 0.8.4 的两条通道（sessionController.prompt / subagents.sendMessage）**整体删除**：
  // 它们是"宿主代造消息"的接口，来源由宿主写成 kind:'user'，冒充真人输入。

  // 通道名（notify.pushedVia[].channel 用）：**只剩一个**，投递面就是 agent.inject。
  const CHANNEL_INJECT: PushChannel = 'inject'

  // 同一 (claimId, reader) 只推一次。
  // 用 claimId -> Set<reader> 的两级结构，**不**把两者拼成一个字符串：claimId 由插件生成、
  // reader 由其他会话写进**共享状态文件**，任何分隔符拼接都不是单射 —— 例如旧式 '::' 拼接下
  //   ('c_1', 'agent::agent:B') 与 ('c_1::agent', 'agent:B')
  // 会撞成同一个键 'c_1::agent::agent:B'，于是第二对合法的释放通知被当成"已推过"静默丢弃。
  // 有界：**总对数**超过 PUSH_DEDUPE_MAX 时按插入顺序淘汰最旧的一对（与拆分前等价）。
  const pushedPairs = new Map<string, Set<string>>()
  const pushedOrder: Array<{ claimId: string; reader: string }> = []
  const PUSH_DEDUPE_MAX = 2000

  // 0.9.11 降噪：循环终止自动释放**发给本人的**那条通知的合并窗口（见 notifyLoopEndRelease）。
  // 与上面的 pushedPairs 分工不同：那个按 (claimId, reader) 去重，重新 claim 会得到新的
  // claimId 于是照发；这里按 holderId 在**时间窗口**内合并，专治"claim→release→claim"抖动。
  // 本 map 住在 installPush 的闭包里 ⇒ 每个插件实例一份，测试之间天然隔离。
  const LOOP_END_NOTICE_DEDUP_MS = 60_000
  const LOOP_END_NOTICE_MAX_KEYS = 500
  const loopEndNoticeAt = new Map<string, number>()

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

  /**
   * 释放通知的**两段文案**（一次性推送，不需要时间稳定性，故不掺时刻）：
   *   - `text`    = 模型可见全文（进 content）；
   *   - `summary` = 折叠态的一句话账目（进 source.summary，**非空**是硬要求）。
   * 两者同源，绝不各写一份 —— summary 与正文漂移就等于折叠态在说谎。
   *
   * `action`（0.9.8）：op=reap 复用同一条投递面时，文案必须说**回收**而不是"释放"——
   * 回收者并不是被回收声明的持有者，照抄"X 已释放"会让读者以为 X 才是锁的主人（来源诚实
   * 不止 `source.kind`，正文也不能替数据撒谎）。两条文案共用同一个 `shown/mode` 组装。
   */
  function releaseNoticeParts(c: PublishedClaim, releaserName: string, action: 'release' | 'reap' | 'auto' = 'release', graceSec: number = LOOP_END_GRACE_SEC_DEFAULT): { text: string; summary: string } {
    const paths = Array.isArray(c.paths) ? c.paths : []
    const shown = paths.slice(0, 3).join(' ') + (paths.length > 3 ? ' 等 ' + paths.length + ' 条' : '')
    if (action === 'reap') {
      const holder = c.holderName || c.holderId
      const text = '[dsh-collab] 会话 ' + releaserName + ' 回收了 ' + holder + ' 的僵尸声明 ' + shown +
        '（' + modeLabel(c.mode) + '）。你此前被登记为它的读者，这些路径不再由该会话占用。'
      const summary = boundContextSummary('collab 锁已回收 · ' + shown)
      return { text, summary }
    }
    // 0.9.10：自动释放。**不许**照抄"X 已释放" —— 释放者不是调用这个 op 的会话，
    // 而是插件在 X 的循环停下之后替它放的；正文必须说清触发条件与宽限期，
    // 否则读者会把这条通知误读成"X 主动放弃了"。
    if (action === 'auto') {
      const text = '[dsh-collab] ' + releaserName + ' 的会话循环已结束（空闲超过 ' + graceSec + ' 秒），其对 ' + shown +
        '（' + modeLabel(c.mode) + '）的声明已被自动释放。你此前被登记为它的读者，这些路径不再由该会话占用。'
      const summary = boundContextSummary('collab 锁自动释放 · ' + shown)
      return { text, summary }
    }
    const text = '[dsh-collab] ' + releaserName + ' 已释放 ' + shown + '（' + modeLabel(c.mode) + '）。' +
      '你此前被登记为它的读者，这些路径不再由该会话占用。'
    // boundContextSummary 截到 120 字符（CONTEXT_SUMMARY_MAX_CHARS，dsh-llm/lib/index.js:15-22）。
    const summary = boundContextSummary('collab 锁已释放 · ' + releaserName + ' · ' + shown)
    return { text, summary }
  }

  /**
   * 给**被自动释放的会话本人**的那条告知文案（0.9.10）。
   * 与 releaseNoticeParts 分开写，因为收件人不同、要求也不同：读者只需知道"路径空出来了"，
   * 而本人需要知道**自己已经不再持锁**，以及"继续写之前先重新 claim"这个动作。
   * 时间稳定性不适用（这是一次性通知），但措辞不得暗示"你（曾）做错了什么"。
   */
  function loopEndHolderNoticeParts(holderName: string, released: PublishedClaim[], graceSec: number): { text: string; summary: string } {
    const uniq: string[] = []
    for (const c of released) for (const p of (Array.isArray(c.paths) ? c.paths : [])) if (!uniq.includes(p)) uniq.push(p)
    const shown = uniq.slice(0, 3).join(' ') + (uniq.length > 3 ? ' 等 ' + uniq.length + ' 条' : '')
    const who = holderName || '你的会话'
    const text = '[dsh-collab] ' + who + ' 的会话循环已结束（空闲超过 ' + graceSec + ' 秒），因此你此前持有的声明 ' + shown +
      ' 已被自动释放。恢复工作前如需写入这些路径，请重新执行 collab_lock op=claim；' +
      '在此期间其他会话可能已经占用它们。'
    const summary = boundContextSummary('collab 你的锁已被自动释放 · ' + shown)
    return { text, summary }
  }

  /**
   * 释放通知消息：**显式标注来源的 notice**（AGENTS.md §1 允许且要求的形态）。
   * `form: 'notice'` 必须带非空 `summary`，否则客户端会把它退化成 opaque 行
   * （`dsh-client-ui-chat/lib/client.js:825-831` 的 `case "notice"` 先算 `noticeSummary`）。
   * role / id / 深冻结全部由真实的构造函数补，本仓库不自造。
   */
  function releaseNoticeMessage(parts: { text: string; summary: string }) {
    return createUserMessage({
      content: [{ type: 'text' as const, text: parts.text }],
      source: {
        kind: 'dsh-collab' as const,
        form: 'notice' as const,
        summary: parts.summary
      }
    })
  }

  /**
   * 单条投递（0.9.6）：**先在进程内解析目标 agent**，解析到就 inject 一条显式来源的 notice。
   *
   * 返回**真实结果**，绝不抛（推送失败只影响通知本身）：
   *   - `{ ok: false, error: 'agent-not-resolvable' }` = 存活判据说"活着"，但此刻
   *     `agents.get(sessionId)` 已经解析不到（两判据之间的 TOCTOU 竞态，或宿主换了注册表）
   *     —— **如实跳过**，这里**没有**任何回退通道（旧实现会掉头去 prompt / sendMessage，
   *     那正是冒充用户的来源）；
   *   - `{ ok: false, error: 'agent-has-no-inject' }` = 解析到的对象没有 inject 面
   *     （受限宿主）；同样只跳过，不另找通道；
   *   - 其它文本 = `agents.get` 或 `inject` 自己抛出的真实错误（不抹平成 undefined）。
   *
   * **为什么没有"超时"这一态**：`inject` 的契约是**同步**的
   * （`dsh-agent/lib/types/runtime-types.d.ts:209` 的 `inject(message: UserMessage): void`；
   *  实现 `dsh-agent-loop/lib/index.js:795` 只是把消息 splice 进收件箱并返回），
   * 同步调用要么正常返回、要么当场抛 —— 不存在"永不 resolve"的窗口，故不再有超时护栏，
   * 也不再用 `() => undefined` 之类抹平错误的写法。失败与成功仍**必须**从返回值上可区分。
   *
   * AgentLike.inject 的形参在 contract 里写 `unknown`（不让 contract 依赖 dsh-llm 的类型），
   * 这里传的是货真价实的 `UserMessage`。
   */
  function pushOne(agents: AgentsLookupService, sessionId: string, parts: { text: string; summary: string }): PushOutcome {
    let agent: AgentLike | undefined
    try {
      agent = agents.get(sessionId)
    } catch (e) {
      return { ok: false, error: describeError(e) }
    }
    if (!agent) return { ok: false, error: 'agent-not-resolvable', notResolvable: true }
    try {
      // 取一次 inject 面并当场校验：受限宿主可能给不出它（只跳过，不另找通道）。
      const inject = agent.inject
      if (typeof inject !== 'function') return { ok: false, error: 'agent-has-no-inject' }
      agent.inject(releaseNoticeMessage(parts))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: describeError(e) }
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

  /**
   * 向受影响的读者推送"锁已释放"，并**把结果带回来**（0.8.3 起的可观测性约定）。
   * 硬约束（安全）：
   *   - 只推给 `agents.get(sessionId)` 此刻**活着**的会话；冷会话**直接丢弃**；
   *     `agent.inject` 对未加载的会话**不可能**投递（注册表里根本没有它，解析即失败），
   *     所以"不唤醒冷会话"这条在**通道本身**上就成立了 —— 不再依赖旧 prompt 的文档约束；
   *   - 排除释放者自己；同一 (claimId, reader) 只推一次（幂等键不变）；
   *   - 全部 best-effort：本函数绝不抛，任何失败也不改变 release 的返回。
   * 返回：每个候选读者要么进 pushed（pushedVia 里带上真实通道 `'inject'`），要么带 reason 进
   * skipped，于是"没有人需要通知"与"通知通道坏了"从结果上就能分辨。
   *
   * `releaserAgent`（第 4 参）：0.8.4 曾是子代理回退通道的 sender；该通道删除后**不再使用**。
   * 形参保留只为**不让 tools.ts 的调用点跟着改签名**（发布面兼容），值本身不参与任何判定。
   */
  async function notifyReaders(
    released: PublishedClaim[],
    releaserHolderId: string,
    releaserName: string,
    releaserAgent?: AgentLike,
    action: 'release' | 'reap' | 'auto' = 'release',
    graceSec: number = LOOP_END_GRACE_SEC_DEFAULT
  ): Promise<NotifyOutcome> {
    const out: NotifyOutcome = { readers: 0, pushed: [], skipped: [], pushedVia: [] }
    // 候选读者 = released 各 claim 上、能解析出 sessionId 且不是释放者的 (claim, reader)。
    // readersOf 已做归一（去重保序 + 过滤非字符串）。
    // 这三个变量**声明在 try 之外**：整体兜底 catch 要用它们把"尚未记账的候选"逐条补记进 skipped。
    const jobs: Array<{ claim: PublishedClaim; reader: string; sessionId: string }> = []
    const distinct = new Set<string>()
    let currentSessionId = ''
    try {
      // 投递面**只有一个**：进程内的 agents 注册表。拿不到它就没有任何诚实通道可投
      // （绝不回退到 prompt / sendMessage —— 那两个会让宿主把来源写成 kind:'user'）。
      const agents = ctx.get('agents') as AgentsLookupService | undefined
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
      const canPush = !!agents && typeof agents.get === 'function'
      for (const job of jobs) {
        // 兜底 catch 用它在 skipped 里指出"抛在哪条候选上"。
        currentSessionId = job.sessionId
        if (!canPush) {
          // 通道整个缺失：这**不是**"没人需要通知"，必须留在 skipped 里（0.8.2 是静默 return）。
          // 也**不许**回退到任何别的通道（AGENTS.md §1：没有诚实通道就不投）。
          out.skipped.push({ sessionId: job.sessionId, reason: 'inject-failed', error: 'no-agents-service' })
          continue
        }
        // 安全闸门：在任何投递之前（冷会话绝不被唤醒 / cold-resume）。
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
        // 幂等键 (claimId, reader) 仍然**先**记账：投递成功/失败都不再重投。
        if (!markPushed(job.claim.claimId, job.reader)) {
          out.skipped.push({ sessionId: job.sessionId, reason: 'already-pushed' })
          continue
        }
        const parts = releaseNoticeParts(job.claim, releaserName, action, graceSec)
        const r = pushOne(agents as AgentsLookupService, job.sessionId, parts)
        if (r.ok) {
          out.pushed.push(job.sessionId)
          out.pushedVia.push({ sessionId: job.sessionId, channel: CHANNEL_INJECT })
          continue
        }
        // 本仓库 tsconfig 是 strict:false，联合类型在属性访问处不做收窄（既有代码同样用 cast），
        // 所以这里显式取失败分支的字段。
        const rf = r as { error?: string; notResolvable?: true }
        // 解析不到目标 agent 是**如实跳过**（不用别的通道顶替）；inject 抛错是通道故障 —— 分开记。
        out.skipped.push({
          sessionId: job.sessionId,
          reason: rf.notResolvable === true ? 'agent-not-resolvable' : 'inject-failed',
          error: rf.error
        })
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

  /**
   * 循环终止自动释放的**两条**告知（0.9.10）：
   *   1. 读者（`notifyReaders(..., 'auto', graceSec)`）—— 谁在等这些路径，谁就该知道它空出来了；
   *   2. 被释放的会话**本人** —— 它此刻正是 idle，`agent.inject` 不唤醒 driver
   *      （`inject = send(msg, 'next-step', wakeup=false)`），消息挂在收件箱里，
   *      下一次被唤醒（真人回话 / 子代理交付）时随下一步进入模型上下文。
   *      这正是本功能的安全阀：**没有这条，会话恢复后会以为自己还持锁**。
   *
   * 绝不抛（自动释放是旁路，任何失败都不许打断宿主）；两个群体分别报账，
   * 使"没人需要通知"与"投递面坏了"从返回值上可分辨（与 notifyReaders 同一口径）。
   *
   * 解析不到本人（已卸载 / 受限宿主）时如实记 `agent-not-resolvable`，
   * **不**回退到任何别的通道（AGENTS.md §1：没有诚实通道就不投）。
   * 那种情况下留痕消息仍在（releaseOnLoopEnd 写在状态文件里），可以从留言板查到。
   *
   * 0.9.11 降噪：同一 holder 在 `LOOP_END_NOTICE_DEDUP_MS` 窗口内**反复**被自动释放时，
   * 发给本人的注入通知只发第一条，其余记 `error: 'deduped'`。**只合并通知，不合并证据** ——
   * 状态文件里的 `[自动释放]` 审计留言一条不少（那是取证用的账）。窗口存在的前提是：
   * 收件人此刻多半还 idle，`agent.inject` 不唤醒 driver，所以它**还没读到**上一条，
   * 内容又一字不差，重复注入只是往它的上下文里塞噪声。
   */
  async function notifyLoopEndRelease(
    released: PublishedClaim[],
    holderId: string,
    holderName: string,
    graceSec: number
  ): Promise<LoopEndReleaseOutcome> {
    const readers = await notifyReaders(released, holderId, holderName, undefined, 'auto', graceSec)
    let holder: PushOutcome = { ok: false, error: 'not-an-agent-holder' }
    try {
      const sessionId = sessionIdOf(holderId)
      if (!sessionId) return { readers, holder }
      const agents = ctx.get('agents') as AgentsLookupService | undefined
      if (!agents || typeof agents.get !== 'function') return { readers, holder: { ok: false, error: 'no-agents-service' } }
      const at = store.now()
      const last = loopEndNoticeAt.get(holderId) || 0
      if (last && at - last < LOOP_END_NOTICE_DEDUP_MS) {
        return { readers, holder: { ok: false, error: 'deduped' } }
      }
      loopEndNoticeAt.set(holderId, at)
      // 有界：只保留窗口内的条目，避免长跑进程里无界增长。
      if (loopEndNoticeAt.size > LOOP_END_NOTICE_MAX_KEYS) {
        for (const [k, ts] of loopEndNoticeAt) if (at - ts >= LOOP_END_NOTICE_DEDUP_MS) loopEndNoticeAt.delete(k)
      }
      holder = pushOne(agents, sessionId, loopEndHolderNoticeParts(holderName, released, graceSec))
    } catch (e) {
      holder = { ok: false, error: describeError(e) }
    }
    return { readers, holder }
  }

  ctx.on('agent/disposed', (payload: { agent?: { id?: string } }) => {
    try {
      const agent = payload && payload.agent
      if (!agent || !agent.id) return
      const h = 'agent:' + String(agent.id)
      // 功能 D：会话退出时把它从**所有** claim 的 readers 里摘掉（否则会向一个已经死掉的会话推送）。
      // W7 起**不再释放它的声明**：声明生命周期只由租约 expiresAt 决定，dispose 不是释放信号
      // （dispose 后的会话常常恢复并继续干活，提前删声明会让别人看到"路径空闲"）。
      // 因此 data.released 正常为空 ⇒ 这条路径正常情况下不产生"锁已释放"通知（那才是实话）。
      const holderId = h
      let releaserName = holderId
      try {
        releaserName = store.hname({ holderId, sessionId: String(agent.id), agent: agent as AgentLike }) || holderId
      } catch (e) {}
      store.mutate(s => dropHolder(s, holderId, Date.now()), String(agent.id), agent as AgentLike)
        .then(res => {
          if (res && res.ok === true && res.data && Array.isArray(res.data.released)) {
            // 0.9.6：这条路径**不需要**"活 Agent 当 sender"了（子代理回退通道已删）——
            // 投递面是进程内解析每个读者自己的 agent 再 inject，与释放者是否还在无关。
            // 新通道下这里**照常如实投递**；解析不到的读者由 notifyReaders 自己记
            // skipped.reason='agent-not-resolvable'（不是靠下面的兜底 catch 保证）。
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

  /**
   * advisory notice 的**单条同步投递**：调用方已经拿着活 Agent（tools/pre-execute 的 execCtx.agent），
   * 不需要（也不该）再走 sessionId 解析。失败三态与 pushOne 同一口径，只是错误名更直白。
   */
  function pushNotice(agent: AgentLike | undefined, text: string, label: string): PushOutcome {
    if (!agent || typeof (agent as { inject?: unknown }).inject !== 'function') {
      return { ok: false, error: 'agent-has-no-inject' }
    }
    try {
      ;(agent as { inject(m: unknown): void }).inject(releaseNoticeMessage({ text, summary: boundContextSummary(label) }))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e && (e as Error).message) || e) }
    }
  }

  return { notifyReaders, notifyLoopEndRelease, pushNotice }
}
