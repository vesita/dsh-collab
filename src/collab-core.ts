// collab-core.ts
// 多智能体协作插件的纯逻辑唯一事实源（JSON Schema v1 契约见 src/schema/collab.schema.json）。
// 不依赖 fs/ctx/sessions，只操作 state 对象；时间通过可选参数注入以便测试。
// 这是可 import、可测试、可被 Python 侧对照复用的实现层。
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
   * **只影响名册行**：声明（claim）的回收与租约无关（claim 没有过期时间）。
   */
  proc?: string
}

/**
 * 家族判据（纯逻辑，两形态同源）：`holderId` 是否属于本 holder 的会话家族。
 *
 * 为什么需要它：子智能体运行在**自己的会话**里，`holderId` 是 `agent:<子会话 id>`，
 * 与父会话不等 —— 于是"父会话 claim src/ 再派子智能体改 src/"时，子智能体被自己的锁
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
  note?: string
}

/** release 操作的输入参数：二选一（claimId 或 paths）。 */
export interface ReleaseInput {
  claimId?: string
  paths?: string[]
}

/** reap（确证死亡的声明显式回收，0.9.8）的输入参数。 */
export interface ReapInput {
  /**
   * 默认 false = **dry-run**：只把候选列出来，绝不改动任何状态。
   * 只有显式 `confirm: true` 才真正删除命中判据的声明。
   */
  confirm?: boolean
  /** 只看与这些路径相交的声明（可选；不给就是全部）。 */
  paths?: string[]
}

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

/** sweep 的可选上限覆盖（默认 MAX_MESSAGES / MAX_MESSAGES_BYTES）。 */
export interface SweepOptions {
  maxMessages?: number
  /** 留言总量的字节预算（默认 MAX_MESSAGES_BYTES）。口径见该常量的注释。 */
  maxMessagesBytes?: number
  /** 唯一存活判据（注入；缺省 ⇒ 不淘汰）。 */
  liveness?: LivenessFn
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
  droppedMessages: number
  prunedHolders: number
  prunedReleased?: number
  /** 确证死亡而被回收的**声明**条数（0.2.9；以前这一项恒为"不碰 claims"）。 */
  prunedClaims?: number
}

/** list 中按 holder 聚合的存活视图：holder 就活不活的唯一判据是 oracle（见 LivenessFn）。 */
export interface HolderView {
  holderId: string
  name?: string
  kind?: string
  sessionId?: string
  lastSeenAt: number
  active: boolean       // 该 holder 当前是否有未过期声明
}

/** 对外发布的 claim 视图（剥离内部字段）。 */
export interface PublishedClaim {
  claimId: string
  holderId: string
  holderName?: string
  paths: string[]
  mode: Mode
  note?: string
  createdAt: number
  /** 可读性，已归一（缺字段的老状态文件输出 true）。 */
  readable: boolean
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

// 显示名清洗：压缩空白并按 Unicode 码点安全截断 24 字（避免 UTF-16 代理对截断导致乱码）。
export function cleanName(s: string): string {
  if (typeof s !== 'string') return s
  let n = s.replace(/\s+/g, ' ').trim()
  const chars = Array.from(n)
  if (chars.length > 24) n = chars.slice(0, 24).join('') + '…'
  return n
}

/** 存活判据三态（与 StateStore.livenessOf 同源）：live / not-live / failed。 */
export type LivenessFn = (holderId: string) => 'live' | 'not-live' | 'failed'

/**
 * 存活判据只有一条：这条声明的持有者还活着吗。
 * 没有判据（受限宿主/单测）⇒ 不淘汰；oracle 自己坏了（failed）⇒ 也不收。
 */
export function holderAlive(holderId: string, liveness?: LivenessFn): boolean {
  if (typeof liveness !== 'function') return true
  try { return liveness(holderId) !== 'not-live' } catch { return true }
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
// 墓碑值取该声明的 Lamport seq（只用于确定性排序），表本身有确定性上限 `MAX_RELEASED`
// （见 sweep）。删除在 join 下不单调：另一份旧副本会把记录带回来；墓碑才单调（有墓碑就赢）。

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
// 另一份独有的字段更新，而且取键大的**不满足结合律**（a > b 时丢掉 b 的信息，再与 c 合并时的
// 结果与先合并 b、c 不同）。逐字段则天然是积格（product lattice）：每个字段各自满足交换/结合/
// 幂等 ⇒ 整个合并满足。

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
    createdAt: joinMinNum(a.createdAt, b.createdAt)
  }
  const holderName = joinMaxStr(a.holderName, b.holderName)
  if (holderName !== undefined) out.holderName = holderName
  const note = joinMaxStr(a.note, b.note)
  if (note !== undefined) out.note = note
  const readable = joinAndBool(a.readable, b.readable)
  if (readable !== undefined) out.readable = readable
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
 * `(seq, writer)` 再按 id，holders 按 holderId，记录内的 paths 按字典序）。
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

/** 墓碑表求并：同一个 claimId 取**较大**的值（join；值是该声明的 Lamport seq，只用于确定性 GC 排序）。 */
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

/** 墓碑表上限（单元 D）：按 `(墓碑值, claimId)` 保留最大的 N 条，其余丢掉。
 *  规则**只看数据**（值 = 该声明的 Lamport seq + claimId），不看插入顺序、不看时钟，
 *  两个副本 GC 出同样结果 —— 否则不收敛。 */
export const MAX_RELEASED: number = 4096


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
// 名册行的**显示**上限（0.14.0，C）。为什么要有界：`list` 过去逐条返回整份名册，
// 现场实测 56 行 / 约 10 KB 一次；而每一步都注入的态势摘要早就把 claims 压到
// 「最多 3 条 × 每条 2 个路径」（见 renderDigest）。同一份"输出必须与注入频率同量级"的
// 纪律，名册这边漏了一半。
// 截断**不丢事实**：调用方始终能拿到 `holdersTotal`，自己看得出被折叠了。
export const HOLDER_VIEW_LIMIT: number = 12

// 惰性清理：确证死亡的声明 + 超额留言 + 确证死亡的 holder。
// 返回各类清理数量，供上层附带诊断信息。
//
// **声明（claim）的回收判据（0.2.9 起）**：只有一条 —— oracle 说持有者 not-live。
// 判据不可用（没有 liveness / 返回 'failed'）时不收（fail-closed）。
//
// **名册行（holder）的回收判据（改用活体 oracle 之后）**：不靠计时器，只有两条 ——
//   1. oracle 说 not-live（`LivenessFn`，唯一存活判据）⇒ 行下一次 sweep 就走；
//   2. `proc`：行上盖着写它的那个进程的身份令牌；这个进程不在了 ⇒ 行下一次 sweep 就走。
//     —— 这一条覆盖 oracle 覆盖不到的"进程被杀但 agent 行还在"。
// `dropHolder()`（agent/disposed）仍会立即摘行。没有任何一条会让行活得更久。
/**
 * 把一批声明记进 `released` 墓碑表（与 `collab-ops.ts` 的 `bury` 同一语义、同一份数据形状）。
 *
 * 为什么 core 里也要有一份：`collab-ops.ts` 单向依赖本文件（ops → core），core 不许反向
 * import ops。这里只做最朴素的那 8 行（墓碑值 = 该声明的 Lamport seq），没有第二套规则 ——
 * 两个写点写的是同一张表的同一列，语义由 `mergeReleased`（求并取大）统一。
 *
 * @param s - 要就地修改的状态文档。
 * @param claims - 刚被拿掉的声明。
 */
function buryClaims(s: StateDocument, claims: Claim[]): void {
  if (!Array.isArray(claims) || !claims.length) return
  if (!s.released || typeof s.released !== 'object') s.released = {}
  for (const c of claims) {
    if (!c || typeof c.claimId !== 'string' || !c.claimId) continue
    const v = Number(c.seq) || 0
    const cur = s.released[c.claimId]
    s.released[c.claimId] = cur === undefined || v > cur ? v : cur
  }
}

export function sweep(s: StateDocument, opts: SweepOptions = {}): SweepResult {
  const maxMessages = Number.isInteger(opts.maxMessages) && opts.maxMessages > 0 ? opts.maxMessages : MAX_MESSAGES
  const maxMessagesBytes = Number.isInteger(opts.maxMessagesBytes) && opts.maxMessagesBytes > 0 ? opts.maxMessagesBytes : MAX_MESSAGES_BYTES
  // 只有真正的 Set 才算"判据可用"；null / undefined 一律降级（见 SweepOptions.liveProcs）。
  const liveProcs: Set<string> | null = opts.liveProcs instanceof Set ? opts.liveProcs : null
  const procStamping = opts.procStamping === true

  // **声明（claim）的回收**（0.2.9 起）：确证死亡（oracle=not-live）的持有者，其声明在
  // 这里就收掉并立墓碑 —— 不再只靠 op=reap 手动清。
  //
  // 为什么必须加：`agent/disposed` 只覆盖**优雅退场**。进程被 SIGKILL（dsh 重启、整条 cgroup
  // 被杀）时那个事件从头到尾没有发射机会，于是声明永久留在盘上。实测现场：5 条声明残留
  // 2.88～3.64 天，所属进程（315976、43110）全已不存在、oracle 全 not-live，而没有**任何**
  // 自动路径会删它们（reap 被刻意做成纯显式 + 默认 dry-run）。那不是"忘了删"，是回收机制的空档。
  //
  // 为什么这里不会误收活会话（**跨进程安全**是这里最硬的要求）：
  //   · oracle（`liveness`）查的是**本进程**的 agents 注册表。多开一个 dsh 实例时，A 看不到
  //     B 里活着的会话 ⇒ 单靠 oracle 会把 B 的锁当死锁删掉。实测本机曾经同时跑着本机会话与
  //     noco 侧 dsh，这不是假想场景。所以 oracle=not-live **只是必要条件，不是充分条件**。
  //   · 充分条件看声明的 `proc` 章（写这条声明时的进程身份令牌 `<pid>:<开机节拍>`）：
  //     那个进程确实不在 `liveProcs` 里（= pid 没了，或同 pid 已换成另一个进程）。
  //     两个判据**同时**成立才收 —— 与名册行回收同一套证据，只是名册行两条任一即可。
  //   · 没有 `proc` 章的声明（老状态文件 / 盖不了章的形态）**不收**：证据不足，维持现状。
  //   · 判据不可用（没有 liveness / 'failed' / liveProcs 不是 Set / 本形态不盖章）
  //     一律**不回收**（fail-closed）—— 漏收只是维持现状，误收会删掉活会话的锁。
  //   · 立墓碑（buryClaims）与 release/reap 同一处理：删除在 join 下不单调，
  //     不立墓碑会被旧副本并回来。
  let prunedClaims = 0
  if (Array.isArray(s.claims) && typeof opts.liveness === 'function') {
    const reclaimable = s.claims.filter(c => {
      if (!c) return false
      // 必要条件一：oracle 说这个持有者不在活名单里。
      if (holderAlive(c.holderId, opts.liveness)) return false
      // 必要条件二：这条声明盖着进程章，且那个进程确实不在了。
      const proc = typeof c.proc === 'string' ? c.proc : ''
      if (!proc) return false
      // liveProcs 不是 Set ⇒ 进程判据不可用 ⇒ fail-closed（与名册行同一口径）。
      if (!(liveProcs instanceof Set)) return false
      return !liveProcs.has(proc)
    })
    if (reclaimable.length) {
      s.claims = s.claims.filter(c => !reclaimable.includes(c))
      buryClaims(s, reclaimable)
      prunedClaims = reclaimable.length
    }
  }
  // 终态墓碑的**确定性** GC（见收敛层注释）：只按条数上限淘汰，规则只看数据（墓碑值 = 该声明的
  // Lamport seq + claimId），不看插入顺序、不看时钟 —— 同一份数据在任何副本上得到同一结果。
  let prunedReleased = 0
  const rel = s.released
  if (rel && typeof rel === 'object') {
    const beforeReleased = Object.keys(rel).length
    const ids = Object.keys(rel)
    if (ids.length > MAX_RELEASED) {
      ids.sort((a, b) => ((Number(rel[b]) || 0) - (Number(rel[a]) || 0)) || (a < b ? 1 : a > b ? -1 : 0))
      for (const id of ids.slice(MAX_RELEASED)) delete rel[id]
    }
    prunedReleased = beforeReleased - Object.keys(rel).length
  }

  let droppedMessages = 0
  if (Array.isArray(s.messages)) {
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
  }

  const active = new Set(s.claims.map(c => c.holderId))
  const beforeHolders = s.holders.length
  s.holders = s.holders.filter(h => {
    // 只要有声明就保留（锁还在）
    if (active.has(h.holderId)) return true
    // oracle 说 not-live（确证死亡）⇒ 淘汰；没有 oracle 或 oracle 坏了（failed）⇒ 保留（fail-closed）。
    if (!holderAlive(h.holderId, opts.liveness)) return false
    const proc = typeof h.proc === 'string' ? h.proc : ''
    if (proc) return liveProcs === null ? true : liveProcs.has(proc)
    // 没有进程身份：旧行，或本形态盖不了章。能盖章的形态直接作废它，否则原样保留。
    return !procStamping
  })
  const prunedHolders = beforeHolders - s.holders.length

  return { droppedMessages, prunedHolders, prunedReleased, prunedClaims }
}

// holder 存活视图：把 holders 数组翻译成"谁还活着"的可读判断。
// active = 该 holder 有未过期声明；谁出现在这里**只由 oracle 决定**（not-live 立即不出现）。
// 按 lastSeenAt 降序，调用方一眼看出最近活跃者。
export function holderView(state: StateDocument, t: number, opts: SweepOptions = {}): HolderView[] {
  const activeIds = new Set(state.claims.map(c => c.holderId))
  return state.holders
    .filter(h => holderAlive(h.holderId, opts.liveness))
    .map(h => ({
      holderId: h.holderId,
      name: h.name,
      kind: h.kind,
      sessionId: h.sessionId,
      lastSeenAt: h.lastSeenAt || 0,
      active: activeIds.has(h.holderId)
    }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
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
