// collab-plugin.host.ts
// 自包含的 Cordis Host 插件源码（等价于动态插件 coll-1/pkg-9，当前运行版本）。
//
// 用法：
//   import { hostCode } from './lib/collab-plugin.host.js'        // ESM（构建产物）
//   cordis_define(code: { host: hostCode })                       // 作为 code.host
//
// 注意：Cordis 动态插件的 code.host 不接受 import/打包，因此本文件内联了
// 与 src/collab-core.ts 逻辑一致的纯逻辑部分。纯逻辑唯一事实源见 collab-core.ts；
// 正式化进 host 组合后可直接 import 该核心模块消除重复。
// 工具参数契约见 src/schema/collab.schema.json（JSON Schema v1）。

// hostCode 是纯 JavaScript 源码文本，直接作为 Cordis 动态插件的 code.host 使用，
// 不参与 TypeScript 类型检查；只导出它的本模块是 TypeScript。
export const hostCode: string = `
return {
  inject: ['fs', 'timer'],
  apply(ctx) {
    const fs = ctx.fs
    const sessions = ctx.get('sessions')
    const sessionTitle = ctx.get('sessionTitle')
    const LEGACY_FILE = '.dsh-collab.json'
    const now = () => Date.now()
    // 状态目录（**绝对路径**）惰性解析 + 闭包缓存：null=未解析/失败，string=成功。
    // 受限动态宿主里拿不到 os/process；唯一可信锚点是 settings.prepareDocument() 返回的
    // 绝对文档路径（实测形如 /home/vesita/.dsh/settings.yaml），取其 dirname 再拼
    // /collab/projects，即 DSH_HOME（或 $HOME）下的 .dsh/collab/projects。
    // 绝不依赖字面量波浪号路径（fs.resolve 不做 shell 展开），也绝不依赖进程 cwd 的相对路径。
    let stateDirCache = null
    async function resolveStateDir() {
      if (stateDirCache) return stateDirCache
      // 只在成功时缓存：settings 服务可能晚于本插件就绪，失败留待下次重试。
      try {
        const settings = ctx.get('settings')
        if (settings && typeof settings.prepareDocument === 'function') {
          const docPath = await settings.prepareDocument()
          if (typeof docPath === 'string') {
            const clean = docPath.replace(/\\\\/g, '/').replace(/\\/+$/, '')
            const cut = clean.lastIndexOf('/')
            if (clean.charAt(0) === '/' && cut > 0) stateDirCache = clean.slice(0, cut) + '/collab/projects'
          }
        }
      } catch (e) { stateDirCache = null }
      return stateDirCache
    }
    const init = () => ({ schemaVersion: 1, seq: 0, claims: [], messages: [], holders: [] })
    const seg = p => p.split('/').filter(Boolean)
    const ov = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false; const sa = seg(a), sb = seg(b), n = Math.min(sa.length, sb.length); for (let i = 0; i < n; i++) if (sa[i] !== sb[i]) return false; return true }
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
    // 写入失败是否属于"乐观并发冲突，值得重读后重试"。
    // 真实 ctx.fs 抛 FsError：code 是独立字段，message 里不含 code（实测文案见下），
    // 所以必须按 code 精确判定，且不要用裸 /stale/i（会命中路径里的 stale 字样）。
    const stale = e => {
      const code = e && typeof e.code === 'string' ? e.code : ''
      if (code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED' || code === 'EEXIST') return true
      const m = String((e && e.message) || e)
      return /FS_STALE_VERSION|FS_NOT_OBSERVED|file changed since it was read|without reading it first|already exists/i.test(m)
    }
    const conflict = cs => { const e = new Error('conflict'); e.collabConflict = true; e.conflicts = cs; return e }
    const withWarn = (data, warn) => (warn ? Object.assign({}, data, { warning: warn }) : data)
    async function cwdOf(agentId, agent) {
      try {
        if (agent && agent.session && agent.session.header && typeof agent.session.header.cwd === 'string' && agent.session.header.cwd) return agent.session.header.cwd
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
      const fileName = storageNameFor(cwd)
      const dir = await resolveStateDir()
      if (dir) {
        // 绝对目录 + 绝对文件路径；fs.resolve 对绝对路径原样通过（实测）。
        return { cwd: cwd, fileName: fileName, stateDir: dir, degraded: false, target: await fs.resolve(dir + '/' + fileName) }
      }
      // 退化路径：解析不到 DSH 用户目录时，落到**会话 cwd** 下的项目内 .dsh-collab/。
      // 仅当连会话 cwd 都没有（控制台调用）时不存在任何绝对锚点，才省略 cwd（退回进程 cwd）。
      const opts = cwd ? { cwd: cwd } : undefined
      const target = await fs.resolve('.dsh-collab/' + fileName, opts)
      let stateDir = '.dsh-collab'
      try { stateDir = fs.processPath(await fs.resolve('.dsh-collab', opts)) } catch (e) {}
      return { cwd: cwd, fileName: fileName, stateDir: stateDir, degraded: true, target: target }
    }
    async function load(agentId, agent) {
      const { cwd, target, stateDir, degraded } = await targetFor(agentId, agent)
      let warn = cwd ? null : 'state-file at default location (no session cwd); per-project isolation disabled'
      if (degraded) {
        const degradedWarn = 'cannot resolve DSH user dir (settings.prepareDocument unavailable or invalid); state lives in project-local .dsh-collab/ and is NOT shared with other launcher forms'
        warn = warn ? warn + '; ' + degradedWarn : degradedWarn
      }
      let info = await fs.stat(target)
      // 平滑兼容：若外部尚未生成，但项目内存在遗留的 .dsh-collab.json，则自动无缝迁移至外部存储
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
      if (!info) return { state: init(), version: null, target: target, stateDir: stateDir, warn: warn }
      const raw = await fs.readText(target)
      let s
      try { s = Object.assign(init(), JSON.parse(raw)) } catch (e) {
        let backupPath = null
        try {
          const backupTarget = await fs.resolve(target.displayPath + '.corrupt-' + now())
          await fs.writeText(backupTarget, raw, { kind: 'createIfAbsent' })
          backupPath = fs.processPath(backupTarget)
        } catch (backupError) {}
        try { await fs.writeText(target, JSON.stringify(init()), { kind: 'replaceIfVersion', version: info.version }) } catch (resetError) {}
        const corruptWarn = 'state corrupted; reinitialized' + (backupPath ? '; backup: ' + backupPath : '')
        return { state: init(), version: null, target: target, stateDir: stateDir, warn: warn ? warn + '; ' + corruptWarn : corruptWarn }
      }
      s.claims = Array.isArray(s.claims) ? s.claims : []
      s.messages = Array.isArray(s.messages) ? s.messages : []
      s.holders = Array.isArray(s.holders) ? s.holders : []
      return { state: s, version: info.version, target: target, stateDir: stateDir, warn: warn }
    }
    // holder 是否仍"新鲜"：age 落在 [-SKEW, TTL) 内。sweep 与 holderView 共用同一判据。
    const holderFresh = (lastSeenAt, t) => { const age = t - (lastSeenAt || 0); return age < 86400000 && age > -300000 }
    function sweep(s, t) {
      const b = s.claims.length; s.claims = s.claims.filter(c => c.expiresAt > t); const expiredClaims = b - s.claims.length
      let droppedMessages = 0
      if (s.messages.length > 2000) { droppedMessages = s.messages.length - 2000; s.messages = s.messages.slice(-2000) }
      const active = new Set(s.claims.map(c => c.holderId)); const hb = s.holders.length
      s.holders = s.holders.filter(h => active.has(h.holderId) || holderFresh(h.lastSeenAt, t))
      return { expiredClaims, droppedMessages, prunedHolders: hb - s.holders.length }
    }
    function expire(s, t) { return sweep(s, t).expiredClaims }
    // stale 用 1h 预警阈值（小于 24h 回收阈值），因此在"先 sweep 再取视图"的路径上依然可达。
    function holderView(s, t) {
      const activeIds = new Set(s.claims.filter(c => c.expiresAt > t).map(c => c.holderId))
      const holders = s.holders.map(h => {
        const lastSeenAt = h.lastSeenAt || 0
        const ageMs = t - lastSeenAt
        const ageSec = Math.max(0, Math.floor(ageMs / 1000))
        const active = activeIds.has(h.holderId)
        return { holderId: h.holderId, name: h.name, kind: h.kind, sessionId: h.sessionId, lastSeenAt, ageSec, active, stale: !active && (ageMs >= 3600000 || !holderFresh(lastSeenAt, t)) }
      }).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      return { holders, staleHolders: holders.filter(x => x.stale).length }
    }
    async function mutate(fn, agentId, agent) {
      for (let i = 0; i < 5; i++) {
        const { state, version, target } = await load(agentId, agent)
        expire(state, now())
        let out
        try { out = fn(state) } catch (e) { if (e && e.collabConflict) return { ok: false, error: 'conflict', conflicts: e.conflicts }; throw e }
        if (!out || out.changed === false) {
          if (!out) return { ok: false, error: 'not-found', message: 'nothing to change' }
          const data = out.data || {}
          if (out.ok === false) return { ok: false, error: data.error || 'bad-request', message: data.message, ...data }
          return { ok: true, data }
        }
        try {
          if (version === null) await fs.writeText(target, JSON.stringify(out.state), { kind: 'createIfAbsent' })
          else await fs.writeText(target, JSON.stringify(out.state), { kind: 'replaceIfVersion', version })
          return { ok: true, data: out.data }
        } catch (e) { if (stale(e) && i < 4) continue; throw e }
      }
      return { ok: false, error: 'concurrent-modification', message: 'state busy, retry later' }
    }
    const holderOf = exec => { const agent = exec && exec.agent; const id = agent && agent.id ? String(agent.id) : null; return { agent, holderId: id ? 'agent:' + id : 'human:console', sessionId: id || undefined } }
    function cleanName(s) {
      if (typeof s !== 'string') return s
      let n = s.replace(/\\s+/g, ' ').trim()
      if (n.length > 24) n = n.slice(0, 24) + '…'
      return n
    }
    function hname(h) {
      let name = null
      if (h.sessionId && (sessions || h.agent) && sessionTitle) { try { const s = (h.agent && h.agent.session) || (sessions && sessions.get(h.sessionId)); if (s) { const t = sessionTitle.get(s); if (t && typeof t.title === 'string' && t.title) name = t.title } } catch (e) {} }
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
      const requested = a.mode === undefined || a.mode === null || a.mode === '' ? 'exclusive' : a.mode
      if (requested !== 'exclusive' && requested !== 'shared' && requested !== 'read') {
        return { ok: false, changed: false, data: { error: 'bad-request', message: 'mode must be one of exclusive | shared | read (got ' + String(a.mode) + ')' } }
      }
      const mode = requested
      const ttl = Math.max(5, Math.min(86400, Number(a.ttlSec) || 1800))
      const note = typeof a.note === 'string' ? a.note.slice(0, 500) : ''
      const t = now(), cs = []
      // read 是纯观测：不阻塞他人，也不被他人阻塞，整段冲突扫描跳过。
      if (mode !== 'read') {
      for (const c of state.claims) {
        if (c.holderId === h.holderId || c.expiresAt <= t || c.mode === 'shared' || c.mode === 'read') continue
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
      }
      if (cs.length) throw conflict(cs)
      holder(state, h, name)
      const expiresAt = t + ttl * 1000
      // 合并限定在**同一 mode**：跨 mode 合并会把子路径的 exclusive 扩到父路径上，
      // 连带锁住从未被独占的兄弟路径。
      const own = state.claims.find(c => c.holderId === h.holderId && c.mode === mode && c.paths.some(cp => paths.some(p => ov(p, cp))))
      let cl
      if (own) {
        for (const p of paths) if (!own.paths.includes(p)) own.paths.push(p)
        own.ttlSec = ttl; own.note = note || own.note; own.expiresAt = expiresAt; cl = own
      }
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
      const { state, target, stateDir, warn } = await load(agentId); const t = now()
      // 先 sweep 再取视图：>24h 的废弃 holder 不再出现；stale 用 1h 预警阈值，依然可达。
      const ex = expire(state, t); const hv = holderView(state, t)
      return { ok: true, data: withWarn({ seq: state.seq, serverTime: t, statePath: fs.processPath(target), stateDir: stateDir, schemaVersion: state.schemaVersion, holders: hv.holders, staleHolders: hv.staleHolders, claims: state.claims.map(pub), expiredCount: ex }, warn) }
    }
    async function overview(agentId) {
      const { state, target, stateDir, warn } = await load(agentId); const t = now(); expire(state, t)
      const byHolder = {}
      for (const c of state.claims) {
        const k = c.holderId
        if (!byHolder[k]) byHolder[k] = { holderId: k, holderName: c.holderName || k, claims: [] }
        byHolder[k].claims.push(pub(c))
      }
      const holders = Object.keys(byHolder).map(k => {
        const h = byHolder[k]
        const modes = [...new Set(h.claims.map(c => c.mode))]
        return { holderId: h.holderId, holderName: h.holderName, claimCount: h.claims.length, mode: modes.length === 1 ? modes[0] : 'mixed', paths: h.claims.flatMap(c => c.paths), claims: h.claims }
      })
      return { ok: true, data: withWarn({ statePath: fs.processPath(target), stateDir: stateDir, serverTime: t, totalClaims: state.claims.length, holders }, warn) }
    }
    async function status(a, agentId) {
      const { state, target, stateDir, warn } = await load(agentId); const t = now(); expire(state, t)
      const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
      const rel = state.claims.filter(c => paths.some(p => c.paths.some(cp => ov(p, cp))))
      return { ok: true, data: withWarn({ statePath: fs.processPath(target), stateDir: stateDir, paths, related: rel.map(pub), exclusive: rel.filter(c => c.mode === 'exclusive').map(pub), serverTime: t }, warn) }
    }
    async function msgs(a, agentId) {
      const { state } = await load(agentId)
      const since = Number(a.since) || 0, limit = Math.max(1, Math.min(200, Number(a.limit) || 50))
      let l = state.messages
      if (typeof a.channel === 'string' && a.channel.trim()) l = l.filter(m => m.channel === a.channel.trim())
      const matched = l.filter(m => m.seq > since)
      const returned = matched.slice(-limit)
      return { ok: true, data: { since, returned: returned.length, total: matched.length, latestSeq: state.messages.length ? state.messages[state.messages.length - 1].seq : 0, messages: returned } }
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
    const exec = (fn) => async (args, e) => { args = args || {}; const h = holderOf(e); const name = hname(h); const aId = h.sessionId || null; try { return await fn(args, h, name, aId, h.agent) } catch (err) { return { ok: false, error: 'internal', message: String((err && err.message) || err) } } }
    const lock = exec((a, h, name, aId, agent) => {
      if (a.op === 'claim') return mutate(s => claim(s, h, name, a), aId, agent)
      if (a.op === 'release') return mutate(s => release(s, h, a), aId, agent)
      if (a.op === 'heartbeat') return mutate(s => heartbeat(s, h, a), aId, agent)
      if (a.op === 'list') return list(aId, agent)
      if (a.op === 'overview') return overview(aId, agent)
      if (a.op === 'status') return status(a, aId, agent)
      if (a.op === 'wait') return waitFor(a, h, aId, agent)
      return { ok: false, error: 'bad-request', message: 'unknown op: ' + String(a.op) }
    })
    const board = exec((a, h, name, aId, agent) => {
      if (a.op === 'post') return mutate(s => post(s, h, name, a), aId, agent)
      if (a.op === 'read') return msgs(a, aId, agent)
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
          mode: { type: 'string', enum: ['exclusive', 'shared', 'read'], description: 'exclusive 独占（默认）；shared 声明共用但被独占挡住；read 只读观测，不排他也不被挡' },
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

    // ---- 多 DSH 会话协同：把同项目的实时占用注入运行时上下文 ----
    // prompt 装配时 agents.currentInitiator() 返回正在装配的那个会话（实测），据此得到项目 cwd，
    // 于是每个会话每一步都能自动看到同项目其他会话的占用，独立会话之间同样成立。
    // text 必须同步返回字符串，所以读盘走后台缓存（TTL 15s），失败时沿用上一份缓存。
    const agents = ctx.get('agents')
    const systemPrompt = ctx.get('systemPrompt')
    const OPEN_HINT = '多会话协作（dsh-collab）：同一项目可能有其他 DSH 会话并行工作。改动文件前用 collab_lock op=claim 声明占用（目录以 / 结尾，如 src/backend/），并先 op=overview 查看他人占用；只读调研用 mode=read；完成后 op=release，长任务 op=heartbeat 续租；协商与交接走 collab_board。'
    const DIGEST_TTL_MS = 15000
    const digestCache = new Map()
    const digestBusy = new Set()
    // 文本必须**时间稳定**：DSH 的 RuntimeContextProjection.project() 在 rendered === retained.text 时
    // 直接返回 undefined（内容没变就不提交新快照），而快照是整块提交的（沙箱策略 + 审批策略 + 本摘要）。
    // 「剩 N 分」每分钟都变，会让整块快照每分钟重发一次；改用绝对起止时刻后只在占用集合真变时才变。
    // 以下 clockUtc / renderDigest 与 collab-core.ts 的同名导出**逐字节等价**（受限执行环境不能 import，
    // 只能内联）；二者的一致性由 tests/collab-hostcode-parity.mjs 逐字符对拍。
    function clockUtc(ms) {
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + 'Z'
    }
    function renderDigest(others) {
      // 显式排序只为确定性：状态文件里的插入顺序不该让同一组占用渲染出不同文本。
      const ordered = others.slice().sort((a, b) => (a.expiresAt - b.expiresAt) || String(a.holderId).localeCompare(String(b.holderId)))
      const parts = ordered.slice(0, 3).map(c => {
        const mins = Math.max(1, Math.round((c.ttlSec || 0) / 60))
        const paths = c.paths.slice(0, 2).join(' ') + (c.paths.length > 2 ? ' 等 ' + c.paths.length + ' 条' : '')
        const start = clockUtc(typeof c.createdAt === 'number' ? c.createdAt : c.expiresAt - (c.ttlSec || 0) * 1000)
        return (c.holderName || c.holderId) + '（' + c.mode + '）占用 ' + paths + '，租约 ' + mins + ' 分（' + start + '–' + clockUtc(c.expiresAt) + '）'
      })
      const more = ordered.length > 3 ? '；另有 ' + (ordered.length - 3) + ' 条' : ''
      return '[dsh-collab] 同项目其他会话当前占用：' + parts.join('；') + more + '。改动这些路径前请先执行 collab_lock op=wait 或用 collab_board 协商。'
    }
    async function refreshDigest(agent) {
      const id = agent && agent.id ? String(agent.id) : null
      const cwd = await cwdOf(id, agent)
      if (!cwd || digestBusy.has(cwd)) return
      digestBusy.add(cwd)
      try {
        const { state } = await load(id, agent)
        const t = now()
        const mine = id ? 'agent:' + id : 'human:console'
        const others = state.claims.filter(c => c.expiresAt > t && c.holderId !== mine)
        digestCache.set(cwd, { text: others.length ? renderDigest(others) : '', at: t })
      } catch (e) {
        // 尽力而为：保留上一份缓存。
      } finally { digestBusy.delete(cwd) }
    }
    if (systemPrompt && typeof systemPrompt.context === 'function') {
      ctx.effect(() => systemPrompt.context({
        name: 'dsh-collab/awareness',
        order: 130,
        text: () => {
          try {
            const init = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : undefined
            const cwd = init && init.session && init.session.header ? init.session.header.cwd : null
            if (!init || typeof cwd !== 'string' || !cwd) return OPEN_HINT
            const hit = digestCache.get(cwd)
            if (!hit || now() - hit.at > DIGEST_TTL_MS) refreshDigest(init).catch(() => {})
            return hit && hit.text ? hit.text : OPEN_HINT
          } catch (e) { return OPEN_HINT }
        }
      }))
    }
    if (agents && typeof agents.list === 'function' && ctx.timer && typeof ctx.timer.interval === 'function') {
      ctx.effect(() => ctx.timer.interval(() => {
        try { for (const a of agents.list()) refreshDigest(a).catch(() => {}) } catch (e) {}
      }, DIGEST_TTL_MS))
    }
    ctx.on('agent/disposed', (payload) => {
      try {
        const agent = payload && payload.agent
        if (!agent || !agent.id) return
        const h = 'agent:' + String(agent.id)
        mutate(s => { const rel = s.claims.filter(c => c.holderId === h); if (!rel.length) return { ok: true, changed: false, data: {} }; s.claims = s.claims.filter(c => c.holderId !== h); return { ok: true, changed: true, state: s, data: { released: rel.map(pub) } } }, String(agent.id), agent).catch(() => {})
      } catch (e) {}
    }, { global: true })
  }
}
`

// 默认导出便于 `import host from '...'` 取用；动态插件场景直接取 hostCode 字符串即可。
export default { hostCode }
