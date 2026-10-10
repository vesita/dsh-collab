// collab-core.ts
// 多智能体协作插件的纯逻辑唯一事实源（JSON Schema v1 契约见 src/schema/collab.schema.json）。
// 不依赖 fs/ctx/sessions，只操作 state 对象；时间通过可选参数注入以便测试。
// 这是可 import、可测试、可被未来 CLI / Python / Rust 对照复用的实现层。
// 注意：Cordis 动态插件的 code.host 不接受 import，所以本模块的**构建产物**
// （lib/collab-core.js）会被 scripts/build-host.mjs 原样内联进 src/host-shell.js 的
// /*__COLLAB_CORE__*/ 位置，生成动态宿主形态的 hostCode。改这里 = 两形态同时改
//（tests/collab-inline-parity.mjs 断言内联区与 lib/collab-core.js 去 export 后逐字节一致）。

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
  /**
   * **会话家族**（血缘）的 holderId 集合：自己 + 祖先链 + 后代。由上层
   * （store.familyIds）从运行时现算，**不落盘** —— `holder()` 只挑已知字段写进状态文件。
   *
   * 缺省（纯逻辑语料、受限宿主拿不到血缘）时判据退化为"只看 holderId 是否相等"，
   * 也就是 0.9.10 的行为：既有语料与既有语义一字不变。
   */
  family?: string[]
  /**
   * **写这一行的进程身份令牌**（0.14.0，B2）：形如 `<pid>:<开机节拍>`，由接线层从
   * `/proc/<pid>/stat` 现算。**它决定名册行的生死**：`sweep()` 只保留「有未过期声明」
   * 或「写它的那个进程还活着」的行 —— 于是进程一被杀（本机 harness 重启就是 SIGKILL 整条
   * cgroup，既没有 `agent/status` 也没有 `agent/disposed`），它留下的名册行在下一次 sweep
   * 就消失，不必再等 24h 计时器。
   *
   * 缺省（纯逻辑语料、受限宿主拿不到进程身份）⇒ 该行退回 24h TTL 老口径，一字不变。
   * **只影响名册行**：声明（claim）的回收仍然只由租约 `expiresAt` 决定（W7 未动）。
   */
  proc?: string
}

/**
 * 家族判据（纯逻辑，两形态同源）：`holderId` 是否属于本 holder 的会话家族。
 *
 * 为什么需要它：子代理运行在**自己的会话**里，`holderId` 是 `agent:<子会话 id>`，
 * 与父会话不等 —— 于是"父会话 claim src/ 再派子代理改 src/"时，子代理被自己的锁
 * 硬拒绝（本部署 ask = deny），而且它无权释放（只有持有者本人能 release）。
 * 父子是同一个写域，锁不该拦自家人。血缘从 `session.header.parentSession` 现算。
 */
export function inFamily(h: HolderInput, holderId: string): boolean {
  if (holderId === h.holderId) return true
  return Array.isArray(h.family) && h.family.indexOf(holderId) >= 0
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
  replyTo?: string
}

/** board read 操作的输入参数。 */
export interface ReadInput {
  channel?: string
  /**
   * 游标。**复合值** `(seq, writer)`，序列化成 `"<seq>@<writer>"`；
   * 数字是向后兼容写法，解释为 `(seq, "")`（见 parseCursor）。省略或 0 = tail 模式。
   */
  since?: number | string
  limit?: number
}

/** sweep 的可选上限覆盖（默认 MAX_MESSAGES / MAX_MESSAGES_BYTES / HOLDER_TTL_MS）。 */
export interface SweepOptions {
  maxMessages?: number
  /** 留言总量的字节预算（默认 MAX_MESSAGES_BYTES）。口径见该常量的注释。 */
  maxMessagesBytes?: number
  holderTtlMs?: number
  staleWarnMs?: number
  /**
   * 名册行的进程判据（0.14.0，B2）：**此刻还活着**的进程令牌集合。
   * `null`（或缺省）= 判据不可用（非 Linux / 读不到 /proc）⇒ 带 `proc` 的行一个也不收
   * （fail-closed：漏收只是维持现状）。只有真正的 `Set` 才允许按它删行。
   */
  liveProcs?: Set<string> | null
  /**
   * 本形态**能**给名册行盖进程章（0.14.0，B2）。只有接线层确认 `proc` 一定写得上去时才传
   * `true`；传 `true` 时没有 `proc` 的行一律作废（升级前留下的旧行 —— 下一次操作自动重新登记）。
   * 拿不到进程身份的形态（受限动态宿主里 `process` 是 undefined）**必须不传**，否则会把活会话的行
   * 反复删掉。
   */
  procStamping?: boolean
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

/**
 * filterMessages 的返回结构。
 *
 * `total` 是本次筛选（channel + since）命中的总条数；`latestSeq` / `earliestSeq` 是**可用窗口**的
 * 上下界，两者**同范围**（都只按 channel 收窄、不看 since）—— 一个全局一个按筛选，会让按频道读的
 * 调用方以为自己永远没追平。`hasMore` / `nextSince` 是 0.13.0 加的**追平出口**：把 `nextSince`
 * 当下一次 read 的 `since`，循环到 `hasMore === false` 即可**无损**追平 —— 裸 seq 游标按
 * **seq 严格大于**匹配（游标一定前进），且分页**从不切开同一个 seq 组**（所以也不会漏掉撞 seq 的
 * 那一位）。`limit` 因此是软上限：一页可能短于它，单组大于它时整组返回。
 */
export interface FilterMessagesResult {
  since: number
  /** tail = 不给游标时读最新 limit 条；forward = 给了 since>0 时从游标往后读。 */
  mode: 'tail' | 'forward'
  returned: number
  total: number
  /** 这个筛选范围（只按 channel 收窄）内**最新**一条的 seq，与 `earliestSeq` 同范围（0 = 一条都没有）。 */
  latestSeq: number
  /** 沿本模式的方向还有更多没返回。 */
  hasMore: boolean
  /** 下一次 read 的游标：本次返回的最后一条的 seq（一条都没返回时原样回传 since）。数字游标按 seq **严格大于**匹配，故翻页一定前进。 */
  nextSince: number
  /**
   * 本次输入游标的**归一化复合形式** `<seq>@<writer>`。
   * 数字入参（老调用方）归一化后 writer 为空串，即 `"5@"`。
   */
  cursor: string
  /**
   * 下一次 read 的**复合**游标 `<seq>@<writer>`：本次返回的最后一条的位置；
   * 一条都没返回时原样回传输入游标。**无损翻页用它**（`nextSince` 在 seq 相撞时
   * 不足以定位到"读到哪了"，会把同 seq 的另一位写者的记录再送一遍）。
   */
  nextCursor: string
  /** 这个筛选范围（只按 channel 收窄）内**还留着**的最旧一条的 seq（0 = 一条都没有）。`since < earliestSeq` ⇒ 中间那段已被 MAX_MESSAGES 回收。 */
  earliestSeq: number
  messages: Message[]
  /** 只在「给了 channel 但一条都没命中，且板里确实有消息」时出现：列出**现有频道**。 */
  channelNote?: string
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

// ---- 收敛层（单元 C）：写者戳、Lamport 序、半格 join ----
//
// 病根（2026-10 实测）：状态文件用 replaceIfVersion 写，而它是 probe → rename；dsh-fs-local 的
// 串行化锁是**实例字段**（只在本进程内排队）⇒ 两个写者可以同时 probe 到同一个 version、各自
// rename 都成功，后写者静默覆盖先写者（64MB 内容拉开窗口 + 文件屏障对齐，4/4 轮双成功 = 丢更新）。
// 本单元不再靠锁，改成让状态本身**可收敛**：合并是半格 join —— 取两份副本并进来，谁也不丢。
//
// 三条不变量（由 tests/collab-convergence.mjs 正面验证）：
//   1. `mergeDocs(a, b)` 是 join：交换律 / 结合律 / 幂等律（规范形见 `normalizeDoc`）；
//   2. 记录 id 全局唯一：`c_<seq>@<writer>` / `m_<seq>@<writer>` —— 两个写者撞上同一个 seq
//      也不会撞 id（Lamport 时钟只保证"不小于所见最大值"，唯一性靠写者戳）；
//   3. 游标是 `(seq, writer)` 复合值：只给数字时解释为 `(n, "")`，**不漏**（至多重送同 seq 那批）。
//
// 终态（release）不是"从数组里删掉"，而是记进 `released` 墓碑表：
// 删除在 join 下**不单调** —— 另一份旧副本会把记录带回来；墓碑才单调（有墓碑就赢）。
// `claims` 因此仍然只含**有效**记录，于是门控（gate / host-shell）与全部视图一个字都不用改。
//
// 墓碑的 GC 规则必须是**确定性**的（否则两个副本收敛不到同一处）：墓碑值 `<= t` 时丢掉。
// 墓碑值本身取 `max(现有值, claim.expiresAt, 释放时刻 + ttlSec)`（单元 D）：只取原 expiresAt
// 会被一条**并发续租**（释放之后才合并进来、expiresAt 更大）绕过 —— 墓碑先到期被 GC、那条
// 声明重新具备权威。表本身还有确定性上限 `MAX_RELEASED`（单元 D，见 sweep）。

/** 一个文档的写者戳（写这份文档的进程身份）。缺字段（老状态文件）归一为空串。 */
export function writerOf(s: StateDocument | null | undefined): string {
  return s && typeof s.writer === 'string' ? s.writer : ''
}

/** `(seq, writer)` 全序：先 seq（数字），再 writer（字符串）。游标与记录排序共用这一条判据。 */
export function compareSeqWriter(aSeq: unknown, aWriter: unknown, bSeq: unknown, bWriter: unknown): number {
  const x = Number(aSeq) || 0, y = Number(bSeq) || 0
  if (x !== y) return x < y ? -1 : 1
  const aw = typeof aWriter === 'string' ? aWriter : ''
  const bw = typeof bWriter === 'string' ? bWriter : ''
  if (aw === bw) return 0
  return aw < bw ? -1 : 1
}

/**
 * 记录 id：`<prefix><seq>@<writer>`。
 * 没有写者戳时（纯逻辑语料、0.16.0 之前写下的老记录）退回老形状 `<prefix><seq>`
 * —— 老语料与老断言因此一字不变；生产路径上写者戳恒非空，id 因此全局唯一。
 */
export function recordId(prefix: string, seq: number, writer: unknown): string {
  const w = typeof writer === 'string' ? writer : ''
  return prefix + seq + (w ? '@' + w : '')
}

// ---- 逐记录 / 逐字段的 join ----
//
// 每一类记录都在**每个字段**上各自取一个 join（取大 / 取小 / 求并），而不是"整条记录二选一"。
// 为什么必须逐字段：整条二选一不是 join —— 当两份记录的排序键不同时，"取键大的那条"会丢掉
// 另一份独有的字段更新（并发续租的 expiresAt、并发登记的 readers），而且取键大的**不满足
// 结合律**（a > b 时丢掉 b 的信息，再与 c 合并时的结果与先合并 b、c 不同）。逐字段则天然是
// 积格（product lattice）：每个字段各自满足交换/结合/幂等 ⇒ 整个合并满足。

/** 数字取大；缺省当 0（`undefined` 视为该字段的底）。 */
function joinMaxNum(a: unknown, b: unknown): number { return Math.max(Number(a) || 0, Number(b) || 0) }

/** 数字取小；缺省当 0。用于 createdAt（创建时刻只能"更早"，不能被后到的副本推后）。 */
function joinMinNum(a: unknown, b: unknown): number { return Math.min(Number(a) || 0, Number(b) || 0) }

/** 字符串取大（字典序）；`undefined` 是底，有值的一方胜出。 */
function joinMaxStr(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return a >= b ? a : b
}

/** 可选布尔取"与"（false 优先 = 更严格的可见性不会被翻松）。 */
function joinAndBool(a: boolean | undefined, b: boolean | undefined): boolean | undefined {
  if (a === undefined && b === undefined) return undefined
  return a !== false && b !== false
}

/** 字符串集合求并，按字典序排 —— 规范序是交换律/结合律的一部分（数组顺序不能带进结果）。 */
function joinStrSet(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined && b === undefined) return undefined
  const out: string[] = []
  for (const x of (a || []).concat(b || [])) if (typeof x === 'string' && !out.includes(x)) out.push(x)
  out.sort()
  return out
}

/** 可选数字取大；两边都缺省时保持缺省（不凭空造字段，否则幂等律的"规范形"就不唯一）。 */
function joinOptNum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(Number(a) || 0, Number(b) || 0)
}

/** 声称的逐字段 join（同 claimId 的两份）。 */
function joinClaim(a: Claim, b: Claim): Claim {
  const out: Claim = {
    claimId: a.claimId,
    holderId: joinMaxStr(a.holderId, b.holderId) || '',
    paths: joinStrSet(a.paths, b.paths) || [],
    mode: ((joinMaxStr(a.mode, b.mode) || a.mode || b.mode) || 'exclusive') as Mode,
    ttlSec: joinMaxNum(a.ttlSec, b.ttlSec),
    expiresAt: joinMaxNum(a.expiresAt, b.expiresAt),
    createdAt: joinMinNum(a.createdAt, b.createdAt)
  }
  const holderName = joinMaxStr(a.holderName, b.holderName)
  if (holderName !== undefined) out.holderName = holderName
  const note = joinMaxStr(a.note, b.note)
  if (note !== undefined) out.note = note
  const readable = joinAndBool(a.readable, b.readable)
  if (readable !== undefined) out.readable = readable
  const readers = joinStrSet(a.readers, b.readers)
  if (readers !== undefined) out.readers = readers
  const seq = joinOptNum(a.seq, b.seq)
  if (seq !== undefined) out.seq = seq
  const writer = joinMaxStr(a.writer, b.writer)
  if (writer !== undefined) out.writer = writer
  return out
}

/** 留言的逐字段 join（同 msgId 的两份；生产里内容逐字节相同，这里只求"确定且成律"）。 */
function joinMessage(a: Message, b: Message): Message {
  const out: Message = {
    msgId: a.msgId,
    seq: joinMaxNum(a.seq, b.seq),
    channel: joinMaxStr(a.channel, b.channel) || a.channel || b.channel || 'general',
    author: joinMaxStr(a.author, b.author) || a.author || b.author || '',
    ts: joinMaxNum(a.ts, b.ts),
    body: joinMaxStr(a.body, b.body) || a.body || b.body || ''
  }
  const replyTo = joinMaxStr(a.replyTo, b.replyTo)
  if (replyTo !== undefined) out.replyTo = replyTo
  const writer = joinMaxStr(a.writer, b.writer)
  if (writer !== undefined) out.writer = writer
  return out
}

/** 名册行的逐字段 join（同 holderId 的两份；lastSeenAt 取大，进程章有值者胜出）。 */
function joinHolder(a: Holder, b: Holder): Holder {
  const out: Holder = {
    holderId: a.holderId,
    name: joinMaxStr(a.name, b.name) || '',
    kind: ((joinMaxStr(a.kind, b.kind) || a.kind || b.kind) || 'agent') as Holder['kind']
  }
  const sessionId = joinMaxStr(a.sessionId, b.sessionId)
  if (sessionId !== undefined) out.sessionId = sessionId
  const lastSeenAt = joinOptNum(a.lastSeenAt, b.lastSeenAt)
  if (lastSeenAt !== undefined) out.lastSeenAt = lastSeenAt
  const proc = joinMaxStr(a.proc, b.proc)
  if (proc !== undefined) out.proc = proc
  return out
}

/** 按 id 把一组记录折叠成逐字段 join（同一 id 的多份全部并进来，不是二选一）。 */
function foldBy<T>(rows: T[], idOf: (x: T) => string, join: (a: T, b: T) => T): T[] {
  const at = new Map<string, number>()
  const out: T[] = []
  for (const x of rows) {
    if (!x || typeof x !== 'object') continue
    const id = idOf(x)
    if (!id) continue
    const i = at.get(id)
    if (i === undefined) { at.set(id, out.length); out.push(join(x, x)) }
    else out[i] = join(out[i], x)
  }
  return out
}

/**
 * 规范形：把任意（可能缺字段、可能是老布局的）文档补成 mergeDocs 的输入/输出形状。
 *
 * 规范化包含四件事：① 标量补默认；② 同 id 的记录逐字段 join 折叠（重复 id 不丢字段）；
 * ③ 剔除墓碑表里那些 id 的声明；④ 全部数组按**确定性顺序**排序（claims/messages 按
 * `(seq, writer)` 再按 id，holders 按 holderId，记录内的 paths/readers 按字典序）。
 *
 * **它就是幂等律里的"规范形"**：`mergeDocs(a, a)` 逐字段等于 `normalizeDoc(a)` —— 因为
 * mergeDocs 的输出本来就是"对 a 与 b 的所有记录逐字段 join 后再规范化"。
 */
export function normalizeDoc(s: StateDocument | null | undefined): StateDocument {
  const src = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
  const released: Record<string, number> = {}
  const rawRel = src.released
  if (rawRel && typeof rawRel === 'object' && !Array.isArray(rawRel)) {
    // 键也要**规范序**（排序）：否则同一组墓碑因插入顺序不同会序列化成不同文本，
    // 而"合并是 join"要能被逐字节比较（见 mergeDocs 的注释）。
    for (const id of Object.keys(rawRel as Record<string, unknown>).sort()) {
      if (!id) continue
      released[id] = Number((rawRel as Record<string, unknown>)[id]) || 0
    }
  }
  const rawClaims = Array.isArray(src.claims) ? (src.claims as Claim[]) : []
  const claims = foldBy(rawClaims, c => (typeof c.claimId === 'string' ? c.claimId : ''), joinClaim)
    .filter(c => !(c.claimId in released))
  claims.sort((x, y) => compareSeqWriter(x.seq, x.writer, y.seq, y.writer) || (x.claimId < y.claimId ? -1 : x.claimId > y.claimId ? 1 : 0))
  const rawMessages = Array.isArray(src.messages) ? (src.messages as Message[]) : []
  const messages = foldBy(rawMessages, m => (typeof m.msgId === 'string' ? m.msgId : ''), joinMessage)
  messages.sort((x, y) => compareSeqWriter(x.seq, x.writer, y.seq, y.writer) || (x.msgId < y.msgId ? -1 : x.msgId > y.msgId ? 1 : 0))
  const rawHolders = Array.isArray(src.holders) ? (src.holders as Holder[]) : []
  const holders = foldBy(rawHolders, h => (typeof h.holderId === 'string' ? h.holderId : ''), joinHolder)
  holders.sort((x, y) => (x.holderId < y.holderId ? -1 : x.holderId > y.holderId ? 1 : 0))
  return {
    schemaVersion: 1,
    seq: Number(src.seq) || 0,
    writer: typeof src.writer === 'string' ? src.writer : '',
    claims, messages, holders, released
  }
}

/** 墓碑表求并：同一个 claimId 取**较大**的 expiresAt（join）。 */
function mergeReleased(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const src of [a, b]) {
    for (const id of Object.keys(src)) {
      const v = Number(src[id]) || 0
      const cur = out[id]
      out[id] = cur === undefined || v > cur ? v : cur
    }
  }
  return out
}

/** 墓碑表上限（单元 D）：按 `(墓碑值, claimId)` 保留最大的 N 条，其余（最接近自己到期的）丢掉。
 *  N 取 4096 的理由：墓碑最多活到"释放时刻 + ttl"（ttl 上限 24h），一次释放只产生一条，4096 条
 *  仍在 KB 级，只在异常密集的释放下才生效。规则**只看数据**（值 + claimId），不看插入顺序，
 *  两个副本 GC 出同样结果 —— 否则不收敛。与 Rust 的 `MAX_RELEASED` 同值、同规则。 */
export const MAX_RELEASED: number = 4096

/** 给若干条声明立墓碑 —— **所有**把声明从 `claims` 里拿掉的路径都必须走这里，否则"删掉"在
 *  join 下不单调，会被旧副本翻案。只加不减、同键取 max，所以它本身也是单调的。
 *
 *  墓碑值（单元 D）= `max(现有值, claim.expiresAt, t + ttlSec*1000)`。第三项堵住一个真实边角：
 *  若有一条**并发续租**在释放之后才被合并进来，它的 `expiresAt` 可以大于原 `expiresAt`；只取原值
 *  的话，墓碑按自己的到期被 GC 之后那条声明会**重新具备权威**（同一个 holder 有两个进程在写
 *  —— 会话被恢复的现场）。取"释放时刻 + ttl"把整段可能的续租窗口盖住，那时的声明必然已过期。 */
function bury(s: StateDocument, claims: Claim[], t: number): void {
  if (!Array.isArray(claims) || !claims.length) return
  if (!s.released || typeof s.released !== 'object') s.released = {}
  for (const c of claims) {
    if (!c || typeof c.claimId !== 'string' || !c.claimId) continue
    const exp = Math.max(Number(c.expiresAt) || 0, t + (Number(c.ttlSec) || 0) * 1000)
    const cur = s.released[c.claimId]
    s.released[c.claimId] = cur === undefined || exp > cur ? exp : cur
  }
}

/**
 * **半格 join**：`mergeDocs(a, b)` = a 与 b 的最小上界。
 *
 * 实现只有两步：把两边的记录**直接拼接**，再交给 `normalizeDoc`（它按 id 逐字段 join 折叠、
 * 剔除墓碑、排成规范序）。于是三条律由构造保证，而不是靠逐例验证：
 *   · 交换律 —— 拼接的顺序不影响结果（逐字段 join 与排序都与顺序无关）；
 *   · 结合律 —— 逐字段 join 结合，而"折叠 + 规范化"是这组 join 的一个截面；
 *   · 幂等律 —— `mergeDocs(a, a)` = 对 a 的记录各自自并 = `normalizeDoc(a)`。
 *
 * 分量语义：`seq` 取 max（Lamport：不小于两边所见最大）；`writer` 取字典序 max（只为确定性，
 * 写盘前由写路径盖上**本次写者**的戳）；`released` 求并（墓碑单调：一旦终态就永远终态，
 * 因此"已释放"不会被还握着旧副本的写者翻案）；claims/messages/holders 按 id 逐字段 join
 * （见 joinClaim / joinMessage / joinHolder）。输出是规范序，可直接逐字节比较。
 */
export function mergeDocs(a: StateDocument, b: StateDocument): StateDocument {
  const A = normalizeDoc(a), B = normalizeDoc(b)
  return normalizeDoc({
    schemaVersion: 1,
    seq: joinMaxNum(A.seq, B.seq),
    writer: joinMaxStr(A.writer, B.writer) || '',
    claims: (A.claims || []).concat(B.claims || []),
    messages: (A.messages || []).concat(B.messages || []),
    holders: (A.holders || []).concat(B.holders || []),
    released: mergeReleased(A.released || {}, B.released || {})
  })
}

/** 复合游标 `(seq, writer)`：按这个位置读"严格在其后"的记录。 */
export interface Cursor { seq: number; writer: string; bare?: boolean; explicit?: boolean }

/**
 * 解析游标。**裸 seq**（`number`，或没有 `@` 的字符串）⇒ `(n, "")` 且标记 `bare`：按
 * **seq 严格大于 n** 匹配（= 老语义 `seq > n`），因此把 `nextSince` 当下一次 `since` 的翻页循环
 * **一定前进**。旧实现一律按复合全序比较，而 0.17 起记录都带写者戳，`(n, "")` 会把 seq 恰好为 n 的
 * 那条**永远再送一遍**（现场实测：`since=379` 又返回 m_379、`nextSince` 仍是 379 ⇒ 死循环）。
 * **复合**写法 `"<seq>@<writer>"`（= 返回的 `nextCursor`）⇒ 原样、按复合全序比较，seq 相撞时也定位得到。
 * 无法解析（空串、乱写）⇒ `(0, "")`（= tail 模式）。**绝不抛**：游标是输入，不是不变量。
 */
export function parseCursor(v: unknown): Cursor {
  if (typeof v === 'number' && Number.isFinite(v)) return { seq: Math.max(0, Math.floor(v)), writer: '', bare: true }
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s) return { seq: 0, writer: '' }
  const at = s.indexOf('@')
  if (at < 0) {
    const n = Number(s)
    if (!Number.isFinite(n) || n < 0) return { seq: 0, writer: '' }
    return { seq: Math.floor(n), writer: '', bare: true }
  }
  const n = Number(s.slice(0, at))
  if (!Number.isFinite(n) || n < 0) return { seq: 0, writer: '' }
  // 含 `@` 的复合写法 = 一个**位置**（哪怕 seq 是 0）⇒ 模式按"给了位置"判定为 forward，
  // 于是 `"0@"` 就是"从头读"，而 `0`/省略仍是 tail。模式不再由数值**大小**决定。
  return { seq: Math.floor(n), writer: s.slice(at + 1), explicit: true }
}

/** 把游标序列化成磁盘/返回值上的形状：`"<seq>@<writer>"`。 */
export function cursorKey(c: Cursor): string { return c.seq + '@' + c.writer }

export function init(): StateDocument { return { schemaVersion: 1, seq: 0, writer: '', claims: [], messages: [], holders: [], released: {} } }

// 状态膨胀上限：留言保留最近 MAX_MESSAGES 条，holder 在无活跃声明且 24h 未出现时回收。
// 两者都由 sweep() 在每次读/写前惰性执行，保证状态文件不会无限增长。
export const MAX_MESSAGES: number = 2000
// **单条**留言正文的字符上限（0.14.0，M2b）。为什么需要它：`MAX_MESSAGES` 只封**条数**，
// 而 `body` 在契约里此前只有 `minLength: 1` —— 一条任意大的正文 × 2000 条 = **任意大**
// （实测一条 5MB 的 body 原样落盘，`sweep()` 也不会缩小它）。
// 取 8000 的理由：够写一条长留言（现场溢出的几十 KB 都发生在 `read` 的**结果**里，
// 不在单条 `post`），× 2000 条上限 ⇒ 最坏约 16MB，而不是"任意大"。
// 超限由 `post()` **显式挡回**（`bad-request`），**绝不静默截断** —— 截断会悄悄改掉调用方的话。
// 口径：按 `body.length`（UTF-16 单元）计，对星平面字符比 JSON Schema 的 `maxLength` 更严。
export const MESSAGE_BODY_MAX_CHARS: number = 8000
// 留言**总量**的字节预算（0.15.0，R2）。为什么除了条数还要封字节：`MAX_MESSAGES = 2000` 条
// × 每条上限 8000 字符，最坏仍约 2 MB；真实状态文件的 97% 就是留言（实测 82,248 B 里 79,815 B）。
// 两者**取先到者**，超出都从**最旧**开始丢（同一个方向，`swept.droppedMessages` 如实报数）。
// 口径：**每条留言的 JSON 序列化的 UTF-8 字节之和**（不含数组的方括号与逗号，也不含外层
// `{schemaVersion, seq, messages}` 的键名），即"要落进旁挂文件的正文量"，不是文件总字节数。
// 一条留言的正文另有 `MESSAGE_BODY_MAX_CHARS` 的硬上限，所以单条不可能大到把预算一口吃光。
export const MAX_MESSAGES_BYTES: number = 256 * 1024

/**
 * 一个字符串的 UTF-8 字节数。**刻意不用 `Buffer` / `TextEncoder`**：本模块会被原样内联进
 * 受限动态宿主（见 src/host-shell.js 的文件头），那里只有纯 JS 全局。
 * 代理对（星平面字符）按 4 字节计，与 `Buffer.byteLength(s, 'utf8')` 同口径。
 */
function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++ } else n += 3
    } else n += 3
  }
  return n
}

/** 一条留言在磁盘上的字节量口径（见 MAX_MESSAGES_BYTES）。序列化失败按 0 计（数据来自 JSON.parse，不会有环）。 */
export function messageBytes(m: Message): number {
  try { return utf8Bytes(JSON.stringify(m)) } catch (e) { return 0 }
}
export const HOLDER_TTL_MS: number = 24 * 60 * 60 * 1000
// 时钟偏移容忍：lastSeenAt 落在未来超过该窗口的 holder 视为不可信并回收。
// 只回收 holder 记录；声明仍按各自的 expiresAt 判定，锁语义不受影响。
export const HOLDER_FUTURE_SKEW_MS: number = 5 * 60 * 1000
// stale 预警阈值：holder 无活跃声明且静默超过该时长即报 stale=true。
// 它**小于**回收阈值（24h），所以 stale 是"看起来已废弃"的先行信号，而不是"马上会被删"的同义词；
// 若与回收同阈值，在"先 sweep 再取视图"的产品路径上该字段恒为 false（死信号）。
export const HOLDER_STALE_WARN_MS: number = 60 * 60 * 1000
// 名册行的**显示**上限（0.14.0，C）。为什么要有界：`list` 过去逐条返回整份名册，
// 现场实测 56 行 / 约 10 KB 一次；而每一步都注入的态势摘要早就把 claims 压到
// 「最多 3 条 × 每条 2 个路径」（见 renderDigest）。同一份"输出必须与注入频率同量级"的
// 纪律，名册这边漏了一半。
// 截断**不丢事实**：调用方始终能拿到 `holdersTotal`，自己看得出被折叠了。
export const HOLDER_VIEW_LIMIT: number = 12

// holder 是否仍算"新鲜"：age 落在 [-HOLDER_FUTURE_SKEW_MS, holderTtlMs) 内。
// sweep 的回收判据与 holderView 的 stale 判据共用这一个函数，二者不会再出现"口径不一致"。
export function holderFresh(lastSeenAt: number | undefined, t: number, holderTtlMs: number = HOLDER_TTL_MS): boolean {
  const age = t - (lastSeenAt || 0)
  return age < holderTtlMs && age > -HOLDER_FUTURE_SKEW_MS
}

// 惰性清理：过期声明 + 超额留言 + 陈旧 holder。
// 返回各类清理数量，供上层附带诊断信息。
//
// **名册行（holder）的回收判据（0.14.0 改写）** —— 旧实现只有一条：`active || 静默 < 24h`，
// 于是"会话句柄已经结束"这件事对名册毫无影响：0.13.0 的 `agent/disposed` 只释放声明，
// 现场实测 4/4 条已 dispose 的 holder 行照样留着，直到 24h 计时器把它们扫走
// （docs/collab-ux-backlog.md §2.24 / §2.27）。现在的判据是**两条终结路径**，都不靠计时器：
//   1. `dropHolder()`：句柄结束（`agent/disposed`）⇒ 行与它的过期声明一起消失；
//   2. `proc`：行上盖着写它的那个进程的身份令牌；这个进程不在了 ⇒ 行下一次 sweep 就走。
//     —— 这一条覆盖第 1 条覆盖不到的"进程被杀"（没有 dispose 事件可等）。
// 仍然保留的兜底只有一种：**行上没有 `proc`**（升级前的旧行，或该形态拿不到进程身份）。
// 此时若接线层声明 `procStamping: true`（本形态确实在盖章）⇒ 旧行直接作废，下一次操作重新登记；
// 否则退回 24h TTL 老口径。判据**只缩不放**：没有任何一条会让行活得更久。
export function sweep(s: StateDocument, t: number, opts: SweepOptions = {}): SweepResult {
  const maxMessages = Number.isInteger(opts.maxMessages) && opts.maxMessages > 0 ? opts.maxMessages : MAX_MESSAGES
  const maxMessagesBytes = Number.isInteger(opts.maxMessagesBytes) && opts.maxMessagesBytes > 0 ? opts.maxMessagesBytes : MAX_MESSAGES_BYTES
  const holderTtlMs = Number.isInteger(opts.holderTtlMs) && opts.holderTtlMs >= 0 ? opts.holderTtlMs : HOLDER_TTL_MS
  // 只有真正的 Set 才算"判据可用"；null / undefined 一律降级（见 SweepOptions.liveProcs）。
  const liveProcs: Set<string> | null = opts.liveProcs instanceof Set ? opts.liveProcs : null
  const procStamping = opts.procStamping === true

  const beforeClaims = s.claims.length
  s.claims = s.claims.filter(c => c.expiresAt > t)
  const expiredClaims = beforeClaims - s.claims.length
  // 终态墓碑的**确定性** GC（见收敛层注释）：墓碑值 `<= t` ⇒ 丢掉墓碑。
  // 判据只看"数据里的墓碑值"与传入的 t，不看本地计数/插入顺序/随机 —— 同一份数据
  // 在任何副本上得到同一结果。丢掉的那一刻起，任何副本上的那条记录都已过期、在所有视图里
  // 不可见（gate 与 list/overview/wait 都按 expiresAt 过滤），复活它无害。
  const rel = s.released
  if (rel && typeof rel === 'object') {
    for (const id of Object.keys(rel)) if (!(Number(rel[id]) > t)) delete rel[id]
    // 墓碑表**有界**（单元 D）：超过 MAX_RELEASED 条时，按 (墓碑值, claimId) 保留最大的那些、
    // 丢最旧的。规则只看数据，不看插入顺序 ⇒ 两个副本 GC 出同样结果（收敛的前提）。
    // 被丢的是"最接近自己到期"的那些（值最小），丢它们只会让本就要到期的墓碑早一点消失。
    const ids = Object.keys(rel)
    if (ids.length > MAX_RELEASED) {
      ids.sort((a, b) => ((Number(rel[b]) || 0) - (Number(rel[a]) || 0)) || (a < b ? 1 : a > b ? -1 : 0))
      for (const id of ids.slice(MAX_RELEASED)) delete rel[id]
    }
  }

  let droppedMessages = 0
  if (s.messages.length > maxMessages) {
    droppedMessages = s.messages.length - maxMessages
    s.messages = s.messages.slice(-maxMessages)
  }
  // 字节预算（0.15.0，R2）：与条数上限**同一个方向**（丢最旧），两者取先到者。
  // 从尾部往前累加到"再加一条就超预算"为止 —— 只扫被保留的那一段，不必先算全量。
  // 注意它是**硬**上限：极端情况下（单条留言自己就超预算）会把留言清空，
  // 因为"文件不无限增长"这条比"留住一条超大的正文"更硬；正常路径上到不了这一步
  // —— `post()` 的 MESSAGE_BODY_MAX_CHARS = 8000 已经把单条封死。
  if (s.messages.length) {
    let total = 0
    let keepFrom = s.messages.length
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const b = messageBytes(s.messages[i])
      if (total + b > maxMessagesBytes) { keepFrom = i + 1; break }
      total += b
      keepFrom = i
    }
    if (keepFrom > 0) {
      droppedMessages += keepFrom
      s.messages = s.messages.slice(keepFrom)
    }
  }

  const active = new Set(s.claims.map(c => c.holderId))
  const beforeHolders = s.holders.length
  s.holders = s.holders.filter(h => {
    if (active.has(h.holderId)) return true
    const proc = typeof h.proc === 'string' ? h.proc : ''
    if (proc) return liveProcs === null ? true : liveProcs.has(proc)
    // 没有进程身份：旧行，或本形态盖不了章。能盖章的形态直接作废它，否则退回 24h TTL。
    return procStamping ? false : holderFresh(h.lastSeenAt, t, holderTtlMs)
  })
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
// 动态宿主形态的 hostCode（构建时由 scripts/build-host.mjs 内联本模块生成）
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

// 稳定短句柄：从 holderId 取一段**不随会话标题变化**的短标识（会话 id 前 8 字符）。
// 为什么需要它：holderName 来自会话标题，而子代理会话的标题就是父 AI 那条 prompt 的开头。
// 实测（2026-10-06 复算，本机 my 项目文件）：35 个 holder 只有 14 种名字，其中一个名字占 10 份
// —— 名单认不出人（docs/collab-ux-backlog.md §2.3）。句柄来自 holderId，不随标题变。
// 8 字符是**短标识、不是身份保证**：它把该语料的重名全部分开（0 碰撞），
// 但两个不同 id 理论上仍可能撞上前 8 字符。
// 非 `agent:` 前缀，或前缀剥掉后为空（如 `agent:session-`）⇒ 返回空串，渲染侧据此不附句柄。
export function holderHandle(holderId?: string): string {
  const id = typeof holderId === 'string' ? holderId : ''
  if (id.slice(0, 6) !== 'agent:') return ''
  return id.slice(6).replace(/^session-/, '').slice(0, 8)
}

// 名单里的一项显示成 `名字#句柄`（名字缺失时 holderId 本身就是唯一标识，不再重复附句柄）。
export function holderLabel(holderId?: string, holderName?: string): string {
  if (typeof holderName !== 'string' || !holderName) return holderId || ''
  const handle = holderHandle(holderId)
  return handle ? holderName + '#' + handle : holderName
}

// `list` 的 holders 字段是**会话名册**（谁在这个项目上出现过），不是锁 —— 锁在 `claims`。
// 实测有人把名册里 32 条 stale 读成"32 把过期锁"，所以只要有 stale 条目就说明一句；
// 没有 stale 时返回 null，调用方**一个字段都不加**（与 otherProjects / teamTasks 同一降级纪律）。
export function holderRosterNote(staleHolders?: number): string | null {
  const n = Number(staleHolders)
  if (!Number.isFinite(n) || n <= 0) return null
  return 'holders 是会话名册，不是锁（锁在 claims）：其中 ' + n +
    ' 条 stale = 该 holder 已无未过期声明且静默超过 1 小时；静默超过 24 小时后由下一次 sweep 回收。'
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
    return holderLabel(c.holderId, c.holderName) + '（' + modeLabel(c.mode) + '）占用 ' + paths +
      '，租约 ' + mins + ' 分（' + start + '–' + clockUtc(c.expiresAt) + '）'
  })
  const more = ordered.length > 3 ? '；另有 ' + (ordered.length - 3) + ' 条' : ''
  return '[dsh-collab] 同项目其他会话当前占用：' + parts.join('；') + more + '。改动这些路径前请先执行 collab_lock op=wait 或用 collab_board 协商。'
}

// ---- 官方 Agent Teams 交叉预警（0.11.0）：只读团队任务的 advisory 写域 ----
//
// 定位（README「与官方 Agent Teams 的分工」）：官方管**树内**（成员派生 + 任务 DAG），
// 本插件管**树间**（同一 checkout 上的路径占用）。两边此前互不可见（backlog §2.21 实测）：
//   - 官方任务的 `writeScopes` 只是 advisory（`dsh-experimental-tool-agent-team/lib/index.js:23`），
//     没有任何写入门控读它；
//   - 团队成员的会话家族豁免让 teammate 既看不到 Lead 的 collab_lock，写门控也不拦它。
// 这里补的是**只读的交叉预警**：把官方**在跑任务**（status='in_progress'）的 writeScopes 当
// "advisory 占用"报给本插件一侧的态势摘要 / overview / claim 返回。**不改锁语义**：
// 这些数据永远不参与 blockers()/claimsCovering()/gate 的判定，只出现在输出侧与提示文本里。
// 服务缺席（未启用 agent-team）时上层返回 null，本插件的一切输出**一字不变**。
//
// 时间稳定性同样是硬约束（与 renderDigest 同因）：团队任务视图没有时间字段，渲染只依赖
// 任务集合与写域本身，所以同一组任务永远渲染同一串文本，不会击穿 DSH 的快照去重。

/** 官方 Agent Teams 任务的只读视图（本插件消费的最小面；字段名对齐 TeamTaskView）。 */
export interface TeamScopeTask {
  id: string
  /** 任务标题；仅用于渲染，缺省时空串。 */
  subject: string
  /** 官方状态；本插件只把 'in_progress' 当"在跑"。 */
  status: string
  /** 认领者名字（官方 TeamTaskView.ownerName）；无主时为 undefined。 */
  ownerName?: string
  /** 工作区相对路径前缀（官方 validation.js 已归一化，尾斜杠可能被剥掉）。 */
  writeScopes: string[]
}

/** 团队任务写域与 collab 路径的重叠（advisory 交叉预警；**不是**冲突判据）。 */
export interface TeamScopeOverlap {
  taskId: string
  subject: string
  /** 团队任务声明的写域。 */
  scope: string
  /** 与之重叠的 collab 路径（已归一化）。 */
  path: string
}

/**
 * 渲染"官方团队在跑任务的写域"为一行 advisory 文本；没有在跑任务时返回 null。
 * 有界（最多 3 条任务 × 3 个写域）且**无时间参数** —— 与 renderDigest 同一纪律。
 */
export function teamTaskScopeLine(tasks: TeamScopeTask[] | null | undefined): string | null {
  const rows = (Array.isArray(tasks) ? tasks : []).filter(t =>
    t && typeof t.id === 'string' && t.id && Array.isArray(t.writeScopes) && t.writeScopes.length > 0)
  if (!rows.length) return null
  const ordered = rows.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const parts = ordered.slice(0, 3).map(t => {
    const scopes = t.writeScopes.slice(0, 3).join(' ') + (t.writeScopes.length > 3 ? ' 等 ' + t.writeScopes.length + ' 条' : '')
    return t.id + (t.subject ? '（' + t.subject + '）' : '') + ' → ' + scopes
  })
  const more = ordered.length > 3 ? '；另有 ' + (ordered.length - 3) + ' 条' : ''
  return '[dsh-collab] 官方 Agent Teams 在跑任务的写域（advisory，非锁）：' + parts.join('；') + more + '。'
}

/**
 * 团队任务写域 × collab 路径的纯重叠计算（分段前缀，与 ov 同源）。
 * 输出**确定性排序 + 去重**，可直接进 JSON 返回（overview / claim 的 advisory 字段）。
 */
export function teamScopeOverlaps(tasks: TeamScopeTask[] | null | undefined, paths: string[] | null | undefined): TeamScopeOverlap[] {
  const ps: string[] = []
  for (const p of (Array.isArray(paths) ? paths : [])) { const n = norm(p); if (n && !ps.includes(n)) ps.push(n) }
  if (!ps.length) return []
  const seen = new Set<string>()
  const out: TeamScopeOverlap[] = []
  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    if (!t || typeof t.id !== 'string' || !t.id || !Array.isArray(t.writeScopes)) continue
    for (const scope of t.writeScopes) {
      const ns = norm(scope)
      if (!ns) continue
      for (const p of ps) {
        if (!ov(ns, p)) continue
        const key = t.id + '\u0000' + ns + '\u0000' + p
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ taskId: t.id, subject: t.subject || '', scope, path: p })
      }
    }
  }
  out.sort((a, b) => (a.taskId.localeCompare(b.taskId)) || (a.scope.localeCompare(b.scope)) || (a.path.localeCompare(b.path)))
  return out
}

/**
 * 反向预警文本：**团队任务的写域**与**外部会话的 collab 声明**重叠时提示一句。
 * 这是"官方读不到本插件声明"那条接缝上唯一能做到的一侧：本插件能同时看到两边，
 * 于是把重叠说给团队听（advisory，不改变任何门控）。没有重叠时返回 null。
 */
export function teamCrossWarnLine(tasks: TeamScopeTask[] | null | undefined, claims: Claim[] | null | undefined): string | null {
  const rows: Array<{ taskId: string; scope: string; path: string; holder: string }> = []
  const seen = new Set<string>()
  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    if (!t || typeof t.id !== 'string' || !t.id || !Array.isArray(t.writeScopes)) continue
    for (const scope of t.writeScopes) {
      const ns = norm(scope)
      if (!ns) continue
      for (const c of (Array.isArray(claims) ? claims : [])) {
        if (!c || !Array.isArray(c.paths)) continue
        let hit: string | null = null
        for (const p of c.paths) {
          const np = norm(p)
          if (np && ov(ns, np)) { hit = p; break }
        }
        if (hit === null) continue
        // 同一段注入文本里的第 4 行（摘要 + 团队写域行 + 交叉预警行一起进 systemPrompt.context）：
        // 它也必须用 holderLabel，否则同一段文本里一半带句柄、一半是裸标题残段。
        const holder = holderLabel(c.holderId, c.holderName)
        const key = t.id + '\u0000' + ns + '\u0000' + hit + '\u0000' + holder
        if (seen.has(key)) continue
        seen.add(key)
        rows.push({ taskId: t.id, scope, path: hit, holder })
      }
    }
  }
  if (!rows.length) return null
  rows.sort((a, b) => (a.taskId.localeCompare(b.taskId)) || (a.scope.localeCompare(b.scope)) || (a.path.localeCompare(b.path)))
  const parts = rows.slice(0, 2).map(r => '任务 ' + r.taskId + ' 的写域 ' + r.scope + ' 与「' + r.holder + '」的声明 ' + r.path + ' 重叠')
  const more = rows.length > 2 ? '；另有 ' + (rows.length - 2) + ' 条' : ''
  return '[dsh-collab] 交叉预警：' + parts.join('；') + more + '（advisory：官方 write_scopes 不挡写入；先 collab_board 协商或换写域）。'
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
 *
 * **相对路径必须先按 cwd 解析**（0.14.0 修的真绕过，2026-10 审计实测）：
 * 反例 —— cwd = `/home/u/proj`，工具给 `../proj/src/a.ts`。fs 后端按 cwd 解析，
 * 这次写入**精确落在** `/home/u/proj/src/a.ts`；而旧实现把 raw 直接交给 `norm()`，
 * 栈回退把首部 `..` 吃掉、得到 `proj/src/a.ts` —— 它不以项目根开头，于是本函数原样返回，
 * `claimsCovering` 判"无冲突"，**门控放行** ⇒ 拿着别人独占的路径照写不误。
 * 现在先拼成 `cwd + '/' + raw` 再归一，`..` 就在正确的坐标系里回退，落回 `src/a.ts`。
 * 三个调用点（gate 的写门控两处、access 的访问通知）因此一起修好 —— 它们共用这一条判据。
 */
export function relToProject(p: string, cwd?: string | null): string {
  const raw = typeof p === 'string' ? p.trim() : ''
  if (!raw) return ''
  const c = typeof cwd === 'string' && cwd ? norm(cwd) : null
  // 绝对路径照旧；相对路径先落到 cwd 坐标系里再归一（见上面的反例）。
  const n = raw.charAt(0) === '/' ? norm(raw) : (c ? norm(c + '/' + raw) : norm(raw))
  if (!n) return ''
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

// ---- 广播推送（单元 F）：受众 ----
//
// 用户实测的硬伤：留言板只有"读者主动 op=read"这一个出口，`src/awareness.ts` 完全不碰 messages
// （每轮摘要只渲染 active claims），于是广播留言**没有任何人会看到**。单元 F 把广播改成推送制：
// `op=post` 带推送意图时，按频道算出**受众**再逐个探活投递。
//
// 受众**每轮现算、不落状态文件**：它只是 `state.holders` / `state.claims` 的投影，没有任何
// 需要跨副本 join 的新事实，所以不进 SSOT、不参与 mergeDocs（也就没有新的收敛字段要定义）。

/**
 * 广播推送的受众。
 *
 *   · `general`  ⇒ 本项目**全部持有人**（`state.holders` 的 holderId），排除投递方自己；
 *   · `path:<p>` ⇒ 声明与该路径**重叠**的持有人（`claimsCovering` 的既有判据），排除自己；
 *   · 其它频道   ⇒ 没有受众规则（`agent:<x>` 是定向唤醒 `wake` 的用法），返回空 + 原因。
 *
 * 结果按 holderId 排序：受众集合要进一次性令牌的载荷，必须**确定性** —— 否则"受众是否变过"
 * 的逐集合比较会失去意义。过期声明不进受众（`claimsCovering` 已按 `expiresAt > t` 过滤）。
 */
export interface PushAudience {
  holderIds: string[]
  kind: 'general' | 'path' | 'unsupported-channel'
  /** 仅 `path`：归一化后的目标路径。 */
  path?: string
  /** 受众为空且原因不是"本来就没别人"时（路径为空 / 频道无规则）的如实说明。 */
  reason?: string
}

export function pushAudience(state: StateDocument, channel: string, selfHolderId: string, t: number): PushAudience {
  const ch = typeof channel === 'string' && channel.trim() ? channel.trim() : 'general'
  const self = typeof selfHolderId === 'string' ? selfHolderId : ''
  if (ch === 'general') {
    const ids = new Set<string>()
    const hs = state && Array.isArray(state.holders) ? state.holders : []
    for (const h of hs) {
      const id = h && typeof h.holderId === 'string' ? h.holderId : ''
      if (id && id !== self) ids.add(id)
    }
    return { holderIds: [...ids].sort(), kind: 'general' }
  }
  if (ch.slice(0, 5) === 'path:') {
    const p = norm(ch.slice(5))
    if (!p) return { holderIds: [], kind: 'path', reason: 'empty-path' }
    const ids = new Set<string>()
    for (const c of claimsCovering(state ? state.claims : [], p, t)) {
      if (c && c.holderId && c.holderId !== self) ids.add(c.holderId)
    }
    return { holderIds: [...ids].sort(), kind: 'path', path: p }
  }
  return { holderIds: [], kind: 'unsupported-channel', reason: 'channel-has-no-audience-rule' }
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
 *
 * **0.14.0 补上"名册行"这一半（A）**：本函数现在还摘掉这个 holder 的**名册行**。
 * 为什么在同一处做：名字本来就叫 dropHolder，而 0.13.0 之前它只清声明与 readers，
 * 行留着等 24h（现场实测 4/4 条已 dispose 的行都还在）。为什么安全：在本函数的调用点上，
 * `releaseOnLoopEnd(..., 'disposed')` **已经在同一个事务里**删掉它全部未过期声明，
 * 所以摘行那一刻它必然零声明 —— 摘行不可能藏住一把活锁。会话若被唤醒，下一次操作
 * 会按 `agent.id` 自动重新登记（见 holder()）。这也让"没有声明可释放"的回收路径
 * 不再是空操作：只要行还在，`changed` 就是 true，handler 会真的写盘。
 */
export function dropHolder(state: StateDocument, holderId: string, t: number): OpResult {
  const expired = (c: Claim): boolean => c.holderId === holderId && c.expiresAt <= t
  const rel = state.claims.filter(expired)
  let changed = rel.length > 0
  if (rel.length) { state.claims = state.claims.filter(c => !expired(c)); bury(state, rel, t) }
  for (const c of state.claims) {
    const list = readersOf(c)
    if (!list.includes(holderId)) continue
    c.readers = list.filter(x => x !== holderId)
    changed = true
  }
  const holdersBefore = Array.isArray(state.holders) ? state.holders.length : 0
  // **不变量**：只要这个 holder 还有未过期声明，它的名册行就必须留着 —— 行是 holder 在 list
  // 名册里的可见性来源，删了会出现"claims 里有人、holders 里没有"的自相矛盾。
  // 真实调用点上 `releaseOnLoopEnd(..., 'disposed')` 已经先删光它的未过期声明，所以这里照常摘干净；
  // 而这条判断让"单独调用 dropHolder 时误摘活行"从根上不可能发生（判据只缩不放）。
  // 上面已把该 holder 的**已过期**声明清掉，所以这里凡还在的都是未过期的。
  const stillClaiming = state.claims.some(c => c.holderId === holderId)
  if (holdersBefore && !stillClaiming) state.holders = state.holders.filter(h => h.holderId !== holderId)
  if (state.holders.length !== holdersBefore) changed = true
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
 * - `cause`（0.13.0）决定留痕正文说哪种结束：`'loop-end'` = 循环停了、空闲超过宽限期；
 *   `'disposed'` = 会话句柄结束了（`agent/disposed`）。两种都是"这个持有者不会再动"的确定性信号，
 *   区别只在文本 —— 正文必须说实话，不能让"句柄结束"被写成"空闲超过 N 秒"。
 * - 留痕消息进 `messages`（契约里已有的结构，不改状态文档 schema）：channel 就是 `holderId`
 *   —— agent holder 的 holderId 本身已经是 `agent:<sessionId>`，正是工具文档里"频道
 *   agent:…"那种寻址写法（**不要**再拼一次 `agent:`，那会得到 `agent:agent:<id>`），
 *   `collab_board op=read` 就能复述。
 * - 返回 `data.released` 是**真正被删掉**的那些声明的公开视图（供通知使用）。
 */
export function releaseOnLoopEnd(state: StateDocument, holderId: string, holderName: string, t: number, graceSec: number, cause: 'loop-end' | 'disposed' = 'loop-end'): OpResult {
  const mine = state.claims.filter(c => c.holderId === holderId && c.expiresAt > t)
  if (!mine.length) return { ok: true, changed: false, data: { released: [] } }
  state.claims = state.claims.filter(c => !mine.includes(c))
  bury(state, mine, t)
  const released = mine.map(publish)
  // 路径去重保序后折叠：与通知文案同一口径（最多列 3 条，其余计数）。
  const uniq: string[] = []
  for (const c of released) for (const p of c.paths) if (!uniq.includes(p)) uniq.push(p)
  const shown = uniq.slice(0, 3).join(' ') + (uniq.length > 3 ? ' 等 ' + uniq.length + ' 条' : '')
  const who = holderLabel(holderId, holderName)
  const w = writerOf(state)
  const n = ++state.seq
  const m: Message = {
    msgId: recordId('m_', n, w),
    seq: n,
    channel: holderId,
    author: AUTO_RELEASE_AUTHOR,
    ts: t,
    body: cause === 'disposed'
      ? '[自动释放] ' + who + ' 的会话句柄已结束（agent/disposed），其对 ' + shown +
        ' 的声明已被自动释放。恢复工作前如需写入这些路径，请重新 collab_lock op=claim。'
      : '[自动释放] ' + who + ' 的会话循环已结束（空闲超过 ' + graceSec + ' 秒），其对 ' + shown +
        ' 的声明已被自动释放。恢复工作前如需写入这些路径，请重新 collab_lock op=claim。'
  }
  if (w) m.writer = w
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
    return holderLabel(c.holderId, c.holderName) + '（' + modeLabel(c.mode) + readableTag + '）占用 ' + paths +
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
// `proc` 只在提供时盖上去（0.14.0）：拿不到进程身份的形态绝不能**清掉**既有行上的章 ——
// 那会让一个活进程刚盖的章被另一个形态的一条读改写抹掉。
export function holder(state: StateDocument, h: HolderInput, name: string, tNow: Clock): Holder {
  let r = state.holders.find(x => x.holderId === h.holderId)
  if (!r) { r = { holderId: h.holderId, name, kind: h.sessionId ? 'agent' : 'human', sessionId: h.sessionId, lastSeenAt: tNow() }; state.holders.push(r) }
  else { r.name = name; r.lastSeenAt = tNow() }
  if (typeof h.proc === 'string' && h.proc) r.proc = h.proc
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
      // inFamily 取代了裸的 `c.holderId === h.holderId`：自家子代理（或父会话）的声明
      // 属于同一个写域，不该互相拦。血缘缺省时 inFamily 的语义与旧写法**完全一致**。
      if (inFamily(h, c.holderId) || c.expiresAt <= t) continue
      // read 是纯观测：不阻塞他人，也不被他人阻塞（与上面 `mode !== 'read'` 的外层判断同源）。
      if (c.mode === 'read') continue
      // **要不要谈，由"本请求的意图"决定**（0.14.0，用户决策：改成允许协商的模式）。
      //   · 我请求 exclusive ⇒ 与已在场的 exclusive **和 shared** 都冲突。
      //     旧实现无条件跳过 shared ⇒ 后来的 exclusive 被**静默批准**：前一秒还在 shared 里
      //     干活的会话，下一秒写入就被门控硬拒（本部署 ask == deny），而"冲突"这件事双方都没
      //     看见 —— 后来者反客为主。现在改为报冲突，让它去协商 / 等待 / 换路径：
      //     返回的 ConflictInfo 里已带 suggestedAction(wait|negotiate)、holderName、
      //     remainingSec、overlapsWith，正是协商所需的全部信息。
      //   · 我请求 shared ⇒ 只与已在场的 exclusive 冲突（"shared 会被他人独占挡住"是它的定义）；
      //     与已在场的 shared 不冲突（共享方互不挡死，保持 0.9.x 起的语义）。
      if (mode === 'shared' && c.mode === 'shared') continue
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
  else {
    // Lamport：`state.seq` 在写路径上已经是「盘上 ∪ 我的副本」的最大值（见 state-core 的
    // merge 基），这里 +1 就是"写时 bump 过所见最大值"。唯一性另由写者戳保证：两个写者
    // 即使撞上同一个 seq，id 也因 `@<writer>` 而不同。
    const w = writerOf(state)
    const n = ++state.seq
    cl = { claimId: recordId('c_', n, w), holderId: h.holderId, holderName: h.name, paths, mode, ttlSec: ttl, expiresAt, note, createdAt: t, readable, readers: [], seq: n, writer: w }
    state.claims.push(cl)
  }
  let warn: string | null = null
  if (ttl < 60) warn = 'short-lease: ttl=' + ttl + 's（<60s）; 请按时 heartbeat 续租，避免过期' + (merged ? '；已并入你现有声明' : '')
  return { ok: true, changed: true, state, tNow, data: { claim: publish(cl), serverTime: t, merged, warning: warn } }
}

// 释放。a = {claimId?} 或 {paths?}。返回 {ok,changed,state,data}。
//
// **终态化**（单元 C）：释放不再"从数组里删掉"，而是把命中的声明从 `claims` 移到
// `released` 墓碑表（claimId → 墓碑值 = max(原 expiresAt, 释放时刻 + ttlSec)）。理由见收敛层注释：删除在 join 下不单调 ——
// 另一份还握着旧副本的写者会把那条声明并回盘上；墓碑才单调（有墓碑就赢）。
// 对外形状一字不变：`claims` 里不再有它，`data.released` 仍是那几条的公开视图。
export function release(state: StateDocument, h: HolderInput, a: ReleaseInput, tNow: Clock): OpResult {
  const t = tNow(); let rel: Claim[] = []
  if (a.claimId) {
    const c = state.claims.find(x => x.claimId === a.claimId)
    if (!c) return { ok: false, changed: false, state, tNow, data: { error: 'not-found', message: 'no claim ' + a.claimId } }
    if (c.holderId !== h.holderId) return { ok: false, changed: false, state, tNow, data: { error: 'forbidden', message: 'only holder can release' } }
    rel = [c]
  } else {
    const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
    if (!paths.length) return { ok: false, changed: false, state, tNow, data: { error: 'bad-request', message: 'claimId or paths required' } }
    rel = state.claims.filter(c => c.holderId === h.holderId && c.paths.some(cp => paths.some(p => ov(p, cp))))
    if (!rel.length) return { ok: true, changed: false, state, tNow, data: { released: [], serverTime: t } }
  }
  state.claims = state.claims.filter(c => !rel.includes(c))
  bury(state, rel, t)
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
  // 级联清 holder（0.9.11）：被回收的 holder 若在本状态里已无未过期声明，它就是一个纯粹的
  // 残留登记 —— 顺手从 holders 表里摘掉。没有这一步，reap 之后 holders 会一直留着刚被清掉的
  // 僵尸，直到 24h 的 sweep 才自愈（`HOLDER_TTL_MS`，见上面的注释）。判据仍然**只缩不放**：
  // 必须同时满足"是本次被回收的 holder" + "已无未过期声明" + "不在活体名单里"（活体检查没跑成
  // 时一个也不摘）。租约到期与 sweep 的既有回收口径都没被改动。
  const gone = new Set(hits.map(c => c.holderId))
  const stillActive = new Set(s.claims.filter(c => !hits.includes(c)).map(c => c.holderId))
  if (!confirm) {
    const candidateHolders: string[] = []
    if (!unknown) for (const hh of s.holders) {
      if (gone.has(hh.holderId) && !stillActive.has(hh.holderId) && !live.has(hh.holderId)) candidateHolders.push(hh.holderId)
    }
    // dry-run：**绝不改状态**（changed:false 让上层不会写盘）。
    return { ok: true, changed: false, state: s, data: Object.assign({ dryRun: true }, base, { candidates: entries, candidateHolders }) }
  }
  if (!hits.length) {
    return { ok: true, changed: false, state: s, data: Object.assign({ dryRun: false }, base, { reaped: [], reapedHolders: [] }) }
  }
  s.claims = s.claims.filter(c => !hits.includes(c))
  // reap（显式回收僵尸）也是"把声明拿掉"，同样立墓碑：否则被回收的声明会被另一份旧副本并回来。
  bury(s, hits, t)
  const reapedHolders: string[] = []
  if (!unknown) {
    s.holders = s.holders.filter(hh => {
      if (!gone.has(hh.holderId) || stillActive.has(hh.holderId) || live.has(hh.holderId)) return true
      reapedHolders.push(hh.holderId)
      return false
    })
  }
  return { ok: true, changed: true, state: s, data: Object.assign({ dryRun: false }, base, { reaped: entries, reapedHolders }) }
}

// 续租。a = {claimId}。
export function heartbeat(state: StateDocument, h: HolderInput, a: HeartbeatInput, tNow: Clock): OpResult {
  const c = state.claims.find(x => x.claimId === a.claimId)
  if (!c) return { ok: false, changed: false, state, tNow, data: { error: 'not-found', message: 'no claim ' + a.claimId } }
  if (c.holderId !== h.holderId) return { ok: false, changed: false, state, tNow, data: { error: 'forbidden', message: 'only holder can heartbeat' } }
  c.expiresAt = tNow() + (c.ttlSec || 1800) * 1000
  return { ok: true, changed: true, state, tNow, data: { claimId: c.claimId, expiresAt: c.expiresAt, serverTime: tNow() } }
}

/**
 * 留言板**没有投递面**的如实说明（0.13.0）：`post` 只写共享状态文件。
 *
 * 为什么放进返回值而不只是写在文档里：「发了就等于通知了」是实测发生过的误读
 * （backlog §2.13）。调用方只能从返回值知道自己**没有**通知到任何人。
 * **不写死任何工具名**：让某个会话动起来用哪个工具，由调用方当时的工具目录决定。
 */
export const BOARD_NO_DELIVERY_HINT: string = '留言板只写共享状态文件：不投递、不唤醒任何会话；对方只在它自己 collab_board op=read 时才会看到这条。要让某个已停下的会话动起来，用它自己的消息工具（以你当时的工具目录为准）。'

/** `post` 收到已移除的 `mentions` 时的报错文案（fail-loud：不静默忽略）。 */
export const BOARD_NO_MENTIONS_HINT: string = 'mentions 已移除：本板没有任何投递面，@ 谁都不等于通知谁。要通知/唤醒某个会话，用它自己的消息工具（以你当时的工具目录为准）；本条消息**没有写入**，请去掉 mentions 重发。'

// 发消息。a = {body, channel?, replyTo?}。
// **没有 mentions**（0.13.0 移除）：@ 某人并让他动起来是官方 Agent Teams 的投递面（`send_message`），
// 本板不重做。旧实现把 mentions 记进消息却不产生任何投递，实测被读成"通知过了"（backlog §2.13），
// 所以现在**显式拒绝**这个参数而不是静默忽略 —— 静默忽略等于继续骗调用方。
export function post(state: StateDocument, h: HolderInput, a: PostInput, tNow: Clock): OpResult {
  // 参数类型里已经没有 mentions 了，这里显式读一次"旧参数"：挡回去而不是静默忽略。
  const legacyMentions = (a as unknown as { mentions?: unknown }).mentions
  if (legacyMentions !== undefined) {
    return { ok: false, changed: false, state, tNow, data: { error: 'bad-request', message: BOARD_NO_MENTIONS_HINT } }
  }
  const body = typeof a.body === 'string' ? a.body.trim() : ''
  if (!body) return { ok: false, changed: false, state, tNow, data: { error: 'bad-request', message: 'body required' } }
  // 上限在**任何写入之前**判定（`holder()` 也不跑）：被挡回的 post 一个字都不落盘。
  if (body.length > MESSAGE_BODY_MAX_CHARS) {
    return { ok: false, changed: false, state, tNow, data: { error: 'bad-request', message: 'body 过长：' + body.length + ' 字符 > 上限 ' + MESSAGE_BODY_MAX_CHARS + '；本条**没有写入**，超限不截断，请精简或拆分后重发' } }
  }
  holder(state, h, h.name, tNow)
  const w = writerOf(state)
  const n = ++state.seq
  const m: Message = { msgId: recordId('m_', n, w), seq: n, channel: (typeof a.channel === 'string' && a.channel.trim()) ? a.channel.trim() : 'general', author: h.holderId, ts: tNow(), body }
  if (w) m.writer = w
  if (typeof a.replyTo === 'string' && a.replyTo) m.replyTo = a.replyTo
  state.messages.push(m)
  return { ok: true, changed: true, state, tNow, data: { msgId: m.msgId, seq: state.seq, ts: m.ts, channel: m.channel, delivered: false, deliveryNote: BOARD_NO_DELIVERY_HINT } }
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

// 筛选消息（channel / since / limit）。**两种模式**，由 `since` 决定方向：
//
//   - 不给 `since`（或 0）→ **tail**：返回**最新** limit 条。这是"看一眼有没有新东西"的用法，
//     也是实测里模型唯一会用的用法（现场 2 次 read 都没带游标）。0.13.0 之前这里也是 tail，
//     但**不给 `hasMore`/`earliestSeq`**，调用方看不出"窗口被截断了"。
//   - 给 `since > 0` → **forward**：从该游标**往后** limit 条（旧→新）。这是增量追平：
//     按 `nextSince` 循环到 `hasMore === false` 就是无损读完。
//
// 为什么必须分两种（两侧都有实测）：
//   - 只用 tail：`since` 只能往后走，被 `slice(-limit)` 跳过的**中段**再也拿不回来 ——
//     现场 62 条留言、默认 limit 50，一次 read 只回 seq 61..206，最旧 12 条静默丢失；
//     按"读到 latestSeq 就算追平"的直觉再读一次得到 0 条，那 12 条永久不可达。
//   - 只用 forward：默认 since=0 会把最老的 50 条倒给调用方 —— 现场两次 read 都因此被历史
//     噪音淹没（其中一次 49KB 触发宿主溢出截断），最新的一条（正是发给它的）反而没进窗口。
//
// `hasMore` = 沿本模式的方向**还有更多没返回**（tail 是"更早的还有"，forward 是"更新的还有"）；
// `earliestSeq` / `latestSeq` 是可用范围的下界/上界，调用方据此知道窗口落在哪一段。
/**
 * 按 `seq` 分组后**整组**取前 `limit` 条（forward）。
 *
 * 为什么必须整组取：`seq` 只是 Lamport 时钟，**两个写者可以撞同一个 seq**。若一页把某组切成两半，
 * 调用方拿数字游标（"我已经读到 n 了"）继续翻页时，剩下那半就**永远读不到**；不切的话，
 * 数字游标既不需要重送（游标一定前进）也不会漏（组是完整的）—— 「无损」与「可终止」同时成立。
 * `limit` 因此是**软上限**：单组大于 `limit` 时整组返回（否则永远前进不了）。
 */
function takeGroupsForward(matched: Message[], limit: number): Message[] {
  const out: Message[] = []
  let i = 0
  while (i < matched.length) {
    const g = Number(matched[i].seq)
    let j = i
    while (j < matched.length && Number(matched[j].seq) === g) j++
    const group = matched.slice(i, j)
    if (out.length && out.length + group.length > limit) break
    out.push(...group)
    if (out.length >= limit) break
    i = j
  }
  return out
}

/** 同上，从**尾部**整组取（tail 模式：读最新 limit 条，且不切开最旧那一组）。 */
function takeGroupsTail(matched: Message[], limit: number): Message[] {
  const out: Message[] = []
  let i = matched.length
  while (i > 0) {
    const g = Number(matched[i - 1].seq)
    let j = i
    while (j > 0 && Number(matched[j - 1].seq) === g) j--
    const group = matched.slice(j, i)
    if (out.length && out.length + group.length > limit) break
    out.unshift(...group)
    if (out.length >= limit) break
    i = j
  }
  return out
}

export function filterMessages(state: StateDocument, a: ReadInput): FilterMessagesResult {
  const cur = parseCursor(a.since)
  const since = cur.seq
  const limit = Math.max(1, Math.min(200, Number(a.limit) || 50))
  const ch = typeof a.channel === 'string' && a.channel.trim() ? a.channel.trim() : null
  const l = ch ? state.messages.filter(m => m.channel === ch) : state.messages
  // 游标是**复合**的 `(seq, writer)` 全序位置，"严格在其后"。**裸 seq** 游标（`nextSince`）按
  // `seq > n` 匹配 —— 它必须**严格前进**，否则"按 nextSince 翻页"会永远重读同一条；
  // 代价是 seq 相撞时定位不到是哪一位写者（会跳过同 seq 的另一位）⇒ 精确翻页用 `nextCursor`。
  const matched = l.filter(m => (cur.bare
    ? Number(m.seq) > cur.seq
    : compareSeqWriter(m.seq, m.writer, cur.seq, cur.writer) > 0))
  // 模式由**游标的形式**决定，不由数值大小：省略 `since` ⇒ tail（读最新 limit 条）；
  // 给了位置（复合写法，或裸 seq>0）⇒ forward。于是 `since:"0@"` = **从头读**（全历史可达），
  // 而 `since:0` / 省略仍是 tail —— 老用法一字不变。
  const mode: 'tail' | 'forward' = cur.explicit || since > 0 ? 'forward' : 'tail'
  const returned = mode === 'forward' ? takeGroupsForward(matched, limit) : takeGroupsTail(matched, limit)
  const hasMore = matched.length > returned.length
  const last = returned.length ? returned[returned.length - 1] : null
  const nextSince = last ? (Number(last.seq) || 0) : since
  // 无损翻页要用 nextCursor：`nextSince` 只带 seq，seq 相撞时定位不到"读到哪一位写者了"。
  const cursor = cursorKey(cur)
  const nextCursor = last
    ? cursorKey({ seq: Number(last.seq) || 0, writer: typeof last.writer === 'string' ? last.writer : '' })
    : (typeof a.since === 'string' && a.since ? a.since : String(since))
  // earliestSeq = 这个筛选范围内**还留着**的最旧一条（0 = 一条都没有）。调用方 `since` 小于它，
  // 说明那段已被 sweep 的 MAX_MESSAGES 回收 —— 与"那段时间没人留言"在返回值上可区分。
  const earliestSeq = l.length ? l[0].seq : 0
  // latestSeq 与 earliestSeq **同范围**：都只看 channel 收窄、不看 since。旧实现取整个文件的最后一条，
  // 于是按频道读的调用方拿 nextSince(379) 与 latestSeq(403) 比会永远以为自己还差 24 条（现场实测）。
  const latestSeq = l.length ? l[Number(l.length) - 1].seq : 0
  // channel 是**精确匹配**的自由字符串（写什么就得按什么读）。实测踩过两种写法不一致：
  // 文档写 `agent:<holderId>` 而 holderId 本身已是 `agent:…`（于是读 0 条）、path 频道少个尾斜杠
  // （于是读 0 条）。空结果时把现有频道如实列出来，调用方一眼看出自己该写哪个。
  const channelNote = ch && matched.length === 0 && state.messages.length ? channelRosterNote(state) : undefined
  const out: FilterMessagesResult = { since, mode, returned: returned.length, total: matched.length, hasMore, nextSince, cursor, nextCursor, earliestSeq, latestSeq, messages: returned }
  if (channelNote) out.channelNote = channelNote
  return out
}

/**
 * 给定频道没有命中时的一句话：列出**现有频道**（按条数降序，最多 5 个），并说明 channel 的匹配口径。
 * 只在"确实有消息但你这个频道一条都没有"时出现 —— 没有消息时一个字都不加（与 otherProjects /
 * holderRosterNote 同一降级纪律）。
 */
export function channelRosterNote(state: StateDocument): string {
  const count = new Map<string, number>()
  for (const m of state.messages) count.set(m.channel, (count.get(m.channel) || 0) + 1)
  const top = [...count.entries()].sort((x, y) => (y[1] - x[1]) || String(x[0]).localeCompare(String(y[0])))
  const shown = top.slice(0, 5).map(([c, n]) => c + '（' + n + ' 条）').join('、')
  const more = top.length > 5 ? ' 等 ' + top.length + ' 个' : ''
  return '该频道没有消息。现有频道：' + shown + more + '。channel 是精确匹配的字符串：写什么就得按什么读（path: 频道与 claim 用同一套相对路径写法）。'
}

// 计算在当前时刻 blocking 的独占声明（供 wait）。
// 家族成员不算 blocker：wait 自己的子代理/父会话没有意义（它们与我是同一个写域）。
export function blockers(state: StateDocument, t: number, h: HolderInput, paths: string[]): Claim[] {
  return state.claims.filter(c => c.expiresAt > t && c.mode === 'exclusive' && !inFamily(h, c.holderId) && c.paths.some(cp => paths.some(p => ov(p, cp))))
}
