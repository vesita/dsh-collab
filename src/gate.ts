// src/gate.ts
// **功能 C：写/读的原生审批门控**。
//
// 依赖：状态存取面（store）+ 偏好读取面（prefs）。写保护总开关是**活读**的：
// prefs.enforceWriteLockEnabled() 每次调用都重新结算，用户在设置里一改即可生效。
// 门控自身故障一律放行（插件的问题不该锁死整个工具面）。

import { inFamily } from './collab-core.js'
import { claimsCovering, relToProject, isReadable, modeLabel, holderLabel } from './collab-ops.js'
import type { Claim } from './collab-core.js'
import { pathArgsFor, SHELL_TOOLS, shellPathMentions } from './spec.js'
import type { AgentLike, CollabContext } from './contract.js'
import type { StateStore } from './store.js'
/** 把 holder 的 agent:<sessionId> 交给 harness 的活体 oracle（三态原样透传；取不到算 failed）。 */
function isLiveFn(store: StateStore): (holderId: string) => 'live' | 'not-live' | 'failed' {
  return (holderId: string) => {
    const sessionId = holderId.startsWith('agent:') ? holderId.slice(6) : holderId
    try { return store.livenessOf(sessionId).state } catch { return 'failed' }
  }
}

import type { PushApi } from './push.js'

/** 门控需要的偏好读取面（由 delegation 安装器交出）。 */
export interface GatePrefs {
  enforceWriteLockEnabled(): boolean
}

/**
 * 官方 Agent Teams 的**建任务/改任务**工具名（0.11.0 反向预警的触发面）。
 * 官方没有给第三方插件任何"任务即将创建"的钩子，但它这两个工具走的就是 DSH 的
 * `tools/pre-execute`，与本插件的写门控同一条缝 —— 于是"团队建任务时提示与外部
 * collab_lock 声明的重叠"可以在这里做到，且**只提示、不阻断**（不改任何门控语义）。
 */
const TEAM_TASK_TOOLS: readonly string[] = ['team_task_create', 'team_task_update']

export function installGate(ctx: CollabContext, store: StateStore, prefs: GatePrefs, push?: PushApi): void {
  // ---- 功能 C：写保门的门控判定 ----

  /** 把命中渲染成 ask 的理由（含持有者、路径、模式与读写类别）。 */
  function gateReason(c: Claim, target: string, kind: 'write' | 'read'): string {
    const who = holderLabel(c.holderId, c.holderName)
    const what = kind === 'write' ? '写入' : '读取（对方已声明不可读）'
    return '[dsh-collab] ' + target + ' 由 ' + who + ' 占用（' + modeLabel(c.mode) + '）：非持有者' + what +
      '需要先协商。先 collab_lock op=wait 或 collab_board 协商，或改用其他路径。'
  }

  /** 门控判定：返回 ask 决策，或 null 表示放行（由调用方 next()）。 */
  async function writeGate(execCtx: any): Promise<{ kind: 'ask'; reason: string } | null> {
    if (!prefs.enforceWriteLockEnabled()) return null
    const toolName = execCtx && typeof execCtx.name === 'string' ? execCtx.name : ''
    const args = (execCtx && execCtx.arguments) || {}
    const spec = pathArgsFor(toolName, args)
    if (!spec.write.length && !spec.read.length) return null
    const agent = execCtx && execCtx.agent
    const id = agent && agent.id ? String(agent.id) : null
    const cwd = await store.cwdOf(id, agent)
    // holderOf 顺带把**会话家族（血缘）**现算出来（自己 + 祖先 + 后代）。父会话 claim 了 src/ 再派
    // 子智能体改 src/ 时，子智能体的写不该被自己家的锁拦下 —— 这正是"子智能体用不了"的现场。
    // 判据与 claim() 的冲突扫描同源（collab-core 的 inFamily），血缘缺省时退化为旧语义。
    const me = store.holderOf(execCtx)
    const { state } = await store.load(id, agent)
    const t = store.now()
    // 登记已废弃的 holder（写它的进程已死 + 长期闲置）与 sweep 用**同一个判据**：
    // 不在门控里另算一套，否则会出现"list 看不见这条锁、门控还在拦"的分裂。
    const stale = store.staleHolderIds(state)
    // 组合后的存活判据：废弃登记直接算 not-live，其余照 oracle 三态。
    const liveFor = (holderId: string): 'live' | 'not-live' | 'failed' =>
      stale.has(holderId) ? 'not-live' : isLiveFn(store)(holderId)
    const hits: Array<{ claim: Claim; target: string; kind: 'write' | 'read' }> = []
    // mode 过滤与 collab-core.ts 的 claim() 冲突判据**同源**（见 collab-core.ts 中
    // claim() 的冲突扫描：`c.mode === 'shared' || c.mode === 'read'` 一律 continue），
    // 也与 blockers() 的 `c.mode === 'exclusive'` 一致 —— 不是随手加的例外：
    //   - shared 按定义就是"声明共用"，两个共享方不该互相挡死；
    //   - read 是纯观测，**既不排他也不被挡**。插件注入的提示（OPEN_HINT）推荐
    //     "只读调研用 mode=read"，若在此拦下它，一个只读会话会硬拒绝所有人的写入
    //     （本部署 ask = deny），正好命中推荐用法。
    // 由此 readable 只对 exclusive 声明有意义：非 exclusive 声明既不拦写也不拦读，
    // 其 readable:false 不产生任何门控效果（见 README「锁模式」「功能 C」两节）。
    const consider = (c: Claim, target: string, kind: 'write' | 'read') => {
      if (inFamily(me, c.holderId)) return
      if (c.mode === 'shared' || c.mode === 'read') return
      // 存活判据：oracle 说 not-live、或这条登记已废弃（见上面的 stale），都在
      // claimsCovering / 空路径分支里施加，这里不再重复判。
      hits.push({ claim: c, target, kind })
    }
    const collect = (fields: string[], kind: 'write' | 'read') => {
      for (const field of fields) {
        const raw = (args as Record<string, unknown>)[field]
        if (typeof raw !== 'string' || !raw) continue
        const rel = relToProject(raw, cwd)
        if (rel === '') {
          // 空串 = **目标就是项目根**（`'.'` / `'./'` / 绝对 cwd 本身），而**不是**"解析不出来"。
          // 旧实现把两者混为一谈、用 `if (!rel) continue` 一起跳过 ⇒ 指向根目录的调用
          // 完全绕开门控（2026-10 审计实测）。根的判据取保守侧：**任何他人的未过期
          // exclusive 声明都算冲突**（宁可多拦一次 —— 本部署 ask == deny，而指向根的写
          // 本来也不可能成功，误拦代价≈0；漏拦才是把整道门控关掉）。
          for (const c of state.claims) if (liveFor(c.holderId) !== 'not-live') consider(c, '.', kind)
          continue
        }
        for (const c of claimsCovering(state.claims, rel, liveFor)) consider(c, rel, kind)
      }
    }
    collect(spec.write, 'write')
    collect(spec.read, 'read')
    if (!hits.length) return null
    // 走到这里 hits 只剩**他人的、未过期的 exclusive 声明**（shared/read 已在 collect 里跳过）。
    // 写：非持有者对 exclusive 占用一律拦。
    // 读：只有持有者显式 readable:false 才拦（可读性默认 true）。
    // 注意 readable 不是"独立的第二条判据"，它只在 exclusive 上生效 —— 与 claim() 同源。
    const blocking = hits.filter(h => h.kind === 'write' || !isReadable(h.claim))
    if (!blocking.length) return null
    const hit = blocking[0]
    return { kind: 'ask', reason: gateReason(hit.claim, hit.target, hit.kind) }
  }

  /**
   * 反向交叉预警（0.11.0）：团队在建/改任务的 `write_scopes` 与**外部会话**的 collab_lock 声明重叠时，
   * 给发起这条工具调用的会话 inject 一条 advisory notice。
   *
   * 纪律：
   *   - **只提示，不阻断** —— 返回 void，调用方照常 `next()`；官方 write_scopes 本来就是 advisory；
   *   - 只在**真有重叠**时投递（没有重叠 = 没有事件，不发"一切正常"的噪声）；
   *   - 过滤口径与写门控同源：不认自家家族（inFamily）、不认 shared/read、只看未过期的声明；
   *   - 任何失败都静默（包括 push 缺失 / inject 失败）—— 预警是旁路，不该影响工具本身。
   */
  async function teamScopeNotice(execCtx: any): Promise<void> {
    if (!push) return
    // 服务缺席 ⇒ 这条支路整体不存在（"服务缺席时输出一字不变"的降级契约要字面成立，
    // 而不是靠"官方工具只在该服务在场时存在"这条外部事实兜底）。
    if (!ctx.get('agentTeams')) return
    const toolName = execCtx && typeof execCtx.name === 'string' ? execCtx.name : ''
    if (!TEAM_TASK_TOOLS.includes(toolName)) return
    const args = (execCtx && execCtx.arguments) || {}
    // 官方工具参数是 snake_case `write_scopes`；service 面是 camelCase `writeScopes`。
    const raw = Array.isArray(args.write_scopes) ? args.write_scopes
      : (Array.isArray(args.writeScopes) ? args.writeScopes : [])
    const scopes = raw.filter((s: unknown): s is string => typeof s === 'string' && !!s.trim())
    if (!scopes.length) return
    const agent = execCtx && execCtx.agent as AgentLike | undefined
    const id = agent && (agent as AgentLike).id ? String((agent as AgentLike).id) : null
    const cwd = await store.cwdOf(id, agent)
    const me = store.holderOf(execCtx)
    const { state } = await store.load(id, agent)
    const t = store.now()
    const hits: Array<{ claim: Claim; target: string }> = []
    const seen = new Set<string>()
    for (const scope of scopes) {
      const rel = relToProject(scope, cwd)
      if (!rel) continue
      for (const c of claimsCovering(state.claims, rel, isLiveFn(store))) {
        if (inFamily(me, c.holderId)) continue
        if (c.mode === 'shared' || c.mode === 'read') continue
        const key = c.claimId + '\u0000' + rel
        if (seen.has(key)) continue
        seen.add(key)
        hits.push({ claim: c, target: rel })
      }
    }
    if (!hits.length) return
    hits.sort((a, b) => a.claim.claimId.localeCompare(b.claim.claimId))
    const parts = hits.slice(0, 2).map(hh => {
      const who = holderLabel(hh.claim.holderId, hh.claim.holderName)
      return '写域 ' + hh.target + ' 已被外部会话「' + who + '」以 ' + modeLabel(hh.claim.mode) + ' 声明占用'
    })
    const more = hits.length > 2 ? '；另有 ' + (hits.length - 2) + ' 条' : ''
    const text = '[dsh-collab] 交叉预警：你要给团队任务声明的' + parts.join('；') + more +
      '。官方 write_scopes 只是 advisory，不会挡住对方；' +
      '建议先 collab_board 与对方协商，或把任务写域换到别处。'
    const label = 'collab 团队写域与外部锁重叠 · ' + hits[0].target
    push.pushNotice(agent, text, label)
  }

  /**
   * 旁路提示（0.2.12，backlog 第 1 条）：shell 类工具的写入**不受**门控保护，而模型侧此前
   * 拿不到任何运行时提示 —— 设置卡片写着"拦截"，同一路径用 `bash` 就绕过去了，静默。
   *
   * 纪律：
   *   - **只提示，绝不拒绝**（返回 void，调用方照常 next()）：靠分词猜目标路径做拒绝，
   *     假阳性会变成硬拒绝（本部署 ask == deny），把合法读取也拦掉 —— 那正是当初不把
   *     shell 列入写工具的理由，现在也不推翻它；
   *   - 判据是**反向匹配**：拿他人已声明的路径去命令文本里找字面出现，而不是猜命令要写哪里
   *     （见 spec.ts 的 shellPathMentions）。没提到 ⇒ 一句话都不投，不制造噪声；
   *   - 与写门控同源过滤：不认自家家族、不认 shared/read、只看未过期的 exclusive；
   *   - 任何失败都静默 —— 提示是旁路，不影响工具本身。
   */
  async function shellBypassNotice(execCtx: any): Promise<void> {
    if (!push) return
    if (!prefs.enforceWriteLockEnabled()) return
    const toolName = execCtx && typeof execCtx.name === 'string' ? execCtx.name : ''
    if (!SHELL_TOOLS.includes(toolName)) return
    const args = (execCtx && execCtx.arguments) || {}
    const command = typeof args.command === 'string' ? args.command : ''
    if (!command) return
    const agent = execCtx && execCtx.agent as AgentLike | undefined
    const id = agent && (agent as AgentLike).id ? String((agent as AgentLike).id) : null
    const cwd = await store.cwdOf(id, agent)
    const me = store.holderOf(execCtx)
    const { state } = await store.load(id, agent)
    // 只拿**他人**的、未过期的 exclusive 声明路径作为反向匹配的字典。
    const live = isLiveFn(store)
    const candidates: string[] = []
    for (const c of state.claims) {
      if (inFamily(me, c.holderId)) continue
      if (c.mode === 'shared' || c.mode === 'read') continue
      if (live(c.holderId) === 'not-live') continue
      for (const p of c.paths) if (typeof p === 'string' && p && !candidates.includes(p)) candidates.push(p)
    }
    if (!candidates.length) return
    const hits = shellPathMentions(command, candidates)
    if (!hits.length) return
    // 把命中路径映射回声明，才能说出"被谁占着"。
    const shown = hits.slice(0, 2)
    const parts = shown.map((p) => {
      const c = state.claims.find((x) => x.paths.includes(p))
      return c ? p + '（' + holderLabel(c.holderId, c.holderName) + '，' + modeLabel(c.mode) + '）' : p
    })
    const more = hits.length > 2 ? '；另有 ' + (hits.length - 2) + ' 条' : ''
    const text = '[dsh-collab] 旁路提示：这条 ' + toolName + ' 命令提到了被占用的路径 ' +
      parts.join('；') + more + '。shell 写入**不受**本插件门控保护（自由文本命令无法可靠解析目标），' +
      '这次不会被拦下 —— 如果确实要改这些路径，先 collab_lock op=wait 或 collab_board 协商。'
    push.pushNotice(agent, text, 'collab shell 旁路 · ' + shown[0])
  }

  // ---- 功能 C：写/读的原生审批门控 ----
  // 未命中任何他人声明（或工具不是写/读类、或开关关掉）→ return next() 原样放行。
  // 本部署的已知后果：审批提示被禁用时 dsh-tools 的 serviceAsk 把 ask 变成 deny
  // （"missing approval support turns ask into denial"，见 tools/pre-execute 的 Event 文档
  // 与 dsh-tools/lib/index.js:3314-3322），也就是**硬拒绝**。这是原生路径本身的行为，
  // 不另造 override 机制。
  ctx.on('tools/pre-execute', async (execCtx: any, next: () => Promise<any>) => {
    try {
      const decision = await writeGate(execCtx)
      if (decision) return decision
    } catch (e) {
      // 门控自身故障时放行：插件的问题不该锁死整个工具面。
    }
    // 反向预警在**放行之后**才发：被门控拒掉的调用不该再收到一条"你的团队写域和别人重叠"。
    try {
      await teamScopeNotice(execCtx)
    } catch (e) {
      // 预警是旁路：任何失败都不影响工具本身。
    }
    // shell 旁路提示同样在放行之后发（它本来就不拦，只补一条模型侧可见的提醒）。
    try {
      await shellBypassNotice(execCtx)
    } catch (e) {
      // 提示是旁路：任何失败都不影响工具本身。
    }
    return next()
  })
}
