// src/store.ts
// **状态文件的存取层**：路径解析、读改写（乐观并发重试 + 损坏自愈 + 历史落点迁移）、
// holder 身份与显示名，以及全部只读查询 op（list / overview / status / msgs / wait）。
// 本模块是唯一碰状态文件的地方；apply() 只做组合，不在这里。
//
// installStore() 的返回值就是它对外暴露的全部能力：其他 installer 通过参数**显式**
// 接收它。段间不共享任何模块级可变状态。

import {
  init, sweep, publish, overview, related, filterMessages, blockers, holderView,
  expire, cleanName, norm, projectStorageFileName
} from './collab-core.js'
import type { Claim, HolderInput, OpResult, PublishedClaim, StateDocument } from './collab-core.js'
import { LEGACY_PROJECT_FILE, collabDir, projectStateFile, legacyCollabDirs } from './paths.js'
import type {
  AgentLike, AgentsLookupService, CollabArgs, CollabContext, CollabFs, FileRef, LoadResult,
  SessionsService, SessionTitleService, ToolExecContext, ToolResult
} from './contract.js'

/** 状态存取面：installStore() 对外暴露的东西，也是其他 installer 的唯一状态入口。 */
export interface StateStore {
  fs: CollabFs
  now(): number
  /** 功能 D 的存活判据：三态（live / not-live / failed）—— 基础设施故障不得折叠成"读者没在线"。 */
  livenessOf(sessionId: string): { state: 'live' | 'not-live' | 'failed'; error?: string }
  cwdOf(agentId: string | null, agent?: AgentLike): Promise<string | null>
  load(agentId: string | null, agent?: AgentLike): Promise<LoadResult>
  mutate(fn: (s: StateDocument) => OpResult, agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  holderOf(exec: ToolExecContext): HolderInput & { agent?: AgentLike }
  hname(h: HolderInput & { agent?: AgentLike }): string
  list(agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  overviewOp(agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  status(a: CollabArgs, agentId: string | null, agent?: AgentLike): Promise<ToolResult>
  msgs(a: CollabArgs, agentId: string | null, agent?: AgentLike): Promise<ToolResult>
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
   *  该 claim 释放时已无人可推 —— 静默丢通知。读者的移除只走 dropHolder()（agent/disposed）。
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
    const warn = cwd ? null : 'state-file at default location (no session cwd); per-project isolation disabled'
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
        migrateNotes.push('legacy migrate failed: ' + describeError(e))
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
          migrateNotes.push('legacy migrate failed: ' + describeError(e))
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
      const corruptWarn = 'state corrupted'
        + (resetOk ? '; reinitialized' : '; reinitialize failed: ' + resetFailure)
        + (backupPath ? '; backup: ' + backupPath : '')
        + (backupFailure ? '; backup failed: ' + backupFailure : '')
        + (resetOk ? '' : '; original corrupt content left on disk')
        + (backupFailure && resetOk ? '; original corrupt content overwritten by the reset' : '')
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
      sessionId: id || undefined
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

  async function overviewOp(agentId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const { state, target, stateDir, warn } = await load(agentId, agent)
    const t = now()
    expire(state, t)
    const o = overview(state)
    return {
      ok: true,
      data: withWarn({
        statePath: fs.processPath(target),
        stateDir,
        serverTime: t,
        totalClaims: o.totalClaims,
        holders: o.holders
      }, warn)
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
    fs, now, livenessOf, cwdOf, load, mutate, holderOf, hname,
    list, overviewOp, status, msgs, waitFor
  }
}
