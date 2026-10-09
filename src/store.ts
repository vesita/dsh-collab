// src/store.ts
// **包形态的状态存取适配器**：只实现**环境面**（状态目录/文件落点、会话家族、存活判据、
// 会话显示名），其余全部转发给 `src/state-core.ts` —— 那是状态机的唯一事实源，也是
// `scripts/build-host.mjs` 构建期内联进动态外壳的同一份源码。
//
// 为什么这样拆：同一套 load / mutate / 损坏自愈 / 磁盘布局曾在两个形态各写一遍，
// 漂移只能靠人盯（历史上已经有两处行为不同步）。现在环境无关的那一半只有一份；
// 这里剩下的每一行都必须回答"为什么环境决定了它"：
//   · targetFor        —— 状态目录怎么找（包形态：src/paths.ts 的 DSH_HOME/HOME + node:os）
//   · legacyTargets    —— 有哪些历史落点要迁移（包形态有三代）
//   · cwdOf            —— cwd 从哪来（包形态：sessions.get(id) + agent.session.header.cwd）
//   · familyIds/descendantIds —— 血缘只存在于运行时服务里
//   · livenessOf/teamTasks/liveAgentHolderIds —— 都在读宿主服务
//   · hname/holderOf   —— 显示名与身份章
//
// installStore() 的返回值就是它对外暴露的全部能力（**API 一字未变**）：其他 installer 通过参数
// **显式**接收它。段间不共享任何模块级可变状态。

import { rm } from 'node:fs/promises'
import * as pure from './collab-core.js'
import type { HolderInput, OpResult, StateDocument, TeamScopeTask } from './collab-core.js'
import { createStateCore, describeError, sidecarNameOf } from './state-core.js'
import type { LegacyTarget, StateTarget } from './state-core.js'
import { selfProcToken, liveProcsOf } from './proc-id.js'
import { LEGACY_PROJECT_FILE, collabDir, projectStateFile, legacyCollabDirs } from './paths.js'
import type {
  AgentLike, AgentTeamsServiceLike, AgentsLookupService, CollabArgs, CollabContext, CollabFs,
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

  /**
   * 静默旁路的**错误留痕**（0.16.0）。状态核心里有几条**故意降级**的旁路（损坏备份清理、
   * 列举其他项目）：它们失败不该影响主路径，但也不该无声无息。优先用注册进来的 `logger`
   * 服务（本插件的 `CollabContext` 契约没有声明它，故现场活取）；没有就用 cordis Context
   * 自带的 `ctx.logger`。两者都取不到时退化为**无害的空操作** —— 那是宿主能力缺失，
   * **不是"成功"**。与 src/push.ts 的 reportInternal 同一口径。
   */
  const log = (line: string): void => {
    try {
      const reg = ctx.get('logger') as { warn?: (m: string) => void } | undefined
      if (reg && typeof reg.warn === 'function') { reg.warn(line); return }
      const native = (ctx as unknown as { logger?: unknown }).logger
      const warn = native && typeof (native as { warn?: unknown }).warn === 'function'
        ? (native as { warn(m: string): void }).warn.bind(native)
        : (typeof native === 'function' ? (native as (m: string) => void) : undefined)
      if (warn) warn(line)
    } catch (e) {}
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

  // ---- 环境面 1/3：文件放哪 ----
  //
  // 绝对状态目录（${DSH_HOME:-$HOME/.dsh}/collab/projects），与进程 cwd 无关。
  // fs.resolve 对绝对路径原样通过（实测），所以这里不做字符串拼接猜测基址。
  // 旁挂与主文件**同一个目录、同一个名字前缀**（前缀取自 projectStorageFileName，唯一事实源）。
  async function targetFor(agentId: string | null, agent?: AgentLike): Promise<StateTarget> {
    const cwd = await cwdOf(agentId, agent)
    const fileName = pure.projectStorageFileName(cwd || 'default')
    const stateDir = collabDir()
    const target = await fs.resolve(projectStateFile(cwd))
    const sidecar = await fs.resolve(stateDir + '/' + sidecarNameOf(fileName))
    return { cwd, target, sidecar, stateDir, fileName }
  }

  // ---- 环境面 2/3：历史落点有哪些 ----
  // 第一代：项目内的 .dsh-collab.json，按会话 cwd 定位；
  // 第二代（两处错误落点）：旧版相对进程 cwd 的 .dsh/collab/projects，以及 `~` 未展开的
  // <HOME>/~/.dsh/collab/projects。只读扫描 + 一次性搬进正确位置；文件名沿用
  // projectStorageFileName，故能与历史产物一一对上。（搬不动的失败由 state-core 记进 warning。）
  async function legacyTargets(cwd: string | null, fileName: string): Promise<LegacyTarget[]> {
    const out: LegacyTarget[] = []
    if (cwd) out.push({ path: LEGACY_PROJECT_FILE, cwd })
    for (const legacyDir of legacyCollabDirs()) out.push({ path: legacyDir + '/' + fileName })
    return out
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

  /**
   * 存活判据的**三态**（0.9.0）：
   *   'live'     = 会话此刻在 agents 注册表里；
   *   'not-live' = 会话未加载（**刻意不唤醒**，两个通道都不许碰它；含 agents 服务整个缺失）；
   *   'failed'   = 判据**本身**坏了（`agents.get()` 抛异常）—— 这是基础设施故障，不是"读者没在线"。
   * 前两态都返回 false（不推），第三态让调用方如实记 `liveness-check-failed` 而不是谎报 `not-live`。
   *
   * 功能 D 的存活判据（0.8.3 起）**只用于"此刻要不要推"**，绝不再用于清理 readers 登记。
   * 0.8.2 曾在 mutate() 里把它注入 sweep()，于是"只是空闲、并未结束"的读者
   * （agents.get(sessionId) 对休眠会话返回 undefined）会在下一次任意写路径上被删掉，
   * 该 claim 释放时已无人可推 —— 静默丢通知。读者的移除只走 dropHolder()（agent/disposed）；
   * 它**只摘 reader 登记 + 回收该 holder 已过期的声明 + 摘掉它的名册行**（0.14.0）；
   * 未过期声明的释放归同事务里的 `releaseOnLoopEnd(..., 'disposed')`（0.13.0 起，见 src/push.ts）。
   * 判据本身仍是 push 前的安全闸：拿不到 agents 服务时一律不推，
   * 因为推送会 resume 冷会话，宁可少推也不能唤醒。
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

  // ---- 环境面 3/3：身份与显示名 ----
  const holderOf = (exec: ToolExecContext): HolderInput & { agent?: AgentLike } => {
    const agent = exec && exec.agent
    const id = agent && agent.id ? String(agent.id) : null
    return {
      agent,
      holderId: id ? 'agent:' + id : 'human:console',
      sessionId: id || undefined,
      // 名册行的进程章（0.14.0，B2）。拿不到就是 undefined —— holder() 只在提供时盖章，
      // 绝不会把另一个形态刚写上的章抹掉。
      proc: selfProcToken() || undefined,
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
    return pure.cleanName(name || h.holderId)
  }

  // 环境面的注入点：状态机本体（load/mutate/几个只读 op）全部来自 state-core，
  // 与动态外壳共用同一份源码（构建期内联）。下面这 11 项就是两形态**真实差异**的全部清单。
  const state = createStateCore({
    fs,
    core: pure,
    now,
    targetFor,
    legacyTargets,
    liveProcsOf,
    selfProcToken,
    removeFile: (absPath: string) => rm(absPath, { force: true }),
    sleep: (ms: number) => ctx.timer.timeout(ms),
    liveAgentHolderIds,
    teamTasks,
    log
  })

  return {
    fs, now, livenessOf, familyIds, descendantIds, teamTasks, cwdOf, holderOf, hname,
    load: (agentId, agent) => state.load(agentId, agent),
    mutate: (fn, agentId, agent) => state.mutate(fn, agentId, agent),
    list: (agentId, agent) => state.list(agentId, agent),
    overviewOp: (agentId, agent) => state.overviewOp(agentId, agent),
    status: (a, agentId, agent) => state.status(a, agentId, agent),
    msgs: (a, agentId, agent) => state.msgs(a, agentId, agent),
    reapOp: (a, h, agentId, agent) => state.reapOp(a, h, agentId, agent),
    waitFor: (a, h, agentId, agent) => state.waitFor(a, h, agentId, agent)
  }
}
