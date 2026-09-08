import {
  norm, ov, hashProjectKey, projectStorageFileName, init, publish,
  expire, conflictError, holder, claim, release, heartbeat,
  post, overview, related, filterMessages, blockers
} from './collab-core.mjs'

export const name = 'dsh-collab'
export const inject = ['fs', 'timer', 'tools']

export function apply(ctx) {
  const fs = ctx.fs
  const sessions = ctx.get('sessions')
  const sessionTitle = ctx.get('sessionTitle')
  const COLLAB_DIR = '~/.dsh/collab/projects'
  const LEGACY_FILE = '.dsh-collab.json'
  const now = () => Date.now()

  const pub = c => publish(c)
  const stale = e => {
    const m = String((e && (e.message || e.code)) || e)
    return m.includes('FS_STALE_VERSION') || /stale|already exists|EEXIST/i.test(m)
  }
  const withWarn = (data, warn) => (warn ? Object.assign({}, data, { warning: warn }) : data)

  async function cwdOf(agentId, agent) {
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

  async function targetFor(agentId, agent) {
    const cwd = await cwdOf(agentId, agent)
    const fileName = projectStorageFileName(cwd)
    const target = await fs.resolve(COLLAB_DIR + '/' + fileName)
    return { cwd, target }
  }

  async function load(agentId, agent) {
    const { cwd, target } = await targetFor(agentId, agent)
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
    let s
    try {
      s = Object.assign(init(), JSON.parse(await fs.readText(target)))
    } catch (e) {
      throw new Error('collab state corrupted: ' + target.displayPath)
    }
    s.claims = Array.isArray(s.claims) ? s.claims : []
    s.messages = Array.isArray(s.messages) ? s.messages : []
    s.holders = Array.isArray(s.holders) ? s.holders : []
    return { state: s, version: info.version, target, warn }
  }

  async function mutate(fn, agentId, agent) {
    for (let i = 0; i < 5; i++) {
      const { state, version, target } = await load(agentId, agent)
      expire(state, now())
      let out
      try {
        out = fn(state)
      } catch (e) {
        if (e && e.collabConflict) return { ok: false, error: 'conflict', conflicts: e.conflicts }
        throw e
      }
      if (!out || out.changed === false) return out ? { ok: out.ok !== false, data: out.data || {} } : { ok: false, error: 'not-found' }
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

  const holderOf = exec => {
    const agent = exec && exec.agent
    const id = agent && agent.id ? String(agent.id) : null
    return {
      agent,
      holderId: id ? 'agent:' + id : 'human:console',
      sessionId: id || undefined
    }
  }

  function cleanName(s) {
    if (typeof s !== 'string') return s
    let n = s.replace(/\s+/g, ' ').trim()
    if (n.length > 24) n = n.slice(0, 24) + '…'
    return n
  }

  function hname(h) {
    let name = null
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

  async function list(agentId, agent) {
    const { state, target, warn } = await load(agentId, agent)
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

  async function overviewOp(agentId, agent) {
    const { state, target, warn } = await load(agentId, agent)
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

  async function status(a, agentId, agent) {
    const { state, target, warn } = await load(agentId, agent)
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

  async function msgs(a, agentId, agent) {
    const { state } = await load(agentId, agent)
    return { ok: true, data: filterMessages(state, a) }
  }

  async function waitFor(a, h, agentId, agent) {
    const timeoutMs = Math.max(0, Math.min(120000, Number(a.timeoutMs) || 30000))
    const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
    if (!paths.length) return { ok: false, error: 'bad-request', message: 'paths required' }
    const deadline = now() + timeoutMs
    let bList = []
    while (now() < deadline) {
      const { state } = await load(agentId, agent)
      const t = now()
      bList = blockers(state, t, h, paths)
      if (bList.length === 0) return { ok: true, data: { paths, blockers: [], waitedMs: Math.round(timeoutMs - Math.max(0, deadline - now())) } }
      await ctx.timer.timeout(400)
    }
    return { ok: false, error: 'timeout', message: 'paths still claimed', paths, blockers: bList.map(pub), waitedMs: timeoutMs }
  }

  const exec = (fn) => async (args, e) => {
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

  const render = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  const lockTool = {
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
      required: ['op']
    },
    output: { schema: { type: 'object' }, render },
    execute: lockHandler
  }

  const boardTool = {
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
      required: ['op']
    },
    output: { schema: { type: 'object' }, render },
    execute: boardHandler
  }

  ctx.tools.register(lockTool)
  ctx.tools.register(boardTool)

  ctx.on('agent/disposed', (payload) => {
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
