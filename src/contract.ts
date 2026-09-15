// src/contract.ts
// **对外契约类型的唯一事实源**：本插件消费的 ctx 服务面、工具定义形状、
// 推送结果形状、以及设置/skill 服务的入参。src/index.ts 从这里重新导出，
// 对外导出面与拆分前一字不差；各功能模块也从这里取类型，避免互相 import。
//
// 刻意不叫 types.ts：src/types/ 是 schema 派生产物的目录，同名会造成解析歧义。

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Claim, ConflictInfo, HolderInput, Mode, PublishedClaim, StateDocument } from './collab-core.js'

/** fs 服务返回的文件引用（displayPath / version 由 DSH fs 服务提供）。 */
export interface FileRef {
  displayPath: string
  version?: number
  [key: string]: any
}

/** ctx.fs 中本插件实际使用的最小接口。 */
export interface CollabFs {
  resolve(path: string, opts?: { cwd?: string }): Promise<FileRef>
  stat(target: FileRef): Promise<{ version: number } | null>
  readText(target: FileRef): Promise<string>
  writeText(target: FileRef, content: string, opts?: { kind?: string; version?: number }): Promise<unknown>
  processPath(target: FileRef): string
}

export interface SessionLike { header?: { cwd?: string } }
export interface AgentLike {
  id?: string
  session?: SessionLike
  /**
   * 循环终止自动释放用：DSH 的 agent 状态（`AgentStatus = 'idle' | 'running'`，
   * `dsh-agent/lib/types/runtime-types.d.ts:90,147`）。
   * `'idle'` = 没有 driver 还排着或跑着（循环停了）；`'running'` = 有驱动在执行。
   * 可选：受限宿主可能给不出这个字段 —— 拿不到就**不武装**自动释放（见 auto-release.ts）。
   */
  status?: 'idle' | 'running'
  /**
   * 功能 A 用：逐事件注入一条**显式标注来源**的消息。
   * 契约原文 `inject(message: UserMessage): void`（`dsh-agent/lib/types/runtime-types.d.ts:209`），
   * 语义是 `send(message, "next-step", wakeup=false)` —— 进入下一步但**不唤醒** driver
   * （`dsh-agent-loop/lib/index.js:795`）。
   * 形参写 `unknown` 是为了让 contract 模块不依赖 dsh-llm 的类型；真正的类型检查在调用点
   * （那里传的是货真价实的 `UserMessage`）。
   */
  inject?(message: unknown): void
}
export interface SessionsService { get(agentId: string): SessionLike | undefined }
export interface SessionTitleService { get(session: SessionLike): { title?: string } | undefined }

/**
 * ctx.agents 中功能 D 用到的活体查询面（实测：`get(id: SessionId): Agent | undefined`）。
 * "活着的会话"是本功能唯一允许被推送的目标 —— 推送会 resume 冷会话，绝不允许。
 *
 * `list()`（0.9.8 op=reap 的活体检查）：返回**此刻加载着的** agent。它同样不含休眠会话，
 * 所以它只用来"排除确信活着的人"，**不许**反过来当成"不在名单里 = 已死"的死亡证明
 * （见 src/collab-core.ts 的 reap 注释）。服务没提供 list 时按"检查不可用"处理：一个也不回收。
 */
export interface AgentsLookupService {
  get(id: string): AgentLike | undefined
  list?(): AgentLike[]
}

/**
 * ctx.sessionController 的最小接口。实测自 `Session` service 契约
 * （@deepseek-ai/dsh-api-session-controller）：
 *   prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>
 *   SessionPromptRequest = { requestId, sessionId, mode: 'queue' | 'steer',
 *                            content: readonly PromptContentPart[] }
 * 文本分支 PromptContentPart 就是 `{ type: 'text', text }`。
 * list() 用来判定会话是否在跑（SessionSummary.running），拿不到就退回 'queue'。
 */
export interface SessionControllerService {
  prompt(request: {
    requestId: string
    sessionId: string
    mode: 'queue' | 'steer'
    content: Array<{ type: 'text'; text: string }>
  }, signal: AbortSignal): Promise<unknown>
  list?(request: unknown, signal: AbortSignal): Promise<{ items?: Array<{ sessionId?: string; running?: boolean }> }>
}

/**
 * ctx.subagents 中功能 D **回退通道**用到的最小接口（0.8.4）。
 * 契约逐字来自 Inspect 实查的 `subagents` 服务，并以源码核对
 * （@deepseek-ai/dsh-subagent/lib/index.js 与 types/continuation.d.ts:57）：
 *   sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[],
 *               options: SubagentSendMessageOptions): Promise<MessageId>
 *   Agent = { readonly id: SessionId }；SubagentSendMessageOptions = { readonly signal: AbortSignal }
 * 文档硬约束：
 *   - 只能投给 sender 的**直接父会话或直接可续子会话**（邻接是硬约束）；
 *   - throws：continuation 服务不可用、**邻接被拒**、或消息未被接收；
 *   - sender 必须是 "exact live Agent" —— 源码用 `ctx.agents.get(sender.id) !== sender`
 *     （dsh-subagent/lib/index.js:1735）做**对象同一性**判定，所以调用方**绝不能重建**这个对象。
 *   - 文档同时写明 "an absent direct child cold-resumes from persistence"，这正是本插件
 *     必须**先过存活闸门**（store.livenessOf，三态）才敢调用它的原因（见 notifyReaders）。
 */
export interface SubagentSenderLike { id: string }
export interface SubagentsService {
  sendMessage(
    sender: SubagentSenderLike,
    targetId: string,
    content: Array<{ type: 'text'; text: string }>,
    options: { signal: AbortSignal }
  ): Promise<unknown>
}

/**
 * 单条推送的返回：成功，或带一行可读原因失败。
 * 0.9.6：`inject` 的契约是**同步**的（`inject(message): void`），不存在"永不 resolve"的窗口，
 * 所以不再有 'timeout' 这一态；`ok` / `error` 的语义与取值一字未动。
 * 失败分支的可选标记让调用方不必解析 error 文本就知道失败类别：
 *   - notResolvable：存活判据说"活着"，但此刻 `agents.get(sessionId)` 已解析不到目标 agent
 *     （TOCTOU 竞态）——**如实跳过**，不回退到任何别的通道（旧实现的 subagentRouting /
 *     notAdjacent 两个标记随通道一起删除：那两条通道会让宿主把来源写成 kind:'user'，即冒充用户）。
 */
export type PushOutcome =
  | { ok: true }
  | { ok: false; error: string; notResolvable?: true }

/** 0.9.6：投递通道名（`notify.pushedVia[].channel`）。**只剩一个诚实通道**：`agent.inject`。 */
export type PushChannel = 'inject'

/**
 * 一次 release 的推送结果汇总（0.8.3 起挂在 release 结果的 `data.notify` 上）。
 * 目的：让释放者能区分"没有人需要通知"与"通知通道坏了"。
 * 0.9.6：投递面换成 `agent.inject`（显式来源的 notice），随旧通道删除的取值见下。
 */
export interface NotifyOutcome {
  /** 该次涉及的去重读者数（= pushed + skipped 的候选读者；无会话的非 agent holder 不计入）。 */
  readers: number
  /** 真正投递成功的 sessionId（一次投递一条；同一读者挂在多条被释放的 claim 上时会出现多次）。语义与 0.8.3 相同，不分通道。 */
  pushed: string[]
  /**
   * 每次成功投递所走的通道，与 `pushed` **等长且同序**。
   * 0.9.6 起**只有一个**取值：'inject' = 进程内解析到读者自己的 agent 后 `agent.inject` 一条
   * 显式来源（`kind:'plugin'`, `form:'notice'`）的消息。始终存在（无成功投递时为空数组）。
   */
  pushedVia: Array<{ sessionId: string; channel: PushChannel }>
  /** 未能投递的候选读者。既有取值 not-live / already-pushed 的语义不变。 */
  skipped: Array<{
    sessionId: string
    /**
     * not-live               = 会话此刻未加载（刻意不唤醒；注入面对未加载的会话结构上不可能投递）；
     * already-pushed         = 同 (claimId, reader) 已推过；
     * liveness-check-failed  = 存活判据**本身坏了**（agents.get 抛异常）—— 基础设施故障，
     *                          与"会话没在线"（not-live）是两件事，绝不能折叠成后者；带真实错误文本。
     * agent-not-resolvable   = 0.9.6 追加：判据说活着、投递时却已解析不到目标 agent（TOCTOU 竞态）
     *                          —— **如实跳过**，不回退到任何会冒充用户的通道（旧通道已删除）。
     * inject-failed          = 0.9.6 追加：投递面本身不可用/失败（`agents` 服务缺失 ->
     *                          error 'no-agents-service'；解析到的对象没有 inject 面 ->
     *                          'agent-has-no-inject'；inject 抛出 -> 真实错误文本）。
     * internal               = 0.9.0 追加：推送链路的整体兜底（当前候选读者处理途中抛出未预期的异常）。
     *                          逐条补记尚未记账的候选，使 pushed + skipped 永远能对上候选条数。
     * 已删除（0.9.6）：prompt-failed / not-adjacent / subagent-failed —— 它们描述的
     * `sessionController.prompt` 与 `subagents.sendMessage` 两条通道会让宿主把消息来源写成
     * `kind:'user'`（GUI 里是用户气泡），已整体移除，取值不再可产生。
     */
    reason: 'not-live' | 'already-pushed' | 'liveness-check-failed'
      | 'agent-not-resolvable' | 'inject-failed' | 'internal'
    /** 出现于失败取值：真实错误文本，或 'no-agents-service' / 'agent-has-no-inject' / 'agent-not-resolvable'。 */
    error?: string
  }>
}

/** 技能调用面：modelInvocable 进模型目录，userInvocable 进人工命令目录。 */
export interface SkillInvocationPolicy {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** 技能正文相对资源的解析基址（目录形态用于引用同目录的附属文件）。 */
export type SkillResourceBase =
  | { kind: 'directory'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'opaque'; description: string }

/** ctx.skills.register 的入参（invocation/provider 可缺省，缺省时由注册表定默认值）。 */
export interface SkillRegistration {
  name: string
  description: string
  whenToUse?: string
  content: string
  source: string
  provider?: string
  resourceBase?: SkillResourceBase
  path?: string
  metadata?: Record<string, unknown>
  invocation?: SkillInvocationPolicy
}

/** ctx.skills 中本插件实际使用的最小接口；**可选服务**，缺失或不可用时静默跳过注册。 */
export interface SkillsService { register(skill: SkillRegistration): () => void }

/** 委托纪律偏好的解析值。 */
export interface DelegationSettings {
  exposeDelegationDiscipline: boolean
  /**
   * 功能 C 的写保护总开关，默认 **true**（"不准写是必须的"）。
   * 关掉后 pre-execute 不再拦截任何写/读调用；已存在的 claim 语义不受影响。
   */
  enforceWriteLock: boolean
  /**
   * 循环终止自动释放总开关（0.9.10），默认 **true**。
   * 关掉后 agent/status → idle 不再触发任何释放，声明只由 op=release / 租约到期回收。
   */
  releaseOnLoopEnd: boolean
  /** 上面那条的宽限期（秒），默认 15，夹在 [LOOP_END_GRACE_SEC_MIN, LOOP_END_GRACE_SEC_MAX]。 */
  loopEndGraceSec: number
}

/**
 * 一次"循环终止自动释放"的告知结果。
 * 两个受影响的群体分开报账，因为它们**不是同一件事**：
 *   - `readers`：此前登记为读者、正等着这些路径的会话（沿用 release 的 NotifyOutcome 口径）；
 *   - `holder`：被释放的会话**本人** —— 它多半正 idle，`agent.inject` 的消息会挂在收件箱里，
 *     等它下一次被唤醒时送达（这正是"别让它恢复后以为自己还持锁"的那条告知）。
 */
export interface LoopEndReleaseOutcome {
  readers: NotifyOutcome
  holder: PushOutcome
}

/** ctx.settings.installSection 的 hooks：setSource 交出**实时**读取器，onChange 在值变化时回调。 */
export interface SettingsSectionHooks {
  setSource(source: () => DelegationSettings): void
  onChange(): void
  validate?(value: DelegationSettings): void
}

/** ctx.settings 中本插件实际使用的最小接口；**可选服务**。 */
export interface SettingsService {
  installSection(owner: unknown, ns: string, schema: unknown, entry: DelegationSettings, hooks: SettingsSectionHooks): void
}

/**
 * ctx.connection 中本插件实际使用的最小接口；**可选服务**。
 * 只读路由的围栏：Host/Origin 检查（防 DNS rebinding）+ 浏览器登录令牌，
 * 返回拒绝状态码，undefined 表示放行。
 */
export interface ConnectionService {
  requestRejection(request: unknown): number | undefined
}

/**
 * ctx.webServer 中本插件实际使用的最小接口；**可选服务**。
 * 与部署里 open-in-app 注册路由的形态一致（kind/path/handler，返回 disposer）。
 */
export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 路由载荷里的一项设置：字段名，以及它关联的随包 skill（无关联时为 null）。 */
export interface CollabSkillItem {
  field: string
  skill: { name: string; description: string; whenToUse?: string; path: string } | null
}

/** 路由载荷：命名空间 + 条目表。**不含 skill 正文**（正文由右侧预览直接读文件）。 */
export interface CollabSkillIndex {
  namespace: string
  items: CollabSkillItem[]
}

/** 已加载的随包 skill：路由只交出 name/description/whenToUse/path，正文永不过网。 */
export interface BundledSkill {
  name: string
  description: string
  whenToUse?: string
  content: string
  path: string
}

/** 工具调用上下文（execute 的第二个参数），取 agent 作为 holder 身份及 cwd 来源。 */
export interface ToolExecContext {
  agent?: AgentLike
  [key: string]: any
}

/** lock / board 的调用参数（由 JSON Schema 描述，字段随 op 变化）。 */
export interface CollabArgs {
  op?: string
  paths?: string[]
  claimId?: string
  mode?: Mode
  /** 功能 C：可读性（默认 true，只认显式 false）。 */
  readable?: boolean
  ttlSec?: number
  timeoutMs?: number
  /** op=reap：默认 false = dry-run；显式 true 才真正删除僵尸声明。 */
  confirm?: boolean
  /** op=reap：age 门槛（秒），默认 600（REAP_DEFAULT_OLDER_THAN_SEC）。 */
  olderThanSec?: number
  note?: string
  channel?: string
  body?: string
  mentions?: string[]
  replyTo?: string
  since?: number
  limit?: number
}

/** 统一结果信封；ok:false 时 error/message 提升到顶层，少数 op 附加诊断字段。 */
export interface ToolResult {
  ok: boolean
  error?: string
  message?: string
  data?: Record<string, any>
  conflicts?: ConflictInfo[]
  paths?: string[]
  blockers?: PublishedClaim[]
  waitedMs?: number
}

/** DSH 工具定义（ctx.tools.register 的入参）。 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: CollabArgs, value: unknown) => Array<{ type: string; text: string }>
  }
  execute: (args: CollabArgs, exec: ToolExecContext) => Promise<ToolResult>
}

/** 插件 ctx：只声明本插件实际消费的服务与事件 API。 */
export interface CollabContext {
  fs: CollabFs
  timer: { timeout(ms: number): Promise<void>; interval(callback: () => void, delay: number): () => void }
  tools: { register(tool: ToolDefinition): void }
  effect(callback: () => void | (() => void), label?: string): void
  get(name: string): any
  /**
   * cordis 事件注册。waterfall 事件的监听器签名是 `(...args, next)`：
   * tools/pre-execute 是 `(exec, next)`，tools/post-execute 是 `(exec, result, next)`。
   * 返回 disposer；listener 作为当前 fiber 的 effect 注册，随 ctx 作用域自动回收。
   */
  on(event: string, handler: (...args: any[]) => any, options?: { global?: boolean; prepend?: boolean }): () => void
  /** cordis 的动态依赖：deps 就绪时在子 fiber 里跑 callback；deferred 直到服务出现。 */
  inject(deps: string[], callback: (ctx: CollabContext & { settings?: SettingsService; webServer?: WebServerService }) => void): unknown
}

/** 单个 op 的处理函数签名。 */
export type OpHandler = (args: CollabArgs, h: HolderInput, agentId: string | null, agent?: AgentLike) => ToolResult | Promise<ToolResult>

/** load() 的返回：状态文档 + 乐观并发版本号 + 存储目标 + 绝对状态目录 + 诊断 warning。 */
export interface LoadResult {
  state: StateDocument
  version: number | null
  target: FileRef
  stateDir: string
  warn: string | null
}

/**
 * ctx.systemPrompt 中本插件实际使用的最小接口；**可选服务**。
 * 态势摘要（dsh-collab/awareness，order 130）与常驻纪律块（dsh-collab/delegation，order 131）
 * 都经它注册；text 必须是同步字符串。
 */
export interface PromptContextService {
  context(c: { name: string; order: number; text: string | ((context: any) => string) }): () => void
}
