// src/tools.ts
// **collab_lock / collab_board 两个模型工具的注册**：参数 schema、执行包装（统一错误信封）
// 与 release 后的推送接线。
//
// 依赖：状态存取面（store）+ 推送面（push）。

import { claim, release, heartbeat, post, teamScopeOverlaps } from './collab-core.js'
import type { HolderInput, PublishedClaim } from './collab-core.js'
import type {
  AgentLike, CollabArgs, CollabContext, OpHandler, ToolDefinition, ToolExecContext, ToolResult
} from './contract.js'
import type { StateStore } from './store.js'
import type { PushApi } from './push.js'

export function installTools(ctx: CollabContext, store: StateStore, push: PushApi): void {
  const exec = (fn: OpHandler) => async (args: CollabArgs, e: ToolExecContext): Promise<ToolResult> => {
    args = args || {}
    const h = store.holderOf(e)
    const name = store.hname(h)
    h.name = name
    const aId = h.sessionId || null
    try {
      return await fn(args, h, aId, h.agent)
    } catch (err) {
      return { ok: false, error: 'internal', message: String((err && err.message) || err) }
    }
  }

  const lockHandler = exec((a, h, aId, agent) => {
    if (a.op === 'claim') return claimWithTeamAdvisory(a, h, aId, agent)
    if (a.op === 'release') return releaseWithNotify(a, h, aId, agent)
    if (a.op === 'heartbeat') return store.mutate(s => heartbeat(s, h, a, store.now), aId, agent)
    if (a.op === 'list') return store.list(aId, agent)
    if (a.op === 'overview') return store.overviewOp(aId, agent)
    if (a.op === 'status') return store.status(a, aId, agent)
    if (a.op === 'wait') return store.waitFor(a, h, aId, agent)
    if (a.op === 'reap') return reapWithNotify(a, h, aId, agent)
    return { ok: false, error: 'bad-request', message: '未知操作：' + String(a.op) }
  })

  /**
   * op=claim + 官方 Agent Teams 的**advisory** 交叉预警（0.11.0）。
   *
   * 纪律：**不改锁语义**。`claim()` 的返回（ok / conflicts / claim）与冲突判定一字不动，
   * 这里只在成功返回的 `data` 上追加一个 `teamOverlaps` —— "你正要声明的这些路径，官方团队
   * 某个在跑任务的 write_scopes 也声称要动"。官方那侧只是 advisory（不挡写入），本插件也
   * 不据此拒绝；它的价值是让模型在动手前看见重叠。
   *
   * `store.teamTasks()` 返回 null（服务缺席 / 读不到）⇒ 一个字段都不加，返回原样。
   */
  async function claimWithTeamAdvisory(a: CollabArgs, h: HolderInput, aId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const res = await store.mutate(s => claim(s, h, a, store.now), aId, agent)
    try {
      if (res && res.ok === true && res.data) {
        const team = store.teamTasks(agent)
        if (team !== null) {
          const paths = (Array.isArray(a.paths) ? a.paths : []).filter((p): p is string => typeof p === 'string' && !!p)
          // 三态刻意可分辨：服务缺席 ⇒ 没有这个字段；服务在场 ⇒ 字段在（可能为空数组）。
          res.data.teamOverlaps = teamScopeOverlaps(team, paths)
        }
      }
    } catch (e) {
      // 预警是旁路：它出问题绝不影响 claim 的结果。
    }
    return res
  }

  /**
   * 显式 op=release + 功能 D 的推送。
   * 返回**原样**的 release 结果（ok / released / serverTime 的语义与形状不变），
   * 只在其 `data` 上**追加** `notify` 汇总；推送是旁路，任何失败都不得改变工具结果、也不得抛出。
   * 0.8.4：把释放者的活 Agent（`exec.agent`，**原对象**）一路传进 notifyReaders，
   * 作为子代理回退通道的 sender。
   */
  async function releaseWithNotify(a: CollabArgs, h: HolderInput, aId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const res = await store.mutate(s => release(s, h, a, store.now), aId, agent)
    try {
      if (res && res.ok === true && res.data && Array.isArray(res.data.released)) {
        res.data.notify = await push.notifyReaders(res.data.released as PublishedClaim[], h.holderId, h.name || h.holderId, agent)
      }
    } catch (e) {
      // 推送失败不影响 release 结果；仍落一个可观测的汇总。
      // **关键**：兜底不得再落 { readers: 0, pushed: [], skipped: [] } —— 那个形状与"本来就没有
      // 读者需要通知"逐字一样（0.8.2 起的观测盲区，注释里承诺过要区分却没做到）。现在带一条
      // reason:'internal' 的记录（含真实错误文本），于是"内部错误"与"没有读者"从返回值上可区分。
      // 原实现还在这条赋值外面套了一个嵌套 try/catch —— 给普通对象赋字段不可能抛，那是纯复制粘贴，
      // 已删除（若 res.data 真的不可写，异常照旧由 exec() 的统一信封兜住，不在这里假吞）。
      if (res && res.data) {
        res.data.notify = {
          readers: 0, pushed: [], pushedVia: [],
          skipped: [{ sessionId: '', reason: 'internal', error: String((e && e.message) || e) }]
        }
      }
    }
    return res
  }

  /**
   * 显式 op=reap + 功能 D 的推送（0.9.8）。
   *
   * 复用 release 的同一条投递面（`notifyReaders` → `agent.inject` + `form:'notice'` 的显式来源消息），
   * **不另造通道**，也**绝不**走进任何冒充用户（`kind:'user'`）的接口 —— AGENTS.md §1 的机械检查
   * （tests/collab-message-provenance.mjs）同样扫到这条路径。
   *
   * 与 releaseWithNotify 的差异只有两点，都是语义要求：
   *   1. 只在**真的回收到了**（`data.reaped` 非空）时才通知：dry-run 与"没有候选"都不该发通知
   *      （没有发生回收事件）；
   *   2. `action:'reap'` 让通知文案说"回收"而不是"释放"（回收者不是原持有者）。
   */
  async function reapWithNotify(a: CollabArgs, h: HolderInput, aId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const res = await store.reapOp(a, h, aId, agent)
    try {
      if (res && res.ok === true && res.data && Array.isArray(res.data.reaped) && res.data.reaped.length > 0) {
        res.data.notify = await push.notifyReaders(res.data.reaped as PublishedClaim[], h.holderId, h.name || h.holderId, agent, 'reap')
      }
    } catch (e) {
      // 推送失败不影响 reap 结果（reap 已经写盘成功）；但必须与"没有读者需要通知"可区分。
      if (res && res.data) {
        res.data.notify = {
          readers: 0, pushed: [], pushedVia: [],
          skipped: [{ sessionId: '', reason: 'internal', error: String((e && e.message) || e) }]
        }
      }
    }
    return res
  }

  const boardHandler = exec((a, h, aId, agent) => {
    if (a.op === 'post') return store.mutate(s => post(s, h, a, store.now), aId, agent)
    if (a.op === 'read') return store.msgs(a, aId, agent)
    return { ok: false, error: 'bad-request', message: '未知操作：' + String(a.op) }
  })

  const render = (args: CollabArgs, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  const lockTool: ToolDefinition = {
    name: 'collab_lock',
    description: '多智能体协作中央注册锁：开工前声明占用项目文件夹（目录以 / 结尾，如 src/backend/），查询他人占用，减少共同开发冲突。规范：动手改代码前先 claim；开工前和定期 list/overview；冲突时先 wait 等待或用 board 留言协商；完成即 release；长任务 heartbeat 续租；被强杀的会话会留下僵尸声明，默认 dry-run 的 op=reap 可显式回收（先看候选，再 confirm:true）。会话循环结束（空闲超过宽限期，默认 15 秒）后，你的声明会被自动释放：恢复工作前请重新 claim。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['claim', 'release', 'list', 'overview', 'status', 'heartbeat', 'wait', 'reap'], description: 'claim 声明 / release 释放 / list 全部 / overview 占用全景 / status 查路径 / heartbeat 续租 / wait 等待路径释放 / reap 显式回收僵尸声明（默认 dry-run）' },
        paths: { type: 'array', items: { type: 'string' }, description: '项目相对路径' },
        claimId: { type: 'string', description: 'claim id，release/heartbeat 用' },
        mode: { type: 'string', enum: ['exclusive', 'shared', 'read'], description: 'exclusive 独占（默认）；shared 声明共用但被独占挡住；read 只读观测，不排他也不被挡' },
        readable: { type: 'boolean', description: 'claim 用：他人是否可读这些路径，默认 true；false 表示他人读取也要先协商（写入对非持有者始终要协商）' },
        ttlSec: { type: 'number', description: '租约秒数（5-86400），默认 1800' },
        timeoutMs: { type: 'number', description: 'wait 用，最多等待毫秒，默认 30000' },
        confirm: { type: 'boolean', description: 'reap 用：默认 false = dry-run，只列候选、绝不改状态；显式 true 才真正删除僵尸声明' },
        olderThanSec: { type: 'number', description: 'reap 用：age 门槛（秒），声明创建至今必须严格大于它才算候选，默认 600' },
        note: { type: 'string', description: '占用说明' }
      },
      additionalProperties: true,
      required: ['op']
    },
    output: { schema: { type: 'object', additionalProperties: true }, render },
    execute: lockHandler
  }

  const boardTool: ToolDefinition = {
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
      additionalProperties: true,
      required: ['op']
    },
    output: { schema: { type: 'object', additionalProperties: true }, render },
    execute: boardHandler
  }

  ctx.tools.register(lockTool)
  ctx.tools.register(boardTool)
}
