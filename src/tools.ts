// src/tools.ts
// **collab_lock / collab_board 两个模型工具的注册**：参数 schema 与执行包装（统一错误信封）。
//
// 依赖：状态存取面（store）。
//
// 留言板**没有投递面**：`op=post` 只写共享状态文件，对方只在它自己 `op=read` 时才会看到。
// 要让某个停下的会话动起来，用 DSH 原生的会话消息工具（本插件不再自造探活 / 唤醒 / 令牌）。

import { claim, release, post, teamScopeOverlaps, holderLiveness } from './collab-ops.js'
import type { HolderInput } from './collab-core.js'
import type {
  AgentLike, CollabArgs, CollabContext, OpHandler, ToolDefinition, ToolExecContext, ToolResult
} from './contract.js'
import type { StateStore } from './store.js'

export function installTools(ctx: CollabContext, store: StateStore): void {
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
    if (a.op === 'release') return store.mutate(s => release(s, h, a, store.now), aId, agent)
    if (a.op === 'list') return store.list(aId, agent)
    if (a.op === 'overview') return store.overviewOp(aId, agent)
    if (a.op === 'status') return store.status(a, aId, agent)
    if (a.op === 'wait') return store.waitFor(a, h, aId, agent)
    if (a.op === 'reap') return store.reapOp(a, h, aId, agent)
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
    const res = await store.mutate(s => claim(s, h, a, store.now, holderLiveness((sid: string) => store.livenessOf(sid))), aId, agent)
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


  const boardHandler = exec((a, h, aId, agent) => {
    if (a.op === 'post') return store.mutate(s => post(s, h, a, store.now), aId, agent)
    if (a.op === 'read') return store.msgs(a, aId, agent)
    return { ok: false, error: 'bad-request', message: '未知操作：' + String(a.op) }
  })

  const render = (args: CollabArgs, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  const lockTool: ToolDefinition = {
    name: 'collab_lock',
    description: '多智能体协作中央注册锁：开工前声明占用项目文件夹（目录以 / 结尾，如 src/backend/），查询他人占用，减少共同开发冲突。规范：动手改代码前先 claim；开工前和定期 list/overview；冲突时先 wait 或用 board 协商；完成即 release；持有者已确证死亡（不在会话注册表里）时用 op=reap 回收（默认只列候选，confirm:true 才真删）。会话句柄结束时（agent/disposed）你的声明会被自动释放并留审计留言：恢复工作前重新 claim。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['claim', 'release', 'list', 'overview', 'status', 'wait', 'reap'], description: 'claim 声明 / release 释放 / list 全部 / overview 占用全景 / status 查路径 / wait 等待路径释放 / reap 显式回收确证死亡的声明（默认 dry-run）' },
        paths: { type: 'array', items: { type: 'string' }, description: '项目相对路径；claim、status、wait 用；目录以 / 结尾表示整棵子树' },
        claimId: { type: 'string', description: 'claim id，release 用' },
        mode: { type: 'string', enum: ['exclusive', 'shared', 'read'], description: 'exclusive 独占（默认）：会与已在场的 exclusive 与 shared 都冲突并返回冲突清单（让你协商/等待/换路径，0.14.0 起不再静默抢占共享方）；shared 声明共用：与已在场的 shared 不冲突、被他人的 exclusive 挡住；read 只读观测，不排他也不被挡' },
        readable: { type: 'boolean', description: 'claim 用：他人是否可读这些路径，默认 true；false 表示他人读取也要先协商（写入对非持有者始终要协商）' },
        timeoutMs: { type: 'number', description: 'wait 用，最多等待毫秒，默认 30000' },
        confirm: { type: 'boolean', description: 'reap 用：默认 false = dry-run，只列候选、绝不改状态；显式 true 才真正删除确证死亡的声明' },
        note: { type: 'string', description: '占用说明，显示在 list/overview 里' }
      },
      additionalProperties: true,
      required: ['op']
    },
    output: { schema: { type: 'object', additionalProperties: true }, render },
    execute: lockHandler
  }

  const boardTool: ToolDefinition = {
    name: 'collab_board',
    description: '跨会话协作留言板：post 往共享状态文件留痕 / read 增量读取。用于同一仓库上互不相识的会话之间交接进度与协商。**没有投递面**：post 只写共享状态文件，不投递、不唤醒任何会话，对方只在它自己 read 时才看得到；要通知或唤醒某个会话，用 DSH 原生的会话消息工具。read 两种模式：不给 since（或 0）读**最新** limit 条（追平用）；否则从该游标**往后**读 limit 条（增量用，旧→新）——按返回的 nextCursor（或数字 nextSince，两者都无损）继续调、直到 hasMore=false 才算读完；**一页不会切开同一个 seq 组**，所以 limit 是软上限（一页可能短于它）。要从头读传 `since:"0@"`（省略或 0 是 tail = 读最新）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['post', 'read'], description: 'post 发消息 / read 增量读取' },
        channel: { type: 'string', description: '频道，默认 general；**精确匹配**的自由字符串（写什么就得按什么读，path: 频道与 claim 用同一套相对路径写法），未命中时返回会列出既有频道' },
        body: { type: 'string', maxLength: 8000, description: 'post 用，消息正文。上限 8000 字符（与 collab-core 的 MESSAGE_BODY_MAX_CHARS 同值）；超限由 post() 以 bad-request 挡回且**整条不写入**，不静默截断' },
        replyTo: { type: 'string', description: '回复的 msgId' },
        since: { type: ['number', 'string'], description: 'read 用：**省略或 0** = 读最新 limit 条（tail）；**给了游标** = 从该位置往后读 limit 条（forward，旧→新）。游标是复合值 (seq, writer)：字符串写法 `<seq>@<writer>`（取返回的 nextCursor），裸 seq（数字或无 @ 的字符串）按 seq 严格大于匹配。**`since: "0@"` = 从头读**（全历史可达）；省略/0 仍是 tail。**一页不会切开同一个 seq 组**，故 limit 是软上限：一页可能短于它，单组更大时整组返回（保证游标一定前进）。' },
        limit: { type: 'number', description: 'read 用，最多条数，默认 50，上限 200' }
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
