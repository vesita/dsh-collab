import {
  norm, ov, hashProjectKey, projectStorageFileName, init, publish,
  expire, sweep, conflictError, holder, claim, release, heartbeat,
  post, overview, related, filterMessages, blockers, cleanName
} from './collab-core.js'
import type {
  Claim, ConflictInfo, HolderInput, Mode, OpResult, PublishedClaim, StateDocument
} from './collab-core.js'

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
interface SessionsService { get(agentId: string): SessionLike | undefined }
interface SessionTitleService { get(session: SessionLike): { title?: string } | undefined }

/** 工具调用上下文（execute 的第二个参数），只取 agent.id 作为 holder 身份。 */
export interface ToolExecContext {
  agent?: { id?: string }
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
  timer: { timeout(ms: number): Promise<void> }
  tools: { register(tool: ToolDefinition): void }
  get(name: string): any
  on(event: string, handler: (payload: any) => void): void
}

/** 单个 op 的处理函数签名。 */
type OpHandler = (args: CollabArgs, h: HolderInput, agentId: string | null) => ToolResult | Promise<ToolResult>

/** load() 的返回：状态文档 + 乐观并发版本号 + 存储目标 + 诊断 warning。 */
interface LoadResult {
  state: StateDocument
  version: number | null
  target: FileRef
  warn: string | null
}

export const name = 'dsh-collab'
export const inject = ['fs', 'timer', 'tools']

export function apply(ctx: CollabContext): void {
  const fs = ctx.fs
  const sessions = ctx.get('sessions') as SessionsService | undefined
  const sessionTitle = ctx.get('sessionTitle') as SessionTitleService | undefined
  const COLLAB_DIR = '.dsh/collab/projects'
  const LEGACY_FILE = '.dsh-collab.json'
  const now = (): number => Date.now()

  const pub = (c: Claim): PublishedClaim => publish(c)
  const stale = (e: unknown): boolean => {
    const err = e as { message?: string; code?: string } | null | undefined
    const m = String((err && (err.message || err.code)) || e)
    return m.includes('FS_STALE_VERSION') || /stale|already exists|EEXIST/i.test(m)
  }
  const withWarn = (data: Record<string, any>, warn: string | null) => (warn ? Object.assign({}, data, { warning: warn }) : data)

  async function cwdOf(agentId: string | null): Promise<string | null> {
    try {
      if (agentId && sessions) {
        const s = sessions.get(agentId)
        const c = s && s.header && s.header.cwd
        if (typeof c === 'string' && c) return c
      }
    } catch (e) {}
    return null
  }

  async function targetFor(agentId: string | null): Promise<{ cwd: string | null; target: FileRef }> {
    const cwd = await cwdOf(agentId)
    const fileName = projectStorageFileName(cwd)
    const target = await fs.resolve(COLLAB_DIR + '/' + fileName)
    return { cwd, target }
  }

  async function load(agentId: string | null): Promise<LoadResult> {
    const { cwd, target } = await targetFor(agentId)
    const warn = cwd ? null : 'state-file at default location (no session cwd); per-project isolation disabled'
    let info = await fs.stat(target)
    if (!info && cwd) {
      try {
        const legacyTarget = await fs.resolve(LEGACY_FILE, { cwd })
        const legInfo = await fs.stat(legacyTarget)
        if (legInfo) {
          const raw = await fs.readText(legacyTarget)
          await fs.writeText(target, raw, { kind: 'createIfAbsent' })
          info = await fs.stat(target)
        }
      } catch (e) {}
    }
    if (!info) return { state: init(), version: null, target, warn }
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
      return { state: init(), version: null, target, warn: warn ? warn + '; ' + corruptWarn : corruptWarn }
    }
    s.claims = Array.isArray(s.claims) ? s.claims : []
    s.messages = Array.isArray(s.messages) ? s.messages : []
    s.holders = Array.isArray(s.holders) ? s.holders : []
    return { state: s, version: info.version, target, warn }
  }

  async function mutate(fn: (s: StateDocument) => OpResult, agentId: string | null): Promise<ToolResult> {
    for (let i = 0; i < 5; i++) {
      const { state, version, target } = await load(agentId)
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

  const holderOf = (exec: ToolExecContext): HolderInput => {
    const id = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : null
    return { holderId: id ? 'agent:' + id : 'human:console', sessionId: id || undefined }
  }

  function hname(h: HolderInput): string {
    let name: string | null = null
    if (h.sessionId && sessions && sessionTitle) {
      try {
        const s = sessions.get(h.sessionId)
        if (s) {
          const t = sessionTitle.get(s)
          if (t && typeof t.title === 'string' && t.title) name = t.title
        }
      } catch (e) {}
    }
    return cleanName(name || h.holderId)
  }

  async function list(agentId: string | null): Promise<ToolResult> {
    const { state, target, warn } = await load(agentId)
    const t = now()
    const ex = expire(state, t)
    return {
      ok: true,
      data: withWarn({
        seq: state.seq,
        serverTime: t,
        statePath: fs.processPath(target),
        schemaVersion: state.schemaVersion,
        holders: state.holders,
        claims: state.claims.map(pub),
        expiredCount: ex
      }, warn)
    }
  }

  async function overviewOp(agentId: string | null): Promise<ToolResult> {
    const { state, target, warn } = await load(agentId)
    const t = now()
    expire(state, t)
    const o = overview(state)
    return {
      ok: true,
      data: withWarn({
        statePath: fs.processPath(target),
        serverTime: t,
        totalClaims: o.totalClaims,
        holders: o.holders
      }, warn)
    }
  }

  async function status(a: CollabArgs, agentId: string | null): Promise<ToolResult> {
    const { state, target, warn } = await load(agentId)
    const t = now()
    expire(state, t)
    const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
    const rel = related(state, paths)
    return {
      ok: true,
      data: withWarn({
        statePath: fs.processPath(target),
        paths,
        related: rel.map(pub),
        exclusive: rel.filter(c => c.mode === 'exclusive').map(pub),
        serverTime: t
      }, warn)
    }
  }

  async function msgs(a: CollabArgs, agentId: string | null): Promise<ToolResult> {
    const { state } = await load(agentId)
    return { ok: true, data: filterMessages(state, a) }
  }

  async function waitFor(a: CollabArgs, h: HolderInput, agentId: string | null): Promise<ToolResult> {
    const timeoutMs = Math.max(0, Math.min(120000, Number(a.timeoutMs) || 30000))
    const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
    if (!paths.length) return { ok: false, error: 'bad-request', message: 'paths required' }
    const deadline = now() + timeoutMs
    let bList: Claim[] = []
    while (now() < deadline) {
      const { state } = await load(agentId)
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
      return await fn(args, h, aId)
    } catch (err) {
      return { ok: false, error: 'internal', message: String((err && err.message) || err) }
    }
  }

  const lockHandler = exec((a, h, aId) => {
    if (a.op === 'claim') return mutate(s => claim(s, h, a, now), aId)
    if (a.op === 'release') return mutate(s => release(s, h, a, now), aId)
    if (a.op === 'heartbeat') return mutate(s => heartbeat(s, h, a, now), aId)
    if (a.op === 'list') return list(aId)
    if (a.op === 'overview') return overviewOp(aId)
    if (a.op === 'status') return status(a, aId)
    if (a.op === 'wait') return waitFor(a, h, aId)
    return { ok: false, error: 'bad-request', message: 'unknown op: ' + String(a.op) }
  })

  const boardHandler = exec((a, h, aId) => {
    if (a.op === 'post') return mutate(s => post(s, h, a, now), aId)
    if (a.op === 'read') return msgs(a, aId)
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
        mode: { type: 'string', enum: ['exclusive', 'shared'], description: 'exclusive 独占（默认）；shared 只声明不排他' },
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
      }, String(agent.id)).catch(() => {})
    } catch (e) {}
  })
}

export default { name, inject, apply }
