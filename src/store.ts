// src/store.ts
// **状态文件的存取层**：路径解析、读改写（乐观并发重试 + 损坏自愈 + 历史落点迁移）、
// holder 身份与显示名，以及全部只读查询 op（list / overview / status / msgs / wait）。
// 本模块是唯一碰状态文件的地方；apply() 只做组合，不在这里。
//
// installStore() 的返回值就是它对外暴露的全部能力：其他 installer 通过参数**显式**
// 接收它。段间不共享任何模块级可变状态。

import { rm } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  init, sweep, publish, overview, related, filterMessages, blockers, holderView,
  cleanName, norm, projectStorageFileName, reap, holderRosterNote, HOLDER_VIEW_LIMIT
} from './collab-core.js'
import type { Claim, HolderInput, Message, OpResult, PublishedClaim, StateDocument } from './collab-core.js'
import type { TeamScopeTask } from './collab-core.js'
import { selfProcToken, liveProcsOf } from './proc-id.js'
import { LEGACY_PROJECT_FILE, collabDir, projectStateFile, legacyCollabDirs } from './paths.js'
import type {
  AgentLike, AgentTeamsServiceLike, AgentsLookupService, CollabArgs, CollabContext, CollabFs, FileRef,
  LoadResult, SessionsService, SessionTitleService, ToolExecContext, ToolResult
} from './contract.js'

/** 状态存取面：installStore() 对外暴露的东西，也是其他 installer 的唯一状态入口。 */
export interface StateStore {
  fs: CollabFs
  now(): number
  /** 功能 D 的存活判据：三态（live / not-live / failed）—— 基础设施故障不得折叠成"读者没在线"。 */
  livenessOf(sessionId: string): { state: 'live' | 'not-live' | 'failed'; error?: string }
  /**
   * 会话家族（血缘）的 holderId 集合：自己 + 祖先链 + 后代。**只用于冲突判定，不落盘。**
   * 拿不到 agents 服务时退化为 `[self]`（= 0.9.10 的语义）。
   */
  familyIds(agentId: string | null, agent?: AgentLike): string[]
  /** 后代会话 id（不含自己）。自动释放的"有子代理在跑"判据用。 */
  descendantIds(agentId: string | null): string[]
  /**
   * 官方 Agent Teams **在跑任务**（status='in_progress'）的 advisory 写域（0.11.0）。
   * 语义三态，必须区分：
   *   - `null`  = 服务缺席 / 读不到（agentTeams 未启用、caller 非成员、宿主抛错）⇒ 上层**一字不变**；
   *   - `[]`    = 服务在场、但此刻没有在跑任务；
   *   - 非空数组 = 在跑任务的写域。**只读**，绝不参与门控/冲突判定。
   */
  teamTasks(agent?: AgentLike): TeamScopeTask[] | null
  cwdOf(agentId: string | null, agent?: AgentLike): Promise<string | null>
  load(agentId: string | null, agent?: AgentLike): Promise<LoadResult>
  mutate(fn: (s: StateDocument) => OpResult, agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  holderOf(exec: ToolExecContext): HolderInput & { agent?: AgentLike }
  hname(h: HolderInput & { agent?: AgentLike }): string
  list(agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  overviewOp(agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  status(a: CollabArgs, agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  msgs(a: CollabArgs, agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  /** op=reap（0.9.8）：僵尸声明的**显式**回收。默认 dry-run，见 collab-core.ts 的 reap 注释。 */
  reapOp(a: CollabArgs, h: HolderInput, agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  waitFor(a: CollabArgs, h: HolderInput, agentId: string | null, agent?: AgentLike): Promise<ToolResult>
}

export function installStore(ctx: CollabContext): StateStore {
  const fs = ctx.fs
  const sessions = ctx.get('sessions') as SessionsService | undefined
  const sessionTitle = ctx.get('sessionTitle') as SessionTitleService | undefined
  const now = (): number => Date.now()

  // ---- 名册行的进程判据（0.14.0，B2）----
  // 本进程的身份令牌只算一次（`<pid>:<开机节拍>`）。拿不到（非 Linux / 读不到 /proc / 解析失败）
  // 就是 null：此时**不盖章**，`sweepOpts` 里的 liveProcs 也必然不可用 —— 两者一起退回 24h TTL
  // 老口径（fail-closed：漏收只是维持现状，误收会删掉活会话的行）。
  const PROC_TOKEN = selfProcToken()
  // 每次 sweep **现算**：判据只看 state 里实际出现过的那几个进程，不引入定时器、不做全表扫描。
  const sweepOpts = (state: StateDocument): { liveProcs: Set<string> | null; procStamping: boolean } => {
    const toks: string[] = []
    if (Array.isArray(state.holders)) {
      for (const h of state.holders) {
        const p = h && typeof h.proc === 'string' ? h.proc : ''
        if (p && toks.indexOf(p) < 0) toks.push(p)
      }
    }
    return { liveProcs: liveProcsOf(toks), procStamping: PROC_TOKEN !== null }
  }

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

  /** 把任意抛出物转成一行可读文本（warning 里要带真实原因，不能只写「失败了」）。 */
  const describeError = (e: unknown): string => {
    try {
      const m = e && typeof e === 'object' ? (e as { message?: unknown }).message : undefined
      if (typeof m === 'string' && m) return m
      return String(e)
    } catch (e2) {
      return 'unknown error'
    }
  }

  /** 功能 D 的存活判据（0.8.3 起）**只用于"此刻要不要推"**，绝不再用于清理 readers 登记。
   *  （判据实现见上面的 livenessOf：三态，基础设施故障与"没在线"分开报。）
   *  0.8.2 曾在 mutate() 里把它注入 sweep()，于是"只是空闲、并未结束"的读者
   *  （agents.get(sessionId) 对休眠会话返回 undefined）会在下一次任意写路径上被删掉，
   *  该 claim 释放时已无人可推 —— 静默丢通知。读者的移除只走 dropHolder()（agent/disposed）；
   *  它**只摘 reader 登记 + 回收该 holder 已过期的声明 + 摘掉它的名册行**（0.14.0）；
   *  未过期声明的释放归同事务里的 `releaseOnLoopEnd(..., 'disposed')`（0.13.0 起，见 src/push.ts）。
   *  判据本身仍是 push 前的安全闸：拿不到 agents 服务时一律不推，
   *  因为推送会 resume 冷会话，宁可少推也不能唤醒。 */
  /**
   * 存活判据的**三态**（0.9.0）：
   *   'live'     = 会话此刻在 agents 注册表里；
   *   'not-live' = 会话未加载（**刻意不唤醒**，两个通道都不许碰它；含 agents 服务整个缺失）；
   *   'failed'   = 判据**本身**坏了（`agents.get()` 抛异常）—— 这是基础设施故障，不是"读者没在线"。
   * 前两态都返回 false（不推），第三态让调用方如实记 `liveness-check-failed` 而不是谎报 `not-live`。
   */
  const livenessOf = (sessionId: string): { state: 'live' | 'not-live' | 'failed'; error?: string } => {
    try {
      const svc = ctx.get('agents') as AgentsLookupService | undefined
      if (!svc || typeof svc.get !== 'function') return { state: 'not-live' }
      return svc.get(sessionId) ? { state: 'live' } : { state: 'not-live' }
    } catch (e) {
      return { state: 'failed', error: describeError(e) }
    }
  }

  /**
   * op=reap 的活体检查（0.9.8）：`agents.list()` 的 holderId 列表（`'agent:' + a.id`）。
   * 返回 **null** 表示检查**没跑成**（服务/方法缺失或抛错）—— 与"名单为空"是两件事：
   * 前者必须一个也不收（拿不到名单时"不在名单里"没有信息量），后者是"此刻确实没有活着的 agent"。
   * 该区别由 collab-core.ts 的 reap() 用 `liveHolderIds === null` 承载（两形态同形）。
   */
  const liveAgentHolderIds = (): string[] | null => {
    try {
      const svc = ctx.get('agents') as AgentsLookupService | undefined
      if (!svc || typeof svc.list !== 'function') return null
      const arr = svc.list()
      if (!Array.isArray(arr)) return null
      const out: string[] = []
      for (const a of arr) {
        const id = a && a.id ? String(a.id) : null
        if (id) out.push('agent:' + id)
      }
      return out
    } catch (e) {
      return null
    }
  }

  // ---- 会话家族（血缘）：只用于冲突判定，**不进状态文件** ----
  //
  // 为什么要它：子代理跑在自己的会话里，holderId 是 `agent:<子会话 id>`，与父会话不等。
  // 于是"父会话 claim src/ 再派子代理改 src/"会被自己的锁硬拒绝（本部署 ask = deny），
  // 而子代理无权 release（只有持有者本人能）。父子是同一个写域。
  // 血缘来源：子代理创建时写入的 `session.header.parentSession`
  // （`dsh-subagent/lib/types/child-agent.js:117-123`）；祖先链写法照
  // `dsh-subagent/lib/types/continuation-activation.js:381-388` 的先例。
  //
  // 三条纪律：
  //   1. **只缩不放**——拿不到 agents 服务 / 读不到血缘时退化为 `[self]`，语义与 0.9.10 一致；
  //   2. **不落盘**——每次从运行时现算，holder() 只挑已知字段写状态文件；
  //   3. **带上环保护与深度上限**——血缘字段来自会话头，不能假设它是良构的。
  const LINEAGE_MAX_DEPTH = 16

  /** 某个会话的父会话 id（拿不到就 null，**不猜**）。 */
  const parentSessionOf = (id: string, self?: AgentLike): string | null => {
    try {
      let a: AgentLike | undefined
      if (self && self.id && String(self.id) === id) a = self
      else {
        const svc = ctx.get('agents') as AgentsLookupService | undefined
        a = svc && typeof svc.get === 'function' ? svc.get(id) : undefined
      }
      const p = a && a.session && a.session.header ? a.session.header.parentSession : undefined
      return typeof p === 'string' && p ? p : null
    } catch (e) { return null }
  }

  /** 祖先链（不含自己），由近及远。 */
  const ancestorIds = (agentId: string, self?: AgentLike): string[] => {
    const out: string[] = []
    const seen = new Set<string>([agentId])
    let cur = parentSessionOf(agentId, self)
    while (cur && !seen.has(cur) && out.length < LINEAGE_MAX_DEPTH) {
      seen.add(cur); out.push(cur); cur = parentSessionOf(cur)
    }
    return out
  }

  /**
   * 后代（不含自己）：`agents.list()` 里祖先链命中我的会话。
   * 注意 list() **只含此刻加载着的** agent —— 所以这个集合天然会比"我派生过的全部"小，
   * 这正好是我们要的方向：只放行**还活着**的自家人。
   */
  const descendantIds = (agentId: string | null): string[] => {
    const out: string[] = []
    if (!agentId) return out
    try {
      const svc = ctx.get('agents') as AgentsLookupService | undefined
      if (!svc || typeof svc.list !== 'function') return out
      const arr = svc.list()
      if (!Array.isArray(arr)) return out
      for (const a of arr) {
        const id = a && a.id ? String(a.id) : ''
        if (!id || id === agentId) continue
        let cur = parentSessionOf(id, a), depth = 0
        while (cur && depth++ < LINEAGE_MAX_DEPTH) {
          if (cur === agentId) { out.push(id); break }
          cur = parentSessionOf(cur)
        }
      }
    } catch (e) {}
    return out
  }

  /** 家族 holderId 集合：自己 + 祖先链 + 后代。agentId 为空（human:console）时只有自己。 */
  const familyIds = (agentId: string | null, agent?: AgentLike): string[] => {
    const self = agentId ? 'agent:' + agentId : 'human:console'
    if (!agentId) return [self]
    const out = [self]
    for (const id of ancestorIds(agentId, agent)) out.push('agent:' + id)
    for (const id of descendantIds(agentId)) out.push('agent:' + id)
    return out
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

  // ---- 磁盘布局（0.15.0，R2）：主文件 + 留言旁挂 ----
  //
  // 为什么拆：一份状态文件里 **97% 的字节是留言**（实测 82,248 B：留言 79,815 B、声明 1,313 B、
  // 名册 1,058 B），而 claim/release/heartbeat 每次都整份重写 —— 为了改 1.3 KB 的锁状态写 82 KB。
  // 拆开之后锁操作只写主文件（KB 级），那条大尾巴只在**留言真的变了**时才动。
  //
  // 硬约束：**内存里的 StateDocument 一个字不改**（仍是 `{schemaVersion, seq, claims, messages, holders}`）
  // —— src/schema/collab.schema.json 是 SSOT，TS/Python/Rust 三份派生物与全部纯函数因此零改动。
  // 变的只有"怎么把它摊到磁盘上"：
  //   <name>.json          {schemaVersion, seq, claims, holders}  主文件（锁状态）
  //   <name>.messages.json {schemaVersion, seq, messages}         旁挂（留言）
  // `seq` 两边都写：它是 claimId（`c_<seq>`）与 msgId（`m_<seq>`）**共用**的单调计数器，
  // 加载时取两边的**较大值**（主文件写得更频繁，正常情形下它就是较大值）。
  //
  // 迁移：主文件里**仍有** `messages`（旧布局）时以它为准（见 load），并在**首次写盘**时
  // 搬进旁挂、同时把主文件里这个键去掉。**只搬不删** —— 留言一条都不许丢。
  const SIDECAR_EXT = '.messages.json'
  /** `<name>.json` → `<name>.messages.json`。只在真的以 `.json` 结尾时替换，否则追加。 */
  const sidecarNameOf = (fileName: string): string =>
    fileName.slice(-'.json'.length) === '.json'
      ? fileName.slice(0, -'.json'.length) + SIDECAR_EXT
      : fileName + SIDECAR_EXT
  /** 主文件那一半。**不含 messages**：迁移之后主文件里永远不会再有这个键。 */
  const mainDocOf = (s: StateDocument) => ({
    schemaVersion: s.schemaVersion, seq: s.seq, claims: s.claims, holders: s.holders
  })
  /** 旁挂那一半。 */
  const sideDocOf = (s: StateDocument) => ({
    schemaVersion: s.schemaVersion, seq: s.seq, messages: s.messages
  })
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
  const msgFingerprint = (msgs: Message[]): string =>
    msgs.length + '|' + (msgs.length ? msgs[0].msgId : '') + '|' + (msgs.length ? msgs[msgs.length - 1].msgId : '')

  async function targetFor(agentId: string | null, agent?: AgentLike): Promise<{ cwd: string | null; target: FileRef; sidecar: FileRef; stateDir: string; fileName: string }> {
    const cwd = await cwdOf(agentId, agent)
    const fileName = projectStorageFileName(cwd || 'default')
    // 绝对状态目录（${DSH_HOME:-$HOME/.dsh}/collab/projects），与进程 cwd 无关。
    // fs.resolve 对绝对路径原样通过（实测），所以这里不做字符串拼接猜测基址。
    const stateDir = collabDir()
    const target = await fs.resolve(projectStateFile(cwd))
    // 旁挂与主文件**同一个目录、同一个名字前缀**（前缀取自 projectStorageFileName，唯一事实源）。
    const sidecar = await fs.resolve(stateDir + '/' + sidecarNameOf(fileName))
    return { cwd, target, sidecar, stateDir, fileName }
  }

  /**
   * 损坏备份的保留份数（0.14.0，M2b）。自愈每次 `JSON.parse` 失败都整份复制状态文件成
   * `<name>.json.corrupt-<ms>`，而"半截读"（并发写期间读到长度 0）会让自愈在同一个文件上
   * 反复触发 —— 旧实现**只写不清**，备份只增不减。
   */
  const CORRUPT_BACKUP_KEEP = 3

  /**
   * 顺手清理旧的损坏备份，只保留最近 `CORRUPT_BACKUP_KEEP` 份（0.14.0，M2b）。
   *
   * 三条纪律，缺一不可：
   *   1. `fs.listDir` 是**可选能力**（与 `otherProjects` 同一降级纪律）：拿不到 / 抛错就静默跳过，
   *      **绝不让自愈路径失败** —— 清理是旁路，不是自愈的前置条件；
   *   2. 只认**自己命名规则**的文件（`<状态文件名>.corrupt-<纯数字>`），且只删普通文件：
   *      别人的 `.bak-*`、别的项目的备份、非数字后缀一律不动；
   *   3. 逐份删除、失败吞掉（`ENOENT` = 目标已经不在，正是我们要的结果）。
   *
   * 删除用 `node:fs` 的 `rm`（宿主插件删自己的文件，与 `dsh-spill-local` / `dsh-storage-json`
   * 同一写法）：`ctx.fs` 服务**没有**删除原语（只有 createIfAbsent / replaceIfVersion 两种写入意图），
   * 而"只保留 N 份"必须真的把文件去掉。路径取自 `fs.processPath`，非绝对路径一律跳过。
   */
  async function pruneCorruptBackups(fileName: string): Promise<void> {
    try {
      if (typeof fs.listDir !== 'function') return
      const dir = await fs.resolve(collabDir())
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
        if (!local || !isAbsolute(local)) continue
        mine.push({ local, stamp: Number(tail) })
      }
      if (mine.length <= CORRUPT_BACKUP_KEEP) return
      mine.sort((a, b) => b.stamp - a.stamp)
      for (const old of mine.slice(CORRUPT_BACKUP_KEEP)) {
        try { await rm(old.local, { force: true }) } catch (err) {}
      }
    } catch (e) {}
  }

  /**
   * 加载结果：契约的 `LoadResult` + 三样**存取层私有**的东西（旁挂目标/版本、主文件是否
   * 还带着旧布局的 `messages`）。对外暴露面（StateStore.load）仍是 LoadResult。
   */
  interface LoadedState extends LoadResult {
    sidecar: FileRef
    sideVersion: number | null
    messagesInMain: boolean
  }

  async function load(agentId: string | null, agent?: AgentLike): Promise<LoadedState> {
    const { cwd, target, sidecar, stateDir, fileName } = await targetFor(agentId, agent)
    const warn = cwd ? null : '状态文件落在默认位置（本会话没有 cwd），按项目隔离已失效'
    // 迁移失败**不再静默**：旧落点搬不过来 = 这个项目凭空退回空状态（用户级故障，且极难自查）。
    // 复用 load() 已有的 warn 通道逐条追加 'legacy migrate failed: <原因>'；
    // 即使 warn 本身为 null（有 cwd 的正常情形）也要能把它带出来，故统一走 mergeWarn()。
    const migrateNotes: string[] = []
    const mergeWarn = (extra: string | null): string | null => {
      const parts: string[] = []
      if (warn) parts.push(warn)
      for (const n of migrateNotes) parts.push(n)
      if (extra) parts.push(extra)
      return parts.length ? parts.join('; ') : null
    }
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
      } catch (e) {
        migrateNotes.push('旧落点迁移失败：' + describeError(e))
      }
    }
    // 第二代错误落点：旧版相对进程 cwd 的 .dsh/collab/projects，以及 `~` 未展开的
    // <HOME>/~/.dsh/collab/projects。只读扫描 + 一次性搬进正确位置；文件名沿用
    // projectStorageFileName，故能与历史产物一一对上。失败不再静默（见上）。
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
        } catch (e) {
          migrateNotes.push('旧落点迁移失败：' + describeError(e))
        }
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
          if (backedUp) await pruneCorruptBackups(sidecarNameOf(fileName))
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
      const empty = init()
      if (sideMessages) { empty.messages = sideMessages; empty.seq = sideSeq }
      return { state: empty, version: null, target, sidecar, sideVersion, messagesInMain: false, stateDir, warn: mergeWarn(null) }
    }
    const raw = await fs.readText(target)
    let s: StateDocument
    let parsed: any = null
    try {
      parsed = JSON.parse(raw)
      s = Object.assign(init(), parsed)
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
      if (backupPath !== null) await pruneCorruptBackups(fileName)
      let resetOk = false
      let resetFailure: string | null = null
      try {
        // 重置写的是**主文件那一半**（不含 messages）：旧布局的 messages 键不能借着重置复活。
        await fs.writeText(target, JSON.stringify(mainDocOf(init())), { kind: 'replaceIfVersion', version: info.version })
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
      const empty = init()
      if (sideMessages) { empty.messages = sideMessages; empty.seq = sideSeq }
      return { state: empty, version: null, target, sidecar, sideVersion, messagesInMain: false, stateDir, warn: mergeWarn(corruptWarn) }
    }
    // 旧布局（主文件里**仍有** messages）以**主文件**为准；否则以旁挂为准。
    const messagesInMain = !!(parsed && Array.isArray(parsed.messages))
    if (messagesInMain) s.messages = parsed.messages
    else if (sideMessages) s.messages = sideMessages
    else s.messages = []
    // seq 是 claimId 与 msgId 共用的计数器：取两边的较大值，避免复用已发过的 id。
    s.seq = Math.max(Number(parsed && parsed.seq) || 0, sideSeq)
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

  async function mutate(fn: (s: StateDocument) => OpResult, agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    for (let i = 0; i < 5; i++) {
      const { state, version, target, sidecar, sideVersion, messagesInMain } = await load(agentId, agent)
      // 跑 op **之前**取留言指纹：sweep() 也会截断留言（条数/字节上限），所以要在它之前取，
      // 否则"这次只清掉了旧留言"会被判成"留言没变"而丢掉截断结果。
      const fpBefore = msgFingerprint(state.messages)
      const swept = sweep(state, now(), sweepOpts(state))
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
        // **错误分支绝不写盘**：被挡回的 op 没有产生任何该持久化的状态。
        if (out.ok === false) return { ok: false, error: data.error || 'bad-request', message: data.message, ...data }
        // 本次 op 自己什么都没改时，过去会直接返回、不写盘。但 `sweep()` 已经在**这个事务里**
        // 清掉了过期声明 / 超限留言 / 死名册行 —— 丢掉它们意味着：读路径只 sweep 内存、不写盘，
        // 只要写操作一直返回 changed:false（反复 release 不存在的路径、reap dry-run、reader 已登记），
        // 磁盘就会长期留着已清理的内容，**视图与磁盘长期不一致**（0.14.0，M2b）。
        // 所以只要本次确实有清理，就把它写回；返回值形状保持不变（仍 `{ok:true, data}`）。
        const cleaned = swept.expiredClaims > 0 || swept.droppedMessages > 0 || swept.prunedHolders > 0
        if (out.changed === false && !cleaned) return { ok: true, data }
        if (out.changed !== false && (swept.droppedMessages > 0 || swept.prunedHolders > 0)) {
          out.data = Object.assign({}, out.data, { swept })
        }
        // changed:false 的 op 可能不带 state（如 registerReader 的幂等分支）；此时本地 `state`
        // 就是唯一事实（fn 在 changed:false 语义下不改它，sweep 已经改过它）。
        const next = out.state || state
        try {
          await writeState(next, version, target, sidecar, sideVersion, messagesInMain, fpBefore)
          return { ok: true, data: out.changed === false ? data : out.data }
        } catch (e) {
          if (stale(e) && i < 4) continue
          throw e
        }
      }
      if (swept.droppedMessages > 0 || swept.prunedHolders > 0) {
        out.data = Object.assign({}, out.data, { swept })
      }
      try {
        await writeState(out.state, version, target, sidecar, sideVersion, messagesInMain, fpBefore)
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
      sessionId: id || undefined,
      // 名册行的进程章（0.14.0，B2）。拿不到就是 undefined —— holder() 只在提供时盖章，
      // 绝不会把另一个形态刚写上的章抹掉。
      proc: PROC_TOKEN || undefined,
      // 血缘在这里现算一次，随 h 传进纯逻辑（collab-core 的 inFamily）。
      // 纯逻辑因此不需要认识 agents 服务，仍是可对拍的纯函数。
      family: familyIds(id, agent)
    }
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
    // 先 sweep 再取视图：死掉的名册行（句柄结束 / 写它的进程不在了）在返回里根本不出现；
    // stale 用的是 1h 预警阈值（见 HOLDER_STALE_WARN_MS），因此在产品路径上依然是可达信号。
    // 注意：`sweep()` 返回 SweepResult **对象**，而 `expire()` 返回数字。0.13.0 起 list 的
    // `expiredCount` 是**数字**（"这次调用顺手扫掉几条过期声明"），动态宿主形态也仍是数字 ——
    // 这里必须取 `.expiredClaims`，别把用户可见契约悄悄换成对象（2026-10 审计抓到的在飞回归）。
    const swept = sweep(state, t, sweepOpts(state))
    const ex = swept.expiredClaims
    const hv = holderView(state, t)
    // holdersNote 只在**有 stale 条目**时出现：名册被读成"过期锁"的实测现场才有这句话，
    // 干净项目一个字都不加（与 otherProjects / teamTasks 同一降级纪律）。
    const rosterNote = holderRosterNote(hv.staleHolders)
    const data: Record<string, unknown> = {
      seq: state.seq,
      serverTime: t,
      statePath: fs.processPath(target),
      stateDir,
      schemaVersion: state.schemaVersion,
      // 0.14.0（C）：名册**有界**返回。过去逐条返回整份名册（现场 56 行 / 约 10 KB 一次），
      // 而每一步都注入的态势摘要早就把 claims 压到「3 条 × 2 路径」。截断不丢事实：
      // holdersTotal 恒在，调用方自己看得出被折叠了。
      holders: hv.holders.slice(0, HOLDER_VIEW_LIMIT),
      holdersTotal: hv.holders.length,
      staleHolders: hv.staleHolders,
      claims: state.claims.map(pub),
      expiredCount: ex
    }
    if (rosterNote) data.holdersNote = rosterNote
    return { ok: true, data: withWarn(data, warn) }
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
  async function otherProjects(current: FileRef, t: number): Promise<Record<string, unknown>> {
    try {
      if (typeof fs.listDir !== 'function') {
        return { otherProjects: [], otherProjectsNote: '宿主 fs 不提供 listDir：只能看到当前项目' }
      }
      const dir = await fs.resolve(collabDir())
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
      return { otherProjects: [], otherProjectsNote: '列举其他项目失败：' + describeError(e) }
    }
  }

  /**
   * 官方 Agent Teams 在跑任务的只读写域（0.11.0）。**唯一**碰 `ctx.agentTeams` 的地方之一。
   *
   * 为什么要"活读 + 三态"：
   *   - 服务可能根本不在（未启用 agent-team bundle）⇒ 返回 null，调用方一字不加（README 的定位契约）；
   *   - `listTasks(caller)` 以**活 Agent** 作授权凭据，非成员会抛 TEAM_NOT_MEMBER，所以整个调用包在
   *     try/catch 里，任何异常都折叠成 null（"读不到" ≠ "没有任务"）；
   *   - agents 服务可能迟到，因此每次调用现场 `ctx.get('agents')`/`ctx.get('agentTeams')`，
   *     与 familyIds/descendantIds 的活读纪律一致（store.ts 顶部注释）。
   *
   * 只取 `status === 'in_progress'` 且 `writeScopes` 非空的任务：官方任务一被 claim 就进 in_progress
   * （实测 `team_task_update action=claim` → status:"in_progress"），那正是"在跑"的口径。
   */
  function teamTasks(agent?: AgentLike): TeamScopeTask[] | null {
    try {
      const svc = ctx.get('agentTeams') as AgentTeamsServiceLike | undefined
      if (!svc || typeof svc.listTasks !== 'function' || !agent) return null
      const rows = svc.listTasks(agent)
      if (!Array.isArray(rows)) return null
      const out: TeamScopeTask[] = []
      for (const r of rows) {
        if (!r || typeof r !== 'object') continue
        const id = typeof r.id === 'string' ? r.id : (r.id === undefined || r.id === null ? '' : String(r.id))
        if (!id) continue
        const status = typeof r.status === 'string' ? r.status : ''
        if (status !== 'in_progress') continue
        const scopes = Array.isArray(r.writeScopes)
          ? r.writeScopes.filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0)
          : []
        if (!scopes.length) continue
        const t: TeamScopeTask = {
          id,
          subject: typeof r.subject === 'string' ? r.subject : '',
          status,
          writeScopes: scopes
        }
        if (typeof r.ownerName === 'string' && r.ownerName) t.ownerName = r.ownerName
        out.push(t)
      }
      // 确定性顺序（官方按创建序返回，这里再按 id 排一次，保证同一集合渲染同一串文本）。
      out.sort((a, b) => a.id.localeCompare(b.id))
      return out
    } catch (e) {
      return null
    }
  }

  async function overviewOp(agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const { state, target, stateDir, warn } = await load(agentId, agent)
    const t = now()
    sweep(state, t, sweepOpts(state))
    const o = overview(state)
    const other = await otherProjects(target, t)
    // 官方团队在跑任务的 advisory 写域（0.11.0）：**输出侧附加**，与 otherProjects 同一纪律。
    // 服务缺席 ⇒ 一个字段都不加（一字不变）；服务在场但此刻没有在跑任务 ⇒ `teamTasks: []` + 明说。
    const team = teamTasks(agent)
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
    sweep(state, t, sweepOpts(state))
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
    // 与 list / status 同一降级纪律：load() 的 warning（例如"本会话没有 cwd ⇒ 按项目隔离已失效"）
    // **必须透传**。0.13.0 之前这里只解构 { state }，把警告丢了 —— 于是"你在读另一个项目的板"
    // 这件事返回到调用方手里时一个字都没有，而 read 与 list 的返回形状本来就该一致。
    const { state, warn } = await load(agentId, agent)
    return { ok: true, data: withWarn(filterMessages(state, a), warn) }
  }

  /**
   * op=reap（0.9.8）：把 collab-core 的纯函数 reap() 接到状态存取层上。
   *
   * 只在这里做一件纯逻辑之外的事：**取活体名单**（ctx.get('agents').list()）。拿不到就传 null，
   * 由 reap() 自己如实标 `livenessCheck: 'unavailable'` 且**一个也不收**。
   *
   * dry-run 时 reap() 返回 `changed:false`，于是 mutate() 直接返回、**不写盘** ——
   * "默认不改状态"由状态层自身的写入门槛保证，不是靠这里多写一个 if。
   * 本 op **只在工具 handler 显式调用时**发生；没有被 sweep()/读路径/定时器引用（见 tests/collab-reap.mjs 的静态断言）。
   */
  async function reapOp(a: CollabArgs, h: HolderInput, agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const live = liveAgentHolderIds()
    return mutate(s => reap(s, h, a, live, now()), agentId, agent)
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

  return {
    fs, now, livenessOf, familyIds, descendantIds, teamTasks, cwdOf, load, mutate, holderOf, hname,
    list, overviewOp, status, msgs, reapOp, waitFor
  }
}
