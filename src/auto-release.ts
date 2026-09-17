// src/auto-release.ts
// **循环终止自动释放（0.9.10）**：会话的 agent 循环停下（`agent/status` → `idle`）并
// 保持空闲超过宽限期（0.9.11 起默认 120 秒，此前 15 秒）之后，把它的声明**自动释放**掉。
// 0.9.11 另加第 4 道闸门：有自家子代理在 running 时不放（见下）。
//
// 为什么需要（一手场景，见 README「循环终止自动释放」）：
//   父会话 `claim src/deploy/`（exclusive），把写入交给子代理后**自己的循环停了**
//   —— agent 还在注册表里（不是 dispose），但 driver 已经不在跑。子代理要写同一批路径，
//   被功能 C 的门控硬拒绝；它到留言板 @ 父会话要求释放，而父会话的循环已经停了：
//   `agent.inject` 的契约是 `send(message, "next-step", wakeup=false)`，**不唤醒 driver**
//   （`dsh-agent/lib/types/runtime-types.d.ts:202-209`；实现
//   `dsh-agent-loop/lib/index.js:795`），留言永远读不到。结果只能干等租约到期（默认 1800 秒）。
//   本模块补上这条回收路径：循环一停、宽限期一过就放锁。
//
// 为什么**不是**挂在 `agent/disposed` 上（W7 的结论仍然成立，见 collab-core.dropHolder）：
//   dispose 是"这个 agent 从注册表里没了"，而它**常常恢复并继续干活**，所以那里绝不缩短租约；
//   本模块的触发是 `agent/status → idle`（循环停了，agent 还在），且**先等过宽限期**、
//   并在到点时**复核它没有变回 running**，两个条件都不满足就不动。宽限期排除的是
//   "两个回合之间的正常停顿"（模型思考 / 工具往返之间的空隙）。
//
// 四道闸门（缺一不可，方向都是"少放而不是多放"）：
//   1. `prefs.releaseOnLoopEndEnabled()` —— 用户可以整个关掉；宽限期内改设置也照样拦住；
//   2. 宽限期计时 + **代次**（generation）：期间任何一次状态变化都让这次武装作废；
//   3. 到点复核**必须**解析到那个 agent 且它的 `status === 'idle'`。
//   4. **没有自家的子代理在 running**（0.9.11）—— 子代理在跑说明锁还在被用，
//      它只是不在我的循环里；不放，重新武装。
// 第 3 条是**合取**，不是"running 才撤回"：服务缺失 / `get()` 抛错 / 解析不到（已 disposed）/
// 状态不是 idle，**一律不放**。后两种尤其重要：
//   - 解析不到 = 会话已离开注册表（dispose）。W7 的结论（退场的会话常常恢复并继续干活）在这里
//     同样成立，而且更危险 —— 它此刻收不到任何告知（`agent.inject` 对未加载的会话结构上不可达），
//     恢复后必然会以为自己还持锁。所以这条路径**不**回收它，把处置权留给租约与 `op=reap`。
//   - 判据抛错 = 基础设施抖动，不是"会话不存在"（与 store.livenessOf 的三态同一口径）。
// 第 4 条的方向与第 3 条相反（判据缺失 ⇒ 照常释放），理由写在 fire() 里：否则一把没人用的锁
// 永远不会被自动释放。
//
// 释放之后**必须**告知两个群体（见 push.ts 的 notifyLoopEndRelease）：正等这些路径的读者，
// 以及被释放的会话本人（它恢复时才知道自己已经不再持锁，从而重新 claim）。
// 此外 releaseOnLoopEnd 会在状态文件里留下一条审计留言，进程重启后仍可追溯。
//
// 已知边界（如实记）：本功能只覆盖"循环停了、agent 还加载着"这一种持有者。**已 dispose 的**
// 持有者不在覆盖范围内（理由见第 3 条），它的声明仍只能靠租约到期或 `op=reap` 回收。
//
// 依赖：状态存取面（store）、推送面（push）、偏好读取面（prefs，来自 delegation）。
// 接线在 src/index.ts；动态宿主形态在 src/collab-plugin.host.ts 内联了一份**只释放不投递**
// 的等价实现（受限环境里没有 @deepseek-ai/dsh-llm，构造不出诚实来源的消息）。

import { releaseOnLoopEnd } from './collab-core.js'
import type { AgentLike, AgentsLookupService, CollabContext } from './contract.js'
import type { StateStore } from './store.js'
import type { PushApi } from './push.js'
import type { DelegationPrefs } from './delegation.js'

/** installAutoRelease() 对外暴露的东西：目前只有给测试用的诊断（武装中的 agent 数）。 */
export interface AutoReleaseApi {
  /** 此刻正"武装着"（等待宽限期到点）的 agent 数。诊断/测试用，不参与任何判定。 */
  armedCount(): number
}

export function installAutoRelease(
  ctx: CollabContext,
  store: StateStore,
  push: PushApi,
  prefs: DelegationPrefs
): AutoReleaseApi {
  /**
   * agents 服务面**每次现场取**，不在 apply 时一次性捕获：本插件的 `inject` 只声明了
   * `fs`/`timer`/`tools`，`agents` 完全可能晚于插件就绪（或热重载）—— 静态捕获会让第 3 条
   * 闸门（复核 status）静默失效，把"复核不了"变成"直接释放"。取不到就是 `undefined`，
   * 由调用方按"判据不可用 ⇒ 不放"处理（push.ts / store.ts 同样是现场取）。
   */
  const agentsNow = (): AgentsLookupService | undefined => {
    try {
      return ctx.get('agents') as AgentsLookupService | undefined
    } catch (e) {
      return undefined
    }
  }

  // agentId -> 代次。**每次状态变化都会 ++seq 并把新代次写进 map**，于是过期的计时器回调
  // 在到点时发现 `map.get(id) !== 自己的代次` 就直接退出。这样不需要可取消的计时器
  // （`ctx.timer.timeout` 的契约只返回 Promise，没有 cancel 面）。
  const armed = new Map<string, number>()
  let seq = 0
  // 插件卸载后不许再改状态：ctx.effect 的 disposer 把闸门关上。
  let closed = false
  ctx.effect(() => () => { closed = true; armed.clear() })

  const statusOf = (agent: unknown): string => {
    const s = agent && typeof (agent as { status?: unknown }).status === 'string' ? String((agent as { status: string }).status) : ''
    return s
  }

  /** 武装一次宽限期。开关关掉时**不**武装（不做事，也不留计时器）。 */
  function arm(agentId: string): void {
    if (closed) return
    if (!prefs.releaseOnLoopEndEnabled()) return
    const graceMs = prefs.loopEndGraceMs()
    const gen = ++seq
    armed.set(agentId, gen)
    // 计时器本身同步不抛；`.then` 里的一切都已包在 fire() 的 try/catch 内。
    void ctx.timer.timeout(graceMs).then(() => fire(agentId, gen, graceMs)).catch(() => {})
  }

  /** 会话恢复（running）：作废这次武装。只删 map —— 过期回调会因代次不符而自我作废。 */
  function disarm(agentId: string): void {
    armed.delete(agentId)
  }

  /**
   * 宽限期到点。**每一步都可能撤回**：插件已卸载 / 期间状态变过 / 开关被关 /
   * 会话已经跑起来。全部通过才释放，并在释放后投递两条告知。
   * 任何异常都在这里兜住：自动释放是旁路能力，绝不许把异常抛回宿主。
   */
  /**
   * 宽限期到点。**每一步都可能撤回**：插件已卸载 / 期间状态变过 / 开关被关 /
   * 判据不可用 / 会话已经跑起来 / 会话已离开注册表。全部通过才释放，并在释放后投递两条告知。
   * 任何异常都在这里兜住：自动释放是旁路能力，绝不许把异常抛回宿主。
   */
  async function fire(agentId: string, gen: number, graceMs: number): Promise<void> {
    try {
      if (closed) return
      if (armed.get(agentId) !== gen) return // 期间发生过状态变化（或已释放过）
      armed.delete(agentId)
      if (!prefs.releaseOnLoopEndEnabled()) return
      const svc = agentsNow()
      // 判据不可用 ⇒ 一个也不放（"少放"方向；宁可留到租约到期 / op=reap）。
      if (!svc || typeof svc.get !== 'function') return
      let current: AgentLike | undefined
      try {
        current = svc.get(agentId)
      } catch (e) {
        return // 判据自己坏了 = 基础设施故障，不是"会话不存在"（与 livenessOf 三态同一口径）
      }
      // W7：解析不到 = 会话已 dispose。**不释放** —— 退场的会话常常恢复并继续干活，
      // 而它此刻收不到任何告知（inject 对未加载的会话结构上不可达）。
      if (!current) return
      // 第 3 条闸门是合取：只有"现在确实是 idle"才放。running、或状态读不出来（受限宿主）一律不放。
      if (statusOf(current) !== 'idle') return
      // 第 4 条闸门（0.9.11）：**有自家子代理正在跑就不放**，重新武装、下一轮回来看。
      //
      // 为什么需要：前三条只看"我这个会话是不是 idle"，不看"我在等谁"。父会话把活派给子代理后
      // 自己停下来，正是最常态的 idle —— 宽限期一过锁就被放掉，父会话醒来（或子代理报错把它
      // 唤回）又得重新 claim，于是 claim→release→claim 抖动、留言板反复留痕。子代理在跑，
      // 说明锁还在被用，它只是不在我的循环里。
      //
      // 与家族豁免（collab-core.inFamily）的次序**不可颠倒**：家族豁免落地前，自动释放是
      // "父独占、子代理写不了"的唯一出口（README「循环终止自动释放」）。先有家族豁免，
      // 子代理不再依赖父会话放锁，这道闸门才不会把那个死锁还回来。
      //
      // 判据不可用时的方向：拿不到后代名单（`agents.list` 缺失）⇒ 当成"没人在跑"，照常释放 ——
      // 它和上面那条合取闸门的方向相反，是**故意的**：agents 服务本身已经校验过（第 122 行），
      // 而这里若也取"少放"，一把没人用的锁就再也不会被自动释放了。单个子代理状态读不出来同理。
      const descendants = store.descendantIds(agentId)
      if (descendants.length) {
        let childRunning = false
        for (const did of descendants) {
          let child: AgentLike | undefined
          try { child = svc.get(did) } catch (e) { continue }
          if (child && statusOf(child) === 'running') { childRunning = true; break }
        }
        if (childRunning) { arm(agentId); return }
      }
      const holderId = 'agent:' + agentId
      const graceSec = Math.max(1, Math.round(graceMs / 1000))
      const name = store.hname({ holderId, sessionId: agentId, agent: current })
      const res = await store.mutate(
        s => releaseOnLoopEnd(s, holderId, name, store.now(), graceSec),
        agentId,
        current
      )
      if (res && res.ok === true && res.data && Array.isArray(res.data.released) && res.data.released.length) {
        await push.notifyLoopEndRelease(res.data.released, holderId, name, graceSec)
      }
    } catch (e) {
      // 自动释放失败只意味着"这次没放成"：下一次 idle 会重新武装，租约到期也仍会回收。
    }
  }

  // ---- 事件接线 ----
  // `{ global: true }`：agent/status 是**作用域派发**的事件（本仓库的 agent/disposed
  // 处理器用的是同一个开关），不加就收不到别人的 agent。
  ctx.on('agent/status', (payload: { agent?: AgentLike; status?: string }) => {
    try {
      const agent = payload && payload.agent
      const id = agent && agent.id ? String(agent.id) : ''
      if (!id) return
      // status 优先取 payload.status（契约 `agent/status` 的载荷字段，dsh-agent-loop/lib/index.js:781
      // 就是 `emit("agent/status", { status })`）；缺失时退回读 agent.status。
      const status = typeof (payload && payload.status) === 'string' ? String(payload.status) : statusOf(agent)
      if (status === 'idle') arm(id)
      else if (status === 'running') disarm(id)
    } catch (e) {}
  }, { global: true })

  // 会话退场（dispose）⇒ 取消这次武装：它已经不在注册表里，到点也不会释放（见 fire 的第 3 条
  // 闸门），留着计时器只是白跑一趟。**只 disarm，不释放** —— W7 的边界就在这句里。
  ctx.on('agent/disposed', (payload: { agent?: AgentLike }) => {
    try {
      const agent = payload && payload.agent
      const id = agent && agent.id ? String(agent.id) : ''
      if (id) disarm(id)
    } catch (e) {}
  }, { global: true })

  // 装机时**已经** idle 的会话也补一次武装：插件热重载（本仓库开发时很常见）或
  // 插件晚于 agent 装载时，否则那一轮 idle 事件就永远收不到了。
  // 拿不到 status 的宿主对象**不**武装 —— 宁可不放，也不猜。
  try {
    const svc = agentsNow()
    const list = svc && typeof svc.list === 'function' ? svc.list() : []
    for (const a of Array.isArray(list) ? list : []) {
      if (a && a.id && statusOf(a) === 'idle') arm(String(a.id))
    }
  } catch (e) {}

  return { armedCount: () => (closed ? 0 : armed.size) }
}
