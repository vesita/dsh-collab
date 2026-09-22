// src/store.ts
// **状态文件的存取层**：路径解析、读改写（乐观并发重试 + 损坏自愈 + 历史落点迁移）、
// holder 身份与显示名，以及全部只读查询 op（list / overview / status / msgs / wait）。
// 本模块是唯一碰状态文件的地方；apply() 只做组合，不在这里。
//
// installStore() 的返回值就是它对外暴露的全部能力：其他 installer 通过参数**显式**
// 接收它。段间不共享任何模块级可变状态。

import {
  init, sweep, publish, overview, related, filterMessages, blockers, holderView,
  expire, cleanName, norm, projectStorageFileName, reap
} from './collab-core.js'
import type { Claim, HolderInput, OpResult, PublishedClaim, StateDocument } from './collab-core.js'
import type { TeamScopeTask } from './collab-core.js'
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
   *  它**只摘 reader 登记 + 回收该 holder 已过期的声明**，不释放未过期声明（W7：租约是唯一回收机制）。
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

  async function targetFor(agentId: string | null, agent?: AgentLike): Promise<{ cwd: string | null; target: FileRef; stateDir: string; fileName: string }> {
    const cwd = await cwdOf(agentId, agent)
    const fileName = projectStorageFileName(cwd || 'default')
    // 绝对状态目录（${DSH_HOME:-$HOME/.dsh}/collab/projects），与进程 cwd 无关。
    // fs.resolve 对绝对路径原样通过（实测），所以这里不做字符串拼接猜测基址。
    const stateDir = collabDir()
    const target = await fs.resolve(projectStateFile(cwd))
    return { cwd, target, stateDir, fileName }
  }

  async function load(agentId: string | null, agent?: AgentLike): Promise<LoadResult> {
    const { cwd, target, stateDir, fileName } = await targetFor(agentId, agent)
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
    if (!info) return { state: init(), version: null, target, stateDir, warn: mergeWarn(null) }
    const raw = await fs.readText(target)
    let s: StateDocument
    try {
      s = Object.assign(init(), JSON.parse(raw))
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
      let resetOk = false
      let resetFailure: string | null = null
      try {
        await fs.writeText(target, JSON.stringify(init()), { kind: 'replaceIfVersion', version: info.version })
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
      return { state: init(), version: null, target, stateDir, warn: mergeWarn(corruptWarn) }
    }
    s.claims = Array.isArray(s.claims) ? s.claims : []
    s.messages = Array.isArray(s.messages) ? s.messages : []
    s.holders = Array.isArray(s.holders) ? s.holders : []
    return { state: s, version: info.version, target, stateDir, warn }
  }

  async function mutate(fn: (s: StateDocument) => OpResult, agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    for (let i = 0; i < 5; i++) {
      const { state, version, target } = await load(agentId, agent)
      const swept = sweep(state, now())
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
        if (out.ok === false) return { ok: false, error: data.error || 'bad-request', message: data.message, ...data }
        return { ok: true, data }
      }
      if (swept.droppedMessages > 0 || swept.prunedHolders > 0) {
        out.data = Object.assign({}, out.data, { swept })
      }
      try {
        if (version === null) await fs.writeText(target, JSON.stringify(out.state), { kind: 'createIfAbsent' })
        else await fs.writeText(target, JSON.stringify(out.state), { kind: 'replaceIfVersion', version })
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
    // 先 sweep 再取视图：超过 24h 的废弃 holder 不再出现在结果里；
    // 而 stale 用的是 1h 预警阈值（见 HOLDER_STALE_WARN_MS），因此在产品路径上依然是可达信号。
    const ex = expire(state, t)
    const hv = holderView(state, t)
    return {
      ok: true,
      data: withWarn({
        seq: state.seq,
        serverTime: t,
        statePath: fs.processPath(target),
        stateDir,
        schemaVersion: state.schemaVersion,
        holders: hv.holders,
        staleHolders: hv.staleHolders,
        claims: state.claims.map(pub),
        expiredCount: ex
      }, warn)
    }
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
    expire(state, t)
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
    expire(state, t)
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
    const { state } = await load(agentId, agent)
    return { ok: true, data: filterMessages(state, a) }
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
