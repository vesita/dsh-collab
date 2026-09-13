import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  norm, ov, hashProjectKey, projectStorageFileName, init, publish,
  expire, sweep, conflictError, holder, claim, release, heartbeat,
  post, overview, related, filterMessages, blockers, cleanName, holderView, renderDigest,
  registerReader, dropHolder,
  accessScope, claimsForAccess, claimsCovering, relToProject, isReadable, readersOf, renderAccessNotice, clockUtc
} from './collab-core.js'
import type {
  Claim, ConflictInfo, HolderInput, Mode, OpResult, PublishedClaim, StateDocument
} from './collab-core.js'
import { boundContextSummary, createUserMessage } from './plugin-message.js'
import type { UserMessageLike } from './plugin-message.js'
import {
  LEGACY_PROJECT_FILE, collabDir, projectStateFile, legacyCollabDirs
} from './paths.js'

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

interface SessionLike { header?: { cwd?: string } }
interface AgentLike { id?: string; session?: SessionLike }
interface SessionsService { get(agentId: string): SessionLike | undefined }
interface SessionTitleService { get(session: SessionLike): { title?: string } | undefined }

/**
 * ctx.agents 中功能 D 用到的活体查询面（实测：`get(id: SessionId): Agent | undefined`）。
 * "活着的会话"是本功能唯一允许被推送的目标 —— 推送会 resume 冷会话，绝不允许。
 */
interface AgentsLookupService {
  get(id: string): AgentLike | undefined
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
interface SessionControllerService {
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
 *     必须**先过 isLiveSession 闸门**才敢调用它的原因（见 notifyReaders）。
 */
interface SubagentSenderLike { id: string }
interface SubagentsService {
  sendMessage(
    sender: SubagentSenderLike,
    targetId: string,
    content: Array<{ type: 'text'; text: string }>,
    options: { signal: AbortSignal }
  ): Promise<unknown>
}

/**
 * 单条推送的返回：成功，或带一行可读原因失败（超时用 'timeout'）。
 * 0.8.4 追加两个**可选**标记（`ok` / `error` 的语义与取值一字未动），
 * 让调用方不必解析 error 文本就知道该不该走子代理回退：
 *   - subagentRouting：失败是 `session/agent-busy` 的"子代理路由托管"拒绝 → 该走回退；
 *   - notAdjacent：回退通道因**邻接**前提不成立被拒（读者不是释放者的直接父/子会话）。
 */
export type PushOutcome =
  | { ok: true }
  | { ok: false; error: string; subagentRouting?: true; notAdjacent?: true }

/** 0.8.4：投递通道名（`notify.pushedVia[].channel`）。 */
export type PushChannel = 'session-controller' | 'subagents'

/**
 * 一次 release 的推送结果汇总（0.8.3 起挂在 release 结果的 `data.notify` 上）。
 * 目的：让释放者能区分"没有人需要通知"与"通知通道坏了" —— 0.8.2 把两者都变成了静默。
 * 0.8.4 只**追加**字段与取值（既有字段名、既有 reason 的语义都没改）。
 */
export interface NotifyOutcome {
  /** 该次涉及的去重读者数（= pushed + skipped 的候选读者；无会话的非 agent holder 不计入）。 */
  readers: number
  /** 真正投递成功的 sessionId（一次投递一条；同一读者挂在多条被释放的 claim 上时会出现多次）。语义与 0.8.3 相同，不分通道。 */
  pushed: string[]
  /**
   * 0.8.4 追加：每次成功投递所走的通道，与 `pushed` **等长且同序**。
   * 'session-controller' = 原生 `prompt`；'subagents' = 子代理路由回退通道（`subagents.sendMessage`）。
   * 始终存在（无成功投递时为空数组）。
   */
  pushedVia: Array<{ sessionId: string; channel: PushChannel }>
  /** 未能投递的候选读者。既有取值 not-live / already-pushed / prompt-failed 的语义不变，只追加两种。 */
  skipped: Array<{
    sessionId: string
    /**
     * not-live        = 会话此刻未加载（刻意不唤醒，两个通道都不会碰它）；
     * already-pushed  = 同 (claimId, reader) 已推过；
     * prompt-failed   = 原生 prompt 失败/超时/通道缺失，**且不是**子代理路由拒绝（0.8.3 语义不变）；
     * not-adjacent    = 0.8.4 追加：原生 prompt 被"子代理路由托管"拒绝、而回退通道又因**邻接**不成立被拒
     *                   （该读者不是释放者的直接父会话或直接可续子会话）；
     * subagent-failed = 0.8.4 追加：回退通道本身失败/超时/不可用（拿不到活 Agent、`subagents` 服务缺失等）。
     */
    reason: 'not-live' | 'already-pushed' | 'prompt-failed' | 'not-adjacent' | 'subagent-failed'
    /** 出现于失败取值：真实错误文本，或 'timeout' / 'no-session-controller' / 'no-subagents-service' / 'no-live-sender-agent'。 */
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

/** 浏览器半边读取「设置项 ↔ 随包 skill」关联的只读 loopback 路由。 */
export const CLIENT_SKILL_ROUTE = '/dsh-collab/skill-index'

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

/** 偏好设置命名空间。 */
export const DELEGATION_SETTINGS_NAMESPACE = 'dsh-collab'

/** 设置契约：默认**开启**——目标是让这套工作方式真的发生，开关是用来关掉它的。 */
export const DELEGATION_SETTINGS_SCHEMA = z.object({
  exposeDelegationDiscipline: z.boolean().default(true),
  // 功能 C：写保护默认开。默认值就是"必须拦"，所以它只能被显式关掉。
  enforceWriteLock: z.boolean().default(true)
})

/** 组合默认值：settings 服务缺失（或 installSection 不可用）时，它就是生效值。 */
export const DELEGATION_SETTINGS_ENTRY: DelegationSettings = { exposeDelegationDiscipline: true, enforceWriteLock: true }

/**
 * 常驻委托纪律文本：**纯常量**，无时间戳、无计数、无任何会漂移的字符。
 * DSH 的运行时上下文快照按整串相等去重（rendered === retained.text 即不提交），
 * 所以常量块每个会话只提交一次，成本近似为零；一旦掺入变量就会击穿这个去重。
 * 注意：正文里不能出现阿拉伯数字，否则测试里"无数字"的断言就没有意义。
 */
export const DELEGATION_DISCIPLINE_TEXT = [
  '[dsh-collab] 委托与验收（默认工作方式）：主 AI 负责规划、下结论与验收；子代理负责探索、调研、测量、机械改造与独立复核。',
  '派活前先过一遍判据：能用一段话写清规格、且能用一次检查判定对错，就委托；否则先想清楚规格再决定。',
  '任务彼此独立就放在同一条消息里并行发起，一个子代理只回答一个完整问题。',
  '验收永远留在主 AI：不外包结论，要求粘贴原始输出作为证据，别只看摘要。'
].join('\n')

/** 随包发布的 skill：正文与目录都来自 <pkg>/skills/subagent-delegation/。 */
const BUNDLED_SKILL_FILE = '../skills/subagent-delegation/SKILL.md'

/** 已加载的随包 skill：路由只交出 name/description/whenToUse/path，正文永不过网。 */
export interface BundledSkill {
  name: string
  description: string
  whenToUse?: string
  content: string
  path: string
}

/**
 * 极简 frontmatter 解析：只认文件开头的 `---` 块，只取 name/description/whenToUse 三个标量，
 * 其余行（含 YAML 注释）忽略；正文是闭合 `---` 之后的全部原文，不做任何改写。
 * 缺 frontmatter、缺 name、或整段不可解析时返回 null，由调用方静默降级。
 */
function parseSkillFrontmatter(text: string): { name: string; description?: string; whenToUse?: string; content: string } | null {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!kv) continue
    let v = kv[2].trim()
    // 值两侧成对的引号剥掉即可，不追求完整 YAML（本文件只用裸标量）。
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1)
    meta[kv[1]] = v
  }
  const name = (meta.name || '').trim()
  if (!name) return null
  const content = text.slice(m[0].length)
  return {
    name,
    description: (meta.description || '').trim() || undefined,
    whenToUse: (meta.whenToUse || '').trim() || undefined,
    content
  }
}

// 读盘结果（含失败）只算一次：prompt 装配路径绝不碰盘，apply 也只同步读一次。
let bundledSkillCache: BundledSkill | null | undefined

/** 读取并解析随包 skill；文件缺失/不可读/解析失败都返回 null（绝不抛）。 */
function loadBundledSkill(): BundledSkill | null {
  if (bundledSkillCache !== undefined) return bundledSkillCache
  bundledSkillCache = null
  try {
    // 相对**构建产物**定位：lib/index.js -> <pkg>/skills/...，因此与安装位置无关。
    const file = fileURLToPath(new URL(BUNDLED_SKILL_FILE, import.meta.url))
    const parsed = parseSkillFrontmatter(readFileSync(file, 'utf8'))
    if (parsed) {
      bundledSkillCache = {
        name: parsed.name,
        description: parsed.description || '',
        whenToUse: parsed.whenToUse,
        content: parsed.content,
        path: file
      }
    }
  } catch (e) {}
  return bundledSkillCache
}

/**
 * 纯函数：把「已加载或缺失的随包 skill」组装成只读路由的载荷。
 * 与读盘解耦，所以 node 里能直接断言「文件缺失 ⇒ skill 为 null」这条降级路径。
 * **绝不**带上 skill 正文：浏览器半边只拿路径与名称/描述，正文由右侧预览自己读文件。
 */
export function buildSkillIndex(skill: BundledSkill | null): CollabSkillIndex {
  return {
    namespace: DELEGATION_SETTINGS_NAMESPACE,
    items: [
      {
        field: 'exposeDelegationDiscipline',
        skill: skill === null
          ? null
          : {
              name: skill.name,
              description: skill.description,
              ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
              path: skill.path
            }
      }
    ]
  }
}

/** 写一个 JSON 响应（no-store：路径与状态是活事实）。 */
function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.headersSent) return
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(payload))
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
type OpHandler = (args: CollabArgs, h: HolderInput, agentId: string | null, agent?: AgentLike) => ToolResult | Promise<ToolResult>

/** load() 的返回：状态文档 + 乐观并发版本号 + 存储目标 + 绝对状态目录 + 诊断 warning。 */
interface LoadResult {
  state: StateDocument
  version: number | null
  target: FileRef
  stateDir: string
  warn: string | null
}

export const name = 'dsh-collab'
export const inject = ['fs', 'timer', 'tools']

// ---- 功能 C：写/读调用的路径事实源 ----
// 工具名与**参数名**逐条来自实测（不是猜的），证据：
//   write / edit        : @deepseek-ai/dsh-tool-fs/lib/index.js:597,742 —— 参数 `file_path`
//   read                : @deepseek-ai/dsh-tool-fs/lib/index.js:332 —— 参数 `file_path`
//   glob / grep         : @deepseek-ai/dsh-tool-fs-search/lib/index.js:782,1090 —— 参数 `path`
//   str_replace_editor  : @deepseek-ai/dsh-tool-str-replace-editor/lib/index.js:266 —— 参数 `path`，
//                         且 `command` 决定读写：view 只读，create/str_replace/insert 是写
// 本会话 live schema（cordis_inspect_query host/Tool/listTools）只出现 read/write/edit/glob/grep；
// str_replace_editor 不在本会话工具集里，但部署里装了这个包，故一并覆盖。
//
// 刻意**不**把 shell 类工具（bash / pwsh，dsh-tool-bash:260 / dsh-tool-pwsh:234）列为写工具：
// 它们的 schema 里没有"目标路径"参数，只有一个自由文本 `command`。要靠分词去猜目标路径，
// 假阳性会直接变成硬拒绝（本部署 ask == deny），例如把 `cat src/a/1` 判成写而拦掉合法读取。
// 代价是 shell 写入不受本门控保护 —— 这是**已知旁路**，写在 README 与报告里，不假装覆盖。
/** 工具 -> { write: 写/改类目标参数, read: 只读类目标参数 }。 */
export const TOOL_PATH_SPECS: Record<string, { write: string[]; read: string[] }> = {
  write: { write: ['file_path'], read: [] },
  edit: { write: ['file_path'], read: [] },
  str_replace_editor: { write: ['path'], read: ['path'] },
  read: { write: [], read: ['file_path'] },
  glob: { write: [], read: ['path'] },
  grep: { write: [], read: ['path'] }
}

/** 需要看 `command` 才能分读写的工具（其余按表直判）。 */
export const COMMAND_AWARE_TOOL = 'str_replace_editor'

/** 按工具名 + 入参判定本次调用的读写目标参数（未知工具一律不拦）。 */
export function pathArgsFor(toolName: string, args: unknown): { write: string[]; read: string[] } {
  const spec = TOOL_PATH_SPECS[toolName]
  if (!spec) return { write: [], read: [] }
  if (toolName === COMMAND_AWARE_TOOL) {
    const cmd = args && typeof (args as { command?: unknown }).command === 'string' ? String((args as { command: string }).command) : ''
    // 认不出的 command 按写处理（fail-safe）：真实的 str_replace_editor 会自行拒绝未知 command。
    return cmd === 'view' ? { write: [], read: spec.read } : { write: spec.write, read: [] }
  }
  return { write: spec.write, read: spec.read }
}

/** 功能 A 的候选路径上限：单次调用最多看这么多字符串，避免在 write.content 上白跑。 */
const MAX_ACCESS_CANDIDATES = 16
/** 单条候选字符串的长度上限：`write` 的 content 可能是上百 KB 的正文，那不是路径。 */
const MAX_CANDIDATE_CHARS = 1024
/** 递归深度上限：防御自引用/环状 arguments。 */
const MAX_CANDIDATE_DEPTH = 6

/**
 * 功能 D 回退通道（0.8.4）的两条稳定判据常量。
 * `SUBAGENT_ROUTING_REASON` 是 DSH 自己在 RemoteError.details 里给的投递指示；
 * `SUBAGENT_ROUTING_MESSAGES` 是 details 万一丢失时的兜底诊断串。
 * 两者都逐字取自 dsh-api-session-controller/lib/index.js:137 与 :1578。
 */
const SUBAGENT_ROUTING_REASON = 'use subagent delivery for this child session'
const SUBAGENT_ROUTING_MESSAGES = ['owned by subagent routing', 'durable parent address']

/**
 * 从 exec.arguments 递归提取候选路径（功能 A）：非空字符串且 norm() 接受；含字符串数组。
 * 两个额外过滤（相对规格的**收紧**，都是为了不把正文误当路径）：
 *   - 含换行符的字符串直接跳过（路径不会有换行，而 write.content 一定有）；
 *   - 长度 > MAX_CANDIDATE_CHARS 的跳过。
 * 两者都只会**少**报，不会多报，因此不改变"A 只是提示"的语义。
 */
export function collectPathCandidates(value: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length >= MAX_ACCESS_CANDIDATES || depth > MAX_CANDIDATE_DEPTH) return out
  if (typeof value === 'string') {
    if (!value || value.length > MAX_CANDIDATE_CHARS || /[\r\n]/.test(value)) return out
    if (norm(value)) out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const v of value) collectPathCandidates(v, out, depth + 1)
    return out
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) collectPathCandidates((value as Record<string, unknown>)[key], out, depth + 1)
  }
  return out
}

/** 功能 A 的去重签名：路径 + 排序后的 claimId + expiresAt。 */
export function accessSignature(claims: Claim[]): string {
  const ids = claims.map(c => c.claimId).slice().sort().join(',')
  const exp = claims.map(c => String(c.expiresAt)).slice().sort().join(',')
  const paths = claims.flatMap(c => c.paths).slice().sort().join(' ')
  return paths + '|' + ids + '|' + exp
}

/** holderId -> sessionId（只有 agent holder 有会话）。 */
export function sessionIdOf(holderId: string): string | null {
  return typeof holderId === 'string' && holderId.startsWith('agent:') ? holderId.slice('agent:'.length) : null
}

export function apply(ctx: CollabContext): void {
  const fs = ctx.fs
  const sessions = ctx.get('sessions') as SessionsService | undefined
  const sessionTitle = ctx.get('sessionTitle') as SessionTitleService | undefined
  const now = (): number => Date.now()

  const pub = (c: Claim): PublishedClaim => publish(c)
  // 判断"写入失败是否属于乐观并发冲突，值得重读后重试"。
  // 真实 ctx.fs 抛的是 FsError：code 是**独立字段**，message 里不含 code（实测）。
  // 后端文案：'cannot write "<p>": file changed since it was read'        (FS_STALE_VERSION)
  //           'cannot overwrite existing "<p>" without reading it first'  (FS_NOT_OBSERVED)
  // 后者正是"并发方抢先创建了状态文件"的竞态：重读一次就能拿到 version 再写。
  // 只认精确文案，不用裸 /stale/i —— 它会命中路径里的 "stale" 字样。
  const stale = (e: unknown): boolean => {
    const err = e as { message?: string; code?: string } | null | undefined
    const code = err && typeof err.code === 'string' ? err.code : ''
    if (code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED' || code === 'EEXIST') return true
    const m = String((err && err.message) || e)
    return /FS_STALE_VERSION|FS_NOT_OBSERVED|file changed since it was read|without reading it first|already exists/i.test(m)
  }
  const withWarn = (data: Record<string, any>, warn: string | null) => (warn ? Object.assign({}, data, { warning: warn }) : data)

  // 功能 D 的存活判据（0.8.3 起）**只用于"此刻要不要推"**，绝不再用于清理 readers 登记。
  // 0.8.2 曾在 mutate() 里把它注入 sweep()，于是"只是空闲、并未结束"的读者
  // （agents.get(sessionId) 对休眠会话返回 undefined）会在下一次任意写路径上被删掉，
  // 该 claim 释放时已无人可推 —— 静默丢通知。读者的移除只走 dropHolder()（agent/disposed）。
  // 判据本身仍是 push 前的安全闸：拿不到 agents 服务时一律返回 false（不推），
  // 因为推送会 resume 冷会话，宁可少推也不能唤醒。
  const isLiveSession = (sessionId: string): boolean => {
    try {
      const svc = ctx.get('agents') as AgentsLookupService | undefined
      if (!svc || typeof svc.get !== 'function') return false
      return !!svc.get(sessionId)
    } catch (e) {
      return false
    }
  }

  async function cwdOf(agentId: string | null, agent?: AgentLike): Promise<string | null> {
    try {
      if (agent && agent.session && agent.session.header) {
        const c = agent.session.header.cwd
        if (typeof c === 'string' && c) return c
      }
      if (agentId && sessions) {
        const s = sessions.get(agentId)
        const c = s && s.header && s.header.cwd
        if (typeof c === 'string' && c) return c
      }
    } catch (e) {}
    return null
  }

  async function targetFor(agentId: string | null, agent?: AgentLike): Promise<{ cwd: string | null; target: FileRef; stateDir: string; fileName: string }> {
    const cwd = await cwdOf(agentId, agent)
    const fileName = projectStorageFileName(cwd || 'default')
    // 绝对状态目录（${DSH_HOME:-$HOME/.dsh}/collab/projects），与进程 cwd 无关。
    // fs.resolve 对绝对路径原样通过（实测），所以这里不做字符串拼接猜测基址。
    const stateDir = collabDir()
    const target = await fs.resolve(projectStateFile(cwd))
    return { cwd, target, stateDir, fileName }
  }

  async function load(agentId: string | null, agent?: AgentLike): Promise<LoadResult> {
    const { cwd, target, stateDir, fileName } = await targetFor(agentId, agent)
    const warn = cwd ? null : 'state-file at default location (no session cwd); per-project isolation disabled'
    let info = await fs.stat(target)
    // 第一代落点：项目内的 .dsh-collab.json，按会话 cwd 定位。
    if (!info && cwd) {
      try {
        const legacyTarget = await fs.resolve(LEGACY_PROJECT_FILE, { cwd })
        const legInfo = await fs.stat(legacyTarget)
        if (legInfo) {
          const raw = await fs.readText(legacyTarget)
          await fs.writeText(target, raw, { kind: 'createIfAbsent' })
          info = await fs.stat(target)
        }
      } catch (e) {}
    }
    // 第二代错误落点：旧版相对进程 cwd 的 .dsh/collab/projects，以及 `~` 未展开的
    // <HOME>/~/.dsh/collab/projects。只读扫描 + 一次性搬进正确位置；文件名沿用
    // projectStorageFileName，故能与历史产物一一对上。任何失败都静默（不阻断工具）。
    if (!info) {
      for (const legacyDir of legacyCollabDirs()) {
        try {
          const legacyTarget = await fs.resolve(legacyDir + '/' + fileName)
          const legInfo = await fs.stat(legacyTarget)
          if (!legInfo) continue
          const raw = await fs.readText(legacyTarget)
          await fs.writeText(target, raw, { kind: 'createIfAbsent' })
          info = await fs.stat(target)
          if (info) break
        } catch (e) {}
      }
    }
    if (!info) return { state: init(), version: null, target, stateDir, warn }
    const raw = await fs.readText(target)
    let s: StateDocument
    try {
      s = Object.assign(init(), JSON.parse(raw))
    } catch (e) {
      // 自愈而非砖化：保留损坏文件的备份，重置为空状态并把问题作为 warning 上报。
      const backupSuffix = '.corrupt-' + now()
      let backupPath: string | null = null
      try {
        const backupTarget = await fs.resolve(target.displayPath + backupSuffix)
        await fs.writeText(backupTarget, raw, { kind: 'createIfAbsent' })
        backupPath = fs.processPath(backupTarget)
      } catch (backupError) {}
      try {
        await fs.writeText(target, JSON.stringify(init()), { kind: 'replaceIfVersion', version: info.version })
      } catch (resetError) {}
      const corruptWarn = 'state corrupted; reinitialized' + (backupPath ? '; backup: ' + backupPath : '')
      return { state: init(), version: null, target, stateDir, warn: warn ? warn + '; ' + corruptWarn : corruptWarn }
    }
    s.claims = Array.isArray(s.claims) ? s.claims : []
    s.messages = Array.isArray(s.messages) ? s.messages : []
    s.holders = Array.isArray(s.holders) ? s.holders : []
    return { state: s, version: info.version, target, stateDir, warn }
  }

  async function mutate(fn: (s: StateDocument) => OpResult, agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    for (let i = 0; i < 5; i++) {
      const { state, version, target } = await load(agentId, agent)
      const swept = sweep(state, now())
      let out: OpResult | undefined
      try {
        out = fn(state)
      } catch (e) {
        if (e && e.collabConflict) return { ok: false, error: 'conflict', conflicts: e.conflicts }
        throw e
      }
      if (!out || out.changed === false) {
        if (!out) return { ok: false, error: 'not-found', message: 'nothing to change' }
        const data = out.data || {}
        // 统一错误信封：ok:false 时 error/message 提升到顶层，调用方无需再挖 data。
        if (out.ok === false) return { ok: false, error: data.error || 'bad-request', message: data.message, ...data }
        return { ok: true, data }
      }
      if (swept.droppedMessages > 0 || swept.prunedHolders > 0) {
        out.data = Object.assign({}, out.data, { swept })
      }
      try {
        if (version === null) await fs.writeText(target, JSON.stringify(out.state), { kind: 'createIfAbsent' })
        else await fs.writeText(target, JSON.stringify(out.state), { kind: 'replaceIfVersion', version })
        return { ok: true, data: out.data }
      } catch (e) {
        if (stale(e) && i < 4) continue
        throw e
      }
    }
    return { ok: false, error: 'concurrent-modification', message: 'state busy, retry later' }
  }

  const holderOf = (exec: ToolExecContext): HolderInput & { agent?: AgentLike } => {
    const agent = exec && exec.agent
    const id = agent && agent.id ? String(agent.id) : null
    return {
      agent,
      holderId: id ? 'agent:' + id : 'human:console',
      sessionId: id || undefined
    }
  }

  function cleanName(s: string): string {
    if (typeof s !== 'string') return s
    let n = s.replace(/\s+/g, ' ').trim()
    if (n.length > 24) n = n.slice(0, 24) + '…'
    return n
  }

  function hname(h: HolderInput & { agent?: AgentLike }): string {
    let name: string | null = null
    if (h.sessionId && (sessions || h.agent) && sessionTitle) {
      try {
        const s = (h.agent && h.agent.session) || (sessions && sessions.get(h.sessionId))
        if (s) {
          const t = sessionTitle.get(s)
          if (t && typeof t.title === 'string' && t.title) name = t.title
        }
      } catch (e) {}
    }
    return cleanName(name || h.holderId)
  }

  async function list(agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const { state, target, stateDir, warn } = await load(agentId, agent)
    const t = now()
    // 先 sweep 再取视图：超过 24h 的废弃 holder 不再出现在结果里；
    // 而 stale 用的是 1h 预警阈值（见 HOLDER_STALE_WARN_MS），因此在产品路径上依然是可达信号。
    const ex = expire(state, t)
    const hv = holderView(state, t)
    return {
      ok: true,
      data: withWarn({
        seq: state.seq,
        serverTime: t,
        statePath: fs.processPath(target),
        stateDir,
        schemaVersion: state.schemaVersion,
        holders: hv.holders,
        staleHolders: hv.staleHolders,
        claims: state.claims.map(pub),
        expiredCount: ex
      }, warn)
    }
  }

  async function overviewOp(agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const { state, target, stateDir, warn } = await load(agentId, agent)
    const t = now()
    expire(state, t)
    const o = overview(state)
    return {
      ok: true,
      data: withWarn({
        statePath: fs.processPath(target),
        stateDir,
        serverTime: t,
        totalClaims: o.totalClaims,
        holders: o.holders
      }, warn)
    }
  }

  async function status(a: CollabArgs, agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const { state, target, stateDir, warn } = await load(agentId, agent)
    const t = now()
    expire(state, t)
    const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
    const rel = related(state, paths)
    return {
      ok: true,
      data: withWarn({
        statePath: fs.processPath(target),
        stateDir,
        paths,
        related: rel.map(pub),
        exclusive: rel.filter(c => c.mode === 'exclusive').map(pub),
        serverTime: t
      }, warn)
    }
  }

  async function msgs(a: CollabArgs, agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const { state } = await load(agentId, agent)
    return { ok: true, data: filterMessages(state, a) }
  }

  async function waitFor(a: CollabArgs, h: HolderInput, agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const timeoutMs = Math.max(0, Math.min(120000, Number(a.timeoutMs) || 30000))
    const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
    if (!paths.length) return { ok: false, error: 'bad-request', message: 'paths required' }
    const deadline = now() + timeoutMs
    let bList: Claim[] = []
    while (now() < deadline) {
      const { state } = await load(agentId, agent)
      const t = now()
      bList = blockers(state, t, h, paths)
      if (bList.length === 0) return { ok: true, data: { paths, blockers: [], waitedMs: Math.round(timeoutMs - Math.max(0, deadline - now())) } }
      await ctx.timer.timeout(400)
    }
    return { ok: false, error: 'timeout', message: 'paths still claimed', paths, blockers: bList.map(pub), waitedMs: timeoutMs }
  }

  // ---- 功能 A + D：访问通知（旁路投递）与读者反向注册 ----

  // 按 agent 去重：exec.agent 是稳定对象（先例 dsh-repeat-tool-reminder/lib/index.js:1462 用
  // WeakMap 键在 agent 上），键不会拦住共享状态文件里的任何东西，也不会泄漏 agent。
  const accessNotified = new WeakMap<object, string>()

  /**
   * 算出本次访问命中的"他人的活跃声明"。返回 null 表示"没有可用路径 / 没有命中"，
   * duplicate=true 表示"与上一次投递给同一 agent 的内容逐字相同"（全部重复 → 原样放行）。
   * 纯读，不写状态；失败由调用方兜。
   */
  async function accessEntries(execCtx: any): Promise<{ id: string | null; agent?: AgentLike; entries: Claim[]; duplicate: boolean } | null> {
    const candidates = collectPathCandidates(execCtx && execCtx.arguments)
    if (!candidates.length) return null
    const agent = execCtx && execCtx.agent
    const id = agent && agent.id ? String(agent.id) : null
    const cwd = await cwdOf(id, agent)
    const mine = id ? 'agent:' + id : 'human:console'
    const { state } = await load(id, agent)
    const t = now()
    const seen = new Set<string>()
    const entries: Claim[] = []
    for (const raw of candidates) {
      const rel = relToProject(raw, cwd)
      if (!rel) continue
      for (const c of claimsForAccess(state.claims, rel, t)) {
        if (c.holderId === mine || seen.has(c.claimId)) continue
        seen.add(c.claimId)
        entries.push(c)
      }
    }
    if (!entries.length) return null
    const signature = accessSignature(entries)
    const key = agent && typeof agent === 'object' ? agent : null
    if (key && accessNotified.get(key) === signature) return { id, agent, entries, duplicate: true }
    if (key) accessNotified.set(key, signature)
    return { id, agent, entries, duplicate: false }
  }

  /**
   * 功能 D 的反向注册：把本次访问者登记为这些 claim 的读者。
   * "被锁通知"这个动作本身就是登记 —— 投递与登记是同一件事。
   * best-effort：写失败绝不阻断通知，也绝不抛进 waterfall。
   */
  async function registerAccessReaders(id: string | null, agent: AgentLike | undefined, entries: Claim[]): Promise<void> {
    if (!id || !entries.length) return
    const me = 'agent:' + id
    try {
      await mutate(s => {
        let changed = false
        for (const c of entries) if (registerReader(s, c.claimId, me).changed) changed = true
        return changed ? { ok: true, changed: true, state: s, data: {} } : { ok: true, changed: false, data: {} }
      }, id, agent)
    } catch (e) {
      // 反向注册失败只是少一条通知对象，不影响本次通知投递。
    }
  }

  /** 构造一条访问通知消息（插件 notice 形态的 user 消息，形状见 plugin-message.ts）。 */
  function accessNoticeMessage(entries: Claim[]): UserMessageLike {
    const head = entries[0] && entries[0].paths.length ? entries[0].paths[0] : ''
    const summary = boundContextSummary('collab 占用 · ' + head + (entries.length > 1 ? ' 等 ' + entries.length + ' 条' : ''))
    return createUserMessage({
      content: [{ type: 'text', text: renderAccessNotice(entries) }],
      source: { kind: 'plugin', plugin: 'dsh-collab', form: 'notice', summary }
    })
  }

  // 先例（dsh-repeat-tool-reminder/lib/index.js:1440-1443）：自己的上下文**前插**，别重建 content。
  function prependContext(ours: UserMessageLike, theirs: UserMessageLike[] | undefined): UserMessageLike[] {
    return [ours, ...(theirs || [])]
  }

  // ---- 功能 C：写保门的门控判定 ----

  /** 把命中渲染成 ask 的理由（含持有者、路径、**绝对 UTC** 租约窗口）。 */
  function gateReason(c: Claim, target: string, kind: 'write' | 'read'): string {
    const start = clockUtc(typeof c.createdAt === 'number' ? c.createdAt : c.expiresAt - (c.ttlSec || 0) * 1000)
    const who = c.holderName || c.holderId
    const what = kind === 'write' ? '写入' : '读取（对方已声明不可读）'
    return '[dsh-collab] ' + target + ' 由 ' + who + ' 占用（' + c.mode + '）：非持有者' + what +
      '需要先协商。租约 ' + start + '–' + clockUtc(c.expiresAt) + '。先 collab_lock op=wait 或 collab_board 协商，或改用其他路径。'
  }

  /** 门控判定：返回 ask 决策，或 null 表示放行（由调用方 next()）。 */
  async function writeGate(execCtx: any): Promise<{ kind: 'ask'; reason: string } | null> {
    if (!enforceWriteLockEnabled()) return null
    const toolName = execCtx && typeof execCtx.name === 'string' ? execCtx.name : ''
    const args = (execCtx && execCtx.arguments) || {}
    const spec = pathArgsFor(toolName, args)
    if (!spec.write.length && !spec.read.length) return null
    const agent = execCtx && execCtx.agent
    const id = agent && agent.id ? String(agent.id) : null
    const cwd = await cwdOf(id, agent)
    const mine = id ? 'agent:' + id : 'human:console'
    const { state } = await load(id, agent)
    const t = now()
    const hits: Array<{ claim: Claim; target: string; kind: 'write' | 'read' }> = []
    const collect = (fields: string[], kind: 'write' | 'read') => {
      for (const field of fields) {
        const raw = (args as Record<string, unknown>)[field]
        if (typeof raw !== 'string' || !raw) continue
        const rel = relToProject(raw, cwd)
        if (!rel) continue
        for (const c of claimsCovering(state.claims, rel, t)) {
          if (c.holderId === mine) continue
          // mode 过滤与 collab-core.ts 的 claim() 冲突判据**同源**（见 collab-core.ts 中
          // claim() 的冲突扫描：`c.mode === 'shared' || c.mode === 'read'` 一律 continue），
          // 也与 blockers() 的 `c.mode === 'exclusive'` 一致 —— 不是随手加的例外：
          //   - shared 按定义就是"声明共用"，两个共享方不该互相挡死；
          //   - read 是纯观测，**既不排他也不被挡**。插件注入的提示（OPEN_HINT）推荐
          //     "只读调研用 mode=read"，若在此拦下它，一个只读会话会硬拒绝所有人的写入
          //     （本部署 ask = deny），正好命中推荐用法。
          // 由此 readable 只对 exclusive 声明有意义：非 exclusive 声明既不拦写也不拦读，
          // 其 readable:false 不产生任何门控效果（见 README「锁模式」「功能 C」两节）。
          if (c.mode === 'shared' || c.mode === 'read') continue
          hits.push({ claim: c, target: rel, kind })
        }
      }
    }
    collect(spec.write, 'write')
    collect(spec.read, 'read')
    if (!hits.length) return null
    // 走到这里 hits 只剩**他人的、未过期的 exclusive 声明**（shared/read 已在 collect 里跳过）。
    // 写：非持有者对 exclusive 占用一律拦。
    // 读：只有持有者显式 readable:false 才拦（可读性默认 true）。
    // 注意 readable 不是"独立的第二条判据"，它只在 exclusive 上生效 —— 与 claim() 同源。
    const blocking = hits.filter(h => h.kind === 'write' || !isReadable(h.claim))
    if (!blocking.length) return null
    const hit = blocking[0]
    return { kind: 'ask', reason: gateReason(hit.claim, hit.target, hit.kind) }
  }

  // ---- 功能 D：释放后的原生推送（sessionController.prompt） ----
  //      0.8.4 追加**子代理投递回退通道**（subagents.sendMessage）：当读者是"由 subagent
  //      路由托管的会话"时，原生 prompt 会被 DSH 结构性地拒绝，而 DSH 自己在错误里
  //      指示"改用 subagent 投递"（见 isSubagentRoutingRejection 的三条源码依据）。

  // 0.8.4：通道名（notify.pushedVia[].channel 用）。
  const CHANNEL_PROMPT: PushChannel = 'session-controller'
  const CHANNEL_SUBAGENT: PushChannel = 'subagents'

  // 同一 (claimId, reader) 只推一次。有界：超过上限按插入顺序淘汰最旧的一条。
  const pushedPairs = new Map<string, true>()
  const PUSH_DEDUPE_MAX = 2000
  const PUSH_TIMEOUT_MS = 3000

  /** 标记"这一对已推过"；返回 false 表示已经推过，跳过。 */
  function markPushed(key: string): boolean {
    if (pushedPairs.has(key)) return false
    pushedPairs.set(key, true)
    if (pushedPairs.size > PUSH_DEDUPE_MAX) {
      const oldest = pushedPairs.keys().next()
      if (!oldest.done) pushedPairs.delete(oldest.value)
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
    try {
      const controller = ctx.get('sessionController') as SessionControllerService | undefined
      // 回退通道是**可选**服务：拿不到就不回退（不回退 ≠ 报错，见 pushViaSubagentsIfPossible）。
      const subagents = ctx.get('subagents') as SubagentsService | undefined
      // **原对象**，不是 { id } 的副本 —— 见上面的对象同一性说明。
      const sender: SubagentSenderLike | undefined =
        releaserAgent && typeof releaserAgent.id === 'string' && releaserAgent.id
          ? (releaserAgent as unknown as SubagentSenderLike)
          : undefined
      // 候选读者 = released 各 claim 上、能解析出 sessionId 且不是释放者的 (claim, reader)。
      // readersOf 已做归一（去重保序 + 过滤非字符串）。
      const jobs: Array<{ claim: PublishedClaim; reader: string; sessionId: string }> = []
      const distinct = new Set<string>()
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
        if (!canPush) {
          // 通道整个缺失：这**不是**"没人需要通知"，必须留在 skipped 里（0.8.2 是静默 return）。
          // 0.8.4 刻意**不**因为"prompt 通道缺失"就改走回退：那会把"原生通道整个不在"
          // 这件基础设施问题伪装成一次正常的旁路投递。缺失照旧如实报。
          out.skipped.push({ sessionId: job.sessionId, reason: 'prompt-failed', error: 'no-session-controller' })
          continue
        }
        // 安全闸门：对**两个通道**统一生效，且在任何投递之前（冷会话绝不被唤醒 / cold-resume）。
        if (!isLiveSession(job.sessionId)) {
          out.skipped.push({ sessionId: job.sessionId, reason: 'not-live' }) // 刻意不唤醒
          continue
        }
        // 幂等键 (claimId, reader) 仍然**先**记账：回退成功/失败都不再重投。
        if (!markPushed(job.claim.claimId + '::' + job.reader)) {
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
    }
    return out
  }

  const exec = (fn: OpHandler) => async (args: CollabArgs, e: ToolExecContext): Promise<ToolResult> => {
    args = args || {}
    const h = holderOf(e)
    const name = hname(h)
    h.name = name
    const aId = h.sessionId || null
    try {
      return await fn(args, h, aId, h.agent)
    } catch (err) {
      return { ok: false, error: 'internal', message: String((err && err.message) || err) }
    }
  }

  const lockHandler = exec((a, h, aId, agent) => {
    if (a.op === 'claim') return mutate(s => claim(s, h, a, now), aId, agent)
    if (a.op === 'release') return releaseWithNotify(a, h, aId, agent)
    if (a.op === 'heartbeat') return mutate(s => heartbeat(s, h, a, now), aId, agent)
    if (a.op === 'list') return list(aId, agent)
    if (a.op === 'overview') return overviewOp(aId, agent)
    if (a.op === 'status') return status(a, aId, agent)
    if (a.op === 'wait') return waitFor(a, h, aId, agent)
    return { ok: false, error: 'bad-request', message: 'unknown op: ' + String(a.op) }
  })

  /**
   * 显式 op=release + 功能 D 的推送。
   * 返回**原样**的 release 结果（ok / released / serverTime 的语义与形状不变），
   * 只在其 `data` 上**追加** `notify` 汇总；推送是旁路，任何失败都不得改变工具结果、也不得抛出。
   * 0.8.4：把释放者的活 Agent（`exec.agent`，**原对象**）一路传进 notifyReaders，
   * 作为子代理回退通道的 sender。
   */
  async function releaseWithNotify(a: CollabArgs, h: HolderInput, aId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const res = await mutate(s => release(s, h, a, now), aId, agent)
    try {
      if (res && res.ok === true && res.data && Array.isArray(res.data.released)) {
        res.data.notify = await notifyReaders(res.data.released as PublishedClaim[], h.holderId, h.name || h.holderId, agent)
      }
    } catch (e) {
      // 推送失败不影响 release 结果；仍落一个可观测的空汇总，
      // 免得"字段消失"和"没人需要通知"被混为一谈。
      try {
        if (res && res.data) res.data.notify = { readers: 0, pushed: [], pushedVia: [], skipped: [] }
      } catch (e2) {}
    }
    return res
  }

  const boardHandler = exec((a, h, aId, agent) => {
    if (a.op === 'post') return mutate(s => post(s, h, a, now), aId, agent)
    if (a.op === 'read') return msgs(a, aId, agent)
    return { ok: false, error: 'bad-request', message: 'unknown op: ' + String(a.op) }
  })

  const render = (args: CollabArgs, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  const lockTool: ToolDefinition = {
    name: 'collab_lock',
    description: '多智能体协作中央注册锁：开工前声明占用项目文件夹（目录以 / 结尾，如 src/backend/），查询他人占用，减少共同开发冲突。规范：动手改代码前先 claim；开工前和定期 list/overview；冲突时先 wait 等待或用 board 留言协商；完成即 release；长任务 heartbeat 续租。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['claim', 'release', 'list', 'overview', 'status', 'heartbeat', 'wait'], description: 'claim 声明 / release 释放 / list 全部 / overview 占用全景 / status 查路径 / heartbeat 续租 / wait 等待路径释放' },
        paths: { type: 'array', items: { type: 'string' }, description: '项目相对路径' },
        claimId: { type: 'string', description: 'claim id，release/heartbeat 用' },
        mode: { type: 'string', enum: ['exclusive', 'shared', 'read'], description: 'exclusive 独占（默认）；shared 声明共用但被独占挡住；read 只读观测，不排他也不被挡' },
        readable: { type: 'boolean', description: 'claim 用：他人是否可读这些路径，默认 true；false 表示他人读取也要先协商（写入对非持有者始终要协商）' },
        ttlSec: { type: 'number', description: '租约秒数（5-86400），默认 1800' },
        timeoutMs: { type: 'number', description: 'wait 用，最多等待毫秒，默认 30000' },
        note: { type: 'string', description: '占用说明' }
      },
      additionalProperties: true,
      required: ['op']
    },
    output: { schema: { type: 'object', additionalProperties: true }, render },
    execute: lockHandler
  }

  const boardTool: ToolDefinition = {
    name: 'collab_board',
    description: '多智能体协作留言板：向协作域发消息（频道 general / path:<路径> / agent:<holderId>）或增量读取消息，用于协商、交接、同步进展。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['post', 'read'] },
        channel: { type: 'string', description: '频道，默认 general' },
        body: { type: 'string', description: 'post 用，消息正文' },
        mentions: { type: 'array', items: { type: 'string' }, description: '被 @ 的 holderId' },
        replyTo: { type: 'string', description: '回复的 msgId' },
        since: { type: 'number', description: 'read 用，只返回 seq 大于此值的消息' },
        limit: { type: 'number', description: 'read 用，最多条数，默认 50' }
      },
      additionalProperties: true,
      required: ['op']
    },
    output: { schema: { type: 'object', additionalProperties: true }, render },
    execute: boardHandler
  }

  // ---- 多 DSH 会话协同：把"同项目还有谁占着什么"注入运行时上下文 ----
  // prompt 装配时 agents.currentInitiator() 返回正在装配的那个会话（实测），
  // 因此每个会话在每一步都能自动看到同项目的实时占用，不依赖任何一方"记得去查"。
  // 这对**互相独立的会话/进程**同样成立：各自读同一个状态文件，各自渲染自己的视图。
  // PromptContext.text 必须是同步字符串，所以读盘走后台缓存：text 读缓存，缓存过期时发起异步刷新。
  const agents = ctx.get('agents') as { currentInitiator(): AgentLike | undefined; list(): AgentLike[] } | undefined
  const systemPrompt = ctx.get('systemPrompt') as {
    context(c: { name: string; order: number; text: string | ((context: any) => string) }): () => void
  } | undefined

  const OPEN_HINT = '多会话协作（dsh-collab）：同一项目可能有其他 DSH 会话并行工作。改动文件前用 collab_lock op=claim 声明占用（目录以 / 结尾，如 src/backend/），并先 op=overview 查看他人占用；只读调研用 mode=read；完成后 op=release，长任务 op=heartbeat 续租；协商与交接走 collab_board。'
  // 包形态的关闭开关：DSH_COLLAB_NO_PROMPT_HINT=1 时不注册态势上下文，也不起刷新定时器。
  const PROMPT_HINT_ENABLED = process.env.DSH_COLLAB_NO_PROMPT_HINT !== '1'
  const DIGEST_TTL_MS = Math.max(200, Number(process.env.DSH_COLLAB_DIGEST_TTL_MS) || 15000)
  const digestCache = new Map<string, { text: string; at: number }>()
  const digestBusy = new Set<string>()

  // 摘要文本必须**时间稳定**，否则会毁掉 DSH 自己的快照去重：
  // dsh-agent-loop 的 RuntimeContextProjection.project() 在 rendered === retained.text 时直接返回 undefined，
  // 也就是"内容没变就不提交新快照"。而快照是**整块**提交的（沙箱策略 + 审批策略 + 本插件摘要一起重发），
  // 所以「剩 N 分」这种相对倒计时每分钟都变，会让整块快照每分钟重发一次。
  // 渲染本身已收进 collab-core 的 renderDigest（唯一事实源，签名不含时间参数），这里只留读盘缓存。
  async function refreshDigest(agent: AgentLike): Promise<void> {
    const id = agent && agent.id ? String(agent.id) : null
    const cwd = await cwdOf(id, agent)
    if (!cwd || digestBusy.has(cwd)) return
    digestBusy.add(cwd)
    try {
      const { state } = await load(id, agent)
      const t = now()
      const mine = id ? 'agent:' + id : 'human:console'
      const others = state.claims.filter(c => c.expiresAt > t && c.holderId !== mine)
      digestCache.set(cwd, { text: others.length ? renderDigest(others) : '', at: t })
    } catch (e) {
      // 态势刷新是尽力而为：失败时保留上一份缓存，绝不打断任何模型步或工具调用。
    } finally {
      digestBusy.delete(cwd)
    }
  }

  if (PROMPT_HINT_ENABLED && systemPrompt && typeof systemPrompt.context === 'function') {
    ctx.effect(() => systemPrompt.context({
      name: 'dsh-collab/awareness',
      order: 130,
      text: () => {
        try {
          const init = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined
          const cwd = init && init.session && init.session.header ? init.session.header.cwd : null
          if (!init || typeof cwd !== 'string' || !cwd) return OPEN_HINT
          const hit = digestCache.get(cwd)
          if (!hit || now() - hit.at > DIGEST_TTL_MS) void refreshDigest(init)
          return hit && hit.text ? hit.text : OPEN_HINT
        } catch (e) {
          return OPEN_HINT
        }
      }
    }))
  }

  if (PROMPT_HINT_ENABLED && agents && typeof agents.list === 'function') {
    ctx.effect(() => ctx.timer.interval(() => {
      try {
        for (const a of agents.list()) void refreshDigest(a)
      } catch (e) {}
    }, DIGEST_TTL_MS))
  }

  ctx.tools.register(lockTool)
  ctx.tools.register(boardTool)

  // ---- 功能 A：访问路径相关通知（旁路投递，绝不改工具结果本身）----
  // 先例：@deepseek-ai/dsh-repeat-tool-reminder/lib/index.js:1495-1508 —— **先 await next()
  // 再合并**，且对 downstream.kind === 'block' 单独分支（block 决策只认 feedback +
  // additionalContexts）。这里同样不重建 content/value，只前插 additionalContexts。
  // 异常绝不进 waterfall（抛出的监听器会把工具结果变成 isError）：计算阶段整体 try/catch，
  // 任何失败都等价于"这次没有通知"。
  // 注册走 ctx.on(...)，listener 作为 ctx 作用域的 effect 注册，随插件卸载自动回收（实测
  // cordis 的 EventsService.register 把 hook 存进当前 fiber 的 effect 里，返回 disposer）。
  ctx.on('tools/post-execute', async (execCtx: any, _result: any, next: () => Promise<any>) => {
    let notice: UserMessageLike | null = null
    try {
      const found = await accessEntries(execCtx)
      // 全部是重复 → 原样放行（Return next() 原样）。
      if (found && !found.duplicate) {
        notice = accessNoticeMessage(found.entries)
        // 功能 D：通知与反向注册是同一个动作，先登记读者再投递。
        await registerAccessReaders(found.id, found.agent, found.entries)
      }
    } catch (e) {
      notice = null
    }
    // 无论是否通知，next() 都恰好调用一次。
    const downstream = await next()
    if (!notice || !downstream || typeof downstream !== 'object') return downstream
    try {
      if (downstream.kind === 'block') {
        return { kind: 'block', feedback: downstream.feedback, additionalContexts: prependContext(notice, downstream.additionalContexts) }
      }
      return { ...downstream, additionalContexts: prependContext(notice, downstream.additionalContexts) }
    } catch (e) {
      return downstream
    }
  })

  // ---- 功能 C：写/读的原生审批门控 ----
  // 未命中任何他人声明（或工具不是写/读类、或开关关掉）→ return next() 原样放行。
  // 本部署的已知后果：审批提示被禁用时 dsh-tools 的 serviceAsk 把 ask 变成 deny
  // （"missing approval support turns ask into denial"，见 tools/pre-execute 的 Event 文档
  // 与 dsh-tools/lib/index.js:3314-3322），也就是**硬拒绝**。这是原生路径本身的行为，
  // 不另造 override 机制。
  ctx.on('tools/pre-execute', async (execCtx: any, next: () => Promise<any>) => {
    try {
      const decision = await writeGate(execCtx)
      if (decision) return decision
    } catch (e) {
      // 门控自身故障时放行：插件的问题不该锁死整个工具面。
    }
    return next()
  })

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
        releaserName = hname({ holderId, sessionId: String(agent.id), agent: agent as AgentLike }) || holderId
      } catch (e) {}
      mutate(s => dropHolder(s, holderId), String(agent.id), agent as AgentLike)
        .then(res => {
          try {
            if (res && res.ok === true && res.data && Array.isArray(res.data.released)) {
              // 0.8.4：这里**刻意不传第 4 个参数**（sender）。事件里的 agent 正在 disposed，
              // 不是回退契约要求的 "exact live Agent" —— 拿它当 sender 只会得到一次
              // UNAUTHORIZED，而且违背"拿不到活 Agent 就不回退"的约定。
              // 于是这条路径上的子代理读者会如实落到 skipped（prompt-failed / subagent-*），不静默。
              return notifyReaders(res.data.released as PublishedClaim[], holderId, releaserName)
            }
          } catch (e) {}
        })
        .catch(() => {})
    } catch (e) {}
  }, { global: true })

  // ---- 委托纪律：偏好在 settings（**可选服务**），默认开 ----
  // 技能正文随包走（<pkg>/skills/subagent-delegation/SKILL.md），所以按构建产物的位置解析，
  // 而不是猜用户 ~/.dsh/skills/ 的落点。锁与留言板是产品本体，纪律只是附加项：
  // 服务缺失、文件缺失、解析失败一律**静默跳过**，绝不抛、也绝不阻断上面的工具注册。
  //
  // 关键约束：偏好的值必须**活读**。installSection 会把 setSource 换成返回注册表实时
  // resolved 值的读取器，用户一改设置 onChange 就触发重新结算 —— 不需要重启进程。
  // 这里缓存的只是"读取器"，不是值本身。
  let readSettings: (() => DelegationSettings) | null = null
  let skillStop: (() => void) | null = null
  let disciplineStop: (() => void) | null = null

  const delegationEnabled = (): boolean => {
    try {
      const value = readSettings ? readSettings() : DELEGATION_SETTINGS_ENTRY
      return !value || value.exposeDelegationDiscipline !== false
    } catch (e) {
      return true // 读设置失败按默认开处理：附加能力不该因为读取异常而消失
    }
  }

  /**
   * 功能 C 的门控开关，**活读**（与 delegationEnabled 同源的那份读取器）。
   * 默认 true：读设置失败、服务缺失、字段缺省都按"**必须拦**"处理 ——
   * 写保护失效比多拦一次危险得多。只有显式 false 才关闭。
   */
  const enforceWriteLockEnabled = (): boolean => {
    try {
      const value = readSettings ? readSettings() : DELEGATION_SETTINGS_ENTRY
      return !value || value.enforceWriteLock !== false
    } catch (e) {
      return true
    }
  }

  // 按当前偏好结算两项交付物；开则注册，关则撤回。注册与撤回都走 effect disposer，可逆。
  function reconcileDelegation(): void {
    try {
      const on = delegationEnabled()

      // a) 随包 skill
      if (on && !skillStop) {
        const skills = ctx.get('skills') as SkillsService | undefined
        const skill = skills && typeof skills.register === 'function' ? loadBundledSkill() : null
        if (skills && skill) {
          ctx.effect(() => {
            const off = skills.register({
              name: skill.name,
              description: skill.description,
              whenToUse: skill.whenToUse,
              content: skill.content,
              source: 'bundled',
              provider: 'dsh-collab',
              path: skill.path,
              resourceBase: { kind: 'directory', path: dirname(skill.path) },
              invocation: { modelInvocable: true, userInvocable: true }
            })
            let live = true
            skillStop = () => { if (!live) return; live = false; skillStop = null; off() }
            return () => { if (!live) return; live = false; skillStop = null; off() }
          })
        }
      } else if (!on && skillStop) {
        const stop = skillStop
        skillStop = null
        stop()
      }

      // b) 常驻纪律上下文：skill 是按需拉取的，而这段文本要的是"默认就发生"。
      // DSH_COLLAB_NO_PROMPT_HINT=1 是包形态的总开关：它关掉**所有**运行时上下文注入，
      // 所以这里一并遵守（该开关不管 skill 注册）。
      if (on && PROMPT_HINT_ENABLED && !disciplineStop) {
        if (systemPrompt && typeof systemPrompt.context === 'function') {
          ctx.effect(() => {
            const off = systemPrompt.context({
              name: 'dsh-collab/delegation',
              order: 131,
              // 常量：每次装配返回同一个串，快照去重才能生效。
              text: () => DELEGATION_DISCIPLINE_TEXT
            })
            let live = true
            disciplineStop = () => { if (!live) return; live = false; disciplineStop = null; off() }
            return () => { if (!live) return; live = false; disciplineStop = null; off() }
          })
        }
      } else if ((!on || !PROMPT_HINT_ENABLED) && disciplineStop) {
        const stop = disciplineStop
        disciplineStop = null
        stop()
      }
    } catch (e) {}
  }

  // settings 的接线：可选服务，缺失时保持默认值（开）。
  // 若此刻 settings 已经可用，则**不**先按默认值落地，等 installSection 把实时读取器交上来
  // 再由 onChange 结算 —— 否则"偏好为关"时会先注册再撤回，留下一次无谓的瞬时注册。
  const settingsNow = ctx.get('settings') as SettingsService | undefined
  const settingsUsable = !!(settingsNow && typeof settingsNow.installSection === 'function')
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      const settings = settingsCtx.settings
      if (settings && typeof settings.installSection === 'function') {
        settings.installSection(ctx, DELEGATION_SETTINGS_NAMESPACE, DELEGATION_SETTINGS_SCHEMA, DELEGATION_SETTINGS_ENTRY, {
          setSource: (source) => { readSettings = () => source() },
          onChange: () => { reconcileDelegation() }
        })
      }
    } catch (e) {}
    // 兜底：installSection 缺席或失败（例如命名空间被占用）时，仍按当时的可读值结算。
    reconcileDelegation()
  })
  if (!settingsUsable) reconcileDelegation()

  // ---- 浏览器半边：只读 loopback 路由 ----
  // 浏览器拿不到包的安装位置，「随包 skill 的绝对路径」只能由 host 交出；这是双方
  // 唯一的共享事实。路由与部署里 open-in-app 的三条路由同构：先问 connection 要不要
  // 拒绝（Host/Origin 防 DNS rebinding + 浏览器登录令牌），再判方法，最后才回载荷。
  // 载荷只有路径与名称/描述，**没有正文** —— 预览由右侧文档面板自己读文件。
  // webServer 是可选服务：本部署没组合它时整段静默跳过，卡片那边自然降级。
  ctx.inject(['webServer'], (webCtx) => {
    try {
      const webServer = webCtx.webServer
      if (!webServer || typeof webServer.register !== 'function') return
      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: CLIENT_SKILL_ROUTE,
        handler: (req: IncomingMessage, res: ServerResponse) => {
          const connection = ctx.get('connection') as ConnectionService | undefined
          if (connection && typeof connection.requestRejection === 'function') {
            const rejection = connection.requestRejection(req)
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.end()
              return
            }
          }
          if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET')
            sendJson(res, 405, { error: '仅支持 GET' })
            return
          }
          sendJson(res, 200, buildSkillIndex(loadBundledSkill()))
        }
      }), `dsh-collab: GET ${CLIENT_SKILL_ROUTE}`)
    } catch (e) {}
  })
}

export default { name, inject, apply }
