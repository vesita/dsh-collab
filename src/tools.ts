// src/tools.ts
// **collab_lock / collab_board 两个模型工具的注册**：参数 schema、执行包装（统一错误信封）
// 与 release 后的推送接线。
//
// 依赖：状态存取面（store）+ 推送面（push）。
//
// 单元 E 起，`collab_board op=post` 多了一条**定向唤醒**（`wake`）的可选路径：投递前先
// 探活（`store.probeAgent`，真判据 `agent.status`），目标 idle 时必须由投递方**二次确认**
// 才真的 steer。自动通知（access / push）一律**保持 inject（不唤醒）**，见各自模块。
//
// 单元 F 起，`op=post` 另有**广播推送**（`push: true`）：受众由频道现算（general = 全部持有人，
// path:<p> = 声明重叠者，都排除自己），逐个探活后**全部在跑就整批 steer**；有任一 idle/unknown
// 就一个都不投递、返回受众预览 + **一个绑定本次广播**的一次性令牌；受众超上限直接拒绝。
// 令牌载荷绑定「频道 + 受众集合 + 投递方 + 到期」—— 受众变了即失效。

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { claim, release, heartbeat, post, teamScopeOverlaps, pushAudience, BOARD_NO_DELIVERY_HINT } from './collab-core.js'
import type { HolderInput, PublishedClaim, PushAudience } from './collab-core.js'
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

  // ════════════════════════════════════════════════════════════════════════
  // 单元 E：定向唤醒 + 探活 + 门控
  // ════════════════════════════════════════════════════════════════════════
  //
  // 用户定的规则（照做，不加戏）：
  //   · 投递前**探活**，且投递方要**二次确认**；
  //   · **接收方 idle ⇒ 投递方必须二次确认；否则（在跑）不需要确认**。
  //
  // 载体分工（与 AGENTS.md §1 的"按性质选载体"一致）：
  //   · `agent.inject`（`send(msg,"next-step",wakeup=false)`）= 不唤醒，下次装配时看到 ——
  //     访问通知 / 释放通知继续用它，本单元**不动**它们（自动唤醒 idle 会话 = 未经同意烧 token，
  //     正是门控要防的事）。
  //   · `agent.steer(message: UserMessage)`（`dsh-agent/lib/types/runtime-types.d.ts:194-200`）
  //     = `send(msg,"next-step",wakeup=true)`，注释原文 "An idle driver starts a turn" ——
  //     **会唤醒 idle**。消息由我们自己经真实的 `@deepseek-ai/dsh-llm` 构造、source 显式非 user
  //     （`kind:'dsh-collab'`, `form:'notice'`）⇒ 不冒充用户。**本单元只用 steer，不用 followup**
  //     （`followup` 会另开一个独立 turn，打扰更大）。
  //
  // 令牌方案与取舍（必须写清）：
  //   · 形状：`base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload))`，payload =
  //     `{ m: msgId, t: target, b: 投递方 holderId, e: 到期时刻, c: channel, x: 正文摘要 }`。
  //     签名密钥是**本插件实例**的 `randomBytes(32)` ⇒ 篡改任一绑定字段（换目标 / 换留言 /
  //     改到期）都会签名不符而拒绝。
  //   · **一次性**：成功 steer 才把令牌记进 `wakeUsed`，之后同令牌再确认一律拒绝（防重放）；
  //     投递失败（目标已消失 / steer 抛错）**不消耗**令牌，可用同一令牌重试。
  //   · **过期**：默认 120 秒（`DSH_COLLAB_WAKE_TTL_SEC` 可覆盖，测试用小值验证过期分支）。
  //   · **跨进程不可用**：密钥与一次性表都是本进程内存里的。这与能力本身一致 —— 探活用的是
  //     **本进程**的 `agents` 注册表，跨进程的会话本来也 steer 不到；跨进程场景如实降级为
  //     "探不到，只落板"。**不落状态文件**：令牌不进 SSOT、不参与 mergeDocs，故不引入新的
  //     收敛字段（也就没有跨副本 join 的语义要定义）。
  //   · 校验顺序：格式 → 签名 → 一次性 → 过期 → 目标一致 → 投递方一致。任一条不过即拒绝，
  //     且**绝不 steer**（判据集中在 verifyWakeToken 一处）。

  /** 确认令牌有效期（毫秒）。`DSH_COLLAB_WAKE_TTL_SEC` 可覆盖（正整数秒），默认 120 秒。 */
  const WAKE_TTL_MS = ((): number => {
    const sec = Number(process.env.DSH_COLLAB_WAKE_TTL_SEC)
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : 120000
  })()

  /** 本实例的签名密钥（进程内、每次 installTools 现生成；重启即失效 —— 见上面的取舍）。 */
  const WAKE_SECRET = randomBytes(32)
  /**
   * 已被成功用掉的一次性令牌 → 到期时刻（GC 判据与令牌自己的 `e` 同源）。
   * 定向唤醒（E）与广播推送（F）**共用这一张表**：键是完整的令牌串，天然不撞。
   */
  const usedTokens = new Map<string, number>()

  /** 令牌载荷：每一个字段都被签名覆盖，所以任何一项被改都过不了校验。 */
  interface WakePayload {
    m: string   // msgId：绑定到**这一条**留言
    t: string   // target sessionId：绑定到**这一个**目标
    b: string   // 投递方 holderId：只有发起人能确认
    e: number   // 到期时刻（epoch ms）
    c: string   // channel（唤醒文案用）
    x: string   // 正文摘要（唤醒文案用）
  }

  type SteerableAgent = AgentLike & { steer?: (message: unknown) => void }

  const b64url = (v: string | Buffer): string => Buffer.from(v).toString('base64url')
  const wakeSig = (body: string): Buffer => createHmac('sha256', WAKE_SECRET).update(body).digest()

  function mintWakeToken(p: WakePayload): string {
    const body = b64url(JSON.stringify(p))
    return body + '.' + b64url(wakeSig(body))
  }

  /** 只做"格式 + 签名"校验，返回载荷或拒绝原因。**不抛**：令牌是输入，不是不变量。 */
  function parseWakeToken(token: unknown): { ok: boolean; payload?: WakePayload; reason?: string } {
    const s = typeof token === 'string' ? token.trim() : ''
    const at = s.indexOf('.')
    if (at <= 0 || at >= s.length - 1) return { ok: false, reason: 'malformed' }
    const body = s.slice(0, at)
    const sig = s.slice(at + 1)
    let got: Buffer
    try { got = Buffer.from(sig, 'base64url') } catch (e) { return { ok: false, reason: 'malformed' } }
    const expect = wakeSig(body)
    // 长度先比：timingSafeEqual 对不等长直接抛。
    if (got.length !== expect.length || !timingSafeEqual(got, expect)) return { ok: false, reason: 'bad-signature' }
    let payload: any
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch (e) { return { ok: false, reason: 'malformed' } }
    const p = payload as Partial<WakePayload>
    if (!p || typeof p.m !== 'string' || !p.m || typeof p.t !== 'string' || !p.t ||
        typeof p.b !== 'string' || !p.b || typeof p.e !== 'number' ||
        typeof p.c !== 'string' || typeof p.x !== 'string') {
      return { ok: false, reason: 'malformed' }
    }
    return { ok: true, payload: { m: p.m, t: p.t, b: p.b, e: p.e, c: p.c, x: p.x } }
  }

  /** 令牌 GC：`usedTokens` 只保留未到期的条目（有界，与 sweep 同一"确定性规则只看数据"口径）。 */
  function pruneUsedTokens(now: number): void {
    for (const [k, exp] of usedTokens) if (!(exp > now)) usedTokens.delete(k)
  }

  /** 完整校验：格式/签名 → 一次性 → 过期 → 目标一致 → 投递方一致。任何一条不过即拒绝。 */
  function verifyWakeToken(token: unknown, target: string, by: string, now: number): { ok: boolean; payload?: WakePayload; reason?: string } {
    const parsed = parseWakeToken(token)
    if (!parsed.ok) return parsed
    if (usedTokens.has(String(token).trim())) return { ok: false, reason: 'used' }
    if (!(parsed.payload.e > now)) return { ok: false, reason: 'expired' }
    if (parsed.payload.t !== target) return { ok: false, reason: 'target-mismatch' }
    if (parsed.payload.b !== by) return { ok: false, reason: 'caller-mismatch' }
    return { ok: true, payload: parsed.payload }
  }

  /** 唤醒提示消息：显式来源的 notice（`form:'notice'` 必须带非空 summary）。 */
  function wakeNoticeMessage(text: string, summary: string) {
    return createUserMessage({
      content: [{ type: 'text' as const, text }],
      source: { kind: 'dsh-collab' as const, form: 'notice' as const, summary }
    })
  }

  const errText = (e: unknown): string => {
    try {
      const m = e && typeof e === 'object' ? (e as { message?: unknown }).message : undefined
      if (typeof m === 'string' && m) return m
      return String(e)
    } catch (e2) { return 'unknown error' }
  }

  /**
   * 对目标 agent 调一次 `steer`。**只在这一处**调它，且必然带一条显式来源的 UserMessage。
   * 返回真实结果、绝不抛：解析不到 / 没有 steer 面 / steer 抛错都如实返回。
   */
  function steerTarget(agent: AgentLike | undefined, text: string, summary: string): { ok: boolean; error?: string } {
    if (!agent) return { ok: false, error: 'agent-not-resolvable' }
    const steer = (agent as SteerableAgent).steer
    if (typeof steer !== 'function') return { ok: false, error: 'agent-has-no-steer' }
    try {
      steer.call(agent, wakeNoticeMessage(text, summary))
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errText(e) }
    }
  }

  /** 正文摘要（唤醒文案 + 预览用）：压空白、截 160 字。 */
  const wakeExcerpt = (body: string): string => {
    const one = String(body || '').replace(/\s+/g, ' ').trim()
    return one.length > 160 ? one.slice(0, 160) + '…' : one
  }

  function wakeNoticeParts(byName: string, channel: string, excerpt: string): { text: string; summary: string } {
    const text = '[dsh-collab] ' + byName + ' 在留言板给你留了一条（频道 ' + channel + '）：' + excerpt +
      '。用 collab_board op=read（channel: ' + channel + '）读取。本条是定向唤醒（steer），来源为 dsh-collab，不是真人输入。'
    return { text, summary: boundContextSummary('collab 留言板 · ' + byName + ' · ' + excerpt) }
  }

  /**
   * 投递前的探活 + 门控。留言**已经落板**，本函数只决定要不要、以及怎么唤醒。
   * 三分支（就是用户定的规则）：
   *   在跑  → 直接 steer，不需要确认，**不发令牌**；
   *   idle  → **不投递**，返回预览 + 一次性令牌；
   *   探不到 → **不投递**，如实说明（留言只落板）。
   * `unknown`（在场但 status 读不出来）按保守侧并入 idle 门控；`failed`（判据抛错）单独如实报。
   */
  async function beginWake(target: string, msgId: string, body: string, byName: string, byHolder: string, channel: string): Promise<Record<string, unknown>> {
    const probe = store.probeAgent(target)
    const excerpt = wakeExcerpt(body)
    if (probe.state === 'running') {
      const parts = wakeNoticeParts(byName, channel, excerpt)
      const r = steerTarget(probe.agent, parts.text, parts.summary)
      if (r.ok) {
        return { target, delivered: true, pending: false, mode: 'running', via: 'steer', note: '目标正在跑（非 idle）：已直接 steer 投递，它会在下一步边界领走；不需要二次确认。' }
      }
      return { target, delivered: false, pending: false, mode: 'running', reason: r.error, note: '目标正在跑，但 steer 失败（' + r.error + '）：未投递，留言已落板。' }
    }
    if (probe.state === 'idle' || probe.state === 'unknown') {
      const now = store.now()
      pruneUsedTokens(now)
      const exp = now + WAKE_TTL_MS
      const token = mintWakeToken({ m: msgId, t: target, b: byHolder, e: exp, c: channel, x: excerpt })
      return {
        target,
        delivered: false,
        pending: true,
        mode: probe.state,
        confirmToken: token,
        expiresAt: exp,
        expiresInSec: Math.round(WAKE_TTL_MS / 1000),
        preview: { target, msgId, channel, bodySummary: excerpt, wakeEffect: '唤醒会让它立刻起一轮' },
        note: '目标此刻 ' + probe.state + '：**未投递**（唤醒它会立刻起一轮）。二次确认请再调一次 collab_board op=post，带上同一 wake 与 confirmToken；确认步**只唤醒、不再写留言**。令牌一次性、' +
          Math.round(WAKE_TTL_MS / 1000) + ' 秒内有效，且只能用于这一目标 + 这一条留言。'
      }
    }
    if (probe.state === 'failed') {
      return { target, delivered: false, pending: false, mode: 'failed', reason: 'probe-failed', note: '探活判据本身出错（' + (probe.error || '') + '）：**未投递**，留言已只落板。' }
    }
    return { target, delivered: false, pending: false, mode: 'absent', reason: 'not-found', note: '探不到该会话（不在本进程 / 无此会话）：**未投递**，留言已只落板；对方下次 collab_board op=read 时可见。' }
  }

  /**
   * 二次确认那一步：**只唤醒，不再写留言**（"留言只落一次"），所以整段不碰 `post`。
   * 校验不过一律拒绝且绝不 steer；成功投递才把令牌记为已用（失败可重试）。
   */
  async function confirmWake(target: string, token: string, h: HolderInput & { agent?: AgentLike }): Promise<ToolResult> {
    const now = store.now()
    pruneUsedTokens(now)
    const v = verifyWakeToken(token, target, h.holderId, now)
    if (!v.ok) {
      return { ok: false, error: 'bad-request', message: '唤醒令牌被拒绝（' + v.reason + '）：**未投递、未写留言**。令牌必须与首次返回的 confirmToken 一致，绑定同一目标与同一留言，且未过期、未被用过。' }
    }
    const probe = store.probeAgent(target)
    if (probe.state === 'absent' || probe.state === 'failed') {
      return { ok: false, error: 'bad-request', message: '令牌有效，但此刻探不到目标会话（' + probe.state + '）：**未投递**。目标恢复后可用同一令牌重试（成功投递才消耗它）。' }
    }
    const parts = wakeNoticeParts(h.name || h.holderId, v.payload.c, v.payload.x)
    const r = steerTarget(probe.agent, parts.text, parts.summary)
    if (!r.ok) return { ok: false, error: 'internal', message: 'steer 失败（' + r.error + '）：**未投递**，令牌未消耗，可重试。' }
    usedTokens.set(token.trim(), v.payload.e)
    return {
      ok: true,
      data: {
        msgId: v.payload.m,
        delivered: true,
        deliveryNote: '定向唤醒已投递：steer 了一条显式来源（dsh-collab/notice）的提示，确认步不再写留言。',
        wake: { target, delivered: true, pending: false, mode: probe.state, via: 'steer', confirmed: true, msgId: v.payload.m, note: '已唤醒目标；留言仍只有原来的那一条。' }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // 单元 F：广播推送（push: true）+ 受众 + 门控 + 一次性令牌
  // ════════════════════════════════════════════════════════════════════════
  //
  // 用户实测的硬伤：广播（`op=post`，不带 wake）**没有出口** —— 留言只写共享状态文件，
  // 而 `src/awareness.ts` 每轮摘要只渲染 active claims、完全不碰 messages，所以除了读者
  // 主动 `op=read`，没有一条广播会进任何人的上下文。单元 F 把广播改成**推送制**。
  //
  // 语义（照用户定的做，不加戏）：
  //   · 受众由**频道**现算（`pushAudience`）：general = 全部持有人，path:<p> = 声明重叠者，
  //     都排除投递方自己；受众里没有可投递的人 ⇒ 不推送、如实说明，留言只落板。
  //   · 逐个探活（复用 `store.probeAgent`）：**全部在跑 ⇒ 直接整批 steer**（在跑就不需要
  //     确认）；**有任一 idle/unknown ⇒ 一个都不投递**，返回受众预览 + 一次性令牌；
  //     **受众数超上限 ⇒ 拒绝**（不推送、不发令牌，也不做"静默推一半"）。
  //   · 令牌沿用单元 E 的 HMAC 方案，但载荷绑定「**频道 + 受众集合 + 投递方 + 到期**」：
  //     受众变了（有人新 claim / 有人消失）⇒ 失效。一次性：成功投递才消耗，失败可重试。
  //   · 内容是一条**短通知**（复用 E 的 notice 构造：真实 dsh-llm、显式非 user 来源），
  //     带频道 + 作者 + 正文摘要（截断 160 字）；长正文留在板上。
  //   · **不落状态文件**：受众与令牌都是本进程内存里的现算量，不进 SSOT、不参与 mergeDocs。

  /** 广播受众上限。`DSH_COLLAB_PUSH_MAX` 可覆盖（正整数），默认 12 —— 超限**拒绝**而不是静默推一半。 */
  const PUSH_MAX = ((): number => {
    const n = Number(process.env.DSH_COLLAB_PUSH_MAX)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 12
  })()

  /** 令牌载荷：每个字段都被签名覆盖。受众 `a` 是**排序后**的 holderId 集合（确定性）。 */
  interface PushPayload {
    ch: string    // 频道（受众规则 + 通知文案都用它）
    a: string[]   // 受众集合（holderId，排序）：受众一变，这个集合就不等了
    b: string     // 投递方 holderId：只有发起人能确认
    e: number     // 到期时刻（epoch ms）
    m: string     // msgId：绑定这一条留言（可追溯）
    n: string     // 投递方显示名（通知文案用）
    x: string     // 正文摘要（通知文案用）
  }

  /** holderId → sessionId；非 `agent:` 前缀（如 `human:console`）返回 null（不可 steer）。 */
  const holderToSession = (holderId: string): string | null => {
    const m = /^agent:(.+)$/.exec(typeof holderId === 'string' ? holderId : '')
    return m && m[1] ? m[1] : null
  }

  /** 频道归一：与 `post()` 同口径（空 / 非串 ⇒ `general`）。 */
  const channelOf = (a: CollabArgs): string => (typeof a.channel === 'string' && a.channel.trim() ? a.channel.trim() : 'general')

  function mintPushToken(p: PushPayload): string {
    const body = b64url(JSON.stringify(p))
    return body + '.' + b64url(wakeSig(body))
  }

  /** 只做"格式 + 签名"校验（字段逐个查类型）。**不抛**：令牌是输入，不是不变量。 */
  function parsePushToken(token: unknown): { ok: boolean; payload?: PushPayload; reason?: string } {
    const s = typeof token === 'string' ? token.trim() : ''
    const at = s.indexOf('.')
    if (at <= 0 || at >= s.length - 1) return { ok: false, reason: 'malformed' }
    const body = s.slice(0, at)
    const sig = s.slice(at + 1)
    let got: Buffer
    try { got = Buffer.from(sig, 'base64url') } catch (e) { return { ok: false, reason: 'malformed' } }
    const expect = wakeSig(body)
    if (got.length !== expect.length || !timingSafeEqual(got, expect)) return { ok: false, reason: 'bad-signature' }
    let payload: any
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch (e) { return { ok: false, reason: 'malformed' } }
    const p = payload as Partial<PushPayload>
    if (!p || typeof p.ch !== 'string' || !p.ch || !Array.isArray(p.a) ||
        !p.a.every((x): x is string => typeof x === 'string' && !!x) ||
        typeof p.b !== 'string' || !p.b || typeof p.e !== 'number' ||
        typeof p.m !== 'string' || typeof p.n !== 'string' || typeof p.x !== 'string') {
      return { ok: false, reason: 'malformed' }
    }
    return { ok: true, payload: { ch: p.ch, a: p.a.slice(), b: p.b, e: p.e, m: p.m, n: p.n, x: p.x } }
  }

  /** 完整校验：格式/签名 → 一次性 → 过期 → 投递方一致。受众一致性要读盘，在 confirmPush 里比。 */
  function verifyPushToken(token: unknown, by: string, now: number): { ok: boolean; payload?: PushPayload; reason?: string } {
    const parsed = parsePushToken(token)
    if (!parsed.ok) return parsed
    if (usedTokens.has(String(token).trim())) return { ok: false, reason: 'used' }
    if (!(parsed.payload.e > now)) return { ok: false, reason: 'expired' }
    if (parsed.payload.b !== by) return { ok: false, reason: 'caller-mismatch' }
    return { ok: true, payload: parsed.payload }
  }

  /** 集合相等（受众绑定判据）：两边排序后逐元素比；长度不同即不等。 */
  function sameHolderSet(a: unknown, b: unknown): boolean {
    const x = Array.isArray(a) ? a.map(String).sort() : []
    const y = Array.isArray(b) ? b.map(String).sort() : []
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
    return true
  }

  /** 广播通知文案（**短通知**：频道 + 作者 + 正文摘要；长正文留在板上）。 */
  function pushNoticeParts(byName: string, channel: string, excerpt: string, count: number): { text: string; summary: string } {
    const text = '[dsh-collab] ' + byName + ' 向频道 ' + channel + ' 广播了一条留言（本次推送 ' + count +
      ' 人）：' + excerpt + '。用 collab_board op=read（channel: ' + channel +
      '）读取。本条是广播推送（steer），来源为 dsh-collab，不是真人输入。'
    return { text, summary: boundContextSummary('collab 广播 · ' + byName + ' · ' + excerpt) }
  }

  /** 一次广播的现场快照（在 `mutate` 的回调里从**当轮状态**现算）。 */
  interface PushCapture { channel: string; audience: PushAudience; names: Map<string, string> }

  /**
   * 投递前的探活 + 门控。留言**已经落板**，本函数只决定要不要、以及怎么投递。
   * 分支：全部在跑 → 整批 steer；有 idle/unknown → 一个都不投递 + 预览 + 令牌；
   * 探不到的人 → 逐个如实记，不静默丢。
   */
  async function beginPush(cap: PushCapture, msgId: string, body: string, h: HolderInput & { agent?: AgentLike }): Promise<Record<string, unknown>> {
    const ids = cap.audience.holderIds
    const excerpt = wakeExcerpt(body)
    if (!ids.length) {
      const why = cap.audience.kind === 'unsupported-channel'
        ? '频道 ' + cap.channel + ' 没有受众规则（只有 general 与 path:<相对路径> 会推送给持有人）'
        : (cap.audience.reason === 'empty-path' ? 'path: 频道没给出可用路径' : '本项目此刻没有其他持有人')
      return {
        supported: true, mode: 'empty', reason: cap.audience.reason || 'audience-empty',
        audience: [], audienceCount: 0, idleCount: 0, runningCount: 0, unreachableCount: 0,
        maxAudience: PUSH_MAX, delivered: false, pushed: [],
        note: '广播受众为空（' + why + '）：**未推送**，留言只落板。'
      }
    }
    const probed = ids.map(holderId => {
      const sid = holderToSession(holderId)
      const probe = sid ? store.probeAgent(sid) : { state: 'absent' as const, agent: undefined }
      return { holderId, sid, name: cap.names.get(holderId) || holderId, status: probe.state, agent: probe.agent }
    })
    const idle = probed.filter(p => p.status === 'idle' || p.status === 'unknown')
    const running = probed.filter(p => p.status === 'running')
    const unreachable = probed.filter(p => p.status === 'absent' || p.status === 'failed')
    const preview = probed.map(p => ({ target: p.holderId, sessionId: p.sid, name: p.name, status: p.status }))
    const base = {
      supported: true, audience: preview, audienceCount: ids.length,
      idleCount: idle.length, runningCount: running.length, unreachableCount: unreachable.length,
      maxAudience: PUSH_MAX, delivered: false, pushed: [] as Array<Record<string, unknown>>
    }
    // 有任一 idle/unknown ⇒ **一个都不投递**（保守侧：唤醒 idle 会立刻起一轮，必须先确认）。
    if (idle.length) {
      const now = store.now()
      pruneUsedTokens(now)
      const exp = now + WAKE_TTL_MS
      const token = mintPushToken({ ch: cap.channel, a: ids, b: h.holderId, e: exp, m: msgId, n: h.name || h.holderId, x: excerpt })
      return Object.assign(base, {
        mode: 'idle', reason: 'idle-confirm-required', confirmToken: token, expiresAt: exp,
        expiresInSec: Math.round(WAKE_TTL_MS / 1000),
        // 「总计将唤醒几个」= 确认后会被 steer 的收件人数（其中 idle/unknown 的那部分会真的起一轮）。
        willDeliverCount: ids.length, willWakeIdleCount: idle.length,
        note: '广播受众 ' + ids.length + ' 人里有 ' + idle.length + ' 个 idle/unknown：**一个都没投递**（唤醒 idle 会立刻起一轮，需要你确认）。' +
          '二次确认请再调一次 collab_board op=post，带同一 pushToken（可带同一 channel）；确认步**只推送、不再写留言**。' +
          '令牌绑定本次广播的频道 + 受众集合（' + ids.length + ' 人），受众一变即失效；一次性、' +
          Math.round(WAKE_TTL_MS / 1000) + ' 秒内有效。'
      })
    }
    // 没有 idle/unknown：可投递的就是在跑的那些；absent/failed 逐个如实记（不静默）。
    const results: Array<Record<string, unknown>> = []
    for (const p of probed) {
      if (p.status === 'running') {
        const parts = pushNoticeParts(h.name || h.holderId, cap.channel, excerpt, ids.length)
        const r = steerTarget(p.agent, parts.text, parts.summary)
        results.push({ target: p.holderId, sessionId: p.sid, ok: r.ok, error: r.error })
      } else {
        results.push({ target: p.holderId, sessionId: p.sid, ok: false, error: p.status === 'failed' ? 'probe-failed' : 'not-found' })
      }
    }
    const okCount = results.filter(r => r.ok === true).length
    const allOk = okCount === ids.length
    return Object.assign(base, {
      mode: running.length ? 'running' : 'unreachable',
      delivered: allOk,
      pushed: results,
      reason: allOk ? undefined : (running.length ? 'partial-unreachable' : 'no-reachable-audience'),
      note: allOk
        ? '广播受众 ' + ids.length + ' 人全部在跑：已直接整批 steer 投递（在跑就不需要二次确认）。'
        : (running.length
          ? '广播受众 ' + ids.length + ' 人里 ' + running.length + ' 人在跑（已 steer）、' + unreachable.length + ' 人探不到（未投递，已逐个记在 pushed 里）：没有 idle，所以不发令牌。'
          : '广播受众 ' + ids.length + ' 人都探不到（不在本进程 / 无此会话）：**未投递**，留言只落板。')
    })
  }

  /**
   * 确认那一步：**只推送、不再写留言**（"留言只落一次"），所以整段不碰 `post`。
   * 校验不过一律拒绝且绝不 steer；受众与令牌绑定不符同样拒绝。至少投递成功一个才消耗令牌
   * （一个都没成 ⇒ 不消耗、可重试；部分成功也消耗 —— 否则重试会对已投的人重复 steer）。
   */
  async function confirmPush(token: string, h: HolderInput & { agent?: AgentLike }, a: CollabArgs, aId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const now = store.now()
    pruneUsedTokens(now)
    const v = verifyPushToken(token, h.holderId, now)
    if (!v.ok) {
      return { ok: false, error: 'bad-request', message: '广播令牌被拒绝（' + v.reason + '）：**未投递、未写留言**。令牌必须是首次返回的 pushToken 原样，绑定本次广播的频道 + 受众集合，且未过期、未被用过。' }
    }
    // 确认步可以带 channel：与令牌里的频道不一致即拒绝（"换频道"必须被挡回而不是被忽略）。
    const rawCh = typeof a.channel === 'string' && a.channel.trim() ? a.channel.trim() : null
    if (rawCh && rawCh !== v.payload.ch) {
      return { ok: false, error: 'bad-request', message: '广播令牌绑定频道 ' + v.payload.ch + '，与本次 channel ' + rawCh + ' 不一致（channel-mismatch）：**未投递、未写留言**。' }
    }
    // 受众**现算**：与令牌里绑定的集合不等 ⇒ 失效（有人新 claim / 有人消失都算）。
    const { state } = await store.load(aId, agent)
    const cur = pushAudience(state, v.payload.ch, h.holderId, now)
    if (!sameHolderSet(cur.holderIds, v.payload.a)) {
      return {
        ok: false, error: 'bad-request',
        message: '广播受众已变化（令牌绑定 ' + v.payload.a.length + ' 人，此刻 ' + cur.holderIds.length + ' 人；audience-changed）：**未投递、未写留言**。受众一变令牌即失效，请重新 op=post 发起广播。',
        data: { push: { supported: true, mode: 'stale', reason: 'audience-changed', audienceCount: v.payload.a.length, currentAudienceCount: cur.holderIds.length, delivered: false, pushed: [] } }
      }
    }
    const results: Array<Record<string, unknown>> = []
    for (const holderId of v.payload.a) {
      const sid = holderToSession(holderId)
      if (!sid) { results.push({ target: holderId, sessionId: null, ok: false, error: 'not-steerable' }); continue }
      const probe = store.probeAgent(sid)
      if (probe.state === 'absent' || probe.state === 'failed') {
        results.push({ target: holderId, sessionId: sid, ok: false, error: probe.state === 'failed' ? 'probe-failed' : 'not-found' })
        continue
      }
      const parts = pushNoticeParts(v.payload.n, v.payload.ch, v.payload.x, v.payload.a.length)
      const r = steerTarget(probe.agent, parts.text, parts.summary)
      results.push({ target: holderId, sessionId: sid, ok: r.ok, error: r.error })
    }
    const okCount = results.filter(r => r.ok === true).length
    if (okCount === 0) {
      return {
        ok: false, error: 'internal',
        message: '广播确认：受众里没有一个能 steer（' + JSON.stringify(results.map(r => r.error)) + '）：**未投递**，令牌未消耗，可重试。',
        data: { push: { supported: true, mode: 'unreachable', reason: 'no-reachable-audience', audienceCount: v.payload.a.length, delivered: false, pushed: results } }
      }
    }
    usedTokens.set(token.trim(), v.payload.e)
    return {
      ok: true,
      data: {
        msgId: v.payload.m,
        delivered: okCount === v.payload.a.length,
        deliveryNote: '广播推送已投递：对每个可达受众各 steer 了一条显式来源（dsh-collab/notice）的短通知，确认步不再写留言。',
        push: {
          supported: true, mode: 'confirmed', channel: v.payload.ch, reason: undefined,
          audienceCount: v.payload.a.length, delivered: okCount === v.payload.a.length,
          pushed: results, confirmed: true, msgId: v.payload.m,
          note: '已对 ' + okCount + '/' + v.payload.a.length + ' 个受众各 steer 恰好一次；留言仍只有原来的那一条。'
        }
      }
    }
  }

  /**
   * `op=post` 的完整路径（单元 F 统一收口）：
   *   · 不带 wake / wakeToken / push / pushToken ⇒ 原样（纯落板，deliveryNote 一字不变）；
   *   · 带 wakeToken（定时确认）⇒ **不写留言**，只校验令牌并 steer；
   *   · 只带 wake ⇒ 先落板（恰好一条），再探活决定直接投递 / 出令牌 / 如实说明；
   *   · 带 pushToken（广播确认）⇒ **不写留言**，校验令牌 + 受众绑定后逐个 steer；
   *   · 只带 push:true ⇒ 先按受众上限决定是否落板，再逐个探活决定整批投递 / 出令牌 / 如实说明。
   */
  async function postWithDelivery(a: CollabArgs, h: HolderInput & { agent?: AgentLike }, aId: string | null, agent?: AgentLike): Promise<ToolResult> {
    const raw = a as unknown as Record<string, unknown>
    const rawWake = raw.wake
    const rawWakeToken = raw.wakeToken
    const rawPush = raw.push
    const rawPushToken = raw.pushToken
    const hasWake = rawWake !== undefined
    const hasWakeToken = rawWakeToken !== undefined
    const hasPushParam = rawPush !== undefined
    const hasPushToken = rawPushToken !== undefined
    const pushIntent = rawPush === true
    if (!hasWake && !hasWakeToken && !hasPushParam && !hasPushToken) return store.mutate(s => post(s, h, a, store.now), aId, agent)
    // push 只认布尔：字符串 / 数字一律挡回（不写留言），而不是猜一个真假。
    if (hasPushParam && rawPush !== true && rawPush !== false) {
      return { ok: false, error: 'bad-request', message: 'push 必须是布尔值（true = 广播推送；false / 省略 = 只落板）；本条**没有写入**。' }
    }
    if ((hasWake || hasWakeToken) && (pushIntent || hasPushToken)) {
      return { ok: false, error: 'bad-request', message: 'wake（定向唤醒）与 push（广播推送）是两条互斥的投递路径：本条**没有写入**，请只选一条。' }
    }
    // ---- 广播推送 ----
    if (hasPushToken) {
      if (typeof rawPushToken !== 'string' || !rawPushToken.trim()) {
        return { ok: false, error: 'bad-request', message: 'pushToken 必须是非空字符串（首次返回的 confirmToken 原样回传）；本条**没有写入**。' }
      }
      return confirmPush(rawPushToken.trim(), h, a, aId, agent)
    }
    if (pushIntent) return broadcastPush(a, h, aId, agent)
    if (hasPushParam) return store.mutate(s => post(s, h, a, store.now), aId, agent) // push:false 且无令牌 ⇒ 纯落板
    // ---- 定向唤醒（单元 E，一字不动） ----
    // 参数校验在任何写入之前：wake 必须是目标会话 id（可带 `agent:` 前缀）。
    if (typeof rawWake !== 'string' || !rawWake.trim()) {
      return { ok: false, error: 'bad-request', message: 'wake 必须是目标会话 id（非空字符串，可带 agent: 前缀）；本条**没有写入**。' }
    }
    const target = rawWake.trim().replace(/^agent:/, '')
    if (hasWakeToken) {
      if (typeof rawWakeToken !== 'string' || !rawWakeToken.trim()) {
        return { ok: false, error: 'bad-request', message: 'wakeToken 必须是非空字符串（首次返回的 confirmToken 原样回传）；本条**没有写入**。' }
      }
      return confirmWake(target, rawWakeToken.trim(), h)
    }
    const res = await store.mutate(s => post(s, h, a, store.now), aId, agent)
    if (!res || res.ok !== true || !res.data) return res
    const report = await beginWake(target, String(res.data.msgId || ''), typeof a.body === 'string' ? a.body : '', h.name || h.holderId, h.holderId, String(res.data.channel || 'general'))
    res.data.wake = report
    res.data.delivered = report.delivered === true
    res.data.deliveryNote = typeof report.note === 'string' ? report.note : BOARD_NO_DELIVERY_HINT
    return res
  }

  /**
   * 广播第一次调用：**受众上限是写入前的门禁**（超限 ⇒ 不推送、不发令牌、**不写留言**，
   * 不做"静默推一半"）；受众为空则照常落板、只如实说明不推送。
   * 受众在 `mutate` 的回调里从当轮状态现算，和这条留言落在同一份状态上。
   */
  async function broadcastPush(a: CollabArgs, h: HolderInput & { agent?: AgentLike }, aId: string | null, agent?: AgentLike): Promise<ToolResult> {
    let cap: PushCapture | null = null
    const res = await store.mutate(s => {
      const ch = channelOf(a)
      const aud = pushAudience(s, ch, h.holderId, store.now())
      const names = new Map<string, string>()
      const hs = s && Array.isArray(s.holders) ? s.holders : []
      for (const row of hs) {
        if (row && typeof row.holderId === 'string' && row.holderId) names.set(row.holderId, typeof row.name === 'string' && row.name ? row.name : row.holderId)
      }
      cap = { channel: ch, audience: aud, names }
      if (aud.holderIds.length > PUSH_MAX) {
        return {
          ok: false, changed: false, state: s,
          data: {
            error: 'bad-request',
            message: '广播受众 ' + aud.holderIds.length + ' 人 > 上限 ' + PUSH_MAX + '（DSH_COLLAB_PUSH_MAX 可覆盖）：**未推送、未写留言、不发令牌**，不做"静默推一半"；请改用更窄的 path:<相对路径> 频道或分批广播。',
            push: {
              supported: true, mode: 'rejected', reason: 'audience-over-limit',
              audience: aud.holderIds.map(id => ({ target: id, name: names.get(id) || id })),
              audienceCount: aud.holderIds.length, maxAudience: PUSH_MAX,
              delivered: false, pushed: []
            }
          }
        }
      }
      return post(s, h, a, store.now)
    }, aId, agent)
    if (!res || res.ok !== true || !res.data || !cap) return res
    const report = await beginPush(cap, String(res.data.msgId || ''), typeof a.body === 'string' ? a.body : '', h)
    res.data.push = report
    res.data.delivered = report.delivered === true
    res.data.deliveryNote = typeof report.note === 'string' ? report.note : BOARD_NO_DELIVERY_HINT
    return res
  }

  const boardHandler = exec((a, h, aId, agent) => {
    if (a.op === 'post') return postWithDelivery(a, h, aId, agent)
    if (a.op === 'read') return store.msgs(a, aId, agent)
    return { ok: false, error: 'bad-request', message: '未知操作：' + String(a.op) }
  })

  const render = (args: CollabArgs, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  const lockTool: ToolDefinition = {
    name: 'collab_lock',
    description: '多智能体协作中央注册锁：开工前声明占用项目文件夹（目录以 / 结尾，如 src/backend/），查询他人占用，减少共同开发冲突。规范：动手改代码前先 claim；开工前和定期 list/overview；冲突时先 wait 或用 board 协商；完成即 release；长任务 heartbeat 续租；被强杀的会话会留下僵尸声明，op=reap 可回收（默认只列候选，confirm:true 才真删）。会话循环结束、空闲超过宽限期（默认 120 秒，随 collab 设置变）后你的声明会被自动释放：恢复工作前重新 claim。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['claim', 'release', 'list', 'overview', 'status', 'heartbeat', 'wait', 'reap'], description: 'claim 声明 / release 释放 / list 全部 / overview 占用全景 / status 查路径 / heartbeat 续租 / wait 等待路径释放 / reap 显式回收僵尸声明（默认 dry-run）' },
        paths: { type: 'array', items: { type: 'string' }, description: '项目相对路径；claim、status、wait 用；目录以 / 结尾表示整棵子树' },
        claimId: { type: 'string', description: 'claim id，release/heartbeat 用' },
        mode: { type: 'string', enum: ['exclusive', 'shared', 'read'], description: 'exclusive 独占（默认）：会与已在场的 exclusive 与 shared 都冲突并返回冲突清单（让你协商/等待/换路径，0.14.0 起不再静默抢占共享方）；shared 声明共用：与已在场的 shared 不冲突、被他人的 exclusive 挡住；read 只读观测，不排他也不被挡' },
        readable: { type: 'boolean', description: 'claim 用：他人是否可读这些路径，默认 true；false 表示他人读取也要先协商（写入对非持有者始终要协商）' },
        ttlSec: { type: 'number', description: '租约秒数（5-86400），默认 1800' },
        timeoutMs: { type: 'number', description: 'wait 用，最多等待毫秒，默认 30000' },
        confirm: { type: 'boolean', description: 'reap 用：默认 false = dry-run，只列候选、绝不改状态；显式 true 才真正删除僵尸声明' },
        olderThanSec: { type: 'number', description: 'reap 用：age 门槛（秒），声明创建至今必须严格大于它才算候选，默认 600' },
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
    description: '跨会话协作留言板：post 往共享状态文件留痕 / read 增量读取。用于同一仓库上互不相识的会话之间交接进度与协商。**默认不投递、不唤醒任何会话**：对方只在它自己 read 时才看得到。可选**广播推送** `push:true`：受众由频道现算（general = 本项目全部持有人，path:<相对路径> = 声明与该路径重叠的持有人；都排除你自己），逐个探活后**全部在跑就整批 steer 投递**（在跑不需要确认），**有任一 idle 就一个都不投递**、返回受众预览 + 一个绑定本次广播的一次性 `pushToken`，你**必须再调一次 op=post 并回传 `pushToken`**（确认步只推送、不再写留言）；受众为空就不推送、如实说明；受众数超过上限（默认 12，env DSH_COLLAB_PUSH_MAX）直接拒绝（不推送、不发令牌、不写留言，不做"静默推一半"）。推送给每个人的是一条**短通知**（频道 + 作者 + 正文摘要，长正文留在板上），由本插件经真实的 dsh-llm 构造、来源显式非 user（kind:dsh-collab, form:notice），不冒充用户。另有**定向唤醒** `wake`（单个目标会话 id）：与 push 互斥；目标在跑就直接 steer，idle 就返回 confirmToken 等你再确认（回传 wakeToken），探不到只落板。read 两种模式：不给 since（或 0）读**最新** limit 条（追平用）；否则从该游标**往后**读 limit 条（增量用，旧→新）——按返回的 nextCursor 继续调、直到 hasMore=false 才算读完（nextCursor 是复合游标 seq@writer；只按数字 nextSince 翻页在 seq 相撞时会把同 seq 的记录再送一遍）。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['post', 'read'], description: 'post 发消息 / read 增量读取' },
        channel: { type: 'string', description: '频道，默认 general；**精确匹配**的自由字符串（写什么就得按什么读，path: 频道与 claim 用同一套相对路径写法），未命中时返回会列出既有频道' },
        body: { type: 'string', maxLength: 8000, description: 'post 用，消息正文。上限 8000 字符（与 collab-core 的 MESSAGE_BODY_MAX_CHARS 同值）；超限由 post() 以 bad-request 挡回且**整条不写入**，不静默截断' },
        replyTo: { type: 'string', description: '回复的 msgId' },
        push: { type: 'boolean', description: 'post 用（可选）：**广播推送**意图（true = 推送；false / 省略 = 只落板）。受众由频道现算：general = 本项目全部持有人、path:<相对路径> = 声明与该路径重叠者，都排除你自己。逐个探活：全部在跑 ⇒ 直接整批 steer（不需确认、不发令牌）；有任一 idle ⇒ 一个都不投递、返回受众预览 + 一次性 pushToken（需再调一次并回传）；受众为空 ⇒ 不推送、如实说明；受众数超上限（默认 12，env DSH_COLLAB_PUSH_MAX）⇒ 拒绝且不写留言。与 wake 互斥。' },
        pushToken: { type: 'string', description: 'post 用（可选）：首次广播推送返回的 confirmToken，原样回传以**确认整批投递**。带它时**只推送、不再写留言**（留言永远只落一条），且对每个受众各 steer 恰好一次；令牌绑定本次广播的**频道 + 受众集合 + 投递方 + 到期** —— 受众变了（有人新 claim / 有人消失）、换频道、过期、乱造、他人令牌一律拒绝且不 steer；一次性（成功投递才消耗，失败可重试）。' },
        wake: { type: 'string', description: 'post 用（可选）：**定向唤醒**的目标会话 id（可带 agent: 前缀）。投递前先探活：目标在跑（非 idle）⇒ 直接 steer 投递、不需确认；目标 idle ⇒ **不投递**、返回预览 + 一次性 confirmToken，需再调一次并回传才唤醒；探不到 ⇒ 不投递、如实说明（留言只落板）。省略则只落板、不投递。与 push 互斥。' },
        wakeToken: { type: 'string', description: 'post 用（可选）：首次 idle 探活返回的 confirmToken，原样回传以**二次确认**唤醒。带它时**只唤醒、不再写留言**（留言永远只落一条）；令牌绑定同一目标 + 同一留言、一次性、有有效期。校验不过一律拒绝且不唤醒。' },
        since: { type: ['number', 'string'], description: 'read 用：省略或 0 = 读最新 limit 条（tail）；否则从该游标往后读 limit 条（forward，旧→新）。游标是复合值 (seq, writer)：字符串写法 `<seq>@<writer>`（取返回的 nextCursor），数字写法（向后兼容）解释为 `(seq, "")`。' },
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
