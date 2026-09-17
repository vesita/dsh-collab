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
    // 注意：这里**故意不**注册随包 skill（skills.register / subagent-delegation）。
    // 受限动态宿主里没有包目录、也没有 import，无法定位 <pkg>/skills/subagent-delegation/SKILL.md，
    // 所以这是环境限制，不是遗漏。包形态见 src/index.ts：它按 import.meta.url 解析 ../skills/ 后注册。
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
    // 与 collab-core 的 publish() 同形：readable / readers 归一后输出（缺字段 = true / []）。
    // 动态宿主形态没有 pre/post-execute 接线（受限环境不注册事件），所以这两个字段在这里
    // 只保证**形状对拍**，不承担门控/推送语义。
    const hostReaders = c => { const raw = Array.isArray(c.readers) ? c.readers : []; const out = []; for (const x of raw) if (typeof x === 'string' && x && !out.includes(x)) out.push(x); return out }
    const pub = c => ({ claimId: c.claimId, holderId: c.holderId, holderName: c.holderName, paths: c.paths, mode: c.mode, ttlSec: c.ttlSec, expiresAt: c.expiresAt, note: c.note, createdAt: c.createdAt, readable: c.readable !== false, readers: hostReaders(c) })
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
    // 把任意抛出物转成一行可读文本（warning 里要带真实原因，不能只写「失败了」）。
    // 与包形态 store.ts 的 describeError 同语义（两形态各写一份，见 inline-parity 的说明）。
    const describeError = e => {
      try {
        const m = e && typeof e === 'object' ? e.message : undefined
        if (typeof m === 'string' && m) return m
        return String(e)
      } catch (e2) { return 'unknown error' }
    }
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
      let warn = cwd ? null : '状态文件落在默认位置（本会话没有 cwd），按项目隔离已失效'
      if (degraded) {
        const degradedWarn = '无法解析 DSH 用户目录（settings.prepareDocument 不可用或无效）；状态文件落在项目本地的 .dsh-collab/ 下，且不与其他启动形态共享'
        warn = warn ? warn + '; ' + degradedWarn : degradedWarn
      }
      // 迁移失败**不再静默**（与包形态 store.ts 同方向）：旧落点搬不过来 = 项目凭空退回空状态。
      const migrateNotes = []
      const mergeWarn = extra => {
        const parts = []
        if (warn) parts.push(warn)
        for (const n of migrateNotes) parts.push(n)
        if (extra) parts.push(extra)
        return parts.length ? parts.join('; ') : null
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
        } catch (e) {
          migrateNotes.push('旧落点迁移失败：' + describeError(e))
        }
      }
      if (!info) return { state: init(), version: null, target: target, stateDir: stateDir, warn: mergeWarn(null) }
      const raw = await fs.readText(target)
      let s
      try { s = Object.assign(init(), JSON.parse(raw)) } catch (e) {
        // **不许谎报**：备份/重置各自是否成功必须如实写进 warning（与包形态 store.ts 逐字对齐）。
        // 原实现在两处 catch 都吞掉失败，却照旧写 'reinitialized' / 'backup: <路径>'。
        let backupPath = null
        let backupFailure = null
        try {
          const backupTarget = await fs.resolve(target.displayPath + '.corrupt-' + now())
          await fs.writeText(backupTarget, raw, { kind: 'createIfAbsent' })
          backupPath = fs.processPath(backupTarget)
        } catch (backupError) { backupFailure = describeError(backupError) }
        let resetOk = false
        let resetFailure = null
        try {
          await fs.writeText(target, JSON.stringify(init()), { kind: 'replaceIfVersion', version: info.version })
          resetOk = true
        } catch (resetError) { resetFailure = describeError(resetError) }
        // 证据链：如实交代原始损坏内容此刻的下落。
        const corruptWarn = '状态文件损坏'
          + (resetOk ? '；已重新初始化' : '；重新初始化失败：' + resetFailure)
          + (backupPath ? '；备份：' + backupPath : '')
          + (backupFailure ? '；备份失败：' + backupFailure : '')
          + (resetOk ? '' : '；原始损坏内容仍留在磁盘上')
          + (backupFailure && resetOk ? '；原始损坏内容已被重置覆盖' : '')
        return { state: init(), version: null, target: target, stateDir: stateDir, warn: mergeWarn(corruptWarn) }
      }
      s.claims = Array.isArray(s.claims) ? s.claims : []
      s.messages = Array.isArray(s.messages) ? s.messages : []
      s.holders = Array.isArray(s.holders) ? s.holders : []
      return { state: s, version: info.version, target: target, stateDir: stateDir, warn: warn }
    }
    // holder 是否仍"新鲜"：age 落在 [-SKEW, TTL) 内。sweep 与 holderView 共用同一判据。
    const holderFresh = (lastSeenAt, t) => { const age = t - (lastSeenAt || 0); return age < 86400000 && age > -300000 }
    function sweep(s, t, opts) {
      const b = s.claims.length; s.claims = s.claims.filter(c => c.expiresAt > t); const expiredClaims = b - s.claims.length
      let droppedMessages = 0
      if (s.messages.length > 2000) { droppedMessages = s.messages.length - 2000; s.messages = s.messages.slice(-2000) }
      const active = new Set(s.claims.map(c => c.holderId)); const hb = s.holders.length
      s.holders = s.holders.filter(h => active.has(h.holderId) || holderFresh(h.lastSeenAt, t))
      // 与 collab-core 的 sweep 同形：**reader 不在这里清理**（0.8.3 修掉的真缺陷）。
      // 曾经的 liveHolders 判据（agents.get(sessionId) !== undefined）会把只是空闲、
      // 并未结束的读者一并删掉 —— 该 claim 释放时已无人可通知。读者只由 dropHolder
      // （agent/disposed）摘掉，且它**只摘 reader 登记、不回收未过期声明**（W7：
      // 租约是声明回收的唯一机制）；有界性由 claim 的 release/到期保证。
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
    // ---- 会话家族（血缘）：只用于冲突判定，**不进状态文件**（与包形态 store.familyIds 同源）----
    // 血缘来自子代理创建时写入的 session.header.parentSession
    // （dsh-subagent/lib/types/child-agent.js:117-123）；拿不到就退化为"只看 holderId 相等"，
    // 也就是 0.9.10 的语义。
    const LINEAGE_MAX_DEPTH = 16
    const parentSessionOf = (id, self) => {
      try {
        let a
        if (self && self.id && String(self.id) === id) a = self
        else { const svc = ctx.get('agents'); a = svc && typeof svc.get === 'function' ? svc.get(id) : undefined }
        const p = a && a.session && a.session.header ? a.session.header.parentSession : undefined
        return typeof p === 'string' && p ? p : null
      } catch (e) { return null }
    }
    const ancestorIds = (agentId, self) => {
      const out = []
      const seen = new Set([agentId])
      let cur = parentSessionOf(agentId, self)
      while (cur && !seen.has(cur) && out.length < LINEAGE_MAX_DEPTH) { seen.add(cur); out.push(cur); cur = parentSessionOf(cur) }
      return out
    }
    const descendantIds = agentId => {
      const out = []
      if (!agentId) return out
      try {
        const svc = ctx.get('agents')
        if (!svc || typeof svc.list !== 'function') return out
        const arr = svc.list()
        if (!Array.isArray(arr)) return out
        for (const a of arr) {
          const id = a && a.id ? String(a.id) : ''
          if (!id || id === agentId) continue
          let cur = parentSessionOf(id, a), depth = 0
          while (cur && depth++ < LINEAGE_MAX_DEPTH) { if (cur === agentId) { out.push(id); break } cur = parentSessionOf(cur) }
        }
      } catch (e) {}
      return out
    }
    const familyIds = (agentId, agent) => {
      const self = agentId ? 'agent:' + agentId : 'human:console'
      if (!agentId) return [self]
      const out = [self]
      for (const id of ancestorIds(agentId, agent)) out.push('agent:' + id)
      for (const id of descendantIds(agentId)) out.push('agent:' + id)
      return out
    }
    // 家族判据（与 collab-core.inFamily **同名同形**，逐输出对拍见 tests/collab-inline-parity.mjs）。
    function inFamily(h, holderId) {
      if (holderId === h.holderId) return true
      return Array.isArray(h.family) && h.family.indexOf(holderId) >= 0
    }
    const holderOf = exec => { const agent = exec && exec.agent; const id = agent && agent.id ? String(agent.id) : null; return { agent, holderId: id ? 'agent:' + id : 'human:console', sessionId: id || undefined, family: familyIds(id, agent) } }
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
      // 可读性（功能 C 的数据维度）：默认 true，只认显式 false；不参与冲突扫描。
      const readable = a.readable === undefined || a.readable === null ? true : a.readable !== false
      const ttl = Math.max(5, Math.min(86400, Number(a.ttlSec) || 1800))
      const note = typeof a.note === 'string' ? a.note.slice(0, 500) : ''
      const t = now(), cs = []
      // read 是纯观测：不阻塞他人，也不被他人阻塞，整段冲突扫描跳过。
      if (mode !== 'read') {
      for (const c of state.claims) {
        if (inFamily(h, c.holderId) || c.expiresAt <= t || c.mode === 'shared' || c.mode === 'read') continue
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
        own.ttlSec = ttl; own.note = note || own.note; own.expiresAt = expiresAt
        // 只在显式给出时改写可读性（缺省不重置）；readers 原样保留。
        if (a.readable !== undefined && a.readable !== null) own.readable = readable
        cl = own
      }
      else { cl = { claimId: 'c_' + (++state.seq), holderId: h.holderId, holderName: name, paths, mode, ttlSec: ttl, expiresAt, note, createdAt: t, readable, readers: [] }; state.claims.push(cl) }
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
    // 僵尸声明显式回收（0.9.8，op=reap）——与 collab-core.ts 的 reap() **同形同名**，
    // 由 tests/collab-inline-parity.mjs 逐输出对拍。**只由显式 op 调用，绝不自动触发**：
    // 判据是「holder 不在 agents.list() 里 + age 超门槛」，而 agents.list() 只含本进程此刻
    // 加载着的 agent —— 休眠但可唤回的会话同样不在里面（0.8.2 按它清 readers 静默丢通知、
    // W7 确认 dispose 不得提前释放未过期声明），运行时注册表**无法区分**"休眠可唤回"与"真死"。
    // 所以默认 dry-run，只把候选交给调用方确认；误杀的代价是持有者恢复后以为自己仍有锁。
    // liveHolderIds = null 表示活体检查没跑成 ⇒ 一个也不收（拿不到名单时"不在名单里"没有信息量）。
    function reap(s, h, a, liveHolderIds, t) {
      const raw = Number(a && a.olderThanSec)
      const olderThanSec = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 600
      const confirm = !!(a && a.confirm === true)
      const paths = (Array.isArray(a && a.paths) ? a.paths : []).map(norm).filter(Boolean)
      const unknown = liveHolderIds === null || liveHolderIds === undefined
      const live = new Set(Array.isArray(liveHolderIds) ? liveHolderIds : [])
      const hits = []
      if (!unknown) {
        for (const c of s.claims) {
          if (!(c.expiresAt > t)) continue
          if (c.holderId === h.holderId) continue
          if (typeof c.holderId !== 'string' || !c.holderId.startsWith('agent:')) continue
          if (live.has(c.holderId)) continue
          const createdAt = typeof c.createdAt === 'number' ? c.createdAt : c.expiresAt - (c.ttlSec || 0) * 1000
          const ageSec = Math.max(0, Math.floor((t - createdAt) / 1000))
          if (!(ageSec > olderThanSec)) continue
          if (paths.length && !c.paths.some(cp => paths.some(p => ov(p, cp)))) continue
          hits.push(c)
        }
      }
      const entries = hits.map(c => {
        const createdAt = typeof c.createdAt === 'number' ? c.createdAt : c.expiresAt - (c.ttlSec || 0) * 1000
        const reasons = ['unexpired', 'agent-holder', 'not-self', 'holder-not-in-agents-list', 'age-over-threshold']
        if (paths.length) reasons.push('paths-intersect')
        return Object.assign(pub(c), {
          ageSec: Math.max(0, Math.floor((t - createdAt) / 1000)),
          remainingSec: Math.max(0, Math.ceil((c.expiresAt - t) / 1000)),
          olderThanSec,
          reasons
        })
      })
      const base = { olderThanSec, serverTime: t, livenessCheck: unknown ? 'unavailable' : 'ok' }
      // 级联清 holder（0.9.11，与包形态 collab-core.reap 同源）：被回收的 holder 若已无
      // 未过期声明且不在活体名单里，就从 holders 表里摘掉，不必等 24h 的 sweep 自愈。
      const gone = new Set(hits.map(c => c.holderId))
      const stillActive = new Set(s.claims.filter(c => !hits.includes(c)).map(c => c.holderId))
      if (!confirm) {
        const candidateHolders = []
        if (!unknown) for (const hh of s.holders) {
          if (gone.has(hh.holderId) && !stillActive.has(hh.holderId) && !live.has(hh.holderId)) candidateHolders.push(hh.holderId)
        }
        return { ok: true, changed: false, state: s, data: Object.assign({ dryRun: true }, base, { candidates: entries, candidateHolders }) }
      }
      if (!hits.length) return { ok: true, changed: false, state: s, data: Object.assign({ dryRun: false }, base, { reaped: [], reapedHolders: [] }) }
      s.claims = s.claims.filter(c => !hits.includes(c))
      const reapedHolders = []
      if (!unknown) {
        s.holders = s.holders.filter(hh => {
          if (!gone.has(hh.holderId) || stillActive.has(hh.holderId) || live.has(hh.holderId)) return true
          reapedHolders.push(hh.holderId)
          return false
        })
      }
      return { ok: true, changed: true, state: s, data: Object.assign({ dryRun: false }, base, { reaped: entries, reapedHolders }) }
    }
    // 与 collab-core/包形态的 dropHolder **同形**（同名同签名，由 tests/collab-inline-parity.mjs
    // 逐输出对拍）：把这个已消失的 holder 从所有剩余 claim 的 readers 摘掉，并**只回收它已经过期**的
    // 声明。租约（expiresAt）是声明回收的**唯一**机制 —— dispose 不是释放信号：会话被 dispose 后
    // 往往会恢复并继续干活，提前删掉声明会让别的会话在 overview 里看到路径空闲（W7 锁安全缺陷）。
    // t 由调用方显式传入（纯逻辑，不隐式读时钟）。
    function dropHolder(s, h, t) {
      const isExpired = c => c.holderId === h && c.expiresAt <= t
      const rel = s.claims.filter(isExpired)
      let changed = rel.length > 0
      if (rel.length) s.claims = s.claims.filter(c => !isExpired(c))
      for (const c of s.claims) {
        const list = hostReaders(c)
        if (!list.includes(h)) continue
        c.readers = list.filter(x => x !== h); changed = true
      }
      if (!changed) return { ok: true, changed: false, data: {} }
      return { ok: true, changed: true, state: s, data: { released: rel.map(pub) } }
    }
    // 循环终止自动释放（0.9.10）：见 src/collab-core.ts 的同名函数与 README「循环终止自动释放」。
    // 与包形态**同语义**：只释放**未过期**声明（过期的归 sweep），并在留言板留一条审计留言
    // （channel=agent:<holderId>，author=system:dsh-collab）。释放之后由谁告知读者与本人，
    // 见下面的 agent/status 接线注释 —— 本形态**不投递**任何通知。
    // 与包形态的一致性由 tests/collab-inline-parity.mjs 逐输出对拍本函数守护。
    const releaseOnLoopEnd = (s, holderId, holderName, t, graceSec) => {
      const mine = s.claims.filter(c => c.holderId === holderId && c.expiresAt > t)
      if (!mine.length) return { ok: true, changed: false, data: { released: [] } }
      s.claims = s.claims.filter(c => !mine.includes(c))
      const released = mine.map(pub)
      const uniq = []
      for (const c of released) for (const p of c.paths) if (!uniq.includes(p)) uniq.push(p)
      const shown = uniq.slice(0, 3).join(' ') + (uniq.length > 3 ? ' 等 ' + uniq.length + ' 条' : '')
      const who = holderName || holderId
      const m = {
        msgId: 'm_' + (++s.seq),
        seq: s.seq,
        channel: holderId,
        author: 'system:dsh-collab',
        ts: t,
        body: '[自动释放] ' + who + ' 的会话循环已结束（空闲超过 ' + graceSec + ' 秒），其对 ' + shown +
          ' 的声明已被自动释放。恢复工作前如需写入这些路径，请重新 collab_lock op=claim。',
        mentions: [holderId]
      }
      s.messages.push(m)
      return { ok: true, changed: true, state: s, data: { released: released, notice: m } }
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
    // 跨项目观测（0.9.11，与包形态 store.otherProjects 同源）：把**别的项目**的占用摘要
    // 附在 overview 的返回里。只读、失败降级、不编造；宿主 fs 没有 listDir 时只报当前项目。
    async function otherProjects(current, stateDirPath, t) {
      try {
        if (!fs || typeof fs.listDir !== 'function' || !stateDirPath) return { otherProjects: [], otherProjectsNote: '宿主 fs 不提供 listDir：只能看到当前项目' }
        const dir = await fs.resolve(stateDirPath)
        const entries = await fs.listDir(dir)
        const here = fs.processPath(current)
        const out = []
        for (const e of entries) {
          if (!e || typeof e.name !== 'string' || !/\.json$/.test(e.name) || !e.target) continue
          if (fs.processPath(e.target) === here) continue
          let doc
          try { doc = JSON.parse(await fs.readText(e.target)) } catch (err) { continue }
          if (!doc || typeof doc !== 'object') continue
          const claims = Array.isArray(doc.claims) ? doc.claims : []
          const active = claims.filter(c => c && typeof c.expiresAt === 'number' && c.expiresAt > t)
          if (!active.length) continue
          out.push({ file: e.name, statePath: fs.processPath(e.target), totalClaims: active.length, claims: active.map(c => ({ holderId: c.holderId, holderName: c.holderName, mode: c.mode, paths: Array.isArray(c.paths) ? c.paths : [] })) })
        }
        out.sort((a, b) => b.totalClaims - a.totalClaims)
        return { otherProjects: out.slice(0, 10) }
      } catch (e) { return { otherProjects: [] } }
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
      const other = await otherProjects(target, stateDir, t)
      return { ok: true, data: withWarn(Object.assign({ statePath: fs.processPath(target), stateDir: stateDir, serverTime: t, totalClaims: state.claims.length, holders }, other), warn) }
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
        blockers = state.claims.filter(c => c.expiresAt > t && c.mode === 'exclusive' && !inFamily(h, c.holderId) && c.paths.some(cp => paths.some(p => ov(p, cp))))
        if (blockers.length === 0) return { ok: true, data: { paths, blockers: [], waitedMs: Math.round(timeoutMs - Math.max(0, deadline - now())) } }
        await ctx.timer.timeout(400)
      }
      return { ok: false, error: 'timeout', message: 'paths still claimed', paths, blockers: blockers.map(pub), waitedMs: timeoutMs }
    }
    // op=reap 的活体检查：agents.list() 的 holderId 列表（'agent:' + a.id）。
    // 返回 **null** = 检查没跑成（服务/方法缺失或抛错）—— 与"名单为空"是两件事：
    // 前者一个也不收（拿不到名单时"不在名单里"没有信息量），后者是"此刻确实没有活着的 agent"。
    function liveAgentHolderIds() {
      try {
        const svc = ctx.get('agents')
        if (!svc || typeof svc.list !== 'function') return null
        const arr = svc.list()
        if (!Array.isArray(arr)) return null
        const out = []
        for (const a of arr) { const id = a && a.id ? String(a.id) : null; if (id) out.push('agent:' + id) }
        return out
      } catch (e) { return null }
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
      if (a.op === 'reap') return mutate(s => reap(s, h, a, liveAgentHolderIds(), now()), aId, agent)
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
      description: '多智能体协作中央注册锁：开工前声明占用项目文件夹（目录以 / 结尾，如 src/backend/），查询他人占用，减少共同开发冲突。规范：动手改代码前先 claim；开工前和定期 list/overview；冲突时先 wait 等待或用 board 留言协商；完成即 release；长任务 heartbeat 续租；被强杀的会话会留下僵尸声明，默认 dry-run 的 op=reap 可显式回收（先看候选，再 confirm:true）。会话循环结束（空闲超过宽限期，默认 15 秒）后，你的声明会被自动释放：恢复工作前请重新 claim。',
      parameters: {
        type: 'object',
        additionalProperties: true,
        properties: {
          op: { type: 'string', enum: ['claim', 'release', 'list', 'overview', 'status', 'heartbeat', 'wait', 'reap'], description: 'claim 声明 / release 释放 / list 全部 / overview 占用全景 / status 查路径 / heartbeat 续租 / wait 等待路径释放 / reap 显式回收僵尸声明（默认 dry-run）' },
          paths: { type: 'array', items: { type: 'string' }, description: '项目相对路径' },
          claimId: { type: 'string', description: 'claim id，release/heartbeat 用' },
          mode: { type: 'string', enum: ['exclusive', 'shared', 'read'], description: 'exclusive 独占（默认）；shared 声明共用但被独占挡住；read 只读观测，不排他也不被挡' },
          ttlSec: { type: 'number', description: '租约秒数（5-86400），默认 1800' },
          timeoutMs: { type: 'number', description: 'wait 用，最多等待毫秒，默认 30000' },
          confirm: { type: 'boolean', description: 'reap 用：默认 false = dry-run，只列候选、绝不改状态；显式 true 才真正删除僵尸声明' },
          olderThanSec: { type: 'number', description: 'reap 用：age 门槛（秒），声明创建至今必须严格大于它才算候选，默认 600' },
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
    // 缓存的是**原始活跃 claim 列表**，不是"某个人视角渲染好的文本"（0.9.1 修，与包形态同语义）。
    // 原实现的"排除自己"做在刷新侧、缓存又只按 cwd 做键 ⇒ 同 cwd 的刷新互相覆盖：
    // 只要有一次刷新发生在 id 为空的 agent 上（mine='human:console'，谁都不排除），
    // 之后同 cwd 的所有会话都会读到这份"含自己锁"的缓存，持有者被自己的占用误导。
    // 视角是**读取侧**的事：按当前发起者现场过滤（见下面的 text()）。
    const digestCache = new Map()
    const digestBusy = new Set()
    // 文本必须**时间稳定**：DSH 的 RuntimeContextProjection.project() 在 rendered === retained.text 时
    // 直接返回 undefined（内容没变就不提交新快照），而快照是整块提交的（沙箱策略 + 审批策略 + 本摘要）。
    // 「剩 N 分」每分钟都变，会让整块快照每分钟重发一次；改用绝对起止时刻后只在占用集合真变时才变。
    // 以下 clockUtc / renderDigest 与 collab-core.ts 的同名导出**逐字节等价**（受限执行环境不能 import，
    // 只能内联）；二者的一致性由 tests/collab-hostcode-parity.mjs 逐字符对拍。
    // 模式名 → 渲染给人看的标签（W9 文案中文化），与 collab-core.ts 的 MODE_LABELS / modeLabel
    // **同形同值**。只用于渲染文本：mode 的取值与契约仍是 'exclusive' | 'shared' | 'read'。
    const MODE_LABELS = { exclusive: '独占', shared: '共享', read: '只读' }
    function modeLabel(mode) {
      return MODE_LABELS[mode] || String(mode)
    }
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
        return (c.holderName || c.holderId) + '（' + modeLabel(c.mode) + '）占用 ' + paths + '，租约 ' + mins + ' 分（' + start + '–' + clockUtc(c.expiresAt) + '）'
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
        // 只按"是否过期"筛；**不**在这里按 holderId 筛（那是读取侧的事，见 digestCache 的注释）。
        const active = state.claims.filter(c => c.expiresAt > t)
        digestCache.set(cwd, { claims: active, at: t })
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
            // 视角过滤在**读取侧**：同一份 cwd 缓存对所有会话都成立，"排除谁"才因人而异。
            // 0.9.11 起排的是整个**会话家族**（自己 + 祖先 + 后代），与包形态同源。
            const fam = new Set(familyIds(init.id ? String(init.id) : null, init))
            const t = now()
            const others = (hit ? hit.claims : []).filter(c => !fam.has(c.holderId) && c.expiresAt > t)
            return others.length ? renderDigest(others) : OPEN_HINT
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
        // 与 collab-core/包形态的 dropHolder 同形：只回收**已过期**的声明，并把这个已消失的
        // holder 从所有剩余 claim 的 readers 摘掉。租约是唯一的回收机制 —— dispose 不缩短租约。
        mutate(s => dropHolder(s, h, now()), String(agent.id), agent).catch(() => {})
      } catch (e) {}
    }, { global: true })

    // ---- 循环终止自动释放（0.9.10）：agent/status → idle 后等宽限期，期间恢复 running 就取消 ----
    // 三道闸门与包形态（src/auto-release.ts）一致：宽限期 + 代次（任何状态变化都让本次武装作废）
    // + 到点复核 status。**唯一的差别**：这里不投递任何通知 —— 受限动态宿主没有
    // @deepseek-ai/dsh-llm，构造不出「显式来源的 notice」，而 AGENTS.md §1 禁止退回任何会冒充
    // 用户的通道，所以本形态只做状态变更（释放 + 留言板留痕）。包形态才发读者/本人两条告知。
    // 宽限期**常量 120 秒**（0.9.11 起；包形态的 loopEndGraceSec 默认值也是它）：
    // 动态形态读不到 settings 服务。15 秒会把"派完子代理、等它跑几分钟"误判成循环终止。
    // tests/collab-hostcode-parity.mjs 会真实触发这条接线，断言"未过期声明在宽限期到点后被释放"。
    const LOOP_END_GRACE_SEC = 120
    const armedIdle = new Map()
    let idleGen = 0
    let idleClosed = false
    ctx.effect(() => () => { idleClosed = true; armedIdle.clear() })
    const agentStatusOf = (a) => (a && typeof a.status === 'string' ? a.status : '')
    function fireIdleRelease(id, gen) {
      try {
        if (idleClosed || armedIdle.get(id) !== gen) return
        armedIdle.delete(id)
        // 服务面**现场取**（与包形态同）：apply 时捕获会让"复核 status"这条闸门静默失效。
        let svc
        try { svc = ctx.get('agents') } catch (e) { svc = undefined }
        if (!svc || typeof svc.get !== 'function') return
        let cur
        try { cur = svc.get(id) } catch (e) { return }
        // 合取闸门：解析不到（已 dispose）或当前不是 idle，一律**不放**。
        // W7 就在这一句里：退场的会话常常恢复并继续干活，而它此刻收不到任何告知。
        if (!cur || agentStatusOf(cur) !== 'idle') return
        // 第 4 道闸门（0.9.11）：有自家子代理在 running 就不放，重新武装（与包形态同源）。
        // 判据缺失时按"没人在跑"处理，否则一把没人用的锁永远不会被自动释放。
        const desc = descendantIds(id)
        if (desc.length) {
          let childRunning = false
          for (const did of desc) {
            let child
            try { child = svc.get(did) } catch (e) { continue }
            if (child && agentStatusOf(child) === 'running') { childRunning = true; break }
          }
          if (childRunning) { armIdleRelease(id); return }
        }
        const holderId = 'agent:' + id
        const name = hname({ holderId: holderId, sessionId: id, agent: cur })
        mutate(s => releaseOnLoopEnd(s, holderId, name, now(), LOOP_END_GRACE_SEC), id, cur).catch(() => {})
      } catch (e) {}
    }
    function armIdleRelease(id) {
      if (idleClosed) return
      const gen = ++idleGen
      armedIdle.set(id, gen)
      ctx.timer.timeout(LOOP_END_GRACE_SEC * 1000).then(() => { fireIdleRelease(id, gen) }).catch(() => {})
    }
    ctx.on('agent/status', (payload) => {
      try {
        const agent = payload && payload.agent
        const id = agent && agent.id ? String(agent.id) : ''
        if (!id) return
        const status = payload && typeof payload.status === 'string' ? payload.status : agentStatusOf(agent)
        if (status === 'idle') armIdleRelease(id)
        else if (status === 'running') armedIdle.delete(id)
      } catch (e) {}
    }, { global: true })
    // 退场 ⇒ 取消武装（到点也不会释放：fireIdleRelease 的第 3 条闸门）。**只取消，不释放**。
    ctx.on('agent/disposed', (payload) => {
      try {
        const agent = payload && payload.agent
        if (agent && agent.id) armedIdle.delete(String(agent.id))
      } catch (e) {}
    }, { global: true })
    // 装机时已经 idle 的会话补一次武装（插件晚于 agent 装载 / 热重载时，那一轮 idle 事件收不到）。
    try {
      const boot = ctx.get('agents')
      if (boot && typeof boot.list === 'function') {
        for (const a of boot.list()) if (a && a.id && agentStatusOf(a) === 'idle') armIdleRelease(String(a.id))
      }
    } catch (e) {}
  }
}
`

// 默认导出便于 `import host from '...'` 取用；动态插件场景直接取 hostCode 字符串即可。
export default { hostCode }
