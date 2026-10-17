// collab-ops.ts
// 协作操作层：claim / release / reap / post / overview / related /
// filterMessages / blockers，以及它们用到的态势与访问面渲染。
//
// 从 src/collab-core.ts 拆出来（单文件千行以内的硬要求）。方向是单向的：
// 本模块 import 核心的纯函数与类型，核心**不**反向依赖本模块（已核对：核心段里
// 出现的本模块名字全部只在注释里，没有一处是真代码）。动态宿主形态下两段仍内联进
// 同一个作用域，顺序是核心在前 —— scripts/build-host.mjs 会把本段顶部的跨模块
// import 语句剥掉（自包含是那边 `new Function` 装得起来的硬约束）。

import type { Claim, ConflictInfo, Holder, Message, Mode, StateDocument } from './types/collab.js'
import type { ClaimInput, Clock, CollabConflictError, FilterMessagesResult, HolderInput, OpResult, OverviewResult, PostInput, PublishedClaim, ReadInput, ReapInput, ReleaseInput , LivenessFn } from './collab-core.js'
import { MAX_MESSAGES, MESSAGE_BODY_MAX_CHARS, compareSeqWriter, cursorKey, inFamily, mergeDocs, norm, ov, parseCursor, recordId, seg, sweep, writerOf, holderAlive } from './collab-core.js'

function bury(s: StateDocument, claims: Claim[]): void {
  if (!Array.isArray(claims) || !claims.length) return
  if (!s.released || typeof s.released !== 'object') s.released = {}
  for (const c of claims) {
    if (!c || typeof c.claimId !== 'string' || !c.claimId) continue
    // 墓碑值 = 该声明的 Lamport seq，只用于确定性 GC 排序（不再是时间）。
    const v = Number(c.seq) || 0
    const cur = s.released[c.claimId]
    s.released[c.claimId] = cur === undefined || v > cur ? v : cur
  }
}

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
// 为什么需要它：holderName 来自会话标题，而子智能体会话的标题就是父 AI 那条 prompt 的开头。
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
// I2（归属唯一实现点）：若标题以第二人称（如「你是...」）开头，不得原样当成读者的称呼，
// 必须显式标明是「另一个会话」，并对超长标题进行安全截断。
export function holderLabel(holderId?: string, holderName?: string): string {
  if (typeof holderName !== 'string' || !holderName) return holderId || ''
  const handle = holderHandle(holderId)
  let clean = holderName.replace(/\s+/g, ' ').trim()
  const chars = Array.from(clean)
  if (chars.length > 24) clean = chars.slice(0, 24).join('') + '…'

  const isSecondPerson = /^(你(?:是一个|是|作为一个|作为|负责|将|需|来|有|的)|you\s+are|you\b)/i.test(clean)
  if (isSecondPerson) {
    const stripped = clean.replace(/^(你(?:是一个|是|作为一个|作为|负责|将|需|来|有|的)\s*|you\s+are\s*|you\b\s*)/i, '').trim()
    const title = stripped ? '另一个会话「' + stripped + '」' : '另一个会话'
    return handle ? title + '#' + handle : title
  }
  return handle ? clean + '#' + handle : clean
}

// `list` 的 holders 字段是**会话名册**（谁在这个项目上出现过），不是锁 —— 锁在 `claims`。

// claims = 他人的占用声明。最多列 3 条、每条最多 2 个路径，其余折叠成计数，
// 因为这一行会在每一个模型步都被注入，长度必须有界。
// 时间无关硬约束：签名声明恰好 1 个入参，禁止 now/t 参数，防止破坏 DSH 运行时快照去重。
export function renderDigest(claims: Claim[]): string {
  // 显式排序只为确定性：状态文件里的插入顺序不该让同一组占用渲染出不同文本。
  const ordered = claims.slice().sort((a, b) =>
    String(a.holderId).localeCompare(String(b.holderId)) || String(a.claimId).localeCompare(String(b.claimId)))
  const parts = ordered.slice(0, 3).map(c => {
    const paths = c.paths.slice(0, 2).join(' ') + (c.paths.length > 2 ? ' 等 ' + c.paths.length + ' 条' : '')
    return holderLabel(c.holderId, c.holderName) + '（' + modeLabel(c.mode) + '）占用 ' + paths
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
 * 及其后代）**或** `ov(accessPath, P)`（P 是 accessPath 的祖先或自身）。
 * 例：访问 `src/a/1` 会命中声明 `src/a/2`、`src/a/2/A`、`src/a/`、`src/`，
 * 不会命中 `src/b`、`other/`。
 */
export function claimsForAccess(claims: Claim[], accessPath: string, liveness?: LivenessFn): Claim[] {
  const target = norm(accessPath)
  if (!target) return []
  const scope = accessScope(target)
  return (Array.isArray(claims) ? claims : []).filter(c => holderAlive(c.holderId, liveness) && c.paths.some(raw => {
    const p = norm(raw)
    if (!p) return false
    return ov(p, scope) || ov(target, p)
  }))
}

/**
 * 覆盖 target 的声明（功能 C 的判据）：C 的某个路径 P 是 target 的祖先或自身
 * （`ov(target, P)`，与 claim() 既有的冲突判据同源）。
 */
export function claimsCovering(claims: Claim[], target: string, liveness?: LivenessFn): Claim[] {
  const t = norm(target)
  if (!t) return []
  return (Array.isArray(claims) ? claims : []).filter(c => holderAlive(c.holderId, liveness) && c.paths.some(raw => {
    const p = norm(raw)
    return !!p && ov(t, p)
  }))
}


/** 可读性归一：缺省（含 0.7.0 之前写下的状态文件）视为**可读**。 */
export function isReadable(c: Claim): boolean {
  return !(c && (c as { readable?: unknown }).readable === false)
}

// ---- 功能 D 已删除：不再有 reader 反向登记（只读不再写状态），readers 字段整体移除 ----

/**
 * 会话退出（dispose）时摘掉这个 holder 的**名册行**（声明由 releaseOnDispose 在同一个事务里释放）。
 *
 * **不变量**：只要这个 holder 还有声明，它的名册行就必须留着 —— 行是 holder 在 list 名册里的
 * 可见性来源，删了会出现"claims 里有人、holders 里没有"的自相矛盾。真实调用点上
 * `releaseOnDispose` 已经先删光它的声明，所以这里照常摘干净；这条判断让"单独调用 dropHolder
 * 时误摘活行"从根上不可能发生（判据只缩不放）。
 * 会话若被唤醒，下一次操作会按 `agent.id` 自动重新登记（见 holder()）。
 */
export function dropHolder(state: StateDocument, holderId: string): OpResult {
  const holdersBefore = Array.isArray(state.holders) ? state.holders.length : 0
  const stillClaiming = state.claims.some(c => c.holderId === holderId)
  if (holdersBefore && !stillClaiming) state.holders = state.holders.filter(h => h.holderId !== holderId)
  if (state.holders.length === holdersBefore) return { ok: true, changed: false, data: {} }
  return { ok: true, changed: true, state, data: {} }
}

// ---- 会话句柄结束时的释放（agent/disposed，op=release 之外的第二条回收路径）----
//
// 为什么需要它（一手场景）：会话 claim 了一个目录，把写入交给子智能体后**自己退场**了
// （agent/disposed，句柄结束）。会话恢复后它的对话历史里仍然"记得"自己持有这些路径，
// 而另一边看到路径空闲 ⇒ 两边同时以为可以写（W7 实测过的锁安全缺陷）。
// 所以句柄结束的那一刻就把它的声明释放掉，并在留言板留下一条可审计的留言。
//
// `t` 由调用方显式传入（纯逻辑模块不隐式读时钟）。
// 与会话**仍在加载但循环停下**（agent/status → idle）无关：那种情况本插件不再自动处理
// （旧实现按宽限期计时释放，属于被删除的计时逻辑）；持有者该自己 `op=release`，
// 确证死亡（会话不在注册表里）的残留声明由 `op=reap` 显式回收。

/** 句柄结束释放的留痕消息作者。不是任何真实 holder：形如 `human:console` 的第三种前缀。 */
export const AUTO_RELEASE_AUTHOR: string = 'system:dsh-collab'

/**
 * 句柄结束时的释放：删除 holderId 的**全部声明**，并在留言板留下一条可审计的留言。
 *
 * - 一条都没有时 `changed: false`，调用方据此**不写盘、不留痕**（没有发生释放事件）。
 * - 留痕消息进 `messages`：channel 就是 `holderId` —— agent holder 的 holderId 本身已经是
 *   `agent:<sessionId>`，正是工具文档里"频道 agent:…"那种寻址写法（**不要**再拼一次
 *   `agent:`，那会得到 `agent:agent:<id>`），`collab_board op=read` 就能复述。
 * - 返回 `data.released` 是**真正被删掉**的那些声明的公开视图。
 */
export function releaseOnDispose(state: StateDocument, holderId: string, holderName: string, t: number): OpResult {
  const mine = state.claims.filter(c => c.holderId === holderId)
  if (!mine.length) return { ok: true, changed: false, data: { released: [] } }
  state.claims = state.claims.filter(c => !mine.includes(c))
  bury(state, mine)
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
    body: '[自动释放] ' + who + ' 的会话句柄已结束（agent/disposed），其对 ' + shown +
      ' 的声明已被自动释放。恢复工作前如需写入这些路径，请重新 collab_lock op=claim。'
  }
  if (w) m.writer = w
  state.messages.push(m)
  return { ok: true, changed: true, state, data: { released, notice: m } }
}

/**
 * 访问通知文本：紧凑、**时间稳定**。与 renderDigest 同源：签名只有一个形参，
 * 没有时间参数 —— 倒计时就无从加回来（这份文本会进上下文，漂移会击穿快照去重）。
 */
export function renderAccessNotice(claims: Claim[]): string {
  // 显式排序只为确定性：状态文件里的插入顺序不该让同一组声明渲染出不同文本。
  const ordered = claims.slice().sort((a, b) =>
    String(a.holderId).localeCompare(String(b.holderId)) || String(a.claimId).localeCompare(String(b.claimId)))
  const parts = ordered.slice(0, 2).map(c => {
    const paths = c.paths.slice(0, 2).join(' ') + (c.paths.length > 2 ? ' 等 ' + c.paths.length + ' 条' : '')
    // 可读性**只对 exclusive 有门控意义**：writeGate 的 collect() 对 shared/read 一律 `continue`
    // 放行（src/index.ts）。所以只在 exclusive 上渲染「可读 / 不可读」—— 对 shared/read 标
    // 「不可读」是句假话，读根本不会被拦。而 OPEN_HINT 恰好推荐"只读调研用 mode=read"，
    // 一个只读声明却被通知写成「不可读」，误导概率最高。
    const readableTag = c.mode === 'exclusive' ? '，' + (isReadable(c) ? '可读' : '不可读') : ''
    return holderLabel(c.holderId, c.holderName) + '（' + modeLabel(c.mode) + readableTag + '）占用 ' + paths
  })
  const more = ordered.length > 2 ? '；另有 ' + (ordered.length - 2) + ' 条' : ''
  return '[dsh-collab] 你刚访问的路径处于其他会话的占用范围内：' + parts.join('；') + more +
    '。改动这些路径前请先执行 collab_lock op=wait 或用 collab_board 协商。'
}

// 对外发出一条 claim 的公开视图（剥离内部字段）。
// readable 归一后输出：老状态文件缺字段时输出 true，与 isReadable 同源。
export function publish(c: Claim): PublishedClaim {
  return { claimId: c.claimId, holderId: c.holderId, holderName: c.holderName, paths: c.paths, mode: c.mode, note: c.note, createdAt: c.createdAt, readable: isReadable(c) }
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

/**
 * 把 holderId 翻成 sessionId 交给 harness 的活体 oracle（唯一实现点，两形态共用）。
 * oracle 缺席 ⇒ 返回 undefined；调用方按"没有判据"处理：既不淘汰，也不误收。
 */
export function holderLiveness(
  oracle?: (sessionId: string) => { state: 'live' | 'not-live' | 'failed' }
): LivenessFn | undefined {
  if (typeof oracle !== 'function') return undefined
  return (holderId: string): 'live' | 'not-live' | 'failed' => {
    const sessionId = holderId.startsWith('agent:') ? holderId.slice(6) : holderId
    try { return oracle(sessionId).state } catch { return 'failed' }
  }
}

// 声明占用。返回 {ok,changed,state,data}，或抛 conflictError。
// tNow 是 () => 当前毫秒；h = {holderId, sessionId?, name?}；a = {paths, mode?, note?}。
export function claim(state: StateDocument, h: HolderInput, a: ClaimInput, tNow: Clock, liveness?: LivenessFn): OpResult {
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
  const note = typeof a.note === 'string' ? a.note.slice(0, 500) : ''
  const t = tNow(), cs: ConflictInfo[] = []
  // read 是纯观测：不阻塞他人，也不被他人阻塞，直接跳过整个冲突扫描。
  if (mode !== 'read') {
    for (const c of state.claims) {
      // 持有者已不在 harness 的活体名单里 ⇒ 这条声明立即失效，不参与冲突判定（不看 TTL）。
      // failed（判据自己坏了）经 holderAlive 视为"仍然有效"，与 I4 的 fail-closed 一致。
      if (!holderAlive(c.holderId, liveness)) continue
      // inFamily 取代了裸的 `c.holderId === h.holderId`：自家子智能体（或父会话）的声明
      // 属于同一个写域，不该互相拦。血缘缺省时 inFamily 的语义与旧写法**完全一致**。
      if (inFamily(h, c.holderId)) continue
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
        cs.push({
          claimId: c.claimId,
          holderId: c.holderId,
          holderName: c.holderName || c.holderId,
          path: p,
          overlapsWith: cp,
          mode: c.mode,
          suggestedAction: 'negotiate',
        })
        break
      }
    }
  }
  if (cs.length) throw conflictError(cs)
  holder(state, h, h.name, tNow)
  // 合并限定在**同一 mode** 的声明上；不同 mode 各成一条。
  // 若跨 mode 合并，"对 src/ 声明 read + 对 src/sub/ 声明 exclusive"会合成一条
  // 覆盖 src/ 的 exclusive 声明，把从未被独占的兄弟路径 src/other/ 一并锁上。
  const own = state.claims.find(c => c.holderId === h.holderId && c.mode === mode && c.paths.some(cp => paths.some(p => ov(p, cp))))
  let cl: Claim, merged = !!own
  if (own) {
    for (const p of paths) if (!own.paths.includes(p)) own.paths.push(p)
    own.note = note || own.note
    // 只在**显式**给出时改写可读性，缺省不重置：否则一次不带 readable 的续声明会把
    // 之前的 readable:false 静默翻回可读。
    if (a.readable !== undefined && a.readable !== null) own.readable = readable
    cl = own
  }
  else {
    // Lamport：`state.seq` 在写路径上已经是「盘上 ∪ 我的副本」的最大值（见 state-core 的
    // merge 基），这里 +1 就是"写时 bump 过所见最大值"。唯一性另由写者戳保证：两个写者
    // 即使撞上同一个 seq，id 也因 `@<writer>` 而不同。
    const w = writerOf(state)
    const n = ++state.seq
    cl = { claimId: recordId('c_', n, w), holderId: h.holderId, holderName: h.name, paths, mode, note, createdAt: t, readable, seq: n, writer: w }
    // 0.2.9：给声明也盖进程章（名册行一直都有，声明此前没有）。
    // 自动回收（sweep）要**同时**有两个证据才敢删一条锁：oracle 说持有者不活了，
    // **并且**写这条声明的进程确实不在了。只有 oracle 是不够的 —— 它查的是本进程的
    // agents 注册表，多开一个 dsh 实例时会把另一个进程里活着的会话判成 not-live。
    // 盖不了章的形态（受限动态宿主拿不到宿主进程信息）就不盖，届时自动回收对它不生效
    // （fail-closed：证据不足就维持现状）。
    if (typeof h.proc === 'string' && h.proc) cl.proc = h.proc
    state.claims.push(cl)
  }
  return { ok: true, changed: true, state, tNow, data: { claim: publish(cl), serverTime: t, merged } }
}

// 释放。a = {claimId?} 或 {paths?}。返回 {ok,changed,state,data}。
//
// **终态化**（单元 C）：释放不再"从数组里删掉"，而是把命中的声明从 `claims` 移到
// `released` 墓碑表（claimId → 墓碑值 = 该声明的 Lamport seq）。理由见收敛层注释：删除在 join 下不单调 ——
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
  bury(state, rel)
  return { ok: true, changed: true, state, tNow, data: { released: rel.map(publish), serverTime: t } }
}

// ---- 确证死亡声明的显式回收（0.9.8，op=reap）----
//
// **只由显式 op 驱动，绝不自动触发。**不能把它接进 sweep() 或任何读路径。
// 判据只有一条：**oracle 说持有者已经 not-live**（`LivenessFn`，与写门控/冲突扫描同源）。
// 不看 age、不看 TTL、不看 `agents.list()` —— 改用活体 oracle 之后，同一条状态不许有两个相反的存活答案。
// oracle 拿不到或自己坏了（failed）⇒ 一个也不收（fail-closed：漏收只是维持现状，误杀会让
// 持有者以为自己还有锁）。默认 dry-run，`confirm:true` 才动手；只回收**未过期**声明
// （过期的归 sweep()，reap 抢着干只会让两条口径分叉）。
//
// 形态：reap(state, holderInput, args, now, liveness?) -> { ok, changed, state, data }
//   - 返回 data 里逐条候选带上 reasons（每条判据一个标签），让"为什么它算死亡"可以从返回值
//     本身复述；`livenessCheck: 'unavailable'` = 从头到尾没拿到过一条可用判据。
export function reap(s: StateDocument, h: HolderInput, a: ReapInput, t: number, liveness?: LivenessFn): OpResult {
  // 只认显式 true：`confirm: 'yes'` / 1 / 缺省一律按 dry-run（fail-safe 的方向是"不改状态"）。
  const confirm = !!(a && a.confirm === true)
  const paths = (Array.isArray(a && a.paths) ? a.paths : []).map(norm).filter(Boolean)
  const verdictOf = (holderId: string): 'live' | 'not-live' | 'failed' => {
    if (typeof liveness !== 'function') return 'failed'
    try { return liveness(holderId) } catch { return 'failed' }
  }
  const hits: Claim[] = []
  let judged = 0
  for (const c of s.claims) {
    // 自己的声明用 op=release：reap 不替调用方清自己的锁（否则一次 confirm 会连带
    // 把调用方正在做的活的占用一起抹掉）。
    if (c.holderId === h.holderId) continue
    // 只对**有会话身份**的 holder（agent:<id>）判死亡。`human:console` 没有 oracle 可问。
    if (typeof c.holderId !== 'string' || !c.holderId.startsWith('agent:')) continue
    const verdict = verdictOf(c.holderId)
    // 判据自己坏了 ⇒ 不收，也不算"判过"（拿不到答案与"答案是活"必须可分辨）。
    if (verdict === 'failed') continue
    judged++
    if (verdict !== 'not-live') continue
    // paths 限定：只考虑与给定路径相交的声明（与 release/blockers 同一套前缀重叠判据）。
    if (paths.length && !c.paths.some(cp => paths.some(p => ov(p, cp)))) continue
    hits.push(c)
  }
  const livenessCheck = judged > 0 ? 'ok' : 'unavailable'
  const entries = hits.map(c => Object.assign(publish(c), {
    reasons: paths.length
      ? ['agent-holder', 'not-self', 'holder-not-live', 'paths-intersect']
      : ['agent-holder', 'not-self', 'holder-not-live']
  }))
  // 级联清 holder（0.9.11）：被回收的 holder 若在本状态里已无未过期声明，它就是一个纯粹的
  // 残留登记 —— 顺手从 holders 表里摘掉。没有这一步，reap 之后 holders 会一直留着刚被清掉的
  // 死亡 holder。判据仍然**只缩不放**：必须同时满足"是本次被回收的 holder" + "已无未过期声明"
  // + oracle 说 not-live。
  const gone = new Set(hits.map(c => c.holderId))
  const stillActive = new Set(s.claims.filter(c => !hits.includes(c)).map(c => c.holderId))
  const deadHolder = (holderId: string): boolean => gone.has(holderId) && !stillActive.has(holderId) && verdictOf(holderId) === 'not-live'
  const base = { serverTime: t, livenessCheck }
  if (!confirm) {
    // dry-run：**绝不改状态**（changed:false 让上层不会写盘）。
    const candidateHolders = s.holders.filter(hh => deadHolder(hh.holderId)).map(hh => hh.holderId)
    return { ok: true, changed: false, state: s, data: Object.assign({ dryRun: true }, base, { candidates: entries, candidateHolders }) }
  }
  if (!hits.length) {
    return { ok: true, changed: false, state: s, data: Object.assign({ dryRun: false }, base, { reaped: [], reapedHolders: [] }) }
  }
  s.claims = s.claims.filter(c => !hits.includes(c))
  // reap（显式回收）也是"把声明拿掉"，同样立墓碑：否则被回收的声明会被另一份旧副本并回来。
  bury(s, hits)
  const reapedHolders = s.holders.filter(hh => deadHolder(hh.holderId)).map(hh => hh.holderId)
  const dead = new Set(reapedHolders)
  s.holders = s.holders.filter(hh => !dead.has(hh.holderId))
  return { ok: true, changed: true, state: s, data: Object.assign({ dryRun: false }, base, { reaped: entries, reapedHolders }) }
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
// 传 liveness 时，not-live 的持有者及其占用整组不出现（与 holderView/related 同一判据）。
export function overview(state: StateDocument, liveness?: LivenessFn): OverviewResult {
  const byHolder: Record<string, { holderId: string; holderName: string; claims: PublishedClaim[] }> = {}

  const claims = typeof liveness === 'function' ? state.claims.filter(c => holderAlive(c.holderId, liveness)) : state.claims

  for (const c of claims) {
    const k = c.holderId
    if (!byHolder[k]) byHolder[k] = { holderId: k, holderName: c.holderName || k, claims: [] }
    byHolder[k].claims.push(publish(c))
  }
  return { totalClaims: claims.length, holders: Object.keys(byHolder).map(k => { const h = byHolder[k]; const modes = [...new Set(h.claims.map(c => c.mode))]; return { holderId: h.holderId, holderName: h.holderName, claimCount: h.claims.length, mode: modes.length === 1 ? modes[0] : 'mixed' as const, paths: h.claims.flatMap(c => c.paths), claims: h.claims } }) }
}

// 查询与给定路径相关的声明。
export function related(state: StateDocument, paths: string[], opts?: { liveness?: LivenessFn }): Claim[] {
  let claims = state.claims
  // 持有者已 not-live ⇒ 立即不参与判定（不看 TTL/age）
  if (opts && typeof opts.liveness === 'function') claims = claims.filter(c => holderAlive(c.holderId, opts.liveness))
  return claims.filter(c => paths.some(p => c.paths.some(cp => ov(p, cp))))
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
// 家族成员不算 blocker：wait 自己的子智能体/父会话没有意义（它们与我是同一个写域）。
export function blockers(state: StateDocument, h: HolderInput, paths: string[], liveness?: LivenessFn): Claim[] {
  return state.claims.filter(c => holderAlive(c.holderId, liveness) && c.mode === 'exclusive' && !inFamily(h, c.holderId) && c.paths.some(cp => paths.some(p => ov(p, cp))))
}
