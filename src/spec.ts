// src/spec.ts
// **纯常量与纯函数**：工具读写路径规格、候选路径收集、去重签名、holderId -> sessionId、
// 以及对外可见的常量（路由路径、设置命名空间与默认值、纪律文本）。
// 全部不依赖 ctx，因此任何模块都可以直接 import，不需要接线。

import z from '@deepseek-ai/schemastery'
import { norm } from './collab-core.js'
import type { Claim } from './collab-core.js'
import type { DelegationSettings } from './contract.js'

/** 浏览器半边读取「设置项 ↔ 随包 skill」关联的只读 loopback 路由。 */
export const CLIENT_SKILL_ROUTE = '/dsh-collab/skill-index'

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
  '探索阶段默认先派：为回答一个问题要连读多个文件、或要先跑一遍才知道结果时，把整个问题包给子代理，只收「文件:行 + 结论」再验收；别在主会话里自己翻。',
  '任务彼此独立就放在同一条消息里并行发起，一个子代理只回答一个完整问题。',
  '验收永远留在主 AI：不外包结论，要求粘贴原始输出作为证据，别只看摘要。',
  '目标轮次要换到真进度：只等子代理时不算一轮，说清在等谁并结束，别用重复验证或轮询去凑。',
  '子代理禁止 client 检视：子代理无浏览器页面，调用客户端检视（槽位或主题等）必永久挂起；界面信息必须由主 AI 在主会话预查并写入委派背景。',
  '子代理可能静默空收尾：别凭收尾消息结案，开文件验产物；同一仓库并发只许一个跑构建，其余只做类型检查。'
].join('\n')

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
export const SUBAGENT_ROUTING_REASON = 'use subagent delivery for this child session'
export const SUBAGENT_ROUTING_MESSAGES = ['owned by subagent routing', 'durable parent address']

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
