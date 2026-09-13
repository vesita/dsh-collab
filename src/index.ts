import {
  norm, ov, hashProjectKey, projectStorageFileName, init, publish,
  expire, sweep, conflictError, holder, claim, release, heartbeat,
  post, overview, related, filterMessages, blockers, cleanName, holderView
} from './collab-core.js'
import type {
  Claim, ConflictInfo, HolderInput, Mode, OpResult, PublishedClaim, StateDocument
} from './collab-core.js'
import {
  LEGACY_PROJECT_FILE, collabDir, projectStateFile, legacyCollabDirs
} from './paths.js'

/** fs 服务返回的文件引用（displayPath / version 由 DSH fs 服务提供）。 */
export interface FileRef {
  displayPath: string
  version?: number
  [key: string]: any
}

/** ctx.fs 中本插件实际使用的最小接口。 */
export interface CollabFs {
  resolve(path: string, opts?: { cwd?: string }): Promise<FileRef>
  stat(target: FileRef): Promise<{ version: number } | null>
  readText(target: FileRef): Promise<string>
  writeText(target: FileRef, content: string, opts?: { kind?: string; version?: number }): Promise<unknown>
  processPath(target: FileRef): string
}

interface SessionLike { header?: { cwd?: string } }
interface AgentLike { id?: string; session?: SessionLike }
interface SessionsService { get(agentId: string): SessionLike | undefined }
interface SessionTitleService { get(session: SessionLike): { title?: string } | undefined }

/** 工具调用上下文（execute 的第二个参数），取 agent 作为 holder 身份及 cwd 来源。 */
export interface ToolExecContext {
  agent?: AgentLike
  [key: string]: any
}

/** lock / board 的调用参数（由 JSON Schema 描述，字段随 op 变化）。 */
export interface CollabArgs {
  op?: string
  paths?: string[]
  claimId?: string
  mode?: Mode
  ttlSec?: number
  timeoutMs?: number
  note?: string
  channel?: string
  body?: string
  mentions?: string[]
  replyTo?: string
  since?: number
  limit?: number
}

/** 统一结果信封；ok:false 时 error/message 提升到顶层，少数 op 附加诊断字段。 */
export interface ToolResult {
  ok: boolean
  error?: string
  message?: string
  data?: Record<string, any>
  conflicts?: ConflictInfo[]
  paths?: string[]
  blockers?: PublishedClaim[]
  waitedMs?: number
}

/** DSH 工具定义（ctx.tools.register 的入参）。 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: CollabArgs, value: unknown) => Array<{ type: string; text: string }>
  }
  execute: (args: CollabArgs, exec: ToolExecContext) => Promise<ToolResult>
}

/** 插件 ctx：只声明本插件实际消费的服务与事件 API。 */
export interface CollabContext {
  fs: CollabFs
  timer: { timeout(ms: number): Promise<void>; interval(callback: () => void, delay: number): () => void }
  tools: { register(tool: ToolDefinition): void }
  effect(callback: () => void | (() => void)): void
  get(name: string): any
  on(event: string, handler: (payload: any) => void, options?: { global?: boolean; prepend?: boolean }): void
}

/** 单个 op 的处理函数签名。 */
type OpHandler = (args: CollabArgs, h: HolderInput, agentId: string | null, agent?: AgentLike) => ToolResult | Promise<ToolResult>

/** load() 的返回：状态文档 + 乐观并发版本号 + 存储目标 + 绝对状态目录 + 诊断 warning。 */
interface LoadResult {
  state: StateDocument
  version: number | null
  target: FileRef
  stateDir: string
  warn: string | null
}

export const name = 'dsh-collab'
export const inject = ['fs', 'timer', 'tools']

export function apply(ctx: CollabContext): void {
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
      } catch (e) {}
    }
    // 第二代错误落点：旧版相对进程 cwd 的 .dsh/collab/projects，以及 `~` 未展开的
    // <HOME>/~/.dsh/collab/projects。只读扫描 + 一次性搬进正确位置；文件名沿用
    // projectStorageFileName，故能与历史产物一一对上。任何失败都静默（不阻断工具）。
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
        } catch (e) {}
      }
    }
    if (!info) return { state: init(), version: null, target, stateDir, warn }
    const raw = await fs.readText(target)
    let s: StateDocument
    try {
      s = Object.assign(init(), JSON.parse(raw))
    } catch (e) {
      // 自愈而非砖化：保留损坏文件的备份，重置为空状态并把问题作为 warning 上报。
      const backupSuffix = '.corrupt-' + now()
      let backupPath: string | null = null
      try {
        const backupTarget = await fs.resolve(target.displayPath + backupSuffix)
        await fs.writeText(backupTarget, raw, { kind: 'createIfAbsent' })
        backupPath = fs.processPath(backupTarget)
      } catch (backupError) {}
      try {
        await fs.writeText(target, JSON.stringify(init()), { kind: 'replaceIfVersion', version: info.version })
      } catch (resetError) {}
      const corruptWarn = 'state corrupted; reinitialized' + (backupPath ? '; backup: ' + backupPath : '')
      return { state: init(), version: null, target, stateDir, warn: warn ? warn + '; ' + corruptWarn : corruptWarn }
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

  function cleanName(s: string): string {
    if (typeof s !== 'string') return s
    let n = s.replace(/\s+/g, ' ').trim()
    if (n.length > 24) n = n.slice(0, 24) + '…'
    return n
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

  const exec = (fn: OpHandler) => async (args: CollabArgs, e: ToolExecContext): Promise<ToolResult> => {
    args = args || {}
    const h = holderOf(e)
    const name = hname(h)
    h.name = name
    const aId = h.sessionId || null
    try {
      return await fn(args, h, aId, h.agent)
    } catch (err) {
      return { ok: false, error: 'internal', message: String((err && err.message) || err) }
    }
  }

  const lockHandler = exec((a, h, aId, agent) => {
    if (a.op === 'claim') return mutate(s => claim(s, h, a, now), aId, agent)
    if (a.op === 'release') return mutate(s => release(s, h, a, now), aId, agent)
    if (a.op === 'heartbeat') return mutate(s => heartbeat(s, h, a, now), aId, agent)
    if (a.op === 'list') return list(aId, agent)
    if (a.op === 'overview') return overviewOp(aId, agent)
    if (a.op === 'status') return status(a, aId, agent)
    if (a.op === 'wait') return waitFor(a, h, aId, agent)
    return { ok: false, error: 'bad-request', message: 'unknown op: ' + String(a.op) }
  })

  const boardHandler = exec((a, h, aId, agent) => {
    if (a.op === 'post') return mutate(s => post(s, h, a, now), aId, agent)
    if (a.op === 'read') return msgs(a, aId, agent)
    return { ok: false, error: 'bad-request', message: 'unknown op: ' + String(a.op) }
  })

  const render = (args: CollabArgs, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  const lockTool: ToolDefinition = {
    name: 'collab_lock',
    description: '多智能体协作中央注册锁：开工前声明占用项目文件夹（目录以 / 结尾，如 src/backend/），查询他人占用，减少共同开发冲突。规范：动手改代码前先 claim；开工前和定期 list/overview；冲突时先 wait 等待或用 board 留言协商；完成即 release；长任务 heartbeat 续租。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['claim', 'release', 'list', 'overview', 'status', 'heartbeat', 'wait'], description: 'claim 声明 / release 释放 / list 全部 / overview 占用全景 / status 查路径 / heartbeat 续租 / wait 等待路径释放' },
        paths: { type: 'array', items: { type: 'string' }, description: '项目相对路径' },
        claimId: { type: 'string', description: 'claim id，release/heartbeat 用' },
        mode: { type: 'string', enum: ['exclusive', 'shared', 'read'], description: 'exclusive 独占（默认）；shared 声明共用但被独占挡住；read 只读观测，不排他也不被挡' },
        ttlSec: { type: 'number', description: '租约秒数（5-86400），默认 1800' },
        timeoutMs: { type: 'number', description: 'wait 用，最多等待毫秒，默认 30000' },
        note: { type: 'string', description: '占用说明' }
      },
      additionalProperties: true,
      required: ['op']
    },
    output: { schema: { type: 'object', additionalProperties: true }, render },
    execute: lockHandler
  }

  const boardTool: ToolDefinition = {
    name: 'collab_board',
    description: '多智能体协作留言板：向协作域发消息（频道 general / path:<路径> / agent:<holderId>）或增量读取消息，用于协商、交接、同步进展。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['post', 'read'] },
        channel: { type: 'string', description: '频道，默认 general' },
        body: { type: 'string', description: 'post 用，消息正文' },
        mentions: { type: 'array', items: { type: 'string' }, description: '被 @ 的 holderId' },
        replyTo: { type: 'string', description: '回复的 msgId' },
        since: { type: 'number', description: 'read 用，只返回 seq 大于此值的消息' },
        limit: { type: 'number', description: 'read 用，最多条数，默认 50' }
      },
      additionalProperties: true,
      required: ['op']
    },
    output: { schema: { type: 'object', additionalProperties: true }, render },
    execute: boardHandler
  }

  // ---- 多 DSH 会话协同：把"同项目还有谁占着什么"注入运行时上下文 ----
  // prompt 装配时 agents.currentInitiator() 返回正在装配的那个会话（实测），
  // 因此每个会话在每一步都能自动看到同项目的实时占用，不依赖任何一方"记得去查"。
  // 这对**互相独立的会话/进程**同样成立：各自读同一个状态文件，各自渲染自己的视图。
  // PromptContext.text 必须是同步字符串，所以读盘走后台缓存：text 读缓存，缓存过期时发起异步刷新。
  const agents = ctx.get('agents') as { currentInitiator(): AgentLike | undefined; list(): AgentLike[] } | undefined
  const systemPrompt = ctx.get('systemPrompt') as {
    context(c: { name: string; order: number; text: string | ((context: any) => string) }): () => void
  } | undefined

  const OPEN_HINT = '多会话协作（dsh-collab）：同一项目可能有其他 DSH 会话并行工作。改动文件前用 collab_lock op=claim 声明占用（目录以 / 结尾，如 src/backend/），并先 op=overview 查看他人占用；只读调研用 mode=read；完成后 op=release，长任务 op=heartbeat 续租；协商与交接走 collab_board。'
  // 包形态的关闭开关：DSH_COLLAB_NO_PROMPT_HINT=1 时不注册态势上下文，也不起刷新定时器。
  const PROMPT_HINT_ENABLED = process.env.DSH_COLLAB_NO_PROMPT_HINT !== '1'
  const DIGEST_TTL_MS = Math.max(200, Number(process.env.DSH_COLLAB_DIGEST_TTL_MS) || 15000)
  const digestCache = new Map<string, { text: string; at: number }>()
  const digestBusy = new Set<string>()

  function renderDigest(others: Claim[], t: number): string {
    const parts = others.slice(0, 3).map(c => {
      const mins = Math.max(1, Math.ceil((c.expiresAt - t) / 60000))
      const paths = c.paths.slice(0, 2).join(' ') + (c.paths.length > 2 ? ' 等 ' + c.paths.length + ' 条' : '')
      return (c.holderName || c.holderId) + '（' + c.mode + '）占用 ' + paths + '，剩 ' + mins + ' 分'
    })
    const more = others.length > 3 ? '；另有 ' + (others.length - 3) + ' 条' : ''
    return '[dsh-collab] 同项目其他会话当前占用：' + parts.join('；') + more + '。改动这些路径前请先执行 collab_lock op=wait 或用 collab_board 协商。'
  }

  async function refreshDigest(agent: AgentLike): Promise<void> {
    const id = agent && agent.id ? String(agent.id) : null
    const cwd = await cwdOf(id, agent)
    if (!cwd || digestBusy.has(cwd)) return
    digestBusy.add(cwd)
    try {
      const { state } = await load(id, agent)
      const t = now()
      const mine = id ? 'agent:' + id : 'human:console'
      const others = state.claims.filter(c => c.expiresAt > t && c.holderId !== mine)
      digestCache.set(cwd, { text: others.length ? renderDigest(others, t) : '', at: t })
    } catch (e) {
      // 态势刷新是尽力而为：失败时保留上一份缓存，绝不打断任何模型步或工具调用。
    } finally {
      digestBusy.delete(cwd)
    }
  }

  if (PROMPT_HINT_ENABLED && systemPrompt && typeof systemPrompt.context === 'function') {
    ctx.effect(() => systemPrompt.context({
      name: 'dsh-collab/awareness',
      order: 130,
      text: () => {
        try {
          const init = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined
          const cwd = init && init.session && init.session.header ? init.session.header.cwd : null
          if (!init || typeof cwd !== 'string' || !cwd) return OPEN_HINT
          const hit = digestCache.get(cwd)
          if (!hit || now() - hit.at > DIGEST_TTL_MS) void refreshDigest(init)
          return hit && hit.text ? hit.text : OPEN_HINT
        } catch (e) {
          return OPEN_HINT
        }
      }
    }))
  }

  if (PROMPT_HINT_ENABLED && agents && typeof agents.list === 'function') {
    ctx.effect(() => ctx.timer.interval(() => {
      try {
        for (const a of agents.list()) void refreshDigest(a)
      } catch (e) {}
    }, DIGEST_TTL_MS))
  }

  ctx.tools.register(lockTool)
  ctx.tools.register(boardTool)

  ctx.on('agent/disposed', (payload: { agent?: { id?: string } }) => {
    try {
      const agent = payload && payload.agent
      if (!agent || !agent.id) return
      const h = 'agent:' + String(agent.id)
      mutate(s => {
        const rel = s.claims.filter(c => c.holderId === h)
        if (!rel.length) return { ok: true, changed: false, data: {} }
        s.claims = s.claims.filter(c => c.holderId !== h)
        return { ok: true, changed: true, state: s, data: { released: rel.map(pub) } }
      }, String(agent.id), agent).catch(() => {})
    } catch (e) {}
  }, { global: true })
}

export default { name, inject, apply }
