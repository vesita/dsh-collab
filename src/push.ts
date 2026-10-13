// src/push.ts
// **通知投递**：逐事件经 `agent.inject` 投一条**显式来源**的 notice。
//
// 为什么只有 `agent.inject` 一条通道（不许加回别的）：`sessionController.prompt` 与
// `subagents.sendMessage` 都只收 content、来源由宿主盖章，GUI 里会渲染成**用户气泡** ——
// 那是冒充真人输入（AGENTS.md §1）。逐事件投递的唯一诚实面是 `agent.inject`
// （`send(msg, "next-step", wakeup=false)`：进下一步但不唤醒 driver）。
//
// 消息由**真实的** `@deepseek-ai/dsh-llm` 构造，source 显式非 user：
//   { kind: 'dsh-collab', form: 'notice', summary: boundContextSummary(…) }
// `form:'notice'` 必须带非空 summary，否则客户端会把它退化成 opaque 行。
//
// 本模块只剩两件事：
//   1. `notifyLoopEndRelease`：会话退场自动释放后，告知**被释放的会话本人**它已不再持锁；
//   2. `pushNotice`：给调用方**已经拿着**的活 Agent 投一条 advisory notice（团队写域交叉预警）。
// 读者通知随 `readers` 字段一起删除：只读不再登记读者，没有读者可通知。

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { dropHolder, releaseOnDispose } from './collab-ops.js'
import type { AgentLike, AgentsLookupService, CollabContext, PushOutcome } from './contract.js'
import type { StateStore } from './store.js'

/** 推送面：installPush() 对外暴露的东西。 */
export interface PushApi {
  /**
   * 一次性 **advisory** notice：直接投给给定的活 Agent。
   * 与上面共用同一条诚实投递面，不新造通道、绝不冒充用户。绝不抛。
   */
  pushNotice(agent: AgentLike | undefined, text: string, label: string): PushOutcome
}

export function installPush(ctx: CollabContext, store: StateStore): PushApi {
  /** 释放通知消息：显式标注来源的 notice（role / id / 深冻结由真实构造函数补）。 */
  function releaseNoticeMessage(parts: { text: string; summary: string }) {
    return createUserMessage({
      content: [{ type: 'text' as const, text: parts.text }],
      source: {
        kind: 'dsh-collab' as const,
        form: 'notice' as const,
        summary: parts.summary
      }
    })
  }

  /** 把任意抛出物转成一行可读文本。 */
  function describeError(e: unknown): string {
    try {
      const m = e && typeof e === 'object' ? (e as { message?: unknown }).message : undefined
      if (typeof m === 'string' && m) return m
      return String(e)
    } catch (e2) {
      return 'unknown error'
    }
  }

  /**
   * 单条投递：**先在进程内解析目标 agent**，解析到就 inject 一条显式来源的 notice。
   * 返回真实结果，绝不抛；解析不到就如实跳过，**绝不回退**到任何会冒充用户的通道。
   */
  function pushOne(agents: AgentsLookupService, sessionId: string, parts: { text: string; summary: string }): PushOutcome {
    let agent: AgentLike | undefined
    try {
      agent = agents.get(sessionId)
    } catch (e) {
      return { ok: false, error: describeError(e) }
    }
    if (!agent) return { ok: false, error: 'agent-not-resolvable', notResolvable: true }
    try {
      if (typeof agent.inject !== 'function') return { ok: false, error: 'agent-has-no-inject' }
      agent.inject(releaseNoticeMessage(parts))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: describeError(e) }
    }
  }

  /**
   * advisory notice 的**单条同步投递**：调用方已经拿着活 Agent（tools/pre-execute 的
   * execCtx.agent），不需要（也不该）再走 sessionId 解析。
   */
  function pushNotice(agent: AgentLike | undefined, text: string, label: string): PushOutcome {
    if (!agent || typeof (agent as { inject?: unknown }).inject !== 'function') {
      return { ok: false, error: 'agent-has-no-inject' }
    }
    try {
      ;(agent as { inject(m: unknown): void }).inject(releaseNoticeMessage({ text, summary: boundContextSummary(label) }))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e && (e as Error).message) || e) }
    }
  }

  /**
   * `agent/disposed` 路径的**如实记账**通道（事件回调没有调用方，失败只能走日志）。
   * 取不到 logger 面时退化为无害的空操作 —— 那是宿主能力缺失，不是"成功"。
   */
  function reportInternal(scope: string, detail: string): void {
    const line = '[dsh-collab] ' + scope + ': ' + detail
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

  /** mutate() 未返回可投递结果时，把它的真实状态压成一行（reportInternal 用）。 */
  function describeMutateResult(res: unknown): string {
    const r = res as { ok?: unknown; error?: unknown; message?: unknown } | null | undefined
    if (!r || typeof r !== 'object') return 'result=' + String(r)
    const parts = ['ok=' + String(r.ok)]
    if (r.error !== undefined) parts.push('error=' + String(r.error))
    if (r.message !== undefined) parts.push('message=' + String(r.message))
    parts.push('released=' + (Array.isArray((r as { data?: { released?: unknown } }).data && (r as { data?: { released?: unknown } }).data!.released) ? 'array' : 'missing'))
    return parts.join(' ')
  }

  // 句柄结束 ⇒ 释放它的**全部**声明 + 摘掉名册行（0.13.0 用户决策）。
  // 恢复后的会话若按对话历史以为自己还持锁，`releaseOnDispose` 留下的审计留言
  // （频道 agent:<holderId>）是它自己能查到的凭据。
  ctx.on('agent/disposed', (payload: { agent?: { id?: string } }) => {
    try {
      const agent = payload && payload.agent
      if (!agent || !agent.id) return
      const holderId = 'agent:' + String(agent.id)
      let releaserName = holderId
      try {
        releaserName = store.hname({ holderId, sessionId: String(agent.id), agent: agent as AgentLike }) || holderId
      } catch (e) {}
      store.mutate(s => {
        const rel = releaseOnDispose(s, holderId, releaserName, Date.now())
        const dropped = dropHolder(s, holderId)
        const released = rel && rel.data && Array.isArray(rel.data.released) ? rel.data.released : []
        if (rel.changed !== true && dropped.changed !== true) return { ok: true, changed: false, data: { released: [] } }
        return { ok: true, changed: true, state: s, data: { released } }
      }, String(agent.id), agent as AgentLike)
        .then(res => {
          if (res && res.ok === true) return
          reportInternal('agent/disposed', 'mutate 未返回成功：' + describeMutateResult(res))
        })
        .catch(e => {
          reportInternal('agent/disposed', '异步链路失败：' + describeError(e))
        })
    } catch (e) {
      reportInternal('agent/disposed', '处理器同步段抛出：' + describeError(e))
    }
  }, { global: true })

  return { pushNotice }
}
