// collab-core.ts
// 多智能体协作插件的纯逻辑唯一事实源（JSON Schema v1 契约见 src/schema/collab.schema.json）。
// 不依赖 fs/ctx/sessions，只操作 state 对象；时间通过可选参数注入以便测试。
// 这是可 import、可测试、可被未来 CLI / Python / Rust 对照复用的实现层。
// 注意：Cordis 动态插件的 code.host 不接受 import，因此 src/collab-plugin.host.ts
// 内联了与这里逻辑一致的自包含可运行版；正式化进 host 组合后改用本模块消除重复。

import type { Claim, ConflictInfo, Holder, Message, Mode, StateDocument } from './types/collab.js'

// 公共类型面（src/types/collab.d.ts）从这里统一再导出，方便调用方只依赖本模块。
export type { Claim, ConflictInfo, Holder, Message, Mode, StateDocument } from './types/collab.js'

/** 注入式时钟：返回当前毫秒时间戳。 */
export type Clock = () => number

/** 调用方 holder 身份。name 由上层（session title / holderId）补全。 */
export interface HolderInput {
  holderId: string
  sessionId?: string
  name?: string
}

/** claim 操作的输入参数。 */
export interface ClaimInput {
  paths?: string[]
  mode?: Mode
  /** 可读性（默认 true）。**只认显式 false**：其余取值（含缺省）都视为可读。 */
  readable?: boolean
  ttlSec?: number
  note?: string
}

/** release 操作的输入参数：二选一（claimId 或 paths）。 */
export interface ReleaseInput {
  claimId?: string
  paths?: string[]
}

/** heartbeat 操作的输入参数。 */
export interface HeartbeatInput {
  claimId?: string
}

/** reap（僵尸声明显式回收，0.9.8）的输入参数。 */
export interface ReapInput {
  /**
   * 默认 false = **dry-run**：只把候选列出来，绝不改动任何状态。
   * 只有显式 `confirm: true` 才真正删除命中判据的声明。
   */
  confirm?: boolean
  /** age 门槛（秒）：`now - createdAt` 必须**严格大于**它才算候选。缺省取保守的 600 秒。 */
  olderThanSec?: number
  /** 只看与这些路径相交的声明（可选；不给就是全部）。 */
  paths?: string[]
}

/**
 * reap 的默认 age 门槛（秒）。刻意保守：刚崩溃的会话可能在几秒内被重新拉起，
 * 太小的门槛会把"正在重启"的活会话判成僵尸。调用方可以显式传更大/更小的值，
 * 但默认值必须偏保守 —— 漏收只是维持现状，误杀会让持有者以为自己还有锁。
 */
export const REAP_DEFAULT_OLDER_THAN_SEC: number = 600

/** board post 操作的输入参数。 */
export interface PostInput {
  body?: string
  channel?: string
  mentions?: string[]
  replyTo?: string
}

/** board read 操作的输入参数。 */
export interface ReadInput {
  channel?: string
  since?: number
  limit?: number
}

/** sweep 的可选上限覆盖（默认 MAX_MESSAGES / HOLDER_TTL_MS）。 */
export interface SweepOptions {
  maxMessages?: number
  holderTtlMs?: number
  staleWarnMs?: number
}

/** sweep 的清理诊断信息。 */
export interface SweepResult {
  expiredClaims: number
  droppedMessages: number
  prunedHolders: number
}

/** list 中按 holder 聚合的存活视图，用于区分"活跃""近期出现过""僵尸"。 */
export interface HolderView {
  holderId: string
  name?: string
  kind?: string
  sessionId?: string
  lastSeenAt: number
  ageSec: number        // 距 t 的秒数
  active: boolean       // 该 holder 当前是否有未过期声明
  stale: boolean        // 无活跃声明且 ageSec*1000 >= holderTtlMs
}

/** 对外发布的 claim 视图（剥离内部字段）。 */
export interface PublishedClaim {
  claimId: string
  holderId: string
  holderName?: string
  paths: string[]
  mode: Mode
  ttlSec: number
  expiresAt: number
  note?: string
  createdAt: number
  /** 可读性，已归一（缺字段的老状态文件输出 true）。 */
  readable: boolean
  /** 反向注册的读者 holderId 列表，已归一（缺字段的老状态文件输出 []）。 */
  readers: string[]
}

/** 各 op 的 data 载荷结构互不相同，统一用宽松的 JSON 字典承载。 */
export type OpData = Record<string, any>

/** 纯逻辑层的统一结果信封。 */
export interface OpResult {
  ok: boolean
  changed?: boolean
  state?: StateDocument
  tNow?: Clock
  data?: OpData
}

/** conflictError 构造出的错误：带上冲突明细供上层转成 error envelope。 */
export interface CollabConflictError extends Error {
  collabConflict: true
  conflicts: ConflictInfo[]
}

/** overview 中按 holder 聚合的占用视图。 */
export interface OverviewHolder {
  holderId: string
  holderName: string
  claimCount: number
  mode: Mode | 'mixed'
  paths: string[]
  claims: PublishedClaim[]
}

export interface OverviewResult {
  totalClaims: number
  holders: OverviewHolder[]
}

/** filterMessages 的返回结构。total 是筛选前的总条数，便于调用方判断是否有更早历史。 */
export interface FilterMessagesResult {
  since: number
  returned: number
  total: number
  latestSeq: number
  messages: Message[]
}

export const seqNever: number = 0

// 路径规范化：目录以 / 结尾，分段感知，容忍 ./、重复斜杠、相对 ..。
export function norm(p: string): string | null {
  if (typeof p !== 'string' || !p.trim()) return null
  let s = p.trim().replace(/\\/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  s = s.replace(/\/{2,}/g, '/').replace(/^\/+/, '')
  const out: string[] = []
  for (const x of s.split('/')) { if (!x || x === '.') continue; if (x === '..') out.pop(); else out.push(x) }
  return out.length ? out.join('/') + (s.endsWith('/') ? '/' : '') : null
}

// 跨语言确定性哈希，用于生成项目唯一隔离标识（无需额外依赖）
export function hashProjectKey(str: string): string {
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c64e6d ^ 0
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(12, '0')
}

// 计算外部独立存储文件名（如 my_project-83f418894e9dd.json）
export function projectStorageFileName(projectRoot: string): string {
  const normRoot = (projectRoot || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normRoot.split('/').filter(Boolean)
  const base = (parts.length ? parts[parts.length - 1] : 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
  const hash = hashProjectKey(normRoot || 'default')
  return `${base}-${hash}.json`
}

// 分段
export const seg = (p: string): string[] => p.split('/').filter(Boolean)

// 前缀重叠（分段）：src/backend/ 与 src/backend/models/ 重叠，src/foo 与 src/foobar 不重叠。
export function ov(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false
  const sa = seg(a), sb = seg(b), n = Math.min(sa.length, sb.length)
  for (let i = 0; i < n; i++) if (sa[i] !== sb[i]) return false
  return true
}

// 显示名清洗：压缩空白并截断 24 字。
export function cleanName(s: string): string {
  if (typeof s !== 'string') return s
  let n = s.replace(/\s+/g, ' ').trim()
  if (n.length > 24) n = n.slice(0, 24) + '…'
  return n
}

export function init(): StateDocument { return { schemaVersion: 1, seq: 0, claims: [], messages: [], holders: [] } }

// 状态膨胀上限：留言保留最近 MAX_MESSAGES 条，holder 在无活跃声明且 24h 未出现时回收。
// 两者都由 sweep() 在每次读/写前惰性执行，保证状态文件不会无限增长。
export const MAX_MESSAGES: number = 2000
export const HOLDER_TTL_MS: number = 24 * 60 * 60 * 1000
// 时钟偏移容忍：lastSeenAt 落在未来超过该窗口的 holder 视为不可信并回收。
// 只回收 holder 记录；声明仍按各自的 expiresAt 判定，锁语义不受影响。
export const HOLDER_FUTURE_SKEW_MS: number = 5 * 60 * 1000
// stale 预警阈值：holder 无活跃声明且静默超过该时长即报 stale=true。
// 它**小于**回收阈值（24h），所以 stale 是"看起来已废弃"的先行信号，而不是"马上会被删"的同义词；
// 若与回收同阈值，在"先 sweep 再取视图"的产品路径上该字段恒为 false（死信号）。
export const HOLDER_STALE_WARN_MS: number = 60 * 60 * 1000

// holder 是否仍算"新鲜"：age 落在 [-HOLDER_FUTURE_SKEW_MS, holderTtlMs) 内。
// sweep 的回收判据与 holderView 的 stale 判据共用这一个函数，二者不会再出现"口径不一致"。
export function holderFresh(lastSeenAt: number | undefined, t: number, holderTtlMs: number = HOLDER_TTL_MS): boolean {
  const age = t - (lastSeenAt || 0)
  return age < holderTtlMs && age > -HOLDER_FUTURE_SKEW_MS
}

// 惰性清理：过期声明 + 超额留言 + 陈旧 holder。
// 返回各类清理数量，供上层附带诊断信息。
export function sweep(s: StateDocument, t: number, opts: SweepOptions = {}): SweepResult {
  const maxMessages = Number.isInteger(opts.maxMessages) && opts.maxMessages > 0 ? opts.maxMessages : MAX_MESSAGES
  const holderTtlMs = Number.isInteger(opts.holderTtlMs) && opts.holderTtlMs >= 0 ? opts.holderTtlMs : HOLDER_TTL_MS

  const beforeClaims = s.claims.length
  s.claims = s.claims.filter(c => c.expiresAt > t)
  const expiredClaims = beforeClaims - s.claims.length

  let droppedMessages = 0
  if (s.messages.length > maxMessages) {
    droppedMessages = s.messages.length - maxMessages
    s.messages = s.messages.slice(-maxMessages)
  }

  const active = new Set(s.claims.map(c => c.holderId))
  const beforeHolders = s.holders.length
  s.holders = s.holders.filter(h => active.has(h.holderId) || holderFresh(h.lastSeenAt, t, holderTtlMs))
  const prunedHolders = beforeHolders - s.holders.length

  // readers **不在这里清理**（0.8.3 修掉的真缺陷）。
  // 曾经的实现用 liveHolders 判据同时清 holders 与 readers，而宿主注入的判据是
  // `agents.get(sessionId) !== undefined`：它对**已休眠但可唤回**的会话返回 undefined
  // （实测活进程 agents.list() 只有 2 个 agent，而 sessionController.list() 有 224 个会话）。
  // 结果是一个"只是空闲、并未结束"的读者会在下一次任意写路径上被悄悄删掉，
  // 该 claim 释放时 readers 已空，通知谁也发不出去 —— 静默丢消息比不清理危险得多。
  // 读者的移除只走 dropHolder()（host 侧的 agent/disposed 路径）：它只摘 reader 登记，
  // **不**回收未过期的声明（W7：租约是声明回收的**唯一**机制，dispose 不是释放信号）。
  // 有界性不需要额外的 TTL 或上限：readers 挂在 claim 上，claim 在 release 或
  // 到期时被上面的 filter 移除，readers 随 claim 一起消亡 —— 天然有界。
  return { expiredClaims, droppedMessages, prunedHolders }
}

// 惰性清理过期声明，返回清理数量（兼容旧调用方）。
export function expire(s: StateDocument, t: number): number { return sweep(s, t).expiredClaims }

// holder 存活视图：把 holders 数组翻译成"谁还活着"的可读判断。
// active = 该 holder 有未过期声明；stale = 无活跃声明且距 t 已超过 holderTtlMs（sweep 下次就会回收它）。
// 按 lastSeenAt 降序，调用方一眼看出最近活跃者；staleHolders 是 stale 的计数。
export function holderView(state: StateDocument, t: number, opts: SweepOptions = {}): { holders: HolderView[]; staleHolders: number } {
  const holderTtlMs = Number.isInteger(opts.holderTtlMs) && opts.holderTtlMs >= 0 ? opts.holderTtlMs : HOLDER_TTL_MS
  // 预警阈值取 min(1h, holderTtlMs)：测试里把 ttl 调小时，stale 判据跟着一起缩，语义保持一致。
  const warnMs = Number.isInteger(opts.staleWarnMs) && opts.staleWarnMs >= 0
    ? opts.staleWarnMs
    : Math.min(HOLDER_STALE_WARN_MS, holderTtlMs)
  const activeIds = new Set(state.claims.filter(c => c.expiresAt > t).map(c => c.holderId))
  const holders: HolderView[] = state.holders
    .map(h => {
      const lastSeenAt = h.lastSeenAt || 0
      const ageMs = t - lastSeenAt
      const ageSec = Math.max(0, Math.floor(ageMs / 1000))
      const active = activeIds.has(h.holderId)
      // stale = 无活跃声明，且（静默超过预警阈值 或 时间戳落在未来过远因而不新鲜）。
      const stale = !active && (ageMs >= warnMs || !holderFresh(lastSeenAt, t, holderTtlMs))
      return { holderId: h.holderId, name: h.name, kind: h.kind, sessionId: h.sessionId, lastSeenAt, ageSec, active, stale }
    })
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  return { holders, staleHolders: holders.filter(x => x.stale).length }
}

// ---- 运行时态势摘要：注入 DSH 运行时上下文的那一行占用视图 ----
// **时间无关**是本函数的硬约束，不是巧合。DSH 的 RuntimeContextProjection.project()
// 在 rendered === retained.text 时直接返回 undefined（内容没变就不提交新快照），
// 而快照是**整块**提交的：沙箱策略 + 审批策略 + 本插件摘要一起重发。
// 旧格式用「剩 N 分」这种相对倒计时，每分钟都变，于是整块快照每分钟重发一次
// （实测全部 90 个会话、415 次已提交快照：其中 237 次（57.1%）只差那个数字，
// 累计 337014 字符被重复注入；237 是逐对做最小差异判定得到的精确值）。
// 改用**绝对 UTC 起止时刻**后，文本只在"他人的占用集合真的变了"时才变，去重恢复生效。
// 因此签名刻意**不接受任何时间参数**：没有参数，倒计时就无从偷偷加回来。
// 动态宿主形态在 src/collab-plugin.host.ts 的 hostCode 里保留一份等价内联实现
// （限制执行环境不能 import），两者的逐字节等价由 tests/collab-hostcode-parity.mjs 对拍。

// 毫秒时间戳 → `MM-DD HH:MMZ`（UTC，分钟粒度）。分钟粒度 + UTC 让它与本地时区、时钟秒数无关。
export function clockUtc(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + 'Z'
}

// 模式名 → 渲染给人看的标签（W9 文案中文化）。
// **只用于渲染文本**：mode 的**取值与契约**在 JSON 返回、schema、类型枚举、参数校验里
// 仍是 'exclusive' | 'shared' | 'read'（见 MODES / tools.ts 的 enum），绝不因文案改动而变。
// 未知取值原样回退（不吞错、不猜），保证渲染层永不对数据撒谎。
export const MODE_LABELS: Readonly<Record<Mode, string>> = { exclusive: '独占', shared: '共享', read: '只读' }
export function modeLabel(mode: Mode | string): string {
  return MODE_LABELS[mode as Mode] || String(mode)
}

// claims = 他人的、未过期的声明。最多列 3 条、每条最多 2 个路径，其余折叠成计数，
// 因为这一行会在每一个模型步都被注入，长度必须有界。
export function renderDigest(claims: Claim[]): string {
  // 显式排序只为确定性：状态文件里的插入顺序不该让同一组占用渲染出不同文本。
  const ordered = claims.slice().sort((a, b) =>
    (a.expiresAt - b.expiresAt) || String(a.holderId).localeCompare(String(b.holderId)))
  const parts = ordered.slice(0, 3).map(c => {
    const mins = Math.max(1, Math.round((c.ttlSec || 0) / 60))
    const paths = c.paths.slice(0, 2).join(' ') + (c.paths.length > 2 ? ' 等 ' + c.paths.length + ' 条' : '')
    const start = clockUtc(typeof c.createdAt === 'number' ? c.createdAt : c.expiresAt - (c.ttlSec || 0) * 1000)
    return (c.holderName || c.holderId) + '（' + modeLabel(c.mode) + '）占用 ' + paths +
      '，租约 ' + mins + ' 分（' + start + '–' + clockUtc(c.expiresAt) + '）'
  })
  const more = ordered.length > 3 ? '；另有 ' + (ordered.length - 3) + ' 条' : ''
  return '[dsh-collab] 同项目其他会话当前占用：' + parts.join('；') + more + '。改动这些路径前请先执行 collab_lock op=wait 或用 collab_board 协商。'
}

// ---- 访问路径判定（功能 A：访问时的旁路通知；功能 C：写保护的原生审批）----
//
// 这里只放**可单测的纯逻辑**；注册 ctx.on('tools/pre-execute'|'tools/post-execute')
// 的宿主接线在 src/index.ts。两条判定的口径刻意不同，别把它们合并：
//   - claimsForAccess（功能 A，**提示性**）沿用「同父目录的旁支及其后代」这一较宽的口径，
//     目的是提醒"你正在访问的目录里还有别人在动别的东西"；
//   - claimsCovering（功能 C，**强制性**）用严格的分段前缀覆盖，只认"别人的声明覆盖了
//     你要动的这个路径"。本部署里 ask 等价于硬拒绝（审批提示被禁用），宽口径会造成
//     假阳性硬拒绝（他人声明 src/a/2 却拦下我对 src/a/1 的写入），所以这里必须窄。

/** 被访问路径的**父目录**：归一化、带尾 `/`。`src/a/1`→`src/a/`；`src/a/`→`src/`；`src`→`''`。 */
export function accessScope(accessPath: string): string {
  const n = norm(accessPath)
  if (!n) return ''
  const parts = seg(n)
  parts.pop()
  return parts.length ? parts.join('/') + '/' : ''
}

/**
 * 把任意路径归一到**项目相对**形式：若它落在 cwd 之下就去掉 cwd 前缀。
 * claim 的 paths 是项目相对的（工具文档："项目相对路径"），而工具入参可能是绝对路径
 * （如 write 的 file_path 交给 fs 后端解析），不归一化就永远匹配不上。
 */
export function relToProject(p: string, cwd?: string | null): string {
  const n = norm(p)
  if (!n) return ''
  const c = typeof cwd === 'string' && cwd ? norm(cwd) : null
  if (!c) return n
  const root = c.replace(/\/+$/, '')
  if (!root) return n
  if (n === root) return ''
  if (n.startsWith(root + '/')) return n.slice(root.length + 1)
  return n
}

/**
 * 与访问 accessPath 相关的声明（功能 A 的判据）。
 * C 被选中当且仅当 C 的某个路径 P 满足 `ov(P, accessScope(accessPath))`（同父目录的旁支
 * 及其后代）**或** `ov(accessPath, P)`（P 是 accessPath 的祖先或自身）；过期声明排除。
 * 例：访问 `src/a/1` 会命中声明 `src/a/2`、`src/a/2/A`、`src/a/`、`src/`，
 * 不会命中 `src/b`、`other/`。
 */
export function claimsForAccess(claims: Claim[], accessPath: string, now: number): Claim[] {
  const target = norm(accessPath)
  if (!target) return []
  const scope = accessScope(target)
  return (Array.isArray(claims) ? claims : []).filter(c => c.expiresAt > now && c.paths.some(raw => {
    const p = norm(raw)
    if (!p) return false
    return ov(p, scope) || ov(target, p)
  }))
}

/**
 * 覆盖 target 的声明（功能 C 的判据）：C 的某个路径 P 是 target 的祖先或自身
 * （`ov(target, P)`，与 claim() 既有的冲突判据同源）。过期声明排除。
 */
export function claimsCovering(claims: Claim[], target: string, now: number): Claim[] {
  const t = norm(target)
  if (!t) return []
  return (Array.isArray(claims) ? claims : []).filter(c => c.expiresAt > now && c.paths.some(raw => {
    const p = norm(raw)
    return !!p && ov(t, p)
  }))
}

/** 可读性归一：缺省（含 0.7.0 之前写下的状态文件）视为**可读**。 */
export function isReadable(c: Claim): boolean {
  return !(c && (c as { readable?: unknown }).readable === false)
}

// ---- 功能 D：reader 反向注册的纯状态变换（纯逻辑，便于单测） ----

/** 把 holderId 登记为 claimId 的读者（幂等；claim 不存在时什么都不做）。 */
export function registerReader(state: StateDocument, claimId: string, holderId: string): OpResult {
  const c = state.claims.find(x => x.claimId === claimId)
  if (!c) return { ok: true, changed: false, data: { registered: false, reason: 'no-claim' } }
  const list = readersOf(c)
  if (list.includes(holderId)) return { ok: true, changed: false, data: { registered: false, reason: 'already' } }
  c.readers = list.concat([holderId])
  return { ok: true, changed: true, state, data: { registered: true, claimId, readers: c.readers.slice() } }
}

/**
 * 会话退出（dispose）时的状态变换：把这个 holderId 从**所有**剩余 claim 的 readers 里摘掉，
 * 并回收它**已经过期**的声明 —— 两件事在同一次状态变更里完成。
 *
 * 为什么不是「释放它的全部声明」（W7 实测过的锁安全缺陷）：
 * 会话被 dispose 后**常常恢复并继续干活**，它的对话历史里仍然"记得"自己持有这个路径。
 * 旧实现只按 holderId 过滤、完全不看 expiresAt，于是声明被提前删掉 ⇒ 其他会话 `op=overview`
 * 看到路径空闲，两边都以为可以写；而且 `released` 通知还说了一件没发生的事。
 *
 * 因此**声明（claim）的生命周期只由租约 `expiresAt` 决定**：dispose **不是**释放信号。
 * 未过期的声明原样保留（连同它自己的 readers 列表），到点由 sweep() 回收 ——
 * 租约是**唯一**的回收机制。安全侧后果：会话死亡后它的声明会一直占用到租约到期，
 * 期间别的会话必须 `op=wait` 或协商；`op=heartbeat` 仍是唯一的续租方式。
 *
 * `t` **必填**（不许隐式读 `Date.now()`）：纯逻辑模块要保持可确定性、可对拍。
 * `data.released` 只含**真正被删掉**的声明 ⇒ 正常情况为空，agent/disposed 路径
 * 也就不再产生"锁已释放"通知（那是实话：没有发生释放事件）。
 */
export function dropHolder(state: StateDocument, holderId: string, t: number): OpResult {
  const expired = (c: Claim): boolean => c.holderId === holderId && c.expiresAt <= t
  const rel = state.claims.filter(expired)
  let changed = rel.length > 0
  if (rel.length) state.claims = state.claims.filter(c => !expired(c))
  for (const c of state.claims) {
    const list = readersOf(c)
    if (!list.includes(holderId)) continue
    c.readers = list.filter(x => x !== holderId)
    changed = true
  }
  if (!changed) return { ok: true, changed: false, data: {} }
  return { ok: true, changed: true, state, data: { released: rel.map(publish) } }
}

// ---- 循环终止自动释放（0.9.10，op=release 之外的第三条回收路径）----
//
// 为什么需要它（一手场景）：父会话 claim 了一个目录，把写入交给子代理后**结束了自己的循环**
// （agent/status → idle，agent 仍加载着、不是 dispose）。子代理需要写同一批路径，被
// 功能 C 的门控硬拒绝，于是到留言板 @ 父会话要求释放 —— 但父会话的循环已经停了，
// `agent.inject` 的契约是 `send(message, "next-step", wakeup=false)`：**不唤醒 driver**
// （`dsh-agent/lib/types/runtime-types.d.ts:202-209`），留言永远读不到、锁也永远不放开，
// 只能干等租约到期（默认 1800 秒）。这条路径补上那个缺口：循环一停，宽限期一过就自动释放。
//
// 与 dropHolder（W7：**dispose 不释放**未过期声明）的分工，别把两者混为一谈：
//   - dropHolder 的触发是 **agent/disposed**（进程里这个 agent 没了），它只能断言"会话已退场"
//     —— 而退场的会话**常常恢复并继续干活**，所以那里不缩短租约；
//   - 本函数的触发是 **agent/status → idle**（循环停了，agent 还在），且调用方**先等过宽限期、
//     并确认它没有恢复成 running** 才调用。宽限期把"两个回合之间的正常停顿"排除掉。
// 语义后果（如实写在这里，不藏）：自动释放之后，那个会话**如果恢复**，它的对话历史里仍然
// "记得"自己持有这些路径。所以调用方有义务（见 src/auto-release.ts 与 push.ts 的
// notifyLoopEndRelease）给被释放的会话投一条显式来源的告知，让它重新 claim 再写。
//
// `t` 与 `graceSec` 都由调用方显式传入（纯逻辑模块不隐式读时钟）；`graceSec` 只用于生成
// 留痕文本 —— 函数**不**自己判断宽限期，那是接线层的事。

/** 自动释放留痕消息的作者。不是任何真实 holder：形如 `human:console` 的第三种前缀。 */
export const AUTO_RELEASE_AUTHOR: string = 'system:dsh-collab'

/**
 * 循环终止自动释放：删除 holderId 的**全部未过期声明**，并在留言板留下一条可审计的留言。
 *
 * - 只处理**未过期**的声明：已过期的归 sweep()，这里不抢它的活（与 reap 同一条口径）。
 * - 一条都没有时 `changed: false`，调用方据此**不写盘、不发通知、不留痕**（没有发生释放事件）。
 * - 留痕消息进 `messages`（契约里已有的结构，不改状态文档 schema）：channel 就是 `holderId`
 *   —— agent holder 的 holderId 本身已经是 `agent:<sessionId>`，正是工具文档里"频道
 *   agent:…"那种寻址写法（**不要**再拼一次 `agent:`，那会得到 `agent:agent:<id>`），
 *   mentions 指向持有者本人，于是"这条锁是谁、因为什么、什么时候被拿掉的"从
 *   `collab_board op=read` 就能复述。
 * - 返回 `data.released` 是**真正被删掉**的那些声明的公开视图（供通知使用）。
 */
export function releaseOnLoopEnd(state: StateDocument, holderId: string, holderName: string, t: number, graceSec: number): OpResult {
  const mine = state.claims.filter(c => c.holderId === holderId && c.expiresAt > t)
  if (!mine.length) return { ok: true, changed: false, data: { released: [] } }
  state.claims = state.claims.filter(c => !mine.includes(c))
  const released = mine.map(publish)
  // 路径去重保序后折叠：与通知文案同一口径（最多列 3 条，其余计数）。
  const uniq: string[] = []
  for (const c of released) for (const p of c.paths) if (!uniq.includes(p)) uniq.push(p)
  const shown = uniq.slice(0, 3).join(' ') + (uniq.length > 3 ? ' 等 ' + uniq.length + ' 条' : '')
  const who = holderName || holderId
  const m: Message = {
    msgId: 'm_' + (++state.seq),
    seq: state.seq,
    channel: holderId,
    author: AUTO_RELEASE_AUTHOR,
    ts: t,
    body: '[自动释放] ' + who + ' 的会话循环已结束（空闲超过 ' + graceSec + ' 秒），其对 ' + shown +
      ' 的声明已被自动释放。恢复工作前如需写入这些路径，请重新 collab_lock op=claim。',
    mentions: [holderId]
  }
  state.messages.push(m)
  return { ok: true, changed: true, state, data: { released, notice: m } }
}

/** readers 归一：缺字段按 []，且**去重保序**（功能 D 要求不重复）。 */
export function readersOf(c: Claim): string[] {
  const raw = c && Array.isArray((c as { readers?: unknown }).readers) ? (c as { readers: unknown[] }).readers : []
  const out: string[] = []
  for (const x of raw) if (typeof x === 'string' && x && !out.includes(x)) out.push(x)
  return out
}

/**
 * 访问通知文本：紧凑、**时间稳定**。与 renderDigest 同源的约束（见上）：
 * 只用**绝对 UTC** 起止时刻，绝不出现「剩 N 分」这类会随秒漂移的倒计时 ——
 * 这份文本会作为 additionalContexts 进入上下文，漂移就会击穿快照去重。
 * 与 renderDigest 一致，签名只有一个形参：没有时间参数，倒计时就无从加回来。
 */
export function renderAccessNotice(claims: Claim[]): string {
  // 显式排序只为确定性：状态文件里的插入顺序不该让同一组声明渲染出不同文本。
  const ordered = claims.slice().sort((a, b) =>
    (a.expiresAt - b.expiresAt) || String(a.holderId).localeCompare(String(b.holderId)))
  const parts = ordered.slice(0, 2).map(c => {
    const mins = Math.max(1, Math.round((c.ttlSec || 0) / 60))
    const paths = c.paths.slice(0, 2).join(' ') + (c.paths.length > 2 ? ' 等 ' + c.paths.length + ' 条' : '')
    const start = clockUtc(typeof c.createdAt === 'number' ? c.createdAt : c.expiresAt - (c.ttlSec || 0) * 1000)
    // 可读性**只对 exclusive 有门控意义**：writeGate 的 collect() 对 shared/read 一律 `continue`
    // 放行（src/index.ts）。所以只在 exclusive 上渲染「可读 / 不可读」—— 对 shared/read 标
    // 「不可读」是句假话，读根本不会被拦。而 OPEN_HINT 恰好推荐"只读调研用 mode=read"，
    // 一个只读声明却被通知写成「不可读」，误导概率最高。
    const readableTag = c.mode === 'exclusive' ? '，' + (isReadable(c) ? '可读' : '不可读') : ''
    return (c.holderName || c.holderId) + '（' + modeLabel(c.mode) + readableTag + '）占用 ' + paths +
      '，租约 ' + mins + ' 分（' + start + '–' + clockUtc(c.expiresAt) + '）'
  })
  const more = ordered.length > 2 ? '；另有 ' + (ordered.length - 2) + ' 条' : ''
  return '[dsh-collab] 你刚访问的路径处于其他会话的占用范围内：' + parts.join('；') + more +
    '。改动这些路径前请先执行 collab_lock op=wait 或用 collab_board 协商。'
}

// 对外发出一条 claim 的公开视图（剥离内部字段）。
// readable / readers 都归一后输出：老状态文件缺字段时输出 true / []，与 isReadable、readersOf 同源。
export function publish(c: Claim): PublishedClaim {
  return { claimId: c.claimId, holderId: c.holderId, holderName: c.holderName, paths: c.paths, mode: c.mode, ttlSec: c.ttlSec, expiresAt: c.expiresAt, note: c.note, createdAt: c.createdAt, readable: isReadable(c), readers: readersOf(c) }
}

// 构造冲突错误（由调用方捕获）。标记 collabConflict 以便 mutate 识别。
export function conflictError(cs: ConflictInfo[]): CollabConflictError {
  const e = new Error('conflict') as CollabConflictError
  e.collabConflict = true
  e.conflicts = cs
  return e
}

// 登记/更新 holder 元数据。
export function holder(state: StateDocument, h: HolderInput, name: string, tNow: Clock): Holder {
  let r = state.holders.find(x => x.holderId === h.holderId)
  if (!r) { r = { holderId: h.holderId, name, kind: h.sessionId ? 'agent' : 'human', sessionId: h.sessionId, lastSeenAt: tNow() }; state.holders.push(r) }
  else { r.name = name; r.lastSeenAt = tNow() }
  return r
}

/** 合法锁模式集合；claim 只接受这三个值。 */
export const MODES: readonly Mode[] = ['exclusive', 'shared', 'read']

// 声明占用。返回 {ok,changed,state,data}，或抛 conflictError。
// tNow 是 () => 当前毫秒；h = {holderId, sessionId?, name?}；a = {paths, mode?, ttlSec?, note?}。
export function claim(state: StateDocument, h: HolderInput, a: ClaimInput, tNow: Clock): OpResult {
  const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
  if (!paths.length) return { ok: false, changed: false, tNow, data: { error: 'bad-request', message: 'paths required（目录以 / 结尾）' } }
  // mode 显式校验：未知值返回 bad-request，而不是替调用方猜一个
  // （猜成 exclusive 会把一次笔误静默升级为最强锁，属于 fail-unsafe）。
  const rawMode = (a as { mode?: unknown }).mode
  const requested = rawMode === undefined || rawMode === null || rawMode === '' ? 'exclusive' : String(rawMode)
  if (requested !== 'exclusive' && requested !== 'shared' && requested !== 'read') {
    return { ok: false, changed: false, tNow, data: { error: 'bad-request', message: 'mode must be one of exclusive | shared | read (got ' + String(rawMode) + ')' } }
  }
  const mode = requested as Mode
  // 可读性（功能 C）：默认 true。兼容映射 —— read/exclusive/shared 在**未显式指定**时
  // 一律默认可读；只有显式 readable:false 才关闭。该字段**不参与**下面的冲突扫描，
  // 因此不会改变任何既有的冲突判定（只被写保护门控使用）。
  const readable = a.readable === undefined || a.readable === null ? true : a.readable !== false
  const ttl = Math.max(5, Math.min(86400, Number(a.ttlSec) || 1800))
  const note = typeof a.note === 'string' ? a.note.slice(0, 500) : ''
  const t = tNow(), cs: ConflictInfo[] = []
  // read 是纯观测：不阻塞他人，也不被他人阻塞，直接跳过整个冲突扫描。
  if (mode !== 'read') {
    for (const c of state.claims) {
      if (c.holderId === h.holderId || c.expiresAt <= t || c.mode === 'shared' || c.mode === 'read') continue
      for (const p of paths) for (const cp of c.paths) if (ov(p, cp)) {
        const remainingSec = Math.max(0, Math.ceil((c.expiresAt - t) / 1000))
        const suggestedAction: ConflictInfo['suggestedAction'] = remainingSec <= 30 ? 'wait' : 'negotiate'
        cs.push({
          claimId: c.claimId,
          holderId: c.holderId,
          holderName: c.holderName || c.holderId,
          path: p,
          overlapsWith: cp,
          mode: c.mode,
          expiresAt: c.expiresAt,
          remainingSec,
          suggestedAction,
        })
        break
      }
    }
  }
  if (cs.length) throw conflictError(cs)
  holder(state, h, h.name, tNow)
  const expiresAt = t + ttl * 1000
  // 合并限定在**同一 mode** 的声明上；不同 mode 各成一条。
  // 若跨 mode 合并，"对 src/ 声明 read + 对 src/sub/ 声明 exclusive"会合成一条
  // 覆盖 src/ 的 exclusive 声明，把从未被独占的兄弟路径 src/other/ 一并锁上。
  const own = state.claims.find(c => c.holderId === h.holderId && c.mode === mode && c.paths.some(cp => paths.some(p => ov(p, cp))))
  let cl: Claim, merged = !!own
  if (own) {
    for (const p of paths) if (!own.paths.includes(p)) own.paths.push(p)
    own.ttlSec = ttl; own.note = note || own.note; own.expiresAt = expiresAt
    // 只在**显式**给出时改写可读性，缺省不重置：否则一次不带 readable 的续声明会把
    // 之前的 readable:false 静默翻回可读。readers 是反向注册的既成事实，合并时原样保留。
    if (a.readable !== undefined && a.readable !== null) own.readable = readable
    cl = own
  }
  else { cl = { claimId: 'c_' + (++state.seq), holderId: h.holderId, holderName: h.name, paths, mode, ttlSec: ttl, expiresAt, note, createdAt: t, readable, readers: [] }; state.claims.push(cl) }
  let warn: string | null = null
  if (ttl < 60) warn = 'short-lease: ttl=' + ttl + 's（<60s）; 请按时 heartbeat 续租，避免过期' + (merged ? '；已并入你现有声明' : '')
  return { ok: true, changed: true, state, tNow, data: { claim: publish(cl), serverTime: t, merged, warning: warn } }
}

// 释放。a = {claimId?} 或 {paths?}。返回 {ok,changed,state,data}。
export function release(state: StateDocument, h: HolderInput, a: ReleaseInput, tNow: Clock): OpResult {
  const t = tNow(); let rel: Claim[] = []
  if (a.claimId) {
    const c = state.claims.find(x => x.claimId === a.claimId)
    if (!c) return { ok: false, changed: false, state, tNow, data: { error: 'not-found', message: 'no claim ' + a.claimId } }
    if (c.holderId !== h.holderId) return { ok: false, changed: false, state, tNow, data: { error: 'forbidden', message: 'only holder can release' } }
    state.claims = state.claims.filter(x => x.claimId !== a.claimId); rel = [c]
  } else {
    const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
    if (!paths.length) return { ok: false, changed: false, state, tNow, data: { error: 'bad-request', message: 'claimId or paths required' } }
    rel = state.claims.filter(c => c.holderId === h.holderId && c.paths.some(cp => paths.some(p => ov(p, cp))))
    if (!rel.length) return { ok: true, changed: false, state, tNow, data: { released: [], serverTime: t } }
    state.claims = state.claims.filter(c => !rel.includes(c))
  }
  return { ok: true, changed: true, state, tNow, data: { released: rel.map(publish), serverTime: t } }
}

// ---- 僵尸声明显式回收（0.9.8，op=reap）----
//
// **只由显式 op 驱动，绝不自动触发。**不能把它接进 sweep() 或任何读路径，原因如实写在这里：
// 判据是「holder 不在 `agents.list()` 里 + age 超过门槛」，而 `agents.list()` 只包含
// **本进程此刻加载着的** agent —— 一个只是空闲、但可以随时被唤回的休眠会话同样不在里面
// （0.8.2 就是按这个判据清 readers，静默丢了通知；W7 又确认 `agent/disposed` 不得提前
// 释放未到期声明）。换句话说：**从运行时注册表无法区分"休眠可唤回"与"真死"**。
// 误杀的代价不对称 —— 被回收的会话恢复后仍按对话历史以为自己持有锁，另一边却看到路径空闲，
// 于是两边同时以为可以写（W7 的锁安全缺陷）。
//
// 所以这套判据只作为**候选清单**交给调用方，由人/模型显式 `confirm`；默认 dry-run，
// 且只回收**未过期**的声明（过期的归 sweep()，不需要 reap；reap 抢着干只会让"僵尸"口径
// 与租约口径分叉）。age 门槛与活体检查都只是**降低误杀概率**，不是"证明它死了"。
//
// 形态：reap(state, holderInput, args, liveHolderIds, now) -> { ok, changed, state, data }
//   - liveHolderIds = 活体检查的结果（`'agent:' + a.id` 列表）；
//     **null = 活体检查没跑成**（agents.list 不可用/抛错）⇒ 一个也不收 —— 拿不到名单时
//     "不在名单里"没有信息量，这正是 `agents.get()` 对休眠会话返回 undefined 的同一个坑。
//   - 返回 data 里逐条候选带上 reasons（每条判据一个标签）与 ageSec / remainingSec，
//     让"为什么它算僵尸"可以从返回值本身复述，而不是靠调用方猜。
export function reap(s: StateDocument, h: HolderInput, a: ReapInput, liveHolderIds: string[] | null, t: number): OpResult {
  const raw = Number(a && a.olderThanSec)
  const olderThanSec = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : REAP_DEFAULT_OLDER_THAN_SEC
  // 只认显式 true：`confirm: 'yes'` / 1 / 缺省一律按 dry-run（fail-safe 的方向是"不改状态"）。
  const confirm = !!(a && a.confirm === true)
  const paths = (Array.isArray(a && a.paths) ? a.paths : []).map(norm).filter(Boolean)
  const unknown = liveHolderIds === null || liveHolderIds === undefined
  const live = new Set(Array.isArray(liveHolderIds) ? liveHolderIds : [])
  const hits: Claim[] = []
  if (!unknown) {
    for (const c of s.claims) {
      // 已过期的不算僵尸（那是 sweep() 的活），所以这里只保留 expiresAt > t。
      if (!(c.expiresAt > t)) continue
      // 自己的声明用 op=release：reap 不替调用方清自己的锁（否则一次 confirm 会连带
      // 把调用方正在做的活的占用一起抹掉）。
      if (c.holderId === h.holderId) continue
      // 只对**有活体信号的 holder**（agent:<id>）判僵尸。`human:console` 从来不在
      // agents.list() 里，"不在名单"对它没有任何信息量 —— 按它回收等于纯按 age 回收。
      if (typeof c.holderId !== 'string' || !c.holderId.startsWith('agent:')) continue
      // 活体检查：名单里有的，无论多老都不碰。
      if (live.has(c.holderId)) continue
      const createdAt = typeof c.createdAt === 'number' ? c.createdAt : c.expiresAt - (c.ttlSec || 0) * 1000
      const ageSec = Math.max(0, Math.floor((t - createdAt) / 1000))
      // 严格大于：等于门槛不收（避免"刚好 600s"这种边界上的口角）。
      if (!(ageSec > olderThanSec)) continue
      // paths 限定：只考虑与给定路径相交的声明（与 release/blockers 同一套前缀重叠判据）。
      if (paths.length && !c.paths.some(cp => paths.some(p => ov(p, cp)))) continue
      hits.push(c)
    }
  }
  const entries = hits.map(c => {
    const createdAt = typeof c.createdAt === 'number' ? c.createdAt : c.expiresAt - (c.ttlSec || 0) * 1000
    const reasons = ['unexpired', 'agent-holder', 'not-self', 'holder-not-in-agents-list', 'age-over-threshold']
    if (paths.length) reasons.push('paths-intersect')
    return Object.assign(publish(c), {
      ageSec: Math.max(0, Math.floor((t - createdAt) / 1000)),
      remainingSec: Math.max(0, Math.ceil((c.expiresAt - t) / 1000)),
      olderThanSec,
      reasons
    })
  })
  const base = { olderThanSec, serverTime: t, livenessCheck: unknown ? 'unavailable' : 'ok' }
  if (!confirm) {
    // dry-run：**绝不改状态**（changed:false 让上层不会写盘）。
    return { ok: true, changed: false, state: s, data: Object.assign({ dryRun: true }, base, { candidates: entries }) }
  }
  if (!hits.length) {
    return { ok: true, changed: false, state: s, data: Object.assign({ dryRun: false }, base, { reaped: [] }) }
  }
  s.claims = s.claims.filter(c => !hits.includes(c))
  return { ok: true, changed: true, state: s, data: Object.assign({ dryRun: false }, base, { reaped: entries }) }
}

// 续租。a = {claimId}。
export function heartbeat(state: StateDocument, h: HolderInput, a: HeartbeatInput, tNow: Clock): OpResult {
  const c = state.claims.find(x => x.claimId === a.claimId)
  if (!c) return { ok: false, changed: false, state, tNow, data: { error: 'not-found', message: 'no claim ' + a.claimId } }
  if (c.holderId !== h.holderId) return { ok: false, changed: false, state, tNow, data: { error: 'forbidden', message: 'only holder can heartbeat' } }
  c.expiresAt = tNow() + (c.ttlSec || 1800) * 1000
  return { ok: true, changed: true, state, tNow, data: { claimId: c.claimId, expiresAt: c.expiresAt, serverTime: tNow() } }
}

// 发消息。a = {body, channel?, mentions?, replyTo?}。
export function post(state: StateDocument, h: HolderInput, a: PostInput, tNow: Clock): OpResult {
  const body = typeof a.body === 'string' ? a.body.trim() : ''
  if (!body) return { ok: false, changed: false, state, tNow, data: { error: 'bad-request', message: 'body required' } }
  holder(state, h, h.name, tNow)
  const m: Message = { msgId: 'm_' + (++state.seq), seq: state.seq, channel: (typeof a.channel === 'string' && a.channel.trim()) ? a.channel.trim() : 'general', author: h.holderId, ts: tNow(), body, mentions: Array.isArray(a.mentions) ? a.mentions.filter(x => typeof x === 'string').slice(0, 20) : [] }
  if (typeof a.replyTo === 'string' && a.replyTo) m.replyTo = a.replyTo
  state.messages.push(m)
  return { ok: true, changed: true, state, tNow, data: { msgId: m.msgId, seq: state.seq, ts: m.ts } }
}

// 按 holder 分组的占用全景。holder 的 mode 在多条声明不一致时聚合为 'mixed'。
export function overview(state: StateDocument): OverviewResult {
  const byHolder: Record<string, { holderId: string; holderName: string; claims: PublishedClaim[] }> = {}
  for (const c of state.claims) {
    const k = c.holderId
    if (!byHolder[k]) byHolder[k] = { holderId: k, holderName: c.holderName || k, claims: [] }
    byHolder[k].claims.push(publish(c))
  }
  return { totalClaims: state.claims.length, holders: Object.keys(byHolder).map(k => { const h = byHolder[k]; const modes = [...new Set(h.claims.map(c => c.mode))]; return { holderId: h.holderId, holderName: h.holderName, claimCount: h.claims.length, mode: modes.length === 1 ? modes[0] : 'mixed' as const, paths: h.claims.flatMap(c => c.paths), claims: h.claims } }) }
}

// 查询与给定路径相关的声明。
export function related(state: StateDocument, paths: string[]): Claim[] {
  return state.claims.filter(c => paths.some(p => c.paths.some(cp => ov(p, cp))))
}

// 筛选消息（channel / since / limit）。total 是筛选前的总条数，便于调用方判断是否有更早历史。
export function filterMessages(state: StateDocument, a: ReadInput): FilterMessagesResult {
  const since = Number(a.since) || 0, limit = Math.max(1, Math.min(200, Number(a.limit) || 50))
  let l = state.messages
  if (typeof a.channel === 'string' && a.channel.trim()) l = l.filter(m => m.channel === a.channel.trim())
  const matched = l.filter(m => m.seq > since)
  const returned = matched.slice(-limit)
  return { since, returned: returned.length, total: matched.length, latestSeq: state.messages.length ? state.messages[state.messages.length - 1].seq : 0, messages: returned }
}

// 计算在当前时刻 blocking 的独占声明（供 wait）。
export function blockers(state: StateDocument, t: number, h: HolderInput, paths: string[]): Claim[] {
  return state.claims.filter(c => c.expiresAt > t && c.mode === 'exclusive' && c.holderId !== h.holderId && c.paths.some(cp => paths.some(p => ov(p, cp))))
}
