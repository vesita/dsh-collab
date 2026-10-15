// src/contract.ts
// **对外契约类型的唯一事实源**：本插件消费的 ctx 服务面、工具定义形状、
// 推送结果形状、以及设置/skill 服务的入参。src/index.ts 从这里重新导出，
// 对外导出面与拆分前一字不差；各功能模块也从这里取类型，避免互相 import。
//
// 刻意不叫 types.ts：src/types/ 是 schema 派生产物的目录，同名会造成解析歧义。

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Claim, ConflictInfo, HolderInput, Mode, PublishedClaim, StateDocument } from './collab-core.js'

/**
 * 本插件自己产出的消息来源。
 *
 * 0.1.7 起 `MessageSourceMap` 里**没有**通用的 `plugin` 兜底种类：每个生产者必须在
 * 自己的模块里声明自己的 `kind`（`dsh-llm/lib/types/message.d.ts` 的 `MessageSourceMap`
 * 文档明写它是 merge-extensible、且**没有共享的 catch-all `plugin` 种类**）。生态同款写法见
 * `dsh-time-context`（`'time-context': { kind: 'time-context' } & ContextFormed`）与
 * `dsh-subagent` 的 `'subagent-settled'`；客户端的 `contextProducer`
 * （`dsh-client-ui-chat/lib/client.js:6760-6779`）对未知 `kind` 的默认分支就是
 * `role: 'inject'` + `label = kind`，所以这条来源在界面上标注为 `dsh-collab`。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-collab': { kind: 'dsh-collab' } & ContextFormed
  }
}

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
  /**
   * 可选：列举目录的直接子项（跨项目观测用）。真实 fs 服务提供
   * `listDir(target, signal?): Promise<FsDirEntry[]>`（`dsh-fs/lib/types/index.d.ts:199`，
   * `FsDirEntry = { name, type, target, version?, size? }`）；受限宿主可能不给 ——
   * 那时 `overview` 只报当前项目，**不编造**别的项目。
   */
  listDir?(target: FileRef, signal?: unknown): Promise<Array<{ name?: string; type?: string; target?: FileRef }>>
}

/**
 * 会话头。`cwd` 是项目隔离键；`parentSession` 是**血缘**（谁派生了我）。
 *
 * 血缘的来源与实测：子智能体创建时把 `parentSession: parentHeader.id`、
 * `origin: 'subagent'`、`delegationDepth` 写进会话头
 * （`dsh-subagent/lib/types/child-agent.js:117-123`），类型定义见部署内
 * `dsh-agent/lib/types/index.d.ts:66`（`SessionHeader.parentSession?: SessionId`）。
 * 祖先链可上溯的先例：`dsh-subagent/lib/types/continuation-activation.js:381-388`。
 *
 * 它**只用于冲突判定**（见 collab-core.ts 的 inFamily）：父子会话共享写域，
 * 所以父的独占锁不该拒绝自家子智能体。血缘不落盘，每次从运行时现算。
 */
export interface SessionLike { header?: { cwd?: string; parentSession?: string } }
export interface AgentLike {
  id?: string
  session?: SessionLike
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

/**
 * 一次 release 的推送结果汇总（0.8.3 起挂在 release 结果的 `data.notify` 上）。
 * 目的：让释放者能区分"没有人需要通知"与"通知通道坏了"。
 * 0.9.6：投递面换成 `agent.inject`（显式来源的 notice），随旧通道删除的取值见下。
 */

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
 * ctx.agentTeams 中本插件实际使用的最小接口；**可选服务**（0.11.0）。
 *
 * 来源：官方实验 bundle `@deepseek-ai/dsh-experimental-agent-team-profile`。服务是**进程级**注册的
 * （`dsh-experimental-agent-team/lib/index.js:1655-1656` 的 `super(ctx, 'agentTeams')`），
 * 但每个读方法都以**活的 Agent 作为授权凭据**：`listTasks(caller)` 解析 caller 的 Team 归属，
 * 非成员抛 TEAM_NOT_MEMBER；没有 Team 记录的顶层会话是"自己的空团队"的隐式 Lead，返回空数组。
 *
 * 本插件**只读**、只在服务在场时使用，且任何失败都按"读不到"处理（调用方降级为一字不变）。
 * `TeamTaskView` 的真实形状见 `dsh-experimental-agent-team/lib/types/types.d.ts:67-78`。
 */
export interface AgentTeamsServiceLike {
  listTasks(caller: unknown): Array<{
    id?: unknown
    subject?: unknown
    status?: unknown
    ownerName?: unknown
    writeScopes?: unknown
  }>
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
  timeoutMs?: number
  /** op=reap：默认 false = dry-run；显式 true 才真正删除确证死亡的声明。 */
  confirm?: boolean
  note?: string
  channel?: string
  body?: string
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
  /**
   * 本插件的 Config（0.1.7 起唯一保存偏好的地方）。
   * `.volatile()` 字段是稳定引用（`{ get() }`，见 cosmokit 的 `Volatile`）：Loader 改值时
   * 就地更新引用内容并发 `loader/volatile-update`，插件**不重载**。
   */
  config?: Record<string, { get(): unknown } | unknown> | null
  effect(callback: () => void | (() => void), label?: string): void
  get(name: string): any
  /**
   * cordis 事件注册。waterfall 事件的监听器签名是 `(...args, next)`：
   * tools/pre-execute 是 `(exec, next)`，tools/post-execute 是 `(exec, result, next)`。
   * 返回 disposer；listener 作为当前 fiber 的 effect 注册，随 ctx 作用域自动回收。
   */
  on(event: string, handler: (...args: any[]) => any, options?: { global?: boolean; prepend?: boolean }): () => void
  /** cordis 的动态依赖：deps 就绪时在子 fiber 里跑 callback；deferred 直到服务出现。 */
  inject(deps: string[], callback: (ctx: CollabContext & { webServer?: WebServerService }) => void): unknown
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
