// src/access.ts
// **功能 A：访问路径相关通知 —— 逐事件投递一条显式标注来源的 notice 消息。**
//
// 载体（规范见 AGENTS.md §1「严禁冒充用户」）：
//   source = { kind: 'dsh-collab', form: 'notice', summary }
// 客户端的分流判据只有一条 —— `source.kind !== 'user'` ⇒ 渲染成 context 节点
// （`dsh-client-ui-chat/lib/client.js:8757`），所以这条消息是 **notice 行，不是用户气泡**：
// 它明确标注了来源，冒充不了用户。这是生态里逐事件通知的标准写法
// （对照 `dsh-tool-jobs/lib/index.js:208-226`）。
//
// 投递用 `agent.inject`：契约是 `send(message, "next-step", wakeup=false)`
// （`dsh-agent/lib/types/runtime-types.d.ts:209`、实现 `dsh-agent-loop/lib/index.js:795`）
// —— 进入下一步但不唤醒 driver。
//
// **不手抄构造函数**：`createUserMessage` / `boundContextSummary` 都来自真实的
// `@deepseek-ai/dsh-llm`（peer + dev 依赖），本仓库不再自制副本。
//
// 与功能 D 的接缝：被通知即被登记为读者（registerAccessReaders）。

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { relToProject, claimsForAccess, registerReader, renderAccessNotice } from './collab-core.js'
import type { Claim } from './collab-core.js'
import { collectPathCandidates, accessSignature } from './spec.js'
import type { AgentLike, CollabContext } from './contract.js'
import type { StateStore } from './store.js'

/**
 * 占用**管理**工具（插件自己的）：功能 A（访问通知 + reader 反向注册）必须整类跳过它。
 * 它的 `paths` 参数含义是"声明 / 查询某路径的占用情况"，**不是**读写该路径。
 *
 * 为什么**只**跳 `collab_lock`、不跳 `collab_board`：
 *   - 实测误报只出现在 `collab_lock`（见 `tools/post-execute` 里的缺陷说明）；
 *   - `collab_board` 的 `mentions` 这类字符串数组里出现路径，是既有测试**故意**守护的性质
 *     （`tests/collab-access-gate.mjs` 的「mentions 字符串数组里的路径也参与候选提取」用例），
 *     即候选提取与工具无关；board 没有实测误报，不该顺手改掉那条性质。
 */
const OCCUPANCY_TOOLS: ReadonlySet<string> = new Set(['collab_lock'])

export function installAccess(ctx: CollabContext, store: StateStore): void {
  // 包形态的关闭开关，与 awareness(130) / delegation(131) **同一个总开关**：
  // `DSH_COLLAB_NO_PROMPT_HINT=1` 的契约是"关掉**所有**运行时注入的内容"。
  // 访问通知是由运行时状态派生、再注入进会话的，所以这个开关对它同样有效 ——
  // 换载体（上下文段 → agent.inject）**不该顺手改掉用户的开关语义**：旧实现是靠
  // "拿不到上下文注册面就没有载体"顺带实现这一条的，现在显式判定。
  // 只关**投递**；读者反向登记（功能 D）照常发生，与换载体前一致。
  const NOTICE_ENABLED = process.env.DSH_COLLAB_NO_PROMPT_HINT !== '1'

  // 按 agent 去重：exec.agent 是稳定对象（先例 dsh-repeat-tool-reminder/lib/index.js:1462 用
  // WeakMap 键在 agent 上），键不会拦住共享状态文件里的任何东西，也不会泄漏 agent。
  const accessNotified = new WeakMap<object, string>()

  /**
   * 算出本次访问命中的"他人的活跃声明"。返回 null 表示"没有可用路径 / 没有命中"，
   * duplicate=true 表示"与上一次投递给同一 agent 的内容逐字相同"（不再重复通知）。
   * 纯读，不写状态；失败由调用方兜。
   */
  async function accessEntries(execCtx: any): Promise<{ id: string | null; agent?: AgentLike; entries: Claim[]; duplicate: boolean } | null> {
    const candidates = collectPathCandidates(execCtx && execCtx.arguments)
    if (!candidates.length) return null
    const agent = execCtx && execCtx.agent
    const id = agent && agent.id ? String(agent.id) : null
    const cwd = await store.cwdOf(id, agent)
    // 会话家族（自己 + 祖先 + 后代）不算"别人的占用"：自家子代理与我共享写域，
    // 为它发访问通知只会制造噪声（判据与 claim()/gate 同源）。
    const fam = new Set(store.familyIds(id, agent))
    const { state } = await store.load(id, agent)
    const t = store.now()
    const seen = new Set<string>()
    const entries: Claim[] = []
    for (const raw of candidates) {
      const rel = relToProject(raw, cwd)
      if (!rel) continue
      for (const c of claimsForAccess(state.claims, rel, t)) {
        if (fam.has(c.holderId) || seen.has(c.claimId)) continue
        seen.add(c.claimId)
        entries.push(c)
      }
    }
    if (!entries.length) return null
    const signature = accessSignature(entries)
    const key = agent && typeof agent === 'object' ? agent : null
    if (key && accessNotified.get(key) === signature) return { id, agent, entries, duplicate: true }
    if (key) accessNotified.set(key, signature)
    return { id, agent, entries, duplicate: false }
  }

  /**
   * 功能 D 的反向注册：把本次访问者登记为这些 claim 的读者。
   * "被锁通知"这个动作本身就是登记 —— 投递与登记是同一件事。
   * best-effort：写失败绝不阻断通知，也绝不抛进 waterfall。
   */
  async function registerAccessReaders(id: string | null, agent: AgentLike | undefined, entries: Claim[]): Promise<void> {
    if (!id || !entries.length) return
    const me = 'agent:' + id
    try {
      await store.mutate(s => {
        let changed = false
        for (const c of entries) if (registerReader(s, c.claimId, me).changed) changed = true
        return changed ? { ok: true, changed: true, state: s, data: {} } : { ok: true, changed: false, data: {} }
      }, id, agent)
    } catch (e) {
      // 反向注册失败只是少一条通知对象，不影响本次通知投递。
    }
  }

  /**
   * 访问通知消息：**显式标注来源的 notice**。
   * `form: 'notice'` **必须带非空 `summary`**，否则客户端会把它退化成 opaque 行
   * （`dsh-client-ui-chat/lib/client.js:825-831` 的 `case "notice"` 先算 `noticeSummary`）。
   * 120 字符上限由 `boundContextSummary` 保证 —— 与生态里 5 个包同款用法。
   */
  function accessNoticeMessage(entries: Claim[]) {
    const head = entries[0] && entries[0].paths.length ? entries[0].paths[0] : ''
    return createUserMessage({
      content: [{ type: 'text' as const, text: renderAccessNotice(entries) }],
      source: {
        kind: 'dsh-collab' as const,
        form: 'notice' as const,
        summary: boundContextSummary('collab 占用 · ' + head + (entries.length > 1 ? ' 等 ' + entries.length + ' 条' : ''))
      }
    })
  }

  // ---- 命中即投递（绝不改工具结果本身）----
  // 先 await next()：本次工具的结果永远原样返回，通知只是**旁路**地注入一条消息。
  // 异常绝不进 waterfall（抛出的监听器会把工具结果变成 isError）：整体 try/catch，
  // 任何失败都等价于"这次没有通知"。
  // 注册走 ctx.on(...)，listener 作为 ctx 作用域的 effect 注册，随插件卸载自动回收。
  ctx.on('tools/post-execute', async (execCtx: any, _result: any, next: () => Promise<any>) => {
    const downstream = await next()
    // 占用管理工具（collab_lock）不算"访问路径"：它的 paths 参数是在**声明或查询占用**，
    // 不是读写该路径。实测缺陷（2026-09-13 23:47）：主 AI 调 `collab_lock op=status` 只为
    // 查询谁占用 `src/collab-probe2/`，插件却给它注入了一条「你刚访问的路径处于其他会话的
    // 占用范围内」——**措辞不实**（它没碰文件），还把它登记成该 claim 的 reader。
    // 功能 A 只对真正的读写触碰负责，故在这里整类跳过（不含 collab_board，理由见常量注释）。
    const ownToolName = execCtx && typeof execCtx.name === 'string' ? execCtx.name : ''
    if (OCCUPANCY_TOOLS.has(ownToolName)) return downstream
    try {
      const found = await accessEntries(execCtx)
      // 全部是重复 → 不再通知（与旧载体的去重语义一致）。
      if (found && !found.duplicate) {
        // 功能 D：通知与反向注册是同一个动作，先登记读者再投递。
        await registerAccessReaders(found.id, found.agent, found.entries)
        const agent = execCtx && execCtx.agent
        // 拿不到带 inject 的 Agent（例如受限宿主）时**不投递**，也绝不退回"自己造一条消息"。
        // 总开关关掉时同样不投递（见上面的 NOTICE_ENABLED）。
        if (NOTICE_ENABLED && agent && typeof agent.inject === 'function') agent.inject(accessNoticeMessage(found.entries))
      }
    } catch (e) {
      // 计算或投递失败 = 本次没有通知。
    }
    return downstream
  })
}
