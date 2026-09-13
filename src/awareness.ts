// src/awareness.ts
// **多 DSH 会话协同：把"同项目还有谁占着什么"注入运行时上下文**（order 130）。
// prompt 装配时 agents.currentInitiator() 返回正在装配的那个会话，因此每个会话在每一步
// 都能自动看到同项目的实时占用。PromptContext.text 必须是同步字符串，所以读盘走后台缓存。
//
// 依赖：状态存取面（store）。对外暴露 AwarenessSurface：delegation 复用它注册常驻纪律块
// （同一个 systemPrompt 服务、同一个总开关）。

import { renderDigest } from './collab-core.js'
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
  const digestCache = new Map<string, { text: string; at: number }>()
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
      const mine = id ? 'agent:' + id : 'human:console'
      const others = state.claims.filter(c => c.expiresAt > t && c.holderId !== mine)
      digestCache.set(cwd, { text: others.length ? renderDigest(others) : '', at: t })
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

  return { promptHintEnabled: PROMPT_HINT_ENABLED, systemPrompt }
}
