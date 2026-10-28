// src/spec.ts
// **纯常量与纯函数**：工具读写路径规格、候选路径收集、去重签名、holderId -> sessionId、
// 以及对外可见的常量（设置命名空间与默认值、纪律文本）。
// 全部不依赖 ctx，因此任何模块都可以直接 import，不需要接线。

import z from '@deepseek-ai/schemastery'
import { norm } from './collab-core.js'
import type { Claim } from './collab-core.js'
import type { DelegationSettings } from './contract.js'

/**
 * 偏好设置的命名空间。
 *
 * 0.1.7 起设置由**当前 Profile 的插件配置**保存（`@deepseek-ai/dsh-settings`），插件不再
 * 自建 section：命名空间就是本插件在 profile 里的**条目 id**。用户的 profile patch 里
 * `id: collab` 就是这个值（见 `cordis.patch.yml`），两者必须逐字一致。
 */
export const DELEGATION_SETTINGS_NAMESPACE = 'collab'


/**
 * 本插件的 Config schema：两个开关，全部声明 `.volatile()`。
 *
 * 0.1.7 起插件设置就是这个 Config 的 volatile 字段（`@deepseek-ai/dsh-settings` 的表单
 * 只展示 volatile 字段），改一个字段**不需要重载插件**：Loader 把新值写进正在运行的
 * fiber，再发一次 `loader/volatile-update`，本插件在那里重新结算（见 src/delegation.ts）。
 *
 * 默认**开启**——目标是让这套工作方式真的发生，开关是用来关掉它的。
 */
export const DELEGATION_SETTINGS_SCHEMA = z.object({
  exposeDelegationDiscipline: z.boolean().default(true).volatile(),
  // 功能 C：写保护默认开。默认值就是"必须拦"，所以它只能被显式关掉。
  enforceWriteLock: z.boolean().default(true).volatile(),
})

/** schema 校验后的生效值；Config 的默认值本身由 schema 的 `.default()` 负责。 */
export const DELEGATION_SETTINGS_ENTRY: DelegationSettings = {
  exposeDelegationDiscipline: true,
  enforceWriteLock: true
}

/**
 * 常驻委托纪律文本：**纯常量**，无时间戳、无计数、无任何会漂移的字符。
 * DSH 的运行时上下文快照按整串相等去重（rendered === retained.text 即不提交），
 * 所以常量块每个会话只提交一次，成本近似为零；一旦掺入变量就会击穿这个去重。
 * 注意：正文里不能出现阿拉伯数字，否则测试里"无数字"的断言就没有意义。
 */
// **常驻**（每轮注入、每个会话都付这份 token），所以只留两件东西：
//   1) 官方面板与随包 skill 都**不覆盖**的那条：委派时尽量换一个模型（用户明确要求它醒目）；
//   2) collab 自己的生命周期约束（句柄结束即释放、子智能体猝死）。
// 其余（判据、动作序列、规格模板、报告体积、并发切分）全在随包 skill `agent-delegation`
// 里（14k 字符，catalog 靠 description 发现）—— 这里再讲一遍就是重复建设（agent-experience：
// 「从最小上下文开始」「每个事实只说一次」）。
export const DELEGATION_DISCIPLINE_TEXT = [
  '[dsh-collab] 委托与验收（默认工作方式；**首选官方智能体团队**，细则见随包 skill `agent-delegation`）：',
  '**默认用官方智能体团队派成员**（spawn_teammate + 共享任务板）：成员继承你的模型、换不了；要指名 provider / model 只能走降级路径（subagent / subagent_fork，先 list_subagent_models 查允许的路由、别编）。',
  '主会话只留结论、决策与验收证据：能用一段话写清规格、且能用一次检查判定对错就委托；验收不外包，要原始输出，别只看摘要。',
  '同一仓库只许一个跑构建；子智能体没有浏览器页面，别派 client 检视。',
  '锁的存活看两样：会话注册表说它还在，且写这条声明的进程还在 —— 进程被杀（harness 重启）后它留下的声明会被自动回收，闲置过久的也回收，所以恢复工作前先 collab_lock op=claim 重新声明；会话句柄结束时（agent/disposed）同样会自动释放并留审计留言。子智能体意外终止（error 或空收尾）后，同一处最多唤醒一两次，唤醒它时提醒它重新 claim。'
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
// 代价是 shell 写入不受本门控保护 —— 这是**已知旁路**。
//
// 0.2.12 起为这条旁路补**旁路提示**（只提示、绝不拒绝）：判据不是"猜命令要写哪个路径"，
// 而是反向的 —— 拿**已声明的路径**去命令文本里找字面出现（见 SHELL_TOOLS / shellPathMentions）。
// 反向匹配的好处是假阳性方向安全：没提到被占路径 ⇒ 一句话都不投；提到了 ⇒ 投一条 advisory，
// 让调用方知道"这次 shell 写没被门控保护，而它可能碰到别人的锁"。不改变任何门控语义。
/** shell 类工具名：它们的 `command` 是自由文本，门控不拦，只做旁路提示。 */
export const SHELL_TOOLS: readonly string[] = ['bash', 'pwsh', 'run_code']

/**
 * 从 shell 命令文本里找出**被声明路径的字面出现**（反向匹配，不猜目标路径）。
 *
 * 判据刻意保守：只认"路径作为独立片段出现"，即前后不是标识符字符 ——
 * `src/a/` 命中 `rm -rf src/a/x` 与 `sed -i s/x/y/ src/a/b.ts`，但**不**命中
 * `src/a` 出现在 `src/abc` 或 `xsrc/a` 里的情况。返回命中的声明路径（去重、保序）。
 *
 * @param command - 工具的 `command` 参数原文
 * @param claimedPaths - 当前**他人**的未过期 exclusive 声明路径（已归一）
 */
export function shellPathMentions(command: string, claimedPaths: readonly string[]): string[] {
  const text = typeof command === 'string' ? command : ''
  if (!text) return []
  const out: string[] = []
  for (const p of claimedPaths) {
    const needle = typeof p === 'string' ? p.replace(/\/+$/, '') : ''
    if (!needle) continue
    if (out.includes(p)) continue
    // 前后不得是标识符字符：`src/a` 不该命中 `src/abc`，也不该命中 `xsrc/a`。
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp('(^|[^\\w./-])' + esc + '(/|$|[^\\w-])')
    if (re.test(text)) out.push(p)
  }
  return out
}
/** 工具 -> { write: 写/改类目标参数, read: 只读类目标参数 }。 */
export const TOOL_PATH_SPECS: Record<string, { write: string[]; read: string[] }> = {
  write: { write: ['file_path'], read: [] },
  edit: { write: ['file_path'], read: [] },
  str_replace_editor: { write: ['path'], read: ['path'] },
  read: { write: [], read: ['file_path'] },
  glob: { write: [], read: ['path'] },
  grep: { write: [], read: ['path'] },
  // 0.14.0 补登：`read_image` 是 DSH 核心文件工具集里**真实注册**的读工具
  //（dsh-tool-fs/lib/index.js:986，参数同为 `file_path`），漏登记时它拿到 read:[] ⇒ 门控直接放行
  // ⇒ 对图片的 `exclusive + readable:false` 完全失效（2026-10 审计实测缺口）。
  // 教训：**核心文件工具集新增一个读工具，这张表就得跟着加一行** —— 见 tests/collab-access-gate.mjs
  // 的「核心 fs 工具必须全部登记」守卫；没有那条守卫，漏登记是静默的。
  read_image: { write: [], read: ['file_path'] }
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

/** 功能 A 的去重签名：路径 + 排序后的 claimId。 */
export function accessSignature(claims: Claim[]): string {
  const ids = claims.map(c => c.claimId).slice().sort().join(',')
  const paths = claims.flatMap(c => c.paths).slice().sort().join(' ')
  return paths + '|' + ids
}

/** holderId -> sessionId（只有 agent holder 有会话）。 */
export function sessionIdOf(holderId: string): string | null {
  return typeof holderId === 'string' && holderId.startsWith('agent:') ? holderId.slice('agent:'.length) : null
}
