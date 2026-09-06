// collab-plugin.host.js
// 自包含的 Cordis Host 插件源码（等价于动态插件 coll-1/pkg-9，当前运行版本）。
//
// 用法：
//   const { hostCode } = require('./src/collab-plugin.host.js')   // CJS
//   import { hostCode } from './src/collab-plugin.host.js'        // ESM
//   cordis_define(code: { host: hostCode })                       // 作为 code.host
//
// 注意：Cordis 动态插件的 code.host 不接受 import/打包，因此本文件内联了
// 与 src/collab-core.mjs 逻辑一致的纯逻辑部分。纯逻辑唯一事实源见 collab-core.mjs；
// 正式化进 host 组合后可直接 import 该核心模块消除重复。
// 工具参数契约见 src/schema/collab.schema.json（JSON Schema v1）。

export const hostCode = `
return {
  inject: ['fs', 'timer'],
  apply(ctx) {
    const fs = ctx.fs
    const sessions = ctx.get('sessions')
    const sessionTitle = ctx.get('sessionTitle')
    const COLLAB_DIR = '~/.dsh/collab/projects'
    const LEGACY_FILE = '.dsh-collab.json'
    const now = () => Date.now()
    const init = () => ({ schemaVersion: 1, seq: 0, claims: [], messages: [], holders: [] })
    const seg = p => p.split('/').filter(Boolean)
    const ov = (a, b) => { const sa = seg(a), sb = seg(b), n = Math.min(sa.length, sb.length); for (let i = 0; i < n; i++) if (sa[i] !== sb[i]) return false; return true }
    const norm = (p) => {
      if (typeof p !== 'string' || !p.trim()) return null
      let s = p.trim().replace(/\\\\/g, '/')
      while (s.startsWith('./')) s = s.slice(2)
      s = s.replace(/\\/{2,}/g, '/').replace(/^\\/+/, '')
      const out = []
      for (const x of s.split('/')) { if (!x || x === '.') continue; if (x === '..') out.pop(); else out.push(x) }
      return out.length ? out.join('/') + (s.endsWith('/') ? '/' : '') : null
    }
    function hashProjectKey(str) {
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
    function storageNameFor(cwd) {
      const normRoot = (cwd || '').trim().replace(/\\\\/g, '/').replace(/\\/+$/, '')
      const parts = normRoot.split('/').filter(Boolean)
      const base = (parts.length ? parts[parts.length - 1] : 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
      const hash = hashProjectKey(normRoot || 'default')
      return base + '-' + hash + '.json'
    }
    const pub = c => ({ claimId: c.claimId, holderId: c.holderId, holderName: c.holderName, paths: c.paths, mode: c.mode, ttlSec: c.ttlSec, expiresAt: c.expiresAt, note: c.note, createdAt: c.createdAt })
    const stale = e => { const m = String((e && (e.message || e.code)) || e); return m.includes('FS_STALE_VERSION') || /stale|already exists|EEXIST/i.test(m) }
    const conflict = cs => { const e = new Error('conflict'); e.collabConflict = true; e.conflicts = cs; return e }
    const withWarn = (data, warn) => (warn ? Object.assign({}, data, { warning: warn }) : data)
    async function cwdOf(agentId) {
      try {
        if (agentId && sessions) {
          const s = sessions.get(agentId)
          const c = s && s.header && s.header.cwd
          if (typeof c === 'string' && c) return c
        }
      } catch (e) {}
      return null
    }
    async function targetFor(agentId) {
      const cwd = await cwdOf(agentId)
      const fileName = storageNameFor(cwd)
      const target = fs.resolve(COLLAB_DIR + '/' + fileName)
      return { cwd, target }
    }
    async function load(agentId) {
      const { cwd, target } = await targetFor(agentId)
      const warn = cwd ? null : 'state-file at default location (no session cwd); per-project isolation disabled'
      let info = await fs.stat(target)
      // 平滑兼容：若外部尚未生成，但项目内存在遗留的 .dsh-collab.json，则自动无缝迁移至外部存储
      if (!info && cwd) {
        try {
          const legacyTarget = fs.resolve(LEGACY_FILE, { cwd })
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
      try { s = Object.assign(init(), JSON.parse(await fs.readText(target))) } catch (e) { throw new Error('collab state corrupted: ' + target.displayPath) }
      s.claims = Array.isArray(s.claims) ? s.claims : []
      s.messages = Array.isArray(s.messages) ? s.messages : []
      s.holders = Array.isArray(s.holders) ? s.holders : []
      return { state: s, version: info.version, target, warn }
    }
    function expire(s, t) { const b = s.claims.length; s.claims = s.claims.filter(c => c.expiresAt > t); return b - s.claims.length }
    async function mutate(fn, agentId) {
      for (let i = 0; i < 5; i++) {
        const { state, version, target } = await load(agentId)
        expire(state, now())
        let out
        try { out = fn(state) } catch (e) { if (e && e.collabConflict) return { ok: false, error: 'conflict', conflicts: e.conflicts }; throw e }
        if (!out || out.changed === false) return out ? { ok: out.ok !== false, data: out.data || {} } : { ok: false, error: 'not-found' }
        try {
          if (version === null) await fs.writeText(target, JSON.stringify(out.state), { kind: 'createIfAbsent' })
          else await fs.writeText(target, JSON.stringify(out.state), { kind: 'replaceIfVersion', version })
          return { ok: true, data: out.data }
        } catch (e) { if (stale(e) && i < 4) continue; throw e }
      }
      return { ok: false, error: 'concurrent-modification', message: 'state busy, retry later' }
    }
    const holderOf = exec => { const id = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : null; return { holderId: id ? 'agent:' + id : 'human:console', sessionId: id || undefined } }
    function cleanName(s) {
      if (typeof s !== 'string') return s
      let n = s.replace(/\\s+/g, ' ').trim()
      if (n.length > 24) n = n.slice(0, 24) + '…'
      return n
    }
    function hname(h) {
      let name = null
      if (h.sessionId && sessions && sessionTitle) { try { const s = sessions.get(h.sessionId); if (s) { const t = sessionTitle.get(s); if (t && typeof t.title === 'string' && t.title) name = t.title } } catch (e) {} }
      return cleanName(name || h.holderId)
    }
    function holder(state, h, name) {
      let r = state.holders.find(x => x.holderId === h.holderId)
      if (!r) { r = { holderId: h.holderId, name, kind: h.sessionId ? 'agent' : 'human', sessionId: h.sessionId, lastSeenAt: now() }; state.holders.push(r) } else { r.name = name; r.lastSeenAt = now() }
      return r
    }
    function claim(state, h, name, a) {
      const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
      if (!paths.length) return { ok: false, changed: false, data: { error: 'bad-request', message: 'paths required（目录以 / 结尾）' } }
      const mode = a.mode === 'shared' ? 'shared' : 'exclusive'
      const ttl = Math.max(5, Math.min(86400, Number(a.ttlSec) || 1800))
      const note = typeof a.note === 'string' ? a.note.slice(0, 500) : ''
      const t = now(), cs = []
      for (const c of state.claims) {
        if (c.holderId === h.holderId || c.expiresAt <= t || c.mode === 'shared') continue
        for (const p of paths) for (const cp of c.paths) if (ov(p, cp)) {
          const remainingSec = Math.max(0, Math.ceil((c.expiresAt - t) / 1000))
          const suggestedAction = remainingSec <= 30 ? 'wait' : 'negotiate'
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
      if (cs.length) throw conflict(cs)
      holder(state, h, name)
      const expiresAt = t + ttl * 1000
      const own = state.claims.find(c => c.holderId === h.holderId && c.paths.some(cp => paths.some(p => ov(p, cp))))
      let cl
      if (own) { for (const p of paths) if (!own.paths.includes(p)) own.paths.push(p); own.mode = mode; own.ttlSec = ttl; own.note = note || own.note; own.expiresAt = expiresAt; cl = own }
      else { cl = { claimId: 'c_' + (++state.seq), holderId: h.holderId, holderName: name, paths, mode, ttlSec: ttl, expiresAt, note, createdAt: t }; state.claims.push(cl) }
      let warn = null
      if (ttl < 60) warn = 'short-lease: ttl=' + ttl + 's（<60s）; 请按时 heartbeat 续租，避免过期' + (own ? '；已并入你现有声明' : '')
      return { ok: true, changed: true, state, data: { claim: pub(cl), serverTime: t, merged: !!own, warning: warn } }
    }
    function release(state, h, a) {
      const t = now(); let rel = []
      if (a.claimId) {
        const c = state.claims.find(x => x.claimId === a.claimId)
        if (!c) return { ok: false, changed: false, data: { error: 'not-found', message: 'no claim ' + a.claimId } }
        if (c.holderId !== h.holderId) return { ok: false, changed: false, data: { error: 'forbidden', message: 'only holder can release' } }
        state.claims = state.claims.filter(x => x.claimId !== a.claimId); rel = [c]
      } else {
        const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
        if (!paths.length) return { ok: false, changed: false, data: { error: 'bad-request', message: 'claimId or paths required' } }
        rel = state.claims.filter(c => c.holderId === h.holderId && c.paths.some(cp => paths.some(p => ov(p, cp))))
        if (!rel.length) return { ok: true, changed: false, data: { released: [], serverTime: t } }
        state.claims = state.claims.filter(c => !rel.includes(c))
      }
      return { ok: true, changed: true, state, data: { released: rel.map(pub), serverTime: t } }
    }
    function heartbeat(state, h, a) {
      const c = state.claims.find(x => x.claimId === a.claimId)
      if (!c) return { ok: false, changed: false, data: { error: 'not-found', message: 'no claim ' + a.claimId } }
      if (c.holderId !== h.holderId) return { ok: false, changed: false, data: { error: 'forbidden', message: 'only holder can heartbeat' } }
      c.expiresAt = now() + (c.ttlSec || 1800) * 1000
      return { ok: true, changed: true, state, data: { claimId: c.claimId, expiresAt: c.expiresAt, serverTime: now() } }
    }
    function post(state, h, name, a) {
      const body = typeof a.body === 'string' ? a.body.trim() : ''
      if (!body) return { ok: false, changed: false, data: { error: 'bad-request', message: 'body required' } }
      holder(state, h, name)
      const m = { msgId: 'm_' + (++state.seq), seq: state.seq, channel: (typeof a.channel === 'string' && a.channel.trim()) ? a.channel.trim() : 'general', author: h.holderId, ts: now(), body, mentions: Array.isArray(a.mentions) ? a.mentions.filter(x => typeof x === 'string').slice(0, 20) : [] }
      if (typeof a.replyTo === 'string' && a.replyTo) m.replyTo = a.replyTo
      state.messages.push(m)
      return { ok: true, changed: true, state, data: { msgId: m.msgId, seq: state.seq, ts: m.ts } }
    }
    async function list(agentId) {
      const { state, target, warn } = await load(agentId); const t = now(); const ex = expire(state, t)
      return { ok: true, data: withWarn({ seq: state.seq, serverTime: t, statePath: fs.processPath(target), schemaVersion: state.schemaVersion, holders: state.holders, claims: state.claims.map(pub), expiredCount: ex }, warn) }
    }
    async function overview(agentId) {
      const { state, target, warn } = await load(agentId); const t = now(); expire(state, t)
      const byHolder = {}
      for (const c of state.claims) {
        const k = c.holderId
        if (!byHolder[k]) byHolder[k] = { holderId: k, holderName: c.holderName || k, claims: [] }
        byHolder[k].claims.push(pub(c))
      }
      const holders = Object.keys(byHolder).map(k => {
        const h = byHolder[k]
        return { holderId: h.holderId, holderName: h.holderName, claimCount: h.claims.length, mode: h.claims[0].mode, paths: h.claims.flatMap(c => c.paths), claims: h.claims }
      })
      return { ok: true, data: withWarn({ statePath: fs.processPath(target), serverTime: t, totalClaims: state.claims.length, holders }, warn) }
    }
    async function status(a, agentId) {
      const { state, target, warn } = await load(agentId); const t = now(); expire(state, t)
      const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
      const rel = state.claims.filter(c => paths.some(p => c.paths.some(cp => ov(p, cp))))
      return { ok: true, data: withWarn({ statePath: fs.processPath(target), paths, related: rel.map(pub), exclusive: rel.filter(c => c.mode === 'exclusive').map(pub), serverTime: t }, warn) }
    }
    async function msgs(a, agentId) {
      const { state } = await load(agentId)
      const since = Number(a.since) || 0, limit = Math.max(1, Math.min(200, Number(a.limit) || 50))
      let l = state.messages
      if (typeof a.channel === 'string' && a.channel.trim()) l = l.filter(m => m.channel === a.channel.trim())
      l = l.filter(m => m.seq > since).slice(-limit)
      return { ok: true, data: { since, returned: l.length, messages: l } }
    }
    async function waitFor(a, h, agentId) {
      const timeoutMs = Math.max(0, Math.min(120000, Number(a.timeoutMs) || 30000))
      const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
      if (!paths.length) return { ok: false, error: 'bad-request', message: 'paths required' }
      const deadline = now() + timeoutMs
      let blockers = []
      while (now() < deadline) {
        const { state } = await load(agentId)
        const t = now()
        blockers = state.claims.filter(c => c.expiresAt > t && c.mode === 'exclusive' && c.holderId !== h.holderId && c.paths.some(cp => paths.some(p => ov(p, cp))))
        if (blockers.length === 0) return { ok: true, data: { paths, blockers: [], waitedMs: Math.round(timeoutMs - Math.max(0, deadline - now())) } }
        await ctx.timer.timeout(400)
      }
      return { ok: false, error: 'timeout', message: 'paths still claimed', paths, blockers: blockers.map(pub), waitedMs: timeoutMs }
    }
    const exec = (fn) => async (args, e) => { args = args || {}; const h = holderOf(e); const name = hname(h); const aId = h.sessionId || null; try { return await fn(args, h, name, aId) } catch (err) { return { ok: false, error: 'internal', message: String((err && err.message) || err) } } }
    const lock = exec((a, h, name, aId) => {
      if (a.op === 'claim') return mutate(s => claim(s, h, name, a), aId)
      if (a.op === 'release') return mutate(s => release(s, h, a), aId)
      if (a.op === 'heartbeat') return mutate(s => heartbeat(s, h, a), aId)
      if (a.op === 'list') return list(aId)
      if (a.op === 'overview') return overview(aId)
      if (a.op === 'status') return status(a, aId)
      if (a.op === 'wait') return waitFor(a, h, aId)
      return { ok: false, error: 'bad-request', message: 'unknown op: ' + String(a.op) }
    })
    const board = exec((a, h, name, aId) => {
      if (a.op === 'post') return mutate(s => post(s, h, name, a), aId)
      if (a.op === 'read') return msgs(a, aId)
      return { ok: false, error: 'bad-request', message: 'unknown op: ' + String(a.op) }
    })
    const render = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    const lockTool = harness.defineTool({
      name: 'collab_lock',
      description: '多智能体协作中央注册锁：开工前声明占用项目文件夹（目录以 / 结尾，如 src/backend/），查询他人占用，减少共同开发冲突。规范：动手改代码前先 claim；开工前和定期 list/overview；冲突时先 wait 等待或用 board 留言协商；完成即 release；长任务 heartbeat 续租。',
      parameters: {
        type: 'object',
        additionalProperties: true,
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
      output: { schema: { type: 'object', additionalProperties: true }, render },
      execute: lock
    })
    const boardTool = harness.defineTool({
      name: 'collab_board',
      description: '多智能体协作留言板：向协作域发消息（频道 general / path:<路径> / agent:<holderId>）或增量读取消息，用于协商、交接、同步进展。',
      parameters: {
        type: 'object',
        additionalProperties: true,
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
      output: { schema: { type: 'object', additionalProperties: true }, render },
      execute: board
    })
    ctx.effect(() => harness.registerTool(ctx, lockTool))
    ctx.effect(() => harness.registerTool(ctx, boardTool))
    ctx.on('agent/disposed', (payload) => {
      try {
        const agent = payload && payload.agent
        if (!agent || !agent.id) return
        const h = 'agent:' + String(agent.id)
        mutate(s => { const rel = s.claims.filter(c => c.holderId === h); if (!rel.length) return { ok: true, changed: false, data: {} }; s.claims = s.claims.filter(c => c.holderId !== h); return { ok: true, changed: true, state: s, data: { released: rel.map(pub) } } }, String(agent.id)).catch(() => {})
      } catch (e) {}
    })
  }
}
`

// 供 CommonJS 使用。动态插件场景直接取 hostCode 字符串即可。
export default { hostCode }
