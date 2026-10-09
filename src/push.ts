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
import { readersOf, dropHolder, releaseOnLoopEnd, modeLabel, holderLabel } from './collab-core.js'
import type { PublishedClaim } from './collab-core.js'
import { sessionIdOf, LOOP_END_GRACE_SEC_DEFAULT } from './spec.js'
import type {
  AgentLike, AgentsLookupService, CollabContext, LoopEndReleaseOutcome, NotifyOutcome, PushChannel, PushOutcome
} from './contract.js'
import type { StateStore } from './store.js'

/**
 * M1：释放/通知结果的诚实口径扩展 —— `NotifyOutcome` 的既有字段（`pushed` / `pushedVia` / …）
 * 语义一字不动，**只补一条**机读 caveat `pushedNote`：`pushed` 仅保证消息进了读者的
 * next-step 收件箱，不保证读者会看到（依据与后果见安装处闭包里的 `PUSHED_NOTE`）。
 * contract.ts 不在本单元的改动范围，故扩展类型就地声明；运行时它真的挂在工具结果的
 * `data.notify` 上（tools.ts 直接赋值，不重建对象）。
 */
export type NotifyOutcomeWithNote = NotifyOutcome & { pushedNote: string }

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
  ): Promise<NotifyOutcomeWithNote>
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
  /**
   * **仅供测试**：循环终止通知去重表的当前条目数。生产路径不消费它；它的存在只是为了
   * 让"M1 第 3 条：size 不超过上限"能是一条**直接**断言，而不是只靠行为旁证。
   */
  debugLoopEndNoticeSize(): number
}

export function installPush(ctx: CollabContext, store: StateStore): PushApi {
  // ---- 功能 D：释放后的通知投递（agent.inject + form:'notice'）----
  // 0.8.4 的两条通道（sessionController.prompt / subagents.sendMessage）**整体删除**：
  // 它们是"宿主代造消息"的接口，来源由宿主写成 kind:'user'，冒充真人输入。

  // 通道名（notify.pushedVia[].channel 用）：**只剩一个**，投递面就是 agent.inject。
  const CHANNEL_INJECT: PushChannel = 'inject'

  /**
   * M1 第 1 条：投递口径的诚实说明（挂在结果 `notify.pushedNote` 上）。
   *
   * `pushed` 的既有含义**不变**（成功调用了 `agent.inject` 的 sessionId），但它被读成
   * "已通知"是不诚实的：`agent.inject` 的契约是 `send(input, 'next-step', wakeup=false)`
   * （实现 `dsh-agent-loop/lib/index.js:812-813`；对照 `:810` 的 `wake(input)` 才传 `true`），
   * 消息只是**进了 next-step 收件箱**。只有下一次 step 检查 `this.inbox.hasPending`
   * （`:1037`）时才取走并送进模型上下文；读者 idle 且此后无人唤醒它 ⇒ 消息一直停在收件箱，
   * 可能永远不被模型看到；被 `cancel()` / `dispose()` 时 `this.inbox.clear()`（`:817`）
   * 会把还没取走的整批直接丢弃。
   *
   * 本单元**不改投递通道、也不去唤醒读者**（那会打断对方回合，超出范围）：只把这条口径
   * 如实标在每次推送结果上，供释放者与读者自己判断"到底通知到了没有"。
   */
  const PUSHED_NOTE = '收件箱口径：agent.inject 的契约是 wakeup=false，pushed 只表示消息已进入读者的 next-step 收件箱；读者 idle 且此后无人唤醒时不会被模型看到，cancel/dispose 会清空收件箱。'


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
  // claimId 于是照发；这里按"holder + 本次释放的 claim 集合指纹"在**时间窗口**内合并，
  // 专治"claim→release→claim"抖动。
  // M1 第 4 条：**键必须带上本次释放的集合指纹**。旧实现只看 holderId+时间窗，于是同一 holder
  // 在窗口内释放了两组**不同**的 claim 时，第二条提及另一些路径的告知被静默丢弃 ——
  // 而旧注释却声称"内容一字不差"。现在只有"同一 holder 且本次释放的路径集合相同"才合并。
  // 本 map 住在 installPush 的闭包里 ⇒ 每个插件实例一份，测试之间天然隔离。
  const LOOP_END_NOTICE_DEDUP_MS = 60_000
  const LOOP_END_NOTICE_MAX_KEYS = 500
  const loopEndNoticeAt = new Map<string, number>()

  /**
   * 发给本人的通知的**内容指纹**（M1 第 4 条）：同一 holder 在窗口内是否算"内容一字不差"，
   * 取决于 `loopEndHolderNoticeParts` 实际用到的输入 —— holder 本人（holderId 已进外层键）、
   * 宽限秒数、以及去重后的路径集合。所以指纹取"排序后的路径集合 + 宽限秒数"。
   * re-claim 同一条路径会拿到新 claimId，但路径集合没变 ⇒ 仍然合并（保留 0.9.11 的抖动降噪）；
   * 释放到**另一些**路径 ⇒ 指纹变 ⇒ 不再合并（修掉被静默丢弃的第二条）。
   */
  function releaseSetFingerprint(released: PublishedClaim[], graceSec: number): string {
    const paths: string[] = []
    for (const c of released) {
      for (const p of (Array.isArray(c.paths) ? c.paths : [])) {
        if (typeof p === 'string' && p && !paths.includes(p)) paths.push(p)
      }
    }
    paths.sort()
    return graceSec + '\u0000' + JSON.stringify(paths)
  }

  /**
   * M1 第 3 条：让"有界"为真 —— 超过上限时**淘汰最旧的一条**（按记录的时间戳），
   * 使 `loopEndNoticeAt.size` 恒 ≤ `LOOP_END_NOTICE_MAX_KEYS`。
   * 旧实现在 `set` 之后才清理、且只删"已过 60s 窗口"的条目：触发那一刻刚 set 的整批 age=0
   * 全保留，窗口内持续有 >500 个不同 holder 时该 map 无界增长，与"有界"的注释相反。
   */
  function trimLoopEndNotice(): void {
    while (loopEndNoticeAt.size > LOOP_END_NOTICE_MAX_KEYS) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [k, ts] of loopEndNoticeAt) {
        if (ts < oldestAt) { oldestAt = ts; oldestKey = k }
      }
      // 空 map 时 size 不可能 > 上限，这里只是防御（不给 `delete(undefined)` 之类留缝）。
      if (oldestKey === undefined) break
      loopEndNoticeAt.delete(oldestKey)
    }
  }

  /** 只读判据：这一对是否**已经成功投递过**（用于跳过，绝不改变任何状态）。 */
  function alreadyPushed(claimId: string, reader: string): boolean {
    const seen = pushedPairs.get(claimId)
    return !!(seen && seen.has(reader))
  }

  /**
   * 记账"这一对已成功推过"（M1 第 5 条：**在投递成功之后**才调用）。
   * 有界：**总对数**超过 PUSH_DEDUPE_MAX 时按插入顺序淘汰最旧的一对（与拆分前等价）。
   */
  function markPushed(claimId: string, reader: string): void {
    const seen = pushedPairs.get(claimId)
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
      const holder = holderLabel(c.holderId, c.holderName)
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
  ): Promise<NotifyOutcomeWithNote> {
    const out: NotifyOutcomeWithNote = { readers: 0, pushed: [], skipped: [], pushedVia: [], pushedNote: PUSHED_NOTE }
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
        // 幂等键 (claimId, reader)：先查、**投递成功之后才记账**（M1 第 5 条）。
        // 旧实现在 pushOne 之前就记账，于是 `inject` 抛错后这一对已被记下 ⇒ 同 claimId 的后续
        // 释放不再重试，而且重推会误报 'already-pushed'，把上次的真实失败原因（inject-failed）
        // 抹掉。现在失败的那一对不记账，第二次释放会真的重试并如实报本次的原因。
        if (alreadyPushed(job.claim.claimId, job.reader)) {
          out.skipped.push({ sessionId: job.sessionId, reason: 'already-pushed' })
          continue
        }
        const parts = releaseNoticeParts(job.claim, releaserName, action, graceSec)
        const r = pushOne(agents as AgentsLookupService, job.sessionId, parts)
        if (r.ok) {
          markPushed(job.claim.claimId, job.reader)
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
   * 收件人此刻多半还 idle，`agent.inject` 不唤醒 driver，所以它**还没读到**上一条，重复注入
   * 只是往它的上下文里塞噪声。
   * M1 第 4 条修正了这里原来不成立的断言：合并的条件不是"同一 holder"就够，而是"同一 holder
   * **且本次释放的路径集合与宽限期相同**"（见 releaseSetFingerprint）—— 否则释放到另一些路径的
   * 第二条会被静默丢弃，而正文其实并不"一字不差"。
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
      // M1 第 4 条：键 = holder + 本次释放集合的指纹（内容相近才合并）。
      const key = holderId + '\u0000' + releaseSetFingerprint(released, graceSec)
      const last = loopEndNoticeAt.get(key) || 0
      if (last && at - last < LOOP_END_NOTICE_DEDUP_MS) {
        return { readers, holder: { ok: false, error: 'deduped' } }
      }
      loopEndNoticeAt.set(key, at)
      // M1 第 3 条：真淘汰（超过上限逐出最旧），size 恒 ≤ LOOP_END_NOTICE_MAX_KEYS。
      trimLoopEndNotice()
      holder = pushOne(agents, sessionId, loopEndHolderNoticeParts(holderName, released, graceSec))
    } catch (e) {
      holder = { ok: false, error: describeError(e) }
    }
    return { readers, holder }
  }

  /**
   * M1 第 2 条：`agent/disposed` 路径的**如实记账**通道。
   *
   * 这条路径没有调用方 —— 它是事件回调，返回值无人接收，所以失败只能走日志。优先用注册进来的
   * `logger` 服务（本插件的 `CollabContext` 契约没有声明它，故现场活取）；没有就用 cordis
   * Context 自带的 `ctx.logger`（每个 Context 都有一个 LoggerService，实测
   * `@deepseek-ai/cordis` 的实例带 `warn`/`info`/`error`）。两者都取不到时退化为**无害的空操作**：
   * 那是宿主能力缺失，**不是"成功"** —— 这里绝不把失败伪装成成功。
   *
   * 记账内容带真实原因（写失败的错误文本 / mutate 返回的 ok:false 取值），便于从宿主日志回溯。
   */
  function reportInternal(scope: string, detail: string): void {
    const line = '[dsh-collab] ' + scope + ': ' + detail
    try {
      const reg = ctx.get('logger') as { warn?: (m: string) => void } | undefined
      if (reg && typeof reg.warn === 'function') { reg.warn(line); return }
      const native = (ctx as unknown as { logger?: unknown }).logger
      const warn = native && typeof (native as { warn?: unknown }).warn === 'function'
        ? (native as { warn(m: string): void }).warn.bind(native)
        : (typeof native === 'function' ? (native as (m: string) => void) : undefined)
      if (warn) warn(line)
    } catch (e) {}
  }

  /** mutate() 未返回可投递结果时，把它的真实状态压成一行（reportInternal 用）。 */
  function describeMutateResult(res: unknown): string {
    const r = res as { ok?: unknown; error?: unknown; message?: unknown } | null | undefined
    if (!r || typeof r !== 'object') return 'result=' + String(r)
    const parts = ['ok=' + String(r.ok)]
    if (r.error !== undefined) parts.push('error=' + String(r.error))
    if (r.message !== undefined) parts.push('message=' + String(r.message))
    parts.push('released=' + (Array.isArray((r as { data?: { released?: unknown } }).data && (r as { data?: { released?: unknown } }).data!.released) ? 'array' : 'missing'))
    return parts.join(' ')
  }

  ctx.on('agent/disposed', (payload: { agent?: { id?: string } }) => {
    try {
      const agent = payload && payload.agent
      if (!agent || !agent.id) return
      const h = 'agent:' + String(agent.id)
      // **句柄结束 ⇒ 自动删除**（0.13.0，用户决策；推翻 0.9.6 起的 W7 取舍）。
      // `agent/disposed` 是"这个 agent 的句柄结束了"的确定性事件（`agent.dispose()` 会停循环、
      // 注销注册表，见 dsh-agent/lib/types/index.d.ts:135-145），所以这一刻它**不可能**还在写文件：
      // 立即释放它的**全部未过期**声明，并照旧把它从所有 claim 的 readers 里摘掉（功能 D）。
      // W7 当年的顾虑是"退场会话常常恢复并继续干活"，恢复后的会话确实会以为自己还持锁 ——
      // 缓解手段是留痕：`releaseOnLoopEnd` 会往频道 `agent:<holderId>` 写一条审计留言，
      // 谁恢复谁能在 `collab_board op=read` 时看到；同时读者会收到"锁已释放"的通知。
      const holderId = h
      let releaserName = holderId
      try {
        releaserName = store.hname({ holderId, sessionId: String(agent.id), agent: agent as AgentLike }) || holderId
      } catch (e) {}
      store.mutate(s => {
        const rel = releaseOnLoopEnd(s, holderId, releaserName, Date.now(), LOOP_END_GRACE_SEC_DEFAULT, 'disposed')
        const dropped = dropHolder(s, holderId, Date.now())
        const released = rel && rel.data && Array.isArray(rel.data.released) ? rel.data.released : []
        if (rel.changed !== true && dropped.changed !== true) return { ok: true, changed: false, data: { released: [] } }
        return { ok: true, changed: true, state: s, data: { released: released.concat(dropped.changed === true && Array.isArray(dropped.data && dropped.data.released) ? dropped.data.released : []) } }
      }, String(agent.id), agent as AgentLike)
        .then(res => {
          if (res && res.ok === true && res.data && Array.isArray(res.data.released)) {
            // 0.9.6：这条路径**不需要**"活 Agent 当 sender"了（子代理回退通道已删）——
            // 投递面是进程内解析每个读者自己的 agent 再 inject，与释放者是否还在无关。
            // 新通道下这里**照常如实投递**；解析不到的读者由 notifyReaders 自己记
            // skipped.reason='agent-not-resolvable'。
            return notifyReaders(res.data.released as PublishedClaim[], holderId, releaserName)
          }
          // M1 第 2 条：mutate **没报成功**（写冲突 / not-found / data 形状不对）同样是失败，
          // 旧实现只用 `if (…ok===true…)` 接住成功分支、失败分支无声滑过 ⇒ 必须留痕。
          reportInternal('agent/disposed', 'mutate 未返回可投递的 released：' + describeMutateResult(res))
        })
        // M1 第 2 条：把原来的空 `.catch(() => {})` 换成**如实记账**。
        // 覆盖两类否则完全无痕的失败：mutate 的写盘拒绝（fs 写失败 / 乐观并发重试用尽），
        // 以及 notifyReaders 的异步拒绝。没有 logger 面时 reportInternal 退化为空操作 ——
        // 宿主能力缺失，不是"成功"。
        .catch(e => {
          reportInternal('agent/disposed', '异步链路失败（状态释放或读者通知）：' + describeError(e))
        })
    } catch (e) {
      // 同步段（取 hname / 调 mutate）的意外：同样留痕，不再静默吞掉。
      reportInternal('agent/disposed', '处理器同步段抛出：' + describeError(e))
    }
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

  return { notifyReaders, notifyLoopEndRelease, pushNotice, debugLoopEndNoticeSize: () => loopEndNoticeAt.size }
}
