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

/**
 * 循环终止自动释放的宽限期（秒）：循环停下（agent/status → idle）后等这么久，
 * 期间会话恢复 running 就**取消**释放。默认 **120 秒**（0.9.11 起，此前是 15）。
 *
 * 为什么从 15 调长：15 秒对"派完子代理、等它跑几分钟"这种最常态的长流程**几乎必然误放** ——
 * 父会话刚 claim 完就被放掉，醒来或被子代理报错唤回后重新 claim，于是 claim→release→claim
 * 反复抖动、留言板反复留痕。**但这个改动不能单独上**：家族豁免（collab-core.inFamily）
 * 落地之前，自动释放是"父独占、子代理写不了"的唯一出口，调长宽限期等于把死锁还回去。
 * 依赖次序记在 README「循环终止自动释放」与 auto-release.ts 的第四道闸门注释里。
 *
 * 它仍然要短到能解开"父会话结束循环、子代理干等锁"的死锁（该场景现在主要由家族豁免 +
 * 第四道闸门处理），又要长到不把两个回合之间的正常停顿算成"会话结束了"。
 */
export const LOOP_END_GRACE_SEC_DEFAULT: number = 120
export const LOOP_END_GRACE_SEC_MIN: number = 1
export const LOOP_END_GRACE_SEC_MAX: number = 3600

/** 设置契约：默认**开启**——目标是让这套工作方式真的发生，开关是用来关掉它的。 */
export const DELEGATION_SETTINGS_SCHEMA = z.object({
  exposeDelegationDiscipline: z.boolean().default(true),
  // 功能 C：写保护默认开。默认值就是"必须拦"，所以它只能被显式关掉。
  enforceWriteLock: z.boolean().default(true),
  // 循环终止自动释放（0.9.10）：默认开。关掉它对应用户明确要求"锁必须活到我手动释放"。
  releaseOnLoopEnd: z.boolean().default(true),
  // 宽限期（秒）。夹在 [1, 3600]：0 会把"每个回合之间的停顿"也算成循环终止。
  loopEndGraceSec: z.number().min(LOOP_END_GRACE_SEC_MIN).max(LOOP_END_GRACE_SEC_MAX).default(LOOP_END_GRACE_SEC_DEFAULT)
})

/** 组合默认值：settings 服务缺失（或 installSection 不可用）时，它就是生效值。 */
export const DELEGATION_SETTINGS_ENTRY: DelegationSettings = {
  exposeDelegationDiscipline: true,
  enforceWriteLock: true,
  releaseOnLoopEnd: true,
  loopEndGraceSec: LOOP_END_GRACE_SEC_DEFAULT
}

/**
 * 常驻委托纪律文本：**纯常量**，无时间戳、无计数、无任何会漂移的字符。
 * DSH 的运行时上下文快照按整串相等去重（rendered === retained.text 即不提交），
 * 所以常量块每个会话只提交一次，成本近似为零；一旦掺入变量就会击穿这个去重。
 * 注意：正文里不能出现阿拉伯数字，否则测试里"无数字"的断言就没有意义。
 */
export const DELEGATION_DISCIPLINE_TEXT = [
  '[dsh-collab] 委托与验收（默认工作方式）：主 AI 规划、下结论、验收；探索/调研/测量/机械改造/独立复核交给子代理 —— 主会话上下文最贵，只留结论、决策与验收证据。',
  '判据：能用一段话写清规格、且能用一次检查判定对错就委托，否则先想清规格；探索阶段默认先派：为答一个问题连读多文件、或先跑一遍才知道结果时，把整个问题包给子代理，只收「文件:行 + 结论」再验收，别在主会话自己翻。',
  '独立单元同一条消息并行发，一个子代理只回答一个完整问题；验收永远留主 AI：不外包结论，要原始输出作证据，别只看摘要。',
  '只等子代理不算一轮：说清在等谁并结束，别用重复验证或轮询凑数。',
  '子代理禁止 client 检视（无浏览器页面必永久挂起），界面信息由主 AI 预查后写进背景；别凭收尾消息结案（可能静默空收尾），开文件验产物；同一仓库只许一个跑构建，其余只做类型检查。',
  '循环一停就自动放锁：你结束循环（空闲十几秒）后，持有的声明会被自动释放 —— 恢复工作时先用 collab_lock op=claim 重新声明，再写这些路径。',
  '子代理意外终止（回合以 error 或空收尾结束、久等之后它不再是 running）先别重派：先 list_agents 看它还在不在（idle / ready 都还能被唤起），在就 send_message 唤醒它接着做 —— 它保留着上下文，比重派便宜；同时提醒它重新 collab_lock op=claim（它一停下，之前的声明就被自动释放了，而它自己不知道）；同一处最多试一两次，再不行就自己写。注意：往留言板 @ 它是唤不醒的，agent.inject 不唤醒 driver，能唤醒的只有 send_message。'
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
