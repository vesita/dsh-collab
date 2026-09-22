// src/awareness.ts
// **多 DSH 会话协同：把"同项目还有谁占着什么"注入运行时上下文**（order 130）。
// prompt 装配时 agents.currentInitiator() 返回正在装配的那个会话，因此每个会话在每一步
// 都能自动看到同项目的实时占用。PromptContext.text 必须是同步字符串，所以读盘走后台缓存。
//
// 依赖：状态存取面（store）。对外暴露 AwarenessSurface：delegation 复用它注册常驻纪律块
// （同一个 systemPrompt 服务、同一个总开关）。

import { renderDigest, teamTaskScopeLine, teamCrossWarnLine } from './collab-core.js'
import type { Claim } from './collab-core.js'
import type { AgentLike, CollabContext, PromptContextService } from './contract.js'
import type { StateStore } from './store.js'

/** 运行时上下文注册面：installAwareness() 对外暴露的东西。 */
export interface AwarenessSurface {
  /** DSH_COLLAB_NO_PROMPT_HINT=1 时为 false（包形态的运行时上下文总开关）。 */
  promptHintEnabled: boolean
  /** systemPrompt 服务面；缺失时 undefined（delegation 据此决定要不要注册纪律块）。 */
  systemPrompt?: PromptContextService
}

export function installAwareness(ctx: CollabContext, store: StateStore): AwarenessSurface {
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
  // 缓存的是**原始活跃 claim 列表**，不是"某个人视角渲染好的文本"（0.9.1 修）。
  // 原实现的"排除自己"做在刷新侧、缓存又只按 cwd 做键，于是同 cwd 的刷新互相覆盖：
  // 只要有一次刷新发生在 id 为空的 agent 上（mine='human:console'，谁都不排除），
  // 之后同 cwd 的所有会话都会读到这份"含自己锁"的缓存 —— 持有者被自己的占用误导。
  // 结论：**视角是读取侧的事**，按当前发起者现场过滤；渲染（renderDigest）与时间无关，
  // 所以按 cwd 缓存原始列表是安全的（谁刷新都一样，不再有"后写覆盖先写"的语义）。
  const digestCache = new Map<string, { claims: Claim[]; at: number }>()
  const digestBusy = new Set<string>()

  // 摘要文本必须**时间稳定**，否则会毁掉 DSH 自己的快照去重：
  // dsh-agent-loop 的 RuntimeContextProjection.project() 在 rendered === retained.text 时直接返回 undefined，
  // 也就是"内容没变就不提交新快照"。而快照是**整块**提交的（沙箱策略 + 审批策略 + 本插件摘要一起重发），
  // 所以「剩 N 分」这种相对倒计时每分钟都变，会让整块快照每分钟重发一次。
  // 渲染本身已收进 collab-core 的 renderDigest（唯一事实源，签名不含时间参数），这里只留读盘缓存。
  async function refreshDigest(agent: AgentLike): Promise<void> {
    const id = agent && agent.id ? String(agent.id) : null
    const cwd = await store.cwdOf(id, agent)
    if (!cwd || digestBusy.has(cwd)) return
    digestBusy.add(cwd)
    try {
      const { state } = await store.load(id, agent)
      const t = store.now()
      // 只按"是否过期"筛；**不**在这里按 holderId 筛（那是读取侧的事，见 digestCache 的注释）。
      const active = state.claims.filter(c => c.expiresAt > t)
      digestCache.set(cwd, { claims: active, at: t })
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
          if (!hit || store.now() - hit.at > DIGEST_TTL_MS) void refreshDigest(init)
          // 视角过滤在**读取侧**做：同一份 cwd 缓存对所有会话都成立，"排除谁"才因人而异。
          // （0.9.1 前这里直接返回 hit.text —— 那是"最后一次刷新者"的视角，会把持有者自己的锁报给自己。）
          // 0.9.11 起排的是**整个会话家族**（自己 + 祖先 + 后代）：自家子代理与我共享写域，
          // 把它报成"其他会话占用"会让父 AI 去协商一个根本不存在的竞争者（backlog §2.2）。
          const fam = new Set(store.familyIds(init.id ? String(init.id) : null, init))
          const t = store.now()
          const others = (hit ? hit.claims : []).filter(c => !fam.has(c.holderId) && c.expiresAt > t)
          // 0.11.0 交叉预警（只读、advisory、不改锁语义）：
          //   - teamTasks 返回 null（服务缺席 / 读不到）⇒ 下面的 teamLine 与 xwarn 都是 null，
          //     本函数输出**一字不变**，与 overview 的 otherProjects 同一降级纪律；
          //   - 官方 Agent Teams 的在跑任务写域当作"外部占用"报出来（团队内成员同样看得见自己的任务）；
          //   - 如果这些写域又与**外部会话**的 collab 声明重叠，再补一句反向预警 —— 官方读不到
          //     本插件的声明，这里是我们能同时看到两边的唯一位置。
          const team = store.teamTasks(init)
          const teamLine = teamTaskScopeLine(team)
          const xwarn = teamCrossWarnLine(team, others)
          const lines: string[] = [others.length ? renderDigest(others) : OPEN_HINT]
          if (teamLine) lines.push(teamLine)
          if (xwarn) lines.push(xwarn)
          return lines.join('\n')
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

  return { promptHintEnabled: PROMPT_HINT_ENABLED, systemPrompt }
}
