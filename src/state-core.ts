// src/state-core.ts
// **状态机的唯一事实源**（与运行环境无关那一半）：读改写（乐观并发重试 + 损坏自愈 + 历史落点
// 迁移）、磁盘布局（主文件 + 留言旁挂）、加载期留言并集、损坏备份的保留份数、跨项目观测，
// 以及全部只读查询 op（list / overview / status / msgs / wait / reap）。
//
// 为什么会有这个文件：同一套状态机曾在 `src/store.ts`（包形态）与 `src/host-shell.js`（动态外壳）
// 各写一遍，两份的漂移只能靠人盯 —— 历史上已经有两处行为不同步（`changed:false` 时是否落盘
// sweep 的清理、损坏备份保留份数）。现在：
//   · 包形态：`src/store.ts` 收缩成**适配器** —— 只实现 targetFor / hname / familyIds / livenessOf
//     这些环境面，其余全部转发到这里；对外 API（`installStore` 返回的 `StateStore`）一字不变。
//   · 动态外壳：`scripts/build-host.mjs` 在构建期把 `lib/state-core.js` 剥掉顶层 `export ` 后
//     **原样内联**进 `src/host-shell.js`（与 `lib/collab-core.js` 同一条路），外壳同样只剩适配器。
//   两形态的状态层因此与纯逻辑一样**逐字节同源**，由 tests/collab-inline-parity.mjs 守护。
//
// **自包含是硬约束**：本文件只许 `import type`（编译后擦除），不许有运行时 import ——
// 受限动态宿主的 code.host 是纯文本、不接受 import/打包，内联之后必须能被 new Function 直接求值。
// 所以路径、时钟、进程判据、删除原语、collab-core 的纯函数、以及"哪个服务在场"这些事
// 全部经 `StateCorePorts` **注入**；连 `node:path` 的 isAbsolute 都由本文件自带的
// `isAbsolutePath` 承担（内联区里没有任何 node 模块可用）。
//
// 与 `src/collab-core.ts` 的分工：core 只操作内存里的 StateDocument（纯函数、不碰 fs）；
// 本文件负责"把它摊到磁盘上、再安全地收回来"。

import type {
  AgentLike, CollabArgs, CollabFs, FileRef, LoadResult, ToolResult
} from './contract.js'
import type {
  Claim, FilterMessagesResult, HolderInput, HolderView, Message, OpData, OpResult, OverviewResult,
  PublishedClaim, ReadInput, ReapInput, StateDocument, SweepOptions, SweepResult, TeamScopeTask
} from './collab-core.js'

/**
 * 本模块需要的**纯逻辑**面。唯一事实源是 `src/collab-core.ts`：包形态注入它的命名空间，
 * 外壳注入构建期内联进同一作用域的那批函数 —— 两个形态拿到的是同一份实现的两种引用方式，
 * 所以本文件不需要（也不许有）运行时 import。
 */
export interface StateCorePure {
  init(): StateDocument
  sweep(s: StateDocument, t: number, opts?: SweepOptions): SweepResult
  publish(c: Claim): PublishedClaim
  holderView(s: StateDocument, t: number, opts?: SweepOptions): { holders: HolderView[]; staleHolders: number }
  holderRosterNote(staleHolders?: number): string | null
  overview(s: StateDocument): OverviewResult
  related(s: StateDocument, paths: string[]): Claim[]
  filterMessages(s: StateDocument, a: ReadInput): FilterMessagesResult
  blockers(s: StateDocument, t: number, h: HolderInput, paths: string[]): Claim[]
  reap(s: StateDocument, h: HolderInput, a: ReapInput, liveHolderIds: string[] | null, t: number): OpResult
  norm(p: string): string | null
  /** 单元 C：半格 join（收敛的唯一事实源在 collab-core）。 */
  mergeDocs(a: StateDocument, b: StateDocument): StateDocument
  /** 单元 C：规范形（补字段、规范序、墓碑表归一）。 */
  normalizeDoc(s: StateDocument | null | undefined): StateDocument
  HOLDER_VIEW_LIMIT: number
}

/**
 * `targetFor` 的返回：**文件放哪**这件事整个由环境面决定（包形态走 `src/paths.ts`，
 * 外壳从 `settings.prepareDocument()` 反推或退到项目内 `.dsh-collab/`）。
 */
export interface StateTarget {
  cwd: string | null
  target: FileRef
  sidecar: FileRef
  stateDir: string
  fileName: string
  /**
   * 环境自身的降级说明（例：外壳解析不到 DSH 用户目录）。它与"没有 cwd"的那句一起
   * 并进 `load()` 的 warning —— 环境文案留在适配器里，本模块只负责按顺序拼装。
   */
  envWarn?: string | null
}

/** 历史落点候选：`path` 交给 `fs.resolve`，`cwd` 可选（第一代落点是**项目内**的相对文件）。 */
export interface LegacyTarget {
  path: string
  cwd?: string
}

/**
 * 注入面。环境相关性全部收在这里，本模块自身只做与平台无关的编排。
 * 可选的能力（`liveProcsOf` / `selfProcToken` / `removeFile` / `teamTasks` / `log`）缺失时
 * 一律**降级**而不是报错：受限动态宿主给不出它们。
 */
export interface StateCorePorts {
  /** 就是 `src/contract.ts` 的 `CollabFs`（唯一一份 fs 接口）。 */
  fs: CollabFs
  /** collab-core 的纯函数面（唯一事实源）。 */
  core: StateCorePure
  now(): number
  /**
   * **本写者的身份戳**（单元 C）：每进程稳定、唯一。它有两个用处，缺一不可 ——
   *   1. 记录 id 的全局唯一性（`c_<seq>@<writer>`）：Lamport 时钟只保证"不小于所见最大值"，
   *      两个写者撞同一个 seq 是正常的，唯一性只能靠写者戳；
   *   2. **写后验证**：落盘成功不代表内容还在盘上（replaceIfVersion 是 probe → rename，
   *      两个写者可以同时 probe 成功），所以写完要重读主文件、确认盘上的写者戳还是我自己。
   * 空串 = 该形态给不出身份（此时写后验证自动跳过，行为退回到不验证）。
   */
  writerId: string
  targetFor(agentId: string | null, agent?: AgentLike): Promise<StateTarget>
  /**
   * 历史落点的候选列表（按优先级）。包形态给三代落点；外壳只有第一代项目内单文件；
   * 没有历史落点的形态传空数组。本模块只负责"逐个只读扫描 + 一次性搬进正确位置"。
   */
  legacyTargets(cwd: string | null, fileName: string): Promise<LegacyTarget[]>
  /** 名册行进程判据（平台能力）。缺失 / 返回 null ⇒ `sweep` 里一个也不收（fail-closed）。 */
  liveProcsOf?(tokens: string[]): Set<string> | null
  /** 本形态的进程身份令牌；null ⇒ `procStamping:false`（旧口径 24h TTL）。 */
  selfProcToken?(): string | null
  /**
   * 删除一个绝对路径（清理损坏备份用）。`ctx.fs` 没有删除原语，包形态用 `node:fs` 的 rm；
   * 受限动态宿主给不出删除能力 ⇒ 不传，清理整段跳过（备份只增不减是它已知的限制）。
   */
  removeFile?(absPath: string): Promise<void>
  /** 轮询间隔（`wait` 用）：包形态与外壳都是 `ctx.timer.timeout`。 */
  sleep(ms: number): Promise<void>
  /** op=reap 的活体名单；null = 检查没跑成（见 `collab-core.reap`）。 */
  liveAgentHolderIds(): string[] | null
  /** 官方 Agent Teams 的在跑任务（可选的只读面）；缺失或不传 ⇒ overview 一字不加。 */
  teamTasks?(agent?: AgentLike): TeamScopeTask[] | null
  /** 静默旁路上的错误留痕（可选的宿主日志面）；不传就是无害的空操作。 */
  log?(line: string): void
}

/** 本模块对外交出的东西：与 `StateStore` 里那几个 op 同形，由适配器转发/收编。 */
export interface StateCore {
  load(agentId: string | null, agent?: AgentLike): Promise<LoadResult>
  mutate(fn: (s: StateDocument) => OpResult, agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  list(agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  overviewOp(agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  status(a: CollabArgs, agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  msgs(a: CollabArgs, agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  reapOp(a: CollabArgs, h: HolderInput, agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  waitFor(a: CollabArgs, h: HolderInput, agentId: string | null, agent?: AgentLike): Promise<ToolResult>
}

// ---- 磁盘布局（0.15.0，R2）：主文件 + 留言旁挂 ----
//
// 为什么拆：一份状态文件里 **97% 的字节是留言**（实测 82,248 B：留言 79,815 B、声明 1,313 B、
// 名册 1,058 B），而 claim/release/heartbeat 每次都整份重写 —— 为了改 1.3 KB 的锁状态写 82 KB。
// 拆开之后锁操作只写主文件（KB 级），那条大尾巴只在**留言真的变了**时才动。
//
// 硬约束：**内存里的 StateDocument 与磁盘上是同一份逻辑文档**（拆盘只发生在落盘/加载这一层）。
// —— src/schema/collab.schema.json 是 SSOT；单元 C 起该文档多了 `writer`（写者戳）与
// `released`（终态墓碑表），claims/messages 的记录上多了 `seq` / `writer`。
// 变的只有"怎么把它摊到磁盘上"：
//   <name>.json          {schemaVersion, seq, claims, holders}  主文件（锁状态）
//   <name>.messages.json {schemaVersion, seq, messages}         旁挂（留言）
// `seq` 两边都写：它是 claimId（`c_<seq>`）与 msgId（`m_<seq>`）**共用**的单调计数器，
// 加载时取两边的**较大值**（主文件写得更频繁，正常情形下它就是较大值）。
//
// 迁移：主文件里**仍有** `messages`（旧布局）时与旁挂**求并集**（见 load），并在**首次写盘**时
// 把并集搬进旁挂、同时把主文件里这个键去掉。**只搬不删** —— 留言一条都不许丢。
const SIDECAR_EXT = '.messages.json'

/** `<name>.json` → `<name>.messages.json`。只在真的以 `.json` 结尾时替换，否则追加。 */
export function sidecarNameOf(fileName: string): string {
  return fileName.slice(-'.json'.length) === '.json'
    ? fileName.slice(0, -'.json'.length) + SIDECAR_EXT
    : fileName + SIDECAR_EXT
}

/** 主文件那一半。**不含 messages**：迁移之后主文件里永远不会再有这个键。 */
function mainDocOf(s: StateDocument): Record<string, unknown> {
  // 单元 C：写者戳（写后验证的判据）与终态墓碑表都属于"锁状态"这一半 —— 放进主文件，
  // 与 claims 一起被每次写盘带上。
  return { schemaVersion: s.schemaVersion, seq: s.seq, writer: s.writer || '', claims: s.claims, holders: s.holders, released: s.released || {} }
}

/** 旁挂那一半。 */
function sideDocOf(s: StateDocument): Record<string, unknown> {
  return { schemaVersion: s.schemaVersion, seq: s.seq, writer: s.writer || '', messages: s.messages }
}

/**
 * 留言指纹：`条数 | 首条 msgId | 末条 msgId`。用来判"这次写盘要不要动旁挂文件"。
 *
 * 为什么这个判据是**可靠**的，不是"猜"的启发式：本插件的留言只有**两种**变化形状 ——
 *   1. `post()` 在**尾部追加**一条（msgId = `m_<seq>`，seq 全局严格递增且唯一）；
 *   2. `sweep()` 从**头部截断**（`MAX_MESSAGES` 条数上限 / `MAX_MESSAGES_BYTES` 字节预算）。
 * 两者各自、以及"先截断再追加"同时发生，都必然改变**条数**或**首条 msgId**；
 * "末条 msgId"再把"条数相同但换了一批"这种（本插件不产生的）情形也覆盖住。
 * 反向：指纹相同 ⇒ 条数与首尾 msgId 都相同 ⇒ 中间那些条目的 msgId 也必然与上次相同
 * （msgId 唯一且按追加顺序递增），所以留言内容不可能变。
 * 迁移（主文件里的 messages 搬进旁挂）**不走**这个指纹，由 `messagesInMain` 单独判定。
 */
function msgFingerprint(msgs: Message[]): string {
  return msgs.length + '|' + (msgs.length ? msgs[0].msgId : '') + '|' + (msgs.length ? msgs[msgs.length - 1].msgId : '')
}

/**
 * 两份留言按 `msgId` 求**并集**、按 `(seq, writer)` 升序（0.16.0，R2 残留修；单元 C 起直接
 * 复用 `core.mergeDocs` 的 messages 分量 —— 求并的胜负判据只有一份实现，不再手抄）。
 *
 * 为什么不是"主文件说了算"：滚动升级期间**同一份状态会被两个版本交替写** —— 旧版把留言写主文件、
 * 新版写旁挂。任何"以某一边为准"的加载都会在下次写盘时把另一边的留言整批覆盖掉（= 静默丢留言）。
 * 同 msgId 取 `(seq, writer)` 较大者（本插件的 msgId 唯一，内容应当逐字节相同，这里只是取一个
 * 确定值）；没有 msgId 的条目（不该出现）原样保留，不参与去重。
 */
function unionMessages(core: StateCorePure, first: Message[], second: Message[]): Message[] {
  return core.mergeDocs(
    Object.assign(core.init(), { messages: first }),
    Object.assign(core.init(), { messages: second })
  ).messages
}

/** 把任意抛出物转成一行可读文本（warning 里要带真实原因，不能只写「失败了」）。 */
export function describeError(e: unknown): string {
  try {
    const m = e && typeof e === 'object' ? (e as { message?: unknown }).message : undefined
    if (typeof m === 'string' && m) return m
    return String(e)
  } catch (e2) {
    return 'unknown error'
  }
}

/** 统一 warning 形状：有 warning 才那个键，没有就一字不加。 */
function withWarn(data: Record<string, any>, warn: string | null): Record<string, any> {
  return warn ? Object.assign({}, data, { warning: warn }) : data
}

/**
 * 判断"写入失败是否属于乐观并发冲突，值得重读后重试"。
 * 真实 ctx.fs 抛的是 FsError：code 是**独立字段**，message 里不含 code（实测）。
 * 后端文案：'cannot write "<p>": file changed since it was read'        (FS_STALE_VERSION)
 *           'cannot overwrite existing "<p>" without reading it first'  (FS_NOT_OBSERVED)
 * 后者正是"并发方抢先创建了状态文件"的竞态：重读一次就能拿到 version 再写。
 * 只认精确文案，不用裸 /stale/i —— 它会命中路径里的 "stale" 字样。
 *
 * ⚠ **这个重试只保证同进程串行；跨进程的 CAS 并不成立**（2026-10 审计实测）：
 *   dsh-fs-local 的串行化锁 `locks` 是 LocalFileSystem **实例**字段（只在本进程内排队），
 *   而 replaceIfVersion 是 probe → rename：两个进程可以同时 probe 到同一个 version、
 *   再各自 rename 成功，**后写者静默覆盖先写者**。实测（64MB 内容拉开窗口 + 文件屏障对齐）
 *   4/4 轮两个写者都返回成功 = 丢更新。所以"并发时重读重试"这条保证**不要**跨进程引用。
 *   （仓库自带 CLI 早先的 `fs::write` 非原子且零版本守卫，在防线上又开了一个洞；
 *    已由 R3a 改成原子替换 + 跨进程写锁，见 crates/collab-cli/src/main.rs。）
 *
 * 单元 C 起这条竞态不再是"丢更新"：版本守卫只当**快速路径**，真正的保证来自
 * `mutate()` 的 读 → `mergeDocs(盘上, 本实例副本)` → 应用 op → 写 → **写后验证**
 * （重读主文件确认写者戳还是自己）→ 重读重合并重试。所以即使两个 rename 都成功，
 * 被覆盖的那一份也会在下一次写里被 join 回来（见 tests/collab-write-merge.mjs）。
 */
function stale(e: unknown): boolean {
  const err = e as { message?: string; code?: string } | null | undefined
  const code = err && typeof err.code === 'string' ? err.code : ''
  if (code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED' || code === 'EEXIST') return true
  const m = String((err && err.message) || e)
  return /FS_STALE_VERSION|FS_NOT_OBSERVED|file changed since it was read|without reading it first|already exists/i.test(m)
}

/**
 * 绝对路径判据。`node:path` 的 isAbsolute 在这里用不了（内联区没有 node 模块），
 * 所以自带一份最小实现：POSIX 的 `/`、Windows 的 `C:\` / `C:/` 与 UNC 的 `\\`。
 * 它只用来决定"要不要真的去删这个备份文件"——判错只是少删 / 不删，不会误删相对路径。
 */
function isAbsolutePath(p: string): boolean {
  return typeof p === 'string' && (p.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(p) || p.slice(0, 2) === '\\\\')
}

/**
 * 损坏备份的保留份数（0.14.0，M2b）。自愈每次 `JSON.parse` 失败都整份复制状态文件成
 * `<name>.json.corrupt-<ms>`，而"半截读"（并发写期间读到长度 0）会让自愈在同一个文件上
 * 反复触发 —— 旧实现**只写不清**，备份只增不减。
 * 主文件与**旁挂**（`<name>.messages.json.corrupt-<ms>`）共用这一个份数。
 */
const CORRUPT_BACKUP_KEEP = 3

/**
 * 顺手清理旧的损坏备份，只保留最近 `CORRUPT_BACKUP_KEEP` 份（0.14.0 M2b；0.16.0 起
 * **主文件与旁挂共用同一规则** —— 调用方分别传两个文件名，不改动任何一份不属于自己的备份）。
 *
 * 四条纪律，缺一不可：
 *   1. `fs.listDir` 是**可选能力**（与 `otherProjects` 同一降级纪律）：拿不到 / 抛错就静默跳过，
 *      **绝不让自愈路径失败** —— 清理是旁路，不是自愈的前置条件；
 *   2. 没有删除原语（受限动态宿主）时整段跳过 —— 删不掉就只能看着备份堆积，这是宿主能力限制；
 *   3. 只认**自己命名规则**的文件（`<状态文件名>.corrupt-<纯数字>`），且只删普通文件：
 *      别人的 `.bak-*`、别的项目的备份、非数字后缀一律不动；
 *   4. 逐份删除、失败吞掉（`ENOENT` = 目标已经不在，正是我们要的结果），失败经 `log` 留痕。
 *
 * 删除原语由注入面给（包形态是 `node:fs` 的 rm）：`ctx.fs` 服务**没有**删除原语，
 * 而"只保留 N 份"必须真的把文件去掉。
 */
async function pruneCorruptBackups(ports: StateCorePorts, stateDir: string, fileName: string): Promise<void> {
  const fs = ports.fs
  const log = typeof ports.log === 'function' ? ports.log : (_line: string): void => {}
  try {
    if (typeof fs.listDir !== 'function') return
    if (typeof ports.removeFile !== 'function') return
    const dir = await fs.resolve(stateDir)
    const entries = await fs.listDir(dir)
    const prefix = fileName + '.corrupt-'
    const mine: Array<{ local: string; stamp: number }> = []
    for (const e of entries) {
      if (!e || typeof e.name !== 'string' || !e.target) continue
      if (e.type && e.type !== 'file') continue
      if (!e.name.startsWith(prefix)) continue
      const tail = e.name.slice(prefix.length)
      if (!/^\d+$/.test(tail)) continue
      let local = ''
      try { local = fs.processPath(e.target) } catch (err) { continue }
      if (!local || !isAbsolutePath(local)) continue
      mine.push({ local, stamp: Number(tail) })
    }
    if (mine.length <= CORRUPT_BACKUP_KEEP) return
    mine.sort((a, b) => b.stamp - a.stamp)
    for (const old of mine.slice(CORRUPT_BACKUP_KEEP)) {
      try { await ports.removeFile(old.local) } catch (err) { log('[dsh-collab] 损坏备份删除失败：' + old.local + '：' + describeError(err)) }
    }
  } catch (e) {
    log('[dsh-collab] 损坏备份清理失败：' + describeError(e))
  }
}

/**
 * `load()` 的内部返回：契约的 `LoadResult` + 三样**存取层私有**的东西
 * （旁挂目标/版本、主文件是否还带着旧布局的 `messages`）。对外仍只暴露 `LoadResult`。
 */
interface LoadedState extends LoadResult {
  sidecar: FileRef
  sideVersion: number | null
  messagesInMain: boolean
}

export function createStateCore(ports: StateCorePorts): StateCore {
  const fs = ports.fs
  const core = ports.core
  const now = ports.now
  const log = typeof ports.log === 'function' ? ports.log : (_line: string): void => {}

  // ---- 名册行的进程判据（0.14.0，B2）----
  // 本进程的身份令牌只算一次（`<pid>:<开机节拍>`）。拿不到（非 Linux / 读不到 /proc / 解析失败）
  // 就是 null：此时**不盖章**，`sweepOpts` 里的 liveProcs 也必然不可用 —— 两者一起退回 24h TTL
  // 老口径（fail-closed：漏收只是维持现状，误收会删掉活会话的行）。
  // 受限动态宿主给不出这个能力 ⇒ 注入面返回 null，外壳的行为与"拿不到进程身份"完全一致。
  const PROC_TOKEN = typeof ports.selfProcToken === 'function' ? ports.selfProcToken() : null

  // 本实例的写者戳（单元 C）：由环境面注入，每进程稳定唯一。空串 ⇒ 该形态给不出身份，
  // 记录 id 退回老形状、写后验证也自动跳过（行为退回到"不验证"，但绝不误报被覆盖）。
  const WRITER_ID: string = typeof ports.writerId === 'string' ? ports.writerId : ''

  // 每次 sweep **现算**：判据只看 state 里实际出现过的那几个进程，不引入定时器、不做全表扫描。
  const sweepOpts = (state: StateDocument): SweepOptions => {
    const toks: string[] = []
    if (Array.isArray(state.holders)) {
      for (const h of state.holders) {
        const p = h && typeof h.proc === 'string' ? h.proc : ''
        if (p && toks.indexOf(p) < 0) toks.push(p)
      }
    }
    const live = typeof ports.liveProcsOf === 'function' ? ports.liveProcsOf(toks) : null
    return { liveProcs: live, procStamping: PROC_TOKEN !== null }
  }

  const pub = (c: Claim): PublishedClaim => core.publish(c)

  async function load(agentId: string | null, agent?: AgentLike): Promise<LoadedState> {
    const t = await ports.targetFor(agentId, agent)
    const { cwd, target, sidecar, stateDir, fileName } = t
    // 两句环境文案在这里按固定顺序拼（"没有 cwd"是两形态共有的降级，envWarn 是各自独有的）。
    const warn = cwd ? null : '状态文件落在默认位置（本会话没有 cwd），按项目隔离已失效'
    // 迁移失败**不再静默**：旧落点搬不过来 = 这个项目凭空退回空状态（用户级故障，且极难自查）。
    // 复用 load() 已有的 warn 通道逐条追加 'legacy migrate failed: <原因>'；
    // 即使 warn 本身为 null（有 cwd 的正常情形）也要能把它带出来，故统一走 mergeWarn()。
    const migrateNotes: string[] = []
    const mergeWarn = (extra: string | null): string | null => {
      const parts: string[] = []
      if (warn) parts.push(warn)
      if (t.envWarn) parts.push(t.envWarn)
      for (const n of migrateNotes) parts.push(n)
      if (extra) parts.push(extra)
      return parts.length ? parts.join('; ') : null
    }
    let info = await fs.stat(target)
    // 历史落点（只读扫描 + 一次性搬进正确位置）：候选由环境面给（包形态三代、外壳第一代、
    // 没有历史的形态给空数组）。文件名沿用 projectStorageFileName，故能与历史产物一一对上。
    for (const cand of await ports.legacyTargets(cwd, fileName)) {
      try {
        const legacyTarget = await fs.resolve(cand.path, cand.cwd ? { cwd: cand.cwd } : undefined)
        const legInfo = await fs.stat(legacyTarget)
        if (!legInfo) continue
        const raw = await fs.readText(legacyTarget)
        await fs.writeText(target, raw, { kind: 'createIfAbsent' })
        info = await fs.stat(target)
        if (info) break
      } catch (e) {
        migrateNotes.push('旧落点迁移失败：' + describeError(e))
      }
    }
    // ---- 旁挂留言文件：**主文件在不在都读** ----
    // 主文件丢了（或被损坏自愈重置）时，留言不该跟着消失 —— 那是另一个文件的事。
    let sideMessages: Message[] | null = null
    let sideVersion: number | null = null
    let sideSeq = 0
    try {
      const sideInfo = await fs.stat(sidecar)
      if (sideInfo) {
        sideVersion = sideInfo.version
        const sideRaw = await fs.readText(sidecar)
        try {
          const sd = JSON.parse(sideRaw)
          if (sd && Array.isArray(sd.messages)) {
            sideMessages = sd.messages
            sideSeq = Number(sd.seq) || 0
          } else {
            migrateNotes.push('留言旁挂文件结构无效（messages 不是数组）：本次按无留言处理，原文件未改动')
          }
        } catch (e) {
          // 解析失败**不删不覆盖**：先原样备份成 `<side>.corrupt-<ms>`，再按无留言继续。
          // 不备份的话，下一次"留言变了"的写盘会把它整份换掉 —— 那就是静默丢留言。
          let note = '留言旁挂文件损坏：' + describeError(e)
          let backedUp = false
          try {
            const backupTarget = await fs.resolve(sidecar.displayPath + '.corrupt-' + now())
            await fs.writeText(backupTarget, sideRaw, { kind: 'createIfAbsent' })
            note += '；备份：' + fs.processPath(backupTarget)
            backedUp = true
          } catch (be) { note += '；备份失败：' + describeError(be) }
          // 与主文件自愈同一降级纪律：备份成功后才顺手清理旧备份，清理失败绝不影响自愈路径。
          // **旁挂的备份也纳入同一份保留份数**（0.16.0 修）：调用方传旁挂自己的文件名。
          if (backedUp) await pruneCorruptBackups(ports, stateDir, sidecarNameOf(fileName))
          migrateNotes.push(note)
        }
      }
    } catch (e) {
      // 读不到（stat / readText 抛错）：**故意**把 sideVersion 留在 null。
      // 真实 fs 对"已存在但本次没读过"的目标会拒绝 replaceIfVersion，于是后续写盘走
      // createIfAbsent 时会失败并重试 —— 宁可让这次 op 失败，也不拿一份读不到的内容去覆盖。
      migrateNotes.push('留言旁挂文件读取失败：' + describeError(e))
    }
    if (!info) {
      const empty = core.init()
      if (sideMessages) { empty.messages = sideMessages; empty.seq = sideSeq }
      return { state: empty, version: null, target, sidecar, sideVersion, messagesInMain: false, stateDir, warn: mergeWarn(null) }
    }
    const raw = await fs.readText(target)
    let s: StateDocument
    let parsed: any = null
    try {
      parsed = JSON.parse(raw)
      s = Object.assign(core.init(), parsed)
    } catch (e) {
      // 自愈而非砖化：保留损坏文件的备份，重置为空状态并把问题作为 warning 上报。
      // **不许谎报**：备份/重置各自是否成功必须如实写进 warning —— 否则"损坏内容是否还在磁盘上、
      // 下一次 load 会不会又炸"这两件事在返回值里无从判断（原实现两处 catch 都吞掉却照旧宣称成功）。
      const backupSuffix = '.corrupt-' + now()
      let backupPath: string | null = null
      let backupFailure: string | null = null
      try {
        const backupTarget = await fs.resolve(target.displayPath + backupSuffix)
        await fs.writeText(backupTarget, raw, { kind: 'createIfAbsent' })
        backupPath = fs.processPath(backupTarget)
      } catch (backupError) {
        backupFailure = describeError(backupError)
      }
      // 备份写成功后才顺手清理旧备份（失败时不删：那会把"证据"清掉而没留下新的）。
      // 这一步自带完整降级（见 pruneCorruptBackups），绝不会让自愈路径失败。
      if (backupPath !== null) await pruneCorruptBackups(ports, stateDir, fileName)
      let resetOk = false
      let resetFailure: string | null = null
      try {
        // 重置写的是**主文件那一半**（不含 messages）：旧布局的 messages 键不能借着重置复活。
        await fs.writeText(target, JSON.stringify(mainDocOf(core.init())), { kind: 'replaceIfVersion', version: info.version })
        resetOk = true
      } catch (resetError) {
        resetFailure = describeError(resetError)
      }
      // 证据链：如实交代原始损坏内容此刻的下落（已备份 / 被重置覆盖 / 仍原样留在磁盘上）。
      const corruptWarn = '状态文件损坏'
        + (resetOk ? '；已重新初始化' : '；重新初始化失败：' + resetFailure)
        + (backupPath ? '；备份：' + backupPath : '')
        + (backupFailure ? '；备份失败：' + backupFailure : '')
        + (resetOk ? '' : '；原始损坏内容仍留在磁盘上')
        + (backupFailure && resetOk ? '；原始损坏内容已被重置覆盖' : '')
      // 主文件重置了，但旁挂留言还在：把它们并进返回值，别让"主文件坏了"看起来像"板也空了"。
      const empty = core.init()
      if (sideMessages) { empty.messages = sideMessages; empty.seq = sideSeq }
      return { state: empty, version: null, target, sidecar, sideVersion, messagesInMain: false, stateDir, warn: mergeWarn(corruptWarn) }
    }
    // 旧布局（主文件里**仍有** messages）与旁挂**都有**留言时按 `msgId` 求**并集**（0.16.0，
    // R2 残留修）：跨版本滚动升级期间，旧版写主文件、新版写旁挂，任何"以某一边为准"都会
    // 在下次写盘时把另一边整批覆盖掉。同 msgId 以主文件那份为准，顺序按 seq 升序。
    const messagesInMain = !!(parsed && Array.isArray(parsed.messages))
    if (messagesInMain && sideMessages) s.messages = unionMessages(core, parsed.messages, sideMessages)
    else if (messagesInMain) s.messages = parsed.messages
    else if (sideMessages) s.messages = sideMessages
    else s.messages = []
    // seq 是 claimId 与 msgId 共用的计数器：取两边的较大值，避免复用已发过的 id。
    s.seq = Math.max(Number(parsed && parsed.seq) || 0, sideSeq)
    // 写者戳（单元 C）：主文件那一半说了算；缺字段（老状态文件）归一为空串 = "观测不到"。
    s.writer = parsed && typeof parsed.writer === 'string' ? parsed.writer : ''
    // 终态墓碑表（单元 C）：缺字段（老状态文件）归一为空表。只认纯数字值，坏值当 0（= 立即可回收）。
    const relRaw = parsed && parsed.released
    const released: Record<string, number> = {}
    if (relRaw && typeof relRaw === 'object' && !Array.isArray(relRaw)) {
      for (const id of Object.keys(relRaw as Record<string, unknown>)) {
        if (!id) continue
        released[id] = Number((relRaw as Record<string, unknown>)[id]) || 0
      }
    }
    s.released = released
    s.claims = Array.isArray(s.claims) ? s.claims : []
    s.messages = Array.isArray(s.messages) ? s.messages : []
    s.holders = Array.isArray(s.holders) ? s.holders : []
    return { state: s, version: info.version, target, sidecar, sideVersion, messagesInMain, stateDir, warn: mergeWarn(null) }
  }

  /**
   * 落盘：**先写旁挂，再写主文件**。
   *
   * 顺序不能反：迁移那一次主文件里的 `messages` 键会被去掉，如果主文件先写成功而旁挂写失败，
   * 留言就只剩内存里那一份了。旁挂先写 ⇒ 任何一步失败时，磁盘上一定还留着一份完整的留言
   * （旧布局时在主文件里，迁移后的新布局里在旁挂）。
   *
   * `messagesInMain` = 主文件里还带着旧布局的 messages ⇒ 这一次**必须**写旁挂（把留言搬过去），
   * 否则主文件里那个键被去掉之后留言就无处可存。其余情况只看指纹（判据与可靠性见 msgFingerprint）。
   */
  async function writeState(
    next: StateDocument, version: number | null, target: FileRef,
    sidecar: FileRef, sideVersion: number | null, messagesInMain: boolean, fpBefore: string
  ): Promise<void> {
    const writeSide = messagesInMain || msgFingerprint(next.messages) !== fpBefore
    if (writeSide) {
      const sideBody = JSON.stringify(sideDocOf(next))
      if (sideVersion === null) await fs.writeText(sidecar, sideBody, { kind: 'createIfAbsent' })
      else await fs.writeText(sidecar, sideBody, { kind: 'replaceIfVersion', version: sideVersion })
    }
    // 主文件：本模块**每一次**写盘都写它 —— 它承载声明/名册/seq，本来就是被改的那一半，
    // 而且只有 KB 级（写放大问题从来不在这一半）。写进去的内容里永远不含 messages。
    const mainBody = JSON.stringify(mainDocOf(next))
    if (version === null) await fs.writeText(target, mainBody, { kind: 'createIfAbsent' })
    else await fs.writeText(target, mainBody, { kind: 'replaceIfVersion', version })
  }

  /**
   * **本实例的本地副本**（单元 C，载荷收敛的核心）。
   *
   * 为什么需要它：盘上的写入是"读改写"，而 CAS 只在本进程有效（实测：两个进程可以同时
   * probe 到同一个 version、各自 rename 都成功，后写者静默覆盖先写者 = 丢更新）。一旦被覆盖，
   * 丢失的那份改动**已经不在盘上**，只在丢掉它的那个写者的记忆里 —— 所以要有一个跨调用保留的
   * 本地副本，下一次写盘时把"盘上 ∪ 我的副本"按半格 join 合起来，两边独有的记录都不丢。
   *
   * 只用于**写路径**（读路径仍以盘上为准，行为不变）。它只在 merge 与 sweep 的收敛规则下
   * 增长与收缩：已过期的记录会被 sweep 再清一次，越限留言会被同一条确定性规则再截一次，
   * 墓碑（`released`）参与 join 因而"释放"不会被旧副本翻案。所以它不会把状态带偏。
   */
  let replica: StateDocument | null = null

  /**
   * 写后验证（单元 C）：落盘成功 **不等于** 这份内容还在盘上。
   *
   * `replaceIfVersion` 是 probe → rename，而串行化锁是文件系统实例的**实例字段**（只在本进程
   * 内排队）—— 两个写者可以同时 probe 成功、各自 rename 成功，后写者静默覆盖先写者。所以写完
   * 必须**重读主文件**确认盘上的写者戳还是我自己。
   *
   * 三态（fail-open，只认"明确被别人盖了"这一种失败）：
   *   · 盘上的 `writer` 就是我自己 ⇒ 我的写入还在（true）；
   *   · `writer` 是**另一个非空**写者 ⇒ 被覆盖了（false）⇒ 重读 + 重合并 + 重试；
   *   · 观测不到（没有 stat / 读不出 / JSON 坏 / 没有 writer 字段 / 本形态给不出写者戳）⇒ 不判定
   *     （true）—— 这里绝不能把"观测不到"当成"被覆盖"，否则没有写入能力的宿主形态会被反复重试。
   */
  async function writeLanded(target: FileRef): Promise<boolean> {
    if (!WRITER_ID) return true
    let info: { version: number } | null
    try { info = await fs.stat(target) } catch (e) { return true }
    if (!info) return true
    let doc: unknown
    try { doc = JSON.parse(await fs.readText(target)) } catch (e) { return true }
    const w = doc && typeof doc === 'object' ? (doc as { writer?: unknown }).writer : undefined
    if (typeof w !== 'string' || w === '') return true
    return w === WRITER_ID
  }

  /**
   * 读改写事务：load → merge(盘上, 我的副本) → sweep → op → 写盘 → **写后验证**；
   * 写失败（乐观并发冲突）或验证发现被覆盖时，重读 + 重合并 + 重试（最多 5 轮）。
   *
   * 0.15.0（R2 残留）：`sweep()` 在**读路径**只清内存、在**写路径**把清理结果落盘 —— 包括
   * 该 op 自己 `changed:false` 的情形（否则反复 release 不存在的路径 / reap dry-run / reader
   * 已登记这几条路径会让磁盘长期留着已清理的内容，**视图与磁盘长期不一致**）。
   * 这一条过去**只有包形态**有，外壳形态漏了；现在两形态共用本函数，不再有第二个口径。
   *
   * 单元 C（载荷收敛）：合并与截断的**顺序**是硬约束 —— 先 join、**再**截断留言。反过来
   * （各自先截一半）会让两个副本截出不同的尾巴，来回抖动、永不收敛。合并之后的截断由
   * `sweep()` 用同一条确定性规则（条数 / 字节预算，都丢最旧）施加，因此两边结果相同。
   */
  async function mutate(fn: (s: StateDocument) => OpResult, agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    // 「本次 op 的结果」跨重试携带。重试**不重跑 op**，只做"重读 → 重合并 → 重写 → 再验证"：
    // 重跑对 claim 只是幂等（会并回自己那条），但对 post 会**再多出一条 seq 不同的留言**
    // —— 同一条消息落两条。op 的效果已经在 `applied` 里，合并它即可。
    let applied: StateDocument | null = null
    let resultData: OpData | undefined
    for (let i = 0; i < 5; i++) {
      const { state, version, target, sidecar, sideVersion, messagesInMain } = await load(agentId, agent)
      let next: StateDocument
      let fpBefore: string
      if (applied) {
        // 重试路径：把「本次 op 的结果」与新盘按半格 join 合起来，再按同一条确定性规则 sweep
        // （截断必须在合并**之后**：两个副本各自先截一半会让尾巴来回抖动、永不收敛）。
        next = core.mergeDocs(state, applied)
        next.writer = WRITER_ID
        fpBefore = msgFingerprint(state.messages)
        core.sweep(next, now(), sweepOpts(next))
      } else {
        // 「我的」= 盘上 ∪ 本实例的副本（半格 join）。首次写盘时副本为空 ⇒ 与旧行为逐字相同。
        const mine = replica ? core.mergeDocs(state, replica) : core.normalizeDoc(state)
        // 盖上**本次写者**的戳：它既是拿出去落盘的 `writer`，也是本事务里分配 id 的写者戳
        // （`claim`/`post`/`releaseOnLoopEnd` 从 state.writer 取），还是写后验证的判据。
        mine.writer = WRITER_ID
        // 跑 op **之前**取留言指纹：sweep() 也会截断留言（条数/字节上限），所以要在它之前取，
        // 否则"这次只清掉了旧留言"会被判成"留言没变"而丢掉截断结果。
        fpBefore = msgFingerprint(mine.messages)
        const swept = core.sweep(mine, now(), sweepOpts(mine))
        // 把"盘上学到的 ∪ 副本 ∪ 本次 sweep 的确定性清理"立刻留在副本里：即使本次 op 被挡回
        // （错误分支与 not-found 都不写盘），下一次也能看见这次的清理结果 —— 否则一块已到期的
        // 墓碑会把某条路径永久卡在"盘上有、副本以为没有"的状态里。
        replica = core.normalizeDoc(mine)
        let out: OpResult | undefined
        try {
          out = fn(mine)
        } catch (e) {
          if (e && e.collabConflict) return { ok: false, error: 'conflict', conflicts: e.conflicts }
          throw e
        }
        if (!out || out.changed === false) {
          if (!out) return { ok: false, error: 'not-found', message: 'nothing to change' }
          const data = out.data || {}
          // 统一错误信封：ok:false 时 error/message 提升到顶层，调用方无需再挖 data。
          // **错误分支绝不写盘**：被挡回的 op 没有产生任何该持久化的状态。
          if (out.ok === false) return { ok: false, error: data.error || 'bad-request', message: data.message, ...data }
          // 本次 op 自己什么都没改时，过去会直接返回、不写盘。但 `sweep()` 已经在**这个事务里**
          // 清掉了过期声明 / 超限留言 / 死名册行 —— 丢掉它们意味着：读路径只 sweep 内存、不写盘，
          // 只要写操作一直返回 changed:false（反复 release 不存在的路径、reap dry-run、reader 已登记），
          // 磁盘就会长期留着已清理的内容，**视图与磁盘长期不一致**。
          // 所以只要本次确实有清理，就把它写回；返回值形状保持不变（仍 `{ok:true, data}`）。
          const cleaned = swept.expiredClaims > 0 || swept.droppedMessages > 0 || swept.prunedHolders > 0
          if (out.changed === false && !cleaned) return { ok: true, data }
          if (out.changed !== false && (swept.droppedMessages > 0 || swept.prunedHolders > 0)) {
            out.data = Object.assign({}, out.data, { swept })
          }
          resultData = out.changed === false ? data : out.data
        } else {
          // 「截断发生了」必须在返回值里可见（本模块两形态同源 ⇒ 这一条对两个形态同时成立）：
          // 留言被条数/字节预算丢掉、或名册行被回收时，把 swept 附到 data 上如实报数。
          if (swept.droppedMessages > 0 || swept.prunedHolders > 0) {
            out.data = Object.assign({}, out.data, { swept })
          }
          resultData = out.data
        }
        // changed:false 的 op 可能不带 state（如 registerReader 的幂等分支）；此时本地 `mine`
        // 就是唯一事实（fn 在 changed:false 语义下不改它，sweep 已经改过它）。
        next = out.state || mine
      }
      // 失败重试都从这里继续：`applied` 已带上本次 op 的结果，下一轮只重读重合并重写。
      applied = next
      next.writer = WRITER_ID
      try {
        await writeState(next, version, target, sidecar, sideVersion, messagesInMain, fpBefore)
      } catch (e) {
        if (stale(e) && i < 4) continue
        throw e
      }
      // 先把本次结果留在副本里，再验证：验证失败（被别人覆盖）时下一轮就是
      // merge(新盘, 我的结果) —— 我的改动不会被丢掉。
      replica = core.normalizeDoc(next)
      // **写后验证**：落盘成功不等于这份内容还在盘上（replaceIfVersion 是 probe → rename，
      // 两个写者可以同时 probe 成功、各自 rename 成功）。重读主文件确认写者戳还是我自己；
      // 不是（被别人覆盖了）⇒ 重读 + 重合并 + 重试。观测不到时不判定（见 writeLanded）。
      if (await writeLanded(target)) return { ok: true, data: resultData || {} }
    }
    return { ok: false, error: 'concurrent-modification', message: 'state busy, retry later' }
  }

  /**
   * 跨项目观测（0.9.11）：把**别的项目**的占用摘要附在 overview 的返回里。
   *
   * 为什么走"输出侧附加"而不是给工具加 `project` / `all` 入参：加参数要改 SSOT 契约
   * （src/schema/collab.schema.json）并同步 4 份派生物（TS / Python / Rust / 包形态真实 schema），
   * 而排障真正缺的是"我能看见别人占着什么"，不是"按名字精确查某个项目"。
   *
   * 纪律三条：只读（不改任何项目文件）；失败降级（fs 没有 listDir / 目录不存在 / 单个文件损坏
   * 都只是"看不到别的项目"）；不编造（本项目那几个数字一字不动）。
   */
  async function otherProjects(current: FileRef, stateDir: string, t: number): Promise<Record<string, unknown>> {
    try {
      if (typeof fs.listDir !== 'function') {
        return { otherProjects: [], otherProjectsNote: '宿主 fs 不提供 listDir：只能看到当前项目' }
      }
      const dir = await fs.resolve(stateDir)
      const entries = await fs.listDir(dir)
      const here = fs.processPath(current)
      const out: Array<{ file: string; statePath: string; totalClaims: number; claims: unknown[] }> = []
      for (const e of entries) {
        if (!e || typeof e.name !== 'string' || !/\.json$/.test(e.name) || !e.target) continue
        // **排除留言旁挂文件**：它也以 .json 结尾，不排掉就会被当成"另一个项目"去 parse。
        // （旁挂本身没有 claims，parse 得出来也只会得到一个空项目，但那是错的分类，
        //  而且把 80 KB 的留言整个读进来只为知道"它没有声明"。）
        if (e.name.endsWith(SIDECAR_EXT)) continue
        if (fs.processPath(e.target) === here) continue
        let doc: any
        try { doc = JSON.parse(await fs.readText(e.target)) } catch (err) { continue }
        if (!doc || typeof doc !== 'object') continue
        const claims = Array.isArray(doc.claims) ? doc.claims : []
        const active = claims.filter((c: any) => c && typeof c.expiresAt === 'number' && c.expiresAt > t)
        if (!active.length) continue
        out.push({
          file: e.name,
          statePath: fs.processPath(e.target),
          totalClaims: active.length,
          claims: active.map((c: any) => ({
            holderId: c.holderId,
            holderName: c.holderName,
            mode: c.mode,
            paths: Array.isArray(c.paths) ? c.paths : []
          }))
        })
      }
      out.sort((a, b) => b.totalClaims - a.totalClaims)
      return { otherProjects: out.slice(0, 10) }
    } catch (e) {
      log('[dsh-collab] 列举其他项目失败：' + describeError(e))
      return { otherProjects: [], otherProjectsNote: '列举其他项目失败：' + describeError(e) }
    }
  }

  async function list(agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const { state, target, stateDir, warn } = await load(agentId, agent)
    const t = now()
    // 先 sweep 再取视图：死掉的名册行（句柄结束 / 写它的进程不在了）在返回里根本不出现；
    // stale 用的是 1h 预警阈值（见 HOLDER_STALE_WARN_MS），因此在产品路径上依然是可达信号。
    // 注意：`sweep()` 返回 SweepResult **对象**，而 `expire()` 返回数字。0.13.0 起 list 的
    // `expiredCount` 是**数字**（"这次调用顺手扫掉几条过期声明"），动态宿主形态也仍是数字 ——
    // 这里必须取 `.expiredClaims`，别把用户可见契约悄悄换成对象（2026-10 审计抓到的在飞回归）。
    const swept = core.sweep(state, t, sweepOpts(state))
    const ex = swept.expiredClaims
    const hv = core.holderView(state, t)
    // holdersNote 只在**有 stale 条目**时出现：名册被读成"过期锁"的实测现场才有这句话，
    // 干净项目一个字都不加（与 otherProjects / teamTasks 同一降级纪律）。
    const rosterNote = core.holderRosterNote(hv.staleHolders)
    const data: Record<string, unknown> = {
      seq: state.seq,
      serverTime: t,
      statePath: fs.processPath(target),
      stateDir,
      schemaVersion: state.schemaVersion,
      // 0.14.0（C）：名册**有界**返回。过去逐条返回整份名册（现场 56 行 / 约 10 KB 一次），
      // 而每一步都注入的态势摘要早就把 claims 压到「3 条 × 2 路径」。截断不丢事实：
      // holdersTotal 恒在，调用方自己看得出被折叠了。
      holders: hv.holders.slice(0, core.HOLDER_VIEW_LIMIT),
      holdersTotal: hv.holders.length,
      staleHolders: hv.staleHolders,
      claims: state.claims.map(pub),
      expiredCount: ex
    }
    if (rosterNote) data.holdersNote = rosterNote
    return { ok: true, data: withWarn(data, warn) }
  }

  async function overviewOp(agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const { state, target, stateDir, warn } = await load(agentId, agent)
    const t = now()
    core.sweep(state, t, sweepOpts(state))
    const o = core.overview(state)
    const other = await otherProjects(target, stateDir, t)
    // 官方团队在跑任务的 advisory 写域（0.11.0）：**输出侧附加**，与 otherProjects 同一纪律。
    // 服务缺席 ⇒ 一个字段都不加（一字不变）；服务在场但此刻没有在跑任务 ⇒ `teamTasks: []` + 明说。
    const team = typeof ports.teamTasks === 'function' ? ports.teamTasks(agent) : null
    const teamField = team === null
      ? {}
      : (team.length
        ? { teamTasks: team, teamTasksNote: '来自官方 Agent Teams 的在跑任务；write_scopes 是 advisory，不参与本插件的门控' }
        : { teamTasks: [], teamTasksNote: '官方 Agent Teams 服务在场：此刻没有在跑任务' })
    return {
      ok: true,
      data: withWarn(Object.assign({
        statePath: fs.processPath(target),
        stateDir,
        serverTime: t,
        totalClaims: o.totalClaims,
        holders: o.holders
      }, other, teamField), warn)
    }
  }

  async function status(a: CollabArgs, agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const { state, target, stateDir, warn } = await load(agentId, agent)
    const t = now()
    core.sweep(state, t, sweepOpts(state))
    const paths = (Array.isArray(a.paths) ? a.paths : []).map(core.norm).filter(Boolean)
    const rel = core.related(state, paths)
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
    // 与 list / status 同一降级纪律：load() 的 warning（例如"本会话没有 cwd ⇒ 按项目隔离已失效"）
    // **必须透传**。0.13.0 之前这里只解构 { state }，把警告丢了 —— 于是"你在读另一个项目的板"
    // 这件事返回到调用方手里时一个字都没有，而 read 与 list 的返回形状本来就该一致。
    const { state, warn } = await load(agentId, agent)
    return { ok: true, data: withWarn(core.filterMessages(state, a), warn) }
  }

  /**
   * op=reap（0.9.8）：把 collab-core 的纯函数 reap() 接到状态存取层上。
   *
   * 只在这里做一件纯逻辑之外的事：**取活体名单**（由环境面给）。拿不到就传 null，
   * 由 reap() 自己如实标 `livenessCheck: 'unavailable'` 且**一个也不收**。
   *
   * dry-run 时 reap() 返回 `changed:false`，于是 mutate() 直接返回、**不写盘** ——
   * "默认不改状态"由状态层自身的写入门槛保证，不是靠这里多写一个 if。
   * 本 op **只在工具 handler 显式调用时**发生；没有被 sweep()/读路径/定时器引用（见 tests/collab-reap.mjs 的静态断言）。
   */
  async function reapOp(a: CollabArgs, h: HolderInput, agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const live = ports.liveAgentHolderIds()
    return mutate(s => core.reap(s, h, a, live, now()), agentId, agent)
  }

  async function waitFor(a: CollabArgs, h: HolderInput, agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const timeoutMs = Math.max(0, Math.min(120000, Number(a.timeoutMs) || 30000))
    const paths = (Array.isArray(a.paths) ? a.paths : []).map(core.norm).filter(Boolean)
    if (!paths.length) return { ok: false, error: 'bad-request', message: 'paths required' }
    const deadline = now() + timeoutMs
    let bList: Claim[] = []
    while (now() < deadline) {
      const { state } = await load(agentId, agent)
      const t = now()
      bList = core.blockers(state, t, h, paths)
      if (bList.length === 0) return { ok: true, data: { paths, blockers: [], waitedMs: Math.round(timeoutMs - Math.max(0, deadline - now())) } }
      await ports.sleep(400)
    }
    return { ok: false, error: 'timeout', message: 'paths still claimed', paths, blockers: bList.map(pub), waitedMs: timeoutMs }
  }

  return { load, mutate, list, overviewOp, status, msgs, reapOp, waitFor }
}
