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
}

/** sweep 的清理诊断信息。 */
export interface SweepResult {
  expiredClaims: number
  droppedMessages: number
  prunedHolders: number
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
export function ov(a: string, b: string): boolean { const sa = seg(a), sb = seg(b), n = Math.min(sa.length, sb.length); for (let i = 0; i < n; i++) if (sa[i] !== sb[i]) return false; return true }

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
  s.holders = s.holders.filter(h => active.has(h.holderId) || t - (h.lastSeenAt || 0) < holderTtlMs)
  const prunedHolders = beforeHolders - s.holders.length

  return { expiredClaims, droppedMessages, prunedHolders }
}

// 惰性清理过期声明，返回清理数量（兼容旧调用方）。
export function expire(s: StateDocument, t: number): number { return sweep(s, t).expiredClaims }

// 对外发出一条 claim 的公开视图（剥离内部字段）。
export function publish(c: Claim): PublishedClaim {
  return { claimId: c.claimId, holderId: c.holderId, holderName: c.holderName, paths: c.paths, mode: c.mode, ttlSec: c.ttlSec, expiresAt: c.expiresAt, note: c.note, createdAt: c.createdAt }
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

// 声明占用。返回 {ok,changed,state,data}，或抛 conflictError。
// tNow 是 () => 当前毫秒；h = {holderId, sessionId?, name?}；a = {paths, mode?, ttlSec?, note?}。
export function claim(state: StateDocument, h: HolderInput, a: ClaimInput, tNow: Clock): OpResult {
  const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
  if (!paths.length) return { ok: false, changed: false, tNow, data: { error: 'bad-request', message: 'paths required（目录以 / 结尾）' } }
  const mode: Mode = a.mode === 'shared' ? 'shared' : 'exclusive'
  const ttl = Math.max(5, Math.min(86400, Number(a.ttlSec) || 1800))
  const note = typeof a.note === 'string' ? a.note.slice(0, 500) : ''
  const t = tNow(), cs: ConflictInfo[] = []
  for (const c of state.claims) {
    if (c.holderId === h.holderId || c.expiresAt <= t || c.mode === 'shared') continue
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
  if (cs.length) throw conflictError(cs)
  holder(state, h, h.name, tNow)
  const expiresAt = t + ttl * 1000
  const own = state.claims.find(c => c.holderId === h.holderId && c.paths.some(cp => paths.some(p => ov(p, cp))))
  let cl: Claim, merged = !!own
  if (own) { for (const p of paths) if (!own.paths.includes(p)) own.paths.push(p); own.mode = mode; own.ttlSec = ttl; own.note = note || own.note; own.expiresAt = expiresAt; cl = own }
  else { cl = { claimId: 'c_' + (++state.seq), holderId: h.holderId, holderName: h.name, paths, mode, ttlSec: ttl, expiresAt, note, createdAt: t }; state.claims.push(cl) }
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
