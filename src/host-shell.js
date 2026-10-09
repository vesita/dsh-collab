// src/host-shell.js
// 受限动态宿主形态的**外壳模板**（唯一事实源）。构建产物 lib/collab-plugin.host.js 由
// scripts/build-host.mjs 从本文件 + lib/collab-core.js 生成；不要手改构建产物。
//
// 这里只放**外壳**：inject/apply 接线、状态文件定位与读写（resolveStateDir /
// targetFor / load / mutate）、会话血缘、工具注册、态势摘要接线、agent/status 与 agent/disposed 接线。
// **纯逻辑一行都不写**：state 变换与渲染由 collab-core 提供，构建时在核心内联标记处
// 内联 lib/collab-core.js（唯一事实源 src/collab-core.ts）—— 剥掉顶层 `export ` 后的
// 整份源码，两形态因此逐字节同源。
//
// 为什么内联而不是 import：Cordis 动态插件的 code.host 是纯文本，不接受 import/打包。
// 为什么内联得进来：lib/collab-core.js 完全自包含（0 个 import/require），也不引用 process/os。
//
// 注意：本文件是 JS 模板字面量，外壳里凡是要生成转义序列的地方，反斜杠必须写两个
// （模板先吃掉一层）。内联进来的核心源码由 JSON.stringify 序列化，不受这一层影响。

export const hostShell = `
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
    // 写入失败是否属于"乐观并发冲突，值得重读后重试"。
    // 真实 ctx.fs 抛 FsError：code 是独立字段，message 里不含 code（实测文案见下），
    // 所以必须按 code 精确判定，且不要用裸 /stale/i（会命中路径里的 stale 字样）。
    const stale = e => {
      const code = e && typeof e.code === 'string' ? e.code : ''
      if (code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED' || code === 'EEXIST') return true
      const m = String((e && e.message) || e)
      return /FS_STALE_VERSION|FS_NOT_OBSERVED|file changed since it was read|without reading it first|already exists/i.test(m)
    }
    const withWarn = (data, warn) => (warn ? Object.assign({}, data, { warning: warn }) : data)
    // 把任意抛出物转成一行可读文本（warning 里要带真实原因，不能只写「失败了」）。
    // 与包形态 store.ts 的 describeError 同语义（外壳层的小工具，受限宿主不能 import）。
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
    // ---- 磁盘布局（0.15.0，R2）：主文件 + 留言旁挂 ----
    // 与包形态（src/store.ts）**同构**：内存里的 StateDocument 一个字不改，只是摊到磁盘上时分成
    //   <name>.json          {schemaVersion, seq, claims, holders}  主文件（锁状态）
    //   <name>.messages.json {schemaVersion, seq, messages}         旁挂（留言）
    // 这样"锁操作只写 KB 级的主文件"在两种形态里都成立（实测 82,248 B 里 79,815 B 是留言）。
    // seq 两边都写（claimId 与 msgId 共用），加载时取较大值。
    const SIDECAR_EXT = '.messages.json'
    const sidecarNameOf = fileName => (fileName.slice(-5) === '.json' ? fileName.slice(0, -5) + SIDECAR_EXT : fileName + SIDECAR_EXT)
    const mainDocOf = s => ({ schemaVersion: s.schemaVersion, seq: s.seq, claims: s.claims, holders: s.holders })
    const sideDocOf = s => ({ schemaVersion: s.schemaVersion, seq: s.seq, messages: s.messages })
    // 留言指纹（判"这次要不要写旁挂"）：条数 | 首条 msgId | 末条 msgId。
    // 判据可靠的理由**与包形态逐字同源**（见 src/store.ts 的 msgFingerprint）：留言只有
    // "尾部追加"（post，msgId 递增唯一）与"头部截断"（sweep 的条数/字节上限）两种变化，
    // 两者都必然改变条数或首条 msgId；指纹相同 ⇒ 条数与首尾 msgId 相同 ⇒ 中间条目也必然相同。
    const msgFingerprint = msgs => msgs.length + '|' + (msgs.length ? msgs[0].msgId : '') + '|' + (msgs.length ? msgs[msgs.length - 1].msgId : '')
    async function targetFor(agentId, agent) {
      const cwd = await cwdOf(agentId, agent)
      // 文件名**只认核心的 projectStorageFileName**（唯一事实源 src/collab-core.ts，构建时内联）：
      // 外壳曾经自带一份 storageNameFor，与核心异名同义、恰好落在对拍之外 —— 已删除。
      const fileName = projectStorageFileName(cwd || 'default')
      const sideName = sidecarNameOf(fileName)
      const dir = await resolveStateDir()
      if (dir) {
        // 绝对目录 + 绝对文件路径；fs.resolve 对绝对路径原样通过（实测）。
        return { cwd: cwd, fileName: fileName, stateDir: dir, degraded: false, target: await fs.resolve(dir + '/' + fileName), sidecar: await fs.resolve(dir + '/' + sideName) }
      }
      // 退化路径：解析不到 DSH 用户目录时，落到**会话 cwd** 下的项目内 .dsh-collab/。
      // 仅当连会话 cwd 都没有（控制台调用）时不存在任何绝对锚点，才省略 cwd（退回进程 cwd）。
      const opts = cwd ? { cwd: cwd } : undefined
      const target = await fs.resolve('.dsh-collab/' + fileName, opts)
      // 旁挂与主文件用**同一套基址**解析（退化路径下 target 可能是相对路径，不能靠字符串拼绝对路径）。
      const sidecar = await fs.resolve('.dsh-collab/' + sideName, opts)
      let stateDir = '.dsh-collab'
      try { stateDir = fs.processPath(await fs.resolve('.dsh-collab', opts)) } catch (e) {}
      return { cwd: cwd, fileName: fileName, stateDir: stateDir, degraded: true, target: target, sidecar: sidecar }
    }
    async function load(agentId, agent) {
      const { cwd, target, sidecar, stateDir, degraded } = await targetFor(agentId, agent)
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
      // ---- 旁挂留言文件：**主文件在不在都读**（与包形态 store.ts 同构）----
      let sideMessages = null
      let sideVersion = null
      let sideSeq = 0
      try {
        const sideInfo = await fs.stat(sidecar)
        if (sideInfo) {
          sideVersion = sideInfo.version
          const sideRaw = await fs.readText(sidecar)
          try {
            const sd = JSON.parse(sideRaw)
            if (sd && Array.isArray(sd.messages)) { sideMessages = sd.messages; sideSeq = Number(sd.seq) || 0 }
            else migrateNotes.push('留言旁挂文件结构无效（messages 不是数组）：本次按无留言处理，原文件未改动')
          } catch (e) {
            // 解析失败**不删不覆盖**：先原样备份成 <side>.corrupt-<ms>，再按无留言继续。
            // 不备份的话，下一次"留言变了"的写盘会把它整份换掉 —— 那就是静默丢留言。
            let note = '留言旁挂文件损坏：' + describeError(e)
            try {
              const backupTarget = await fs.resolve(sidecar.displayPath + '.corrupt-' + now())
              await fs.writeText(backupTarget, sideRaw, { kind: 'createIfAbsent' })
              note += '；备份：' + fs.processPath(backupTarget)
            } catch (be) { note += '；备份失败：' + describeError(be) }
            migrateNotes.push(note)
          }
        }
      } catch (e) {
        // 读不到：**故意**把 sideVersion 留在 null ⇒ 后续写盘走 createIfAbsent，
        // 真实 fs 对"已存在但没读过"的目标会拒写，宁可让 op 失败也不用读不到的内容去覆盖。
        migrateNotes.push('留言旁挂文件读取失败：' + describeError(e))
      }
      if (!info) {
        const empty = init()
        if (sideMessages) { empty.messages = sideMessages; empty.seq = sideSeq }
        return { state: empty, version: null, target: target, sidecar: sidecar, sideVersion: sideVersion, messagesInMain: false, stateDir: stateDir, warn: mergeWarn(null) }
      }
      const raw = await fs.readText(target)
      let s
      let parsed = null
      try {
        parsed = JSON.parse(raw)
        s = Object.assign(init(), parsed)
      } catch (e) {
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
          // 重置写的是**主文件那一半**（不含 messages）：旧布局的 messages 键不能借着重置复活。
          await fs.writeText(target, JSON.stringify(mainDocOf(init())), { kind: 'replaceIfVersion', version: info.version })
          resetOk = true
        } catch (resetError) { resetFailure = describeError(resetError) }
        // 证据链：如实交代原始损坏内容此刻的下落。
        const corruptWarn = '状态文件损坏'
          + (resetOk ? '；已重新初始化' : '；重新初始化失败：' + resetFailure)
          + (backupPath ? '；备份：' + backupPath : '')
          + (backupFailure ? '；备份失败：' + backupFailure : '')
          + (resetOk ? '' : '；原始损坏内容仍留在磁盘上')
          + (backupFailure && resetOk ? '；原始损坏内容已被重置覆盖' : '')
        // 主文件重置了，但旁挂留言还在：并进返回值，别让"主文件坏了"看起来像"板也空了"。
        const empty = init()
        if (sideMessages) { empty.messages = sideMessages; empty.seq = sideSeq }
        return { state: empty, version: null, target: target, sidecar: sidecar, sideVersion: sideVersion, messagesInMain: false, stateDir: stateDir, warn: mergeWarn(corruptWarn) }
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
      return { state: s, version: info.version, target: target, sidecar: sidecar, sideVersion: sideVersion, messagesInMain: messagesInMain, stateDir: stateDir, warn: mergeWarn(null) }
    }
    /*__COLLAB_CORE__*/
    /*__COLLAB_DISCIPLINE_TEXT__*/
    /*__COLLAB_PATH_SPECS__*/
    // 下面这一整段（到 __COLLAB_GATE_END__ 为止）是宿主形态的写门控，**只有**它把
    // tools/pre-execute 接到真事件总线上。tests/collab-hostcode-parity.mjs 会整段切掉再跑一次
    // 同样的写调用，断言"切掉即放行" —— 这就是"拦写确实来自这个钩子"的负向对照。
    /*__COLLAB_GATE_BEGIN__*/
    // ---- 功能 C：写/读的原生审批门控（宿主形态）----
    // 可行性取证（2026-10，M3）：tools/pre-execute 是 Cordis 的 **ctx waterfall 事件**，不是
    // 服务方法：契约声明在 dsh-tools/lib/types/index.d.ts:47（@mode waterfall），派发点是
    // dsh-tools/lib/index.js:3223 this.ctx.waterfall(carrier, 'tools/pre-execute', exec, …)。
    // 受限宿主的 ctx 门面把 on 列在白名单里（dsh-cordis-host-runner/lib/types/guard.js:569
    // 的 CTX_VERBS 含 'on'），并由 guardedPlugin 把 on 转发到**真实** host ctx
    // （guard.js:746 交给 sandboxContext，其 on 分支是 Reflect.apply(ctx[prop], ctx, args)）——
    // 也就是说监听器落在真事件总线上，与包形态的 ctx.on 同一条缝。
    // 作用域过滤对**未打标签**的监听器一律放行（dsh-scope/lib/index.js:327 的 scopeTarget：
    // if (tag === undefined) return true），而动态半边挂在未打标签的 cordis-dynamic 组下
    // （dsh-cordis-host-runner/lib/index.js:2530 this.rootCtx.plugin({ name: 'cordis-dynamic' })），
    // 所以这个钩子会收到每个 agent 的工具调用。
    //
    // 与包形态（src/gate.ts）的差异只有一处，且是**环境限制**不是设计选择：受限宿主读不到
    // process.env 与插件 Config，所以 enforceWriteLock / DSH_COLLAB_NO_PROMPT_HINT 两个开关
    // 在这里都不存在 —— 按"默认拦"实现（= 包形态两个开关的默认值）。
    // 反向交叉预警（gate.ts 的 teamScopeNotice）**不移植**：它要 agent.inject 投递一条显式来源的
    // notice，而受限宿主没有 @deepseek-ai/dsh-llm（见本文件 agent/disposed 的注释）；团队写域的
    // 只读交叉预警仍由 order-130 的态势摘要提供（teamCrossWarnLine）。
    // 门控自身故障一律放行（插件的问题不该锁死整个工具面），与包形态同。
    /** 把命中渲染成 ask 的理由（与 src/gate.ts 的 gateReason 逐字一致）。 */
    function gateReason(c, target, kind) {
      const start = clockUtc(typeof c.createdAt === 'number' ? c.createdAt : c.expiresAt - (c.ttlSec || 0) * 1000)
      const who = holderLabel(c.holderId, c.holderName)
      const what = kind === 'write' ? '写入' : '读取（对方已声明不可读）'
      return '[dsh-collab] ' + target + ' 由 ' + who + ' 占用（' + modeLabel(c.mode) + '）：非持有者' + what +
        '需要先协商。租约 ' + start + '–' + clockUtc(c.expiresAt) + '。先 collab_lock op=wait 或 collab_board 协商，或改用其他路径。'
    }
    /** 门控判定：返回 ask 决策，或 null 表示放行。判据与 src/gate.ts 的 writeGate 逐条同语义。 */
    async function writeGate(execCtx) {
      const toolName = execCtx && typeof execCtx.name === 'string' ? execCtx.name : ''
      const args = (execCtx && execCtx.arguments) || {}
      const spec = pathArgsFor(toolName, args)
      if (!spec.write.length && !spec.read.length) return null
      const agent = execCtx && execCtx.agent
      const id = agent && agent.id ? String(agent.id) : null
      const cwd = await cwdOf(id, agent)
      // holderOf 顺带把会话家族（血缘）现算出来：父会话 claim 了 src/ 再派子代理改 src/ 时，
      // 子代理的写不该被自己家的锁拦下（判据与 claim() 的冲突扫描同源，见 collab-core.inFamily）。
      const me = holderOf(execCtx)
      const { state } = await load(id, agent)
      const t = now()
      const hits = []
      // mode 过滤与 collab-core 的 claim() 冲突判据**同源**：shared/read 一律不参与门控
      //（read 是纯观测、既不排他也不被挡；OPEN_HINT 正好推荐只读调研用 mode=read）。
      const consider = (c, target, kind) => {
        if (inFamily(me, c.holderId)) return
        if (c.mode === 'shared' || c.mode === 'read') return
        hits.push({ claim: c, target: target, kind: kind })
      }
      const collect = (fields, kind) => {
        for (const field of fields) {
          const raw = args[field]
          if (typeof raw !== 'string' || !raw) continue
          const rel = relToProject(raw, cwd)
          if (rel === '') {
            // 空串 = **目标就是项目根**（'.' / './' / 绝对 cwd 本身），不是"解析不出来"。
            // 根的判据取保守侧（0.14.0 修）：任何他人的未过期 exclusive 声明都算冲突 ——
            // 本部署 ask == deny，指向根的写本来也不可能成功，误拦代价≈0，漏拦才是把门控关掉。
            for (const c of state.claims) if (c.expiresAt > t) consider(c, '.', kind)
            continue
          }
          for (const c of claimsCovering(state.claims, rel, t)) consider(c, rel, kind)
        }
      }
      collect(spec.write, 'write')
      collect(spec.read, 'read')
      if (!hits.length) return null
      // 走到这里 hits 只剩他人的、未过期的 exclusive 声明。写：非持有者一律拦。
      // 读：只有持有者显式 readable:false 才拦（可读性默认 true）。
      const blocking = hits.filter(h => h.kind === 'write' || !isReadable(h.claim))
      if (!blocking.length) return null
      const hit = blocking[0]
      return { kind: 'ask', reason: gateReason(hit.claim, hit.target, hit.kind) }
    }
    ctx.on('tools/pre-execute', async (execCtx, next) => {
      try {
        const decision = await writeGate(execCtx)
        if (decision) return decision
      } catch (e) {
        // 门控自身故障时放行：插件的问题不该锁死整个工具面。
      }
      return next()
    })
    /*__COLLAB_GATE_END__*/
    /**
     * 落盘：**先写旁挂，再写主文件**（与包形态 store.ts 的 writeState 同构、同理由）。
     * 顺序不能反：迁移那一次主文件里的 messages 键会被去掉，主文件先写成功而旁挂写失败
     * 就等于把留言只剩在内存里。messagesInMain 为真时这一次**必须**写旁挂。
     * 注意：本文件是模板字面量，外壳里的注释**一个反引号都不能有**（会提前结束模板）。
     */
    async function writeState(next, version, target, sidecar, sideVersion, messagesInMain, fpBefore) {
      const writeSide = messagesInMain || msgFingerprint(next.messages) !== fpBefore
      if (writeSide) {
        const sideBody = JSON.stringify(sideDocOf(next))
        if (sideVersion === null) await fs.writeText(sidecar, sideBody, { kind: 'createIfAbsent' })
        else await fs.writeText(sidecar, sideBody, { kind: 'replaceIfVersion', version: sideVersion })
      }
      // 主文件：本形态**每一次**写盘都写它（承载声明/名册/seq，本来就只有 KB 级），内容永不含 messages。
      const mainBody = JSON.stringify(mainDocOf(next))
      if (version === null) await fs.writeText(target, mainBody, { kind: 'createIfAbsent' })
      else await fs.writeText(target, mainBody, { kind: 'replaceIfVersion', version })
    }
    async function mutate(fn, agentId, agent) {
      for (let i = 0; i < 5; i++) {
        const { state, version, target, sidecar, sideVersion, messagesInMain } = await load(agentId, agent)
        // 跑 op **之前**取留言指纹：expire() 也会截断留言（条数/字节上限），所以要在它之前取，
        // 否则"这次只清掉了旧留言"会被判成"留言没变"而丢掉截断结果。
        const fpBefore = msgFingerprint(state.messages)
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
          await writeState(out.state, version, target, sidecar, sideVersion, messagesInMain, fpBefore)
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
    const holderOf = exec => { const agent = exec && exec.agent; const id = agent && agent.id ? String(agent.id) : null; return { agent, holderId: id ? 'agent:' + id : 'human:console', sessionId: id || undefined, family: familyIds(id, agent) } }
    function hname(h) {
      let name = null
      if (h.sessionId && (sessions || h.agent) && sessionTitle) { try { const s = (h.agent && h.agent.session) || (sessions && sessions.get(h.sessionId)); if (s) { const t = sessionTitle.get(s); if (t && typeof t.title === 'string' && t.title) name = t.title } } catch (e) {} }
      return cleanName(name || h.holderId)
    }
    // 读路径必须与写路径**用同一份状态文件**：agent 是 cwdOf 的第一顺位锚点
    // （agent.session.header.cwd），丢了它就会落到 default-<hash>.json —— claim 与 list 读写不同文件。
    // 包形态 store.ts 的 6 个 load 调用同理，全都传 agent。下面 5 个只读 op 都不许再漏。
    async function list(agentId, agent) {
      const { state, target, stateDir, warn } = await load(agentId, agent); const t = now()
      // 先 sweep 再取视图：死掉的名册行（句柄结束 / 写它的进程不在了）根本不出现；
      // stale 用 1h 预警阈值，依然可达。
      const ex = expire(state, t); const hv = holderView(state, t)
      // holdersNote 只在有 stale 条目时出现（与包形态 store.ts 的 list 同形同文案）：
      // 名册被读成"过期锁"的实测现场才有这句话，干净项目一个字都不加。
      const rosterNote = holderRosterNote(hv.staleHolders)
      // 名册**有界**返回（0.14.0，C）：截断不丢事实 —— holdersTotal 恒在，调用方自己看得出被折叠了。
      const data = { seq: state.seq, serverTime: t, statePath: fs.processPath(target), stateDir: stateDir, schemaVersion: state.schemaVersion, holders: hv.holders.slice(0, HOLDER_VIEW_LIMIT), holdersTotal: hv.holders.length, staleHolders: hv.staleHolders, claims: state.claims.map(publish), expiredCount: ex }
      if (rosterNote) data.holdersNote = rosterNote
      return { ok: true, data: withWarn(data, warn) }
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
          // **排除留言旁挂文件**（与包形态 store.otherProjects 同构）：它也以 .json 结尾，
          // 不排掉就会被当成"另一个项目"去 parse。
          if (e.name.slice(-SIDECAR_EXT.length) === SIDECAR_EXT) continue
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
    // op=overview 的 I/O 外壳。**不能叫 overview**：collab-core 导出的纯函数 overview(state)
    // 会被内联进同一个作用域，同名会互相遮蔽（后者胜），所以外壳这一层改名 overviewOf。
    async function overviewOf(agentId, agent) {
      const { state, target, stateDir, warn } = await load(agentId, agent); const t = now(); expire(state, t)
      const byHolder = {}
      for (const c of state.claims) {
        const k = c.holderId
        if (!byHolder[k]) byHolder[k] = { holderId: k, holderName: c.holderName || k, claims: [] }
        byHolder[k].claims.push(publish(c))
      }
      const holders = Object.keys(byHolder).map(k => {
        const h = byHolder[k]
        const modes = [...new Set(h.claims.map(c => c.mode))]
        return { holderId: h.holderId, holderName: h.holderName, claimCount: h.claims.length, mode: modes.length === 1 ? modes[0] : 'mixed', paths: h.claims.flatMap(c => c.paths), claims: h.claims }
      })
      const other = await otherProjects(target, stateDir, t)
      // 官方团队在跑任务的 advisory 写域（0.11.0）：服务缺席 ⇒ 一个字段都不加（一字不变）。
      const team = teamTasks(agent)
      const teamField = team === null
        ? {}
        : (team.length
          ? { teamTasks: team, teamTasksNote: '来自官方 Agent Teams 的在跑任务；write_scopes 是 advisory，不参与本插件的门控' }
          : { teamTasks: [], teamTasksNote: '官方 Agent Teams 服务在场：此刻没有在跑任务' })
      return { ok: true, data: withWarn(Object.assign({ statePath: fs.processPath(target), stateDir: stateDir, serverTime: t, totalClaims: state.claims.length, holders }, other, teamField), warn) }
    }
    async function status(a, agentId, agent) {
      const { state, target, stateDir, warn } = await load(agentId, agent); const t = now(); expire(state, t)
      const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
      const rel = state.claims.filter(c => paths.some(p => c.paths.some(cp => ov(p, cp))))
      return { ok: true, data: withWarn({ statePath: fs.processPath(target), stateDir: stateDir, paths, related: rel.map(publish), exclusive: rel.filter(c => c.mode === 'exclusive').map(publish), serverTime: t }, warn) }
    }
    async function msgs(a, agentId, agent) {
      const { state, warn } = await load(agentId, agent)
      return { ok: true, data: withWarn(filterMessages(state, a), warn) }
    }
    async function waitFor(a, h, agentId, agent) {
      const timeoutMs = Math.max(0, Math.min(120000, Number(a.timeoutMs) || 30000))
      const paths = (Array.isArray(a.paths) ? a.paths : []).map(norm).filter(Boolean)
      if (!paths.length) return { ok: false, error: 'bad-request', message: 'paths required' }
      const deadline = now() + timeoutMs
      let blockers = []
      while (now() < deadline) {
        const { state } = await load(agentId, agent)
        const t = now()
        blockers = state.claims.filter(c => c.expiresAt > t && c.mode === 'exclusive' && !inFamily(h, c.holderId) && c.paths.some(cp => paths.some(p => ov(p, cp))))
        if (blockers.length === 0) return { ok: true, data: { paths, blockers: [], waitedMs: Math.round(timeoutMs - Math.max(0, deadline - now())) } }
        await ctx.timer.timeout(400)
      }
      return { ok: false, error: 'timeout', message: 'paths still claimed', paths, blockers: blockers.map(publish), waitedMs: timeoutMs }
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
    // 时钟注入：collab-core 的纯函数不隐式读时钟，全部由调用点把 now 传进去
    // （claim/release/heartbeat/post/holder 的最后一个参数）。h.name 也是 collab-core
    // 取名字的入口（旧的宿主副本走独立的 name 形参）。
    const exec = (fn) => async (args, e) => { args = args || {}; const h = holderOf(e); const name = hname(h); h.name = name; const aId = h.sessionId || null; try { return await fn(args, h, name, aId, h.agent) } catch (err) { return { ok: false, error: 'internal', message: String((err && err.message) || err) } } }
    // op=claim + 官方 Agent Teams 的 advisory 交叉预警（0.11.0，与包形态 tools.ts 同语义）：
    // claim 的结果与冲突判定**一字不动**，只在成功返回的 data 上追加 teamOverlaps。
    async function claimWithTeamAdvisory(a, h, name, aId, agent) {
      const res = await mutate(s => claim(s, h, a, now), aId, agent)
      try {
        if (res && res.ok === true && res.data) {
          const team = teamTasks(agent)
          if (team !== null) {
            const paths = (Array.isArray(a.paths) ? a.paths : []).filter(p => typeof p === 'string' && !!p)
            res.data.teamOverlaps = teamScopeOverlaps(team, paths)
          }
        }
      } catch (e) {}
      return res
    }
    const lock = exec((a, h, name, aId, agent) => {
      if (a.op === 'claim') return claimWithTeamAdvisory(a, h, name, aId, agent)
      if (a.op === 'release') return mutate(s => release(s, h, a, now), aId, agent)
      if (a.op === 'heartbeat') return mutate(s => heartbeat(s, h, a, now), aId, agent)
      if (a.op === 'list') return list(aId, agent)
      if (a.op === 'overview') return overviewOf(aId, agent)
      if (a.op === 'status') return status(a, aId, agent)
      if (a.op === 'wait') return waitFor(a, h, aId, agent)
      if (a.op === 'reap') return mutate(s => reap(s, h, a, liveAgentHolderIds(), now()), aId, agent)
      return { ok: false, error: 'bad-request', message: '未知操作：' + String(a.op) }
    })
    const board = exec((a, h, name, aId, agent) => {
      if (a.op === 'post') return mutate(s => post(s, h, a, now), aId, agent)
      if (a.op === 'read') return msgs(a, aId, agent)
      return { ok: false, error: 'bad-request', message: '未知操作：' + String(a.op) }
    })
    const render = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    const lockTool = harness.defineTool({
      name: 'collab_lock',
      description: '多智能体协作中央注册锁：开工前声明占用项目文件夹（目录以 / 结尾，如 src/backend/），查询他人占用，减少共同开发冲突。规范：动手改代码前先 claim；开工前和定期 list/overview；冲突时先 wait 或用 board 协商；完成即 release；长任务 heartbeat 续租；被强杀的会话会留下僵尸声明，op=reap 可回收（默认只列候选，confirm:true 才真删）。会话循环结束、空闲超过宽限期（默认 120 秒，随 collab 设置变）后你的声明会被自动释放：恢复工作前重新 claim。',
      parameters: {
        type: 'object',
        additionalProperties: true,
        properties: {
          op: { type: 'string', enum: ['claim', 'release', 'list', 'overview', 'status', 'heartbeat', 'wait', 'reap'], description: 'claim 声明 / release 释放 / list 全部 / overview 占用全景 / status 查路径 / heartbeat 续租 / wait 等待路径释放 / reap 显式回收僵尸声明（默认 dry-run）' },
          paths: { type: 'array', items: { type: 'string' }, description: '项目相对路径；claim、status、wait 用；目录以 / 结尾表示整棵子树' },
          claimId: { type: 'string', description: 'claim id，release/heartbeat 用' },
          mode: { type: 'string', enum: ['exclusive', 'shared', 'read'], description: 'exclusive 独占（默认）；shared 声明共用但被独占挡住；read 只读观测，不排他也不被挡' },
          readable: { type: 'boolean', description: 'claim 用：他人是否可读这些路径，默认 true；false 表示他人读取也要先协商（写入对非持有者始终要协商）' },
          ttlSec: { type: 'number', description: '租约秒数（5-86400），默认 1800' },
          timeoutMs: { type: 'number', description: 'wait 用，最多等待毫秒，默认 30000' },
          confirm: { type: 'boolean', description: 'reap 用：默认 false = dry-run，只列候选、绝不改状态；显式 true 才真正删除僵尸声明' },
          olderThanSec: { type: 'number', description: 'reap 用：age 门槛（秒），声明创建至今必须严格大于它才算候选，默认 600' },
          note: { type: 'string', description: '占用说明，显示在 list/overview 里' }
        },
        required: ['op']
      },
      output: { schema: { type: 'object', additionalProperties: true }, render },
      execute: lock
    })
    const boardTool = harness.defineTool({
      name: 'collab_board',
      description: '跨会话协作留言板：post 往共享状态文件留痕 / read 增量读取。用于同一仓库上互不相识的会话之间交接进度与协商。**不投递、不唤醒任何会话**（没有 mentions 参数）：对方只在它自己 read 时才看得到；要让某个已停下的会话动起来，用它自己的消息工具（以你当时的工具目录为准）。read 两种模式：不给 since（或 0）读**最新** limit 条（追平用）；给 since>0 从该游标**往后**读 limit 条（增量用，旧→新）——按返回的 nextSince 继续调、直到 hasMore=false 才算读完。',
      parameters: {
        type: 'object',
        additionalProperties: true,
        properties: {
          op: { type: 'string', enum: ['post', 'read'], description: 'post 发消息 / read 增量读取' },
          channel: { type: 'string', description: '频道，默认 general；**精确匹配**的自由字符串（写什么就得按什么读，path: 频道与 claim 用同一套相对路径写法），未命中时返回会列出既有频道' },
          body: { type: 'string', maxLength: 8000, description: 'post 用，消息正文。上限 8000 字符（与 collab-core 的 MESSAGE_BODY_MAX_CHARS 同值）；超限由 post() 以 bad-request 挡回且**整条不写入**，不静默截断' },
          replyTo: { type: 'string', description: '回复的 msgId' },
          since: { type: 'number', description: 'read 用：省略或 0 = 读最新 limit 条（tail）；>0 = 从该 seq 往后读 limit 条（forward，旧→新）。返回的 nextSince 是下一次的游标' },
          limit: { type: 'number', description: 'read 用，最多条数，默认 50，上限 200' }
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
    const OPEN_HINT = '多会话协作（dsh-collab）：同一项目可能有其他 DSH 会话并行工作。改动文件前用 collab_lock op=claim 声明占用（目录以 / 结尾，如 src/backend/），并先 op=overview 查看他人占用；只读调研用 mode=read；完成后 op=release，长任务 op=heartbeat 续租；跨会话交接与协商走 collab_board（只留痕，不投递、不唤醒；要某个已停下的会话动起来用它自己的消息工具）。'
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
    // 官方 Agent Teams 在跑任务的只读视图（0.11.0，与包形态 store.teamTasks 同语义）：
    // 服务缺席 / 读不到 ⇒ null（调用方一字不变）；服务在场但此刻没有在跑任务 ⇒ []。
    function teamTasks(agent) {
      try {
        const svc = ctx.get('agentTeams')
        if (!svc || typeof svc.listTasks !== 'function' || !agent) return null
        const rows = svc.listTasks(agent)
        if (!Array.isArray(rows)) return null
        const out = []
        for (const r of rows) {
          if (!r || typeof r !== 'object') continue
          const id = typeof r.id === 'string' ? r.id : (r.id === undefined || r.id === null ? '' : String(r.id))
          if (!id) continue
          const status = typeof r.status === 'string' ? r.status : ''
          if (status !== 'in_progress') continue
          const scopes = Array.isArray(r.writeScopes) ? r.writeScopes.filter(s => typeof s === 'string' && s.trim().length > 0) : []
          if (!scopes.length) continue
          const t = { id: id, subject: typeof r.subject === 'string' ? r.subject : '', status: status, writeScopes: scopes }
          if (typeof r.ownerName === 'string' && r.ownerName) t.ownerName = r.ownerName
          out.push(t)
        }
        out.sort((a, b) => a.id.localeCompare(b.id))
        return out
      } catch (e) { return null }
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
            // 0.11.0 交叉预警（只读、advisory）：teamTasks 为 null（服务缺席 / 读不到）时
            // teamLine 与 xwarn 都是 null ⇒ 本函数输出**一字不变**。
            const team = teamTasks(init)
            const teamLine = teamTaskScopeLine(team)
            const xwarn = teamCrossWarnLine(team, others)
            const lines = [others.length ? renderDigest(others) : OPEN_HINT]
            if (teamLine) lines.push(teamLine)
            if (xwarn) lines.push(xwarn)
            return lines.join('\\n')
          } catch (e) { return OPEN_HINT }
        }
      }))
      // 委托纪律（order 131，与包形态 src/delegation.ts 同名同序号、**同一份文本**）。
      // 纪律文本的唯一事实源是 src/spec.ts 的 DELEGATION_DISCIPLINE_TEXT：构建时由
      // scripts/build-host.mjs 从 lib/spec.js 取值，内联到上面的 /*__COLLAB_DISCIPLINE_TEXT__*/
      // 标记处 —— 外壳里**没有**手抄副本（手抄副本会静默腐烂，见 AGENTS.md §1）。
      // 这里不认包形态的 DSH_COLLAB_NO_PROMPT_HINT / exposeDelegationDiscipline 开关：
      // 受限动态宿主里读不到 process/env 与插件 Config，所以按"默认开"处理。
      ctx.effect(() => systemPrompt.context({
        name: 'dsh-collab/delegation',
        order: 131,
        text: () => DELEGATION_DISCIPLINE_TEXT
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
        // **句柄结束 ⇒ 自动删除**（0.13.0，与包形态 src/push.ts 同源）：释放它的全部未过期声明
        // （带审计留痕），并照旧把它从所有 claim 的 readers 里摘掉。本形态不投递任何通知。
        let name = h
        try { name = hname({ holderId: h, sessionId: String(agent.id), agent: agent }) || h } catch (e) {}
        mutate(s => {
          const rel = releaseOnLoopEnd(s, h, name, now(), 120, 'disposed')
          const dropped = dropHolder(s, h, now())
          if (rel.changed !== true && dropped.changed !== true) return { ok: true, changed: false, data: {} }
          return { ok: true, changed: true, state: s, data: {} }
        }, String(agent.id), agent).catch(() => {})
      } catch (e) {}
    }, { global: true })

    // ---- 循环终止自动释放（0.9.10）：agent/status → idle 后等宽限期，期间恢复 running 就取消 ----
    // 三道闸门与包形态（src/auto-release.ts）一致：宽限期 + 代次（任何状态变化都让本次武装作废）
    // + 到点复核 status。**唯一的差别**：这里不投递任何通知 —— 受限动态宿主没有
    // @deepseek-ai/dsh-llm，构造不出「显式来源的 notice」，而 AGENTS.md §1 禁止退回任何会冒充
    // 用户的通道，所以本形态只做状态变更（释放 + 留言板留痕）。包形态才发读者/本人两条告知。
    // 宽限期**常量 120 秒**（0.9.11 起；包形态的 loopEndGraceSec 默认值也是它）：
    // 动态形态读不到 settings 服务，所以这里写死常量；旧的十几秒会把"派完子代理、等它跑几分钟"误判成循环终止。
    // tests/collab-hostcode-parity.mjs 会真实触发这条接线，断言"未过期声明在宽限期到点后被释放"。
    const LOOP_END_GRACE_SEC = 120
    // 第 4 道闸门的**有界延期**（0.12.0，与包形态同源）：最多延期这么多轮宽限期，到顶照常释放。
    // 理由见 src/auto-release.ts 文件头第 4 条（running 可能只是没落地的陈旧状态）。
    const CHILD_DEFER_MAX_ROUNDS = 10
    const armedIdle = new Map()
    const idleDeferrals = new Map()
    let idleGen = 0
    let idleClosed = false
    ctx.effect(() => () => { idleClosed = true; armedIdle.clear(); idleDeferrals.clear() })
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
          if (childRunning) {
            const rounds = idleDeferrals.get(id) || 0
            if (rounds < CHILD_DEFER_MAX_ROUNDS) {
              idleDeferrals.set(id, rounds + 1)
              armIdleRelease(id)
              return
            }
          }
        }
        idleDeferrals.delete(id)
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
        else if (status === 'running') { armedIdle.delete(id); idleDeferrals.delete(id) }
      } catch (e) {}
    }, { global: true })
    // 退场 ⇒ 取消武装（到点也不会释放：fireIdleRelease 的第 3 条闸门）。**只取消，不释放**。
    ctx.on('agent/disposed', (payload) => {
      try {
        const agent = payload && payload.agent
        if (agent && agent.id) { armedIdle.delete(String(agent.id)); idleDeferrals.delete(String(agent.id)) }
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
