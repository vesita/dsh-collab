// tests/collab-auto-release.mjs
// 循环终止自动释放（0.9.10）：`agent/status` → `idle` 后等宽限期，期间恢复 `running` 就取消；
// 到点仍空闲（或已卸载）才把该会话的**未过期**声明自动释放，并告知两个群体。
//
// 它解决的一手场景（README「循环终止自动释放」）：
//   父会话 claim 了目录 → 派出子代理 → **自己的循环停了**（idle，agent 仍在注册表里）。
//   子代理要写同一批路径，被功能 C 的硬拒绝；它到留言板 @ 父会话要求释放，而父会话的循环
//   已经停了：`agent.inject` 的契约是 `send(message, "next-step", wakeup=false)`，
//   **不唤醒 driver**（`dsh-agent/lib/types/runtime-types.d.ts:202-209`），留言永远读不到。
//   于是只能干等租约到期（默认 1800 秒）。本功能补上这条回收路径。
//
// 覆盖（每条都是"行为 + 取值"双断言，不只是"没抛"）：
//   1) idle + 宽限到点 → 未过期声明被释放；别人的声明、已过期声明不受影响；
//   2) 宽限期内恢复 running → 撤销，什么都不动；
//   3) 到点复核：fire 时 agent.status 已是 running（没有新事件）→ 仍然不释放；
//   4) 设置 releaseOnLoopEnd=false → **不武装**（连计时器都不建）；
//   5) 活的设置变更：武装之后、到点之前关掉开关 → 到点也不释放；
//   6) loopEndGraceSec 可配（默认 15s）→ 计时器毫秒数与文案秒数都跟着走；
//   7) 两个群体的告知：读者（release 同一条投递面，文案说"自动释放"）+ 被释放会话本人
//      （"你已不再持锁，重新 claim 再写"）；每一条来源都显式非 user；
//   8) 审计留痕：状态文件里追加一条 channel=agent:<holderId> 的留言，`collab_board op=read` 读得到；
//   9) 无声明 → 不留痕、不投递（"没有发生释放事件"与"通道坏了"可分辨）；
//  10) W7 回归：`agent/disposed` **仍然不释放**未过期声明 —— 含真路径「先 idle 武装、再 dispose」，
//      到点必须**不**释放（退场会话收不到告知，恢复后必然会以为自己还持锁）；
//  10b) 判据不可用（`agents.get` 抛错 / `agents` 服务缺失）⇒ **放弃本次释放**，不是当成"会话不存在"；
//  11) 卸载后不再释放（effect disposer 关闸）；
//  12) 装机时已经 idle 的会话补一次武装（插件热重载 / 晚装载不至于漏掉那一轮）；
//  13) 源码级：auto-release 绝不调用 followup/steer/sessionController（不唤醒、不冒充用户）。
//
// 运行：node tests/collab-auto-release.mjs

import path from 'node:path'
import os from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { createHarness } from './_harness.mjs'

const cordis = await import('@deepseek-ai/cordis').catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
const { Context } = cordis

const ROOT = path.dirname(new URL(import.meta.url).pathname)
process.env.DSH_HOME = path.join(os.tmpdir(), 'collab-auto-release-' + process.pid)
delete process.env.DSH_COLLAB_NO_PROMPT_HINT

const { projectStateFile } = await import(path.join(ROOT, '../lib/paths.js'))
const mod = await import(path.join(ROOT, '../lib/index.js'))
const collabPlugin = mod.default

const h = createHarness()
const { ok } = h

const CWD = '/fake/project/auto-release'
const settle = () => new Promise((r) => setTimeout(r, 25))

function makeFs(store, versions) {
  return {
    resolve: async (p) => ({ displayPath: p, path: p }),
    stat: async (t) => (store.has(t.path) ? { version: versions.get(t.path) || 1 } : null),
    readText: async (t) => store.get(t.path) || '',
    writeText: async (t, c, o) => {
      if (o && o.kind === 'replaceIfVersion') {
        const cur = store.has(t.path) ? (versions.get(t.path) || 1) : null
        if (cur === null || cur !== o.version) {
          const e = new Error('cannot write "' + t.path + '": file changed since it was read')
          e.code = 'FS_STALE_VERSION'
          throw e
        }
      }
      store.set(t.path, c)
      versions.set(t.path, (versions.get(t.path) || 0) + 1)
    },
    processPath: (t) => t.path
  }
}

/**
 * 造一个装着本插件的真实 Cordis Context，外加三样测试专用的观测面：
 *   - `timers`：**手动计时器**。`timeout(ms)` 只登记 {ms, resolve}，由 flush() 统一触发 ——
 *     测试因此不必真的等 15 秒，也不会因为机器慢而假红；
 *   - `agents.peek(id)`：直接改 agent 对象的 status（模拟"没有新事件、但状态已经变了"）；
 *   - `deliveries`：每一条经 `agent.inject` 投出去的消息（来源形状与正文都从这里断言）。
 *
 * @param opts.claims    预置状态文件里的 claims（会自动补 readers/messages/holders 空字段）
 * @param opts.agents    装机时就在注册表里的 agent（id -> status），用来测"已 idle 时补武装"
 * @param opts.settings  用户设置（缺省 = releaseOnLoopEnd:true / loopEndGraceSec:15）
 */
async function makeHarness(opts = {}) {
  const store = new Map()
  const versions = new Map()
  const timers = []
  const deliveries = []
  const tools = []
  const statePath = projectStateFile(CWD)
  store.set(statePath, JSON.stringify({
    schemaVersion: 1, seq: opts.seq || 0, claims: opts.claims || [], messages: [], holders: []
  }))
  versions.set(statePath, 1)

  // 注册表：id -> 假 agent（带真实契约里存在的 status / inject / session 三面）。
  const registry = new Map()
  const addAgent = (id, status) => {
    const agent = {
      id,
      status,
      session: { header: { cwd: CWD }, id },
      inject: (message) => { deliveries.push({ sessionId: id, message }) }
    }
    registry.set(id, agent)
    return agent
  }
  for (const [id, status] of Object.entries(opts.agents || {})) addAgent(id, status)

  let hooks = null
  let value = Object.assign({ exposeDelegationDiscipline: true, enforceWriteLock: true, releaseOnLoopEnd: true, loopEndGraceSec: 15 }, opts.settings || {})

  const ctx = new Context()
  const withAgents = opts.withAgents !== false
  const services = ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'systemPrompt', 'settings']
  if (withAgents) services.push('agents')
  for (const n of services) ctx.provide(n)
  ctx.set('tools', { register: (t) => { tools.push(t); return () => {} } })
  ctx.set('timer', {
    timeout: (ms) => new Promise((resolve) => { timers.push({ ms, resolve }) }),
    interval: () => () => {}
  })
  ctx.set('fs', makeFs(store, versions))
  ctx.set('sessions', { get: (id) => ({ header: { cwd: CWD }, id }) })
  ctx.set('sessionTitle', { get: (s) => ({ title: 'Worker ' + (s && s.id ? s.id : '?') }) })
  if (withAgents) {
    ctx.set('agents', {
      currentInitiator: () => opts.initiator ? registry.get(opts.initiator) : undefined,
      list: () => [...registry.values()],
      get: (id) => {
        // 判据本身坏掉（注册表抖动）——自动释放必须因此**放弃**，而不是当成"会话不存在"。
        if (opts.agentsGetThrows) throw new Error('agents registry exploded')
        return registry.get(id)
      }
    })
  }
  ctx.set('systemPrompt', { context: () => () => {} })
  ctx.set('settings', {
    installSection: (_owner, _ns, _schema, _entry, hk) => { hooks = hk; hk.setSource(() => value); hk.onChange() }
  })

  const fiber = await ctx.plugin(collabPlugin)
  await settle()

  /** 触发一次 agent/status（载荷形状照 dsh-agent-loop/lib/index.js:781 的 emit("agent/status", { status })）。 */
  const emitStatus = (id, status) => {
    const agent = registry.get(id)
    if (agent) agent.status = status
    ctx.emit('agent/status', { agent: agent, status })
  }
  /** 真实退场：先从注册表摘掉，再发 agent/disposed（dsh-agent 的 emitDisposed 就是这个次序）。 */
  const dispose = (id) => {
    registry.delete(id)
    ctx.emit('agent/disposed', { agent: { id } })
  }
  /** 把已登记的计时器全部触发，并等到异步链路（mutate / inject）跑完。 */
  const flush = async () => {
    const due = timers.splice(0, timers.length)
    for (const t of due) t.resolve()
    await settle(); await settle()
    return due
  }

  return {
    ctx, tools, timers, deliveries, store, versions, statePath, registry, fiber,
    addAgent, emitStatus, dispose, flush,
    readState: () => JSON.parse(store.get(statePath) || '{}'),
    peek: (id) => { const a = registry.get(id); return a ? a.status : undefined },
    set: (patch) => { value = Object.assign({}, value, patch); if (hooks) hooks.onChange() },
    callTool: (name, args, agent) => {
      const t = tools.find((x) => x.name === name)
      if (!t) throw new Error('tool not registered: ' + name)
      return t.execute(args, { agent: agent || undefined })
    }
  }
}

const NOW = Date.now()
const LIVE_MS = 3600 * 1000
const mkClaim = (o) => Object.assign({
  claimId: 'c_1', holderId: 'agent:A', holderName: 'Worker A', paths: ['src/deploy/shared/'],
  mode: 'exclusive', ttlSec: 1800, expiresAt: NOW + LIVE_MS, note: '', createdAt: NOW - 1000, readable: true, readers: []
}, o)

const noticeShapeOk = (msg) => {
  const s = msg && msg.source
  return !!s && s.kind === 'plugin' && s.plugin === 'dsh-collab' && s.form === 'notice' &&
    typeof s.summary === 'string' && s.summary.length > 0 && s.summary.length <= 120
}
const textOf = (msg) => {
  const parts = msg && Array.isArray(msg.content) ? msg.content : []
  return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('')
}

// ════════════════════════════════════════════════════════════════════════
// 1. 核心路径：idle + 宽限到点 → 释放 + 两个群体都收到告知 + 留痕
// ════════════════════════════════════════════════════════════════════════
console.log('# 核心路径：idle → 宽限 15s 到点 → 自动释放')
{
  const hh = await makeHarness({
    claims: [
      mkClaim({ claimId: 'c_44', holderId: 'agent:A', paths: ['src/deploy/shared/', 'src/deploy/installer/'], readers: ['agent:B'] }),
      mkClaim({ claimId: 'c_b', holderId: 'agent:B', holderName: 'Worker B', paths: ['src/other/'] })
    ]
  })
  hh.addAgent('A', 'running')
  hh.addAgent('B', 'running')
  ok(hh.readState().claims.length === 2, '前置：状态文件里两条声明', JSON.stringify(hh.readState().claims.map((c) => c.claimId)))

  hh.emitStatus('A', 'idle')
  await settle()
  ok(hh.timers.length === 1, 'idle 武装了一个宽限期计时器', JSON.stringify(hh.timers.map((t) => t.ms)))
  ok(hh.timers[0] && hh.timers[0].ms === 15000, '默认宽限期是 15 秒（15000ms）', String(hh.timers[0] && hh.timers[0].ms))
  ok(hh.readState().claims.length === 2, '宽限期内**还没**释放', JSON.stringify(hh.readState().claims.map((c) => c.claimId)))

  await hh.flush()
  const st = hh.readState()
  ok(!st.claims.some((c) => c.claimId === 'c_44'), '宽限到点后 c_44 被自动释放', JSON.stringify(st.claims.map((c) => c.claimId)))
  ok(st.claims.some((c) => c.claimId === 'c_b'), '别人（agent:B）的声明不受影响', JSON.stringify(st.claims.map((c) => c.claimId)))
  ok(st.messages.length === 1, '状态文件里留了一条审计留言', JSON.stringify(st.messages.length))
  const m = st.messages[0]
  ok(m && m.channel === 'agent:A', '留痕频道寻址到持有者本人（agent:<sessionId>，不重复拼前缀）', String(m && m.channel))
  ok(m && m.author === 'system:dsh-collab', '留痕作者是 system:dsh-collab（不是任何会话）', String(m && m.author))
  ok(m && Array.isArray(m.mentions) && m.mentions[0] === 'agent:A', '留痕 mention 持有者', JSON.stringify(m && m.mentions))
  ok(m && String(m.body).includes('自动释放') && String(m.body).includes('15 秒'), '留痕正文写明触发条件与宽限期', String(m && m.body))

  // 两个群体：读者 agent:B + 被释放的 agent:A。
  const toB = hh.deliveries.find((d) => d.sessionId === 'B')
  const toA = hh.deliveries.find((d) => d.sessionId === 'A')
  ok(!!toB, '读者（agent:B）收到"锁已自动释放"的告知', JSON.stringify(hh.deliveries.map((d) => d.sessionId)))
  ok(!!toA, '被释放的会话本人（agent:A）也收到告知（它恢复时才知道自己已不再持锁）', JSON.stringify(hh.deliveries.map((d) => d.sessionId)))
  ok(hh.deliveries.every((d) => noticeShapeOk(d.message)), '投出去的每一条消息来源都显式非 user（plugin/notice + 非空 summary）',
    JSON.stringify(hh.deliveries.map((d) => d.message && d.message.source)))
  ok(!textOf(toB && toB.message).includes('已释放 c_44') && textOf(toB && toB.message).includes('自动释放'),
    '读者文案说的是"自动释放"，不是"X 主动释放"', textOf(toB && toB.message))
  ok(!textOf(toB && toB.message).includes('15 秒') === false, '读者文案带上宽限期秒数', textOf(toB && toB.message))
  ok(textOf(toA && toA.message).includes('自动释放') && textOf(toA && toA.message).includes('重新执行 collab_lock op=claim'),
    '本人文案说明"已自动释放"并给出恢复动作（重新 claim）', textOf(toA && toA.message))
  ok(textOf(toA && toA.message).includes('你此前持有'), '本人文案是第二人称（收件人不同，措辞也不同）', textOf(toA && toA.message))

  // 端到端：留言板读得到这条留痕。
  const readBack = await hh.callTool('collab_board', { op: 'read', since: 0 }, { id: 'C', session: { header: { cwd: CWD } } })
  const got = readBack && readBack.ok === true && readBack.data && Array.isArray(readBack.data.messages) ? readBack.data.messages : []
  ok(got.some((x) => x.msgId === (m && m.msgId)), 'collab_board op=read 能读到这条审计留言', JSON.stringify(got.map((x) => x.msgId)))

  // 幂等：再触发一次不能凭空再造一条（没有声明可放）。
  const before = hh.readState().messages.length
  hh.emitStatus('A', 'idle')
  await hh.flush()
  ok(hh.readState().messages.length === before, '没有声明时不再留痕（避免空转刷留言板）', String(hh.readState().messages.length))
  await hh.fiber.dispose()
}

// ════════════════════════════════════════════════════════════════════════
// 2. 宽限期内恢复 running → 撤销
// ════════════════════════════════════════════════════════════════════════
console.log('# 宽限期内恢复 running → 撤销（锁保住）')
{
  const hh = await makeHarness({ claims: [mkClaim({ claimId: 'c_1' })] })
  hh.addAgent('A', 'running')
  hh.emitStatus('A', 'idle')
  await settle()
  ok(hh.timers.length === 1, 'idle 已武装', String(hh.timers.length))
  hh.emitStatus('A', 'running')          // 宽限期内会话回来了
  await hh.flush()
  const st = hh.readState()
  ok(st.claims.length === 1, '恢复 running 后声明**没有**被释放', JSON.stringify(st.claims.map((c) => c.claimId)))
  ok(st.messages.length === 0, '没有留痕（没发生释放事件）', JSON.stringify(st.messages.length))
  ok(hh.deliveries.length === 0, '没有投递任何通知', JSON.stringify(hh.deliveries.map((d) => d.sessionId)))
  await hh.fiber.dispose()
}

// ════════════════════════════════════════════════════════════════════════
// 3. 到点复核：fire 时已是 running（没有新事件）→ 仍然不释放
// ════════════════════════════════════════════════════════════════════════
console.log('# 到点复核 agent.status：没有新事件也拦得住')
{
  const hh = await makeHarness({ claims: [mkClaim({ claimId: 'c_1' })] })
  const a = hh.addAgent('A', 'running')
  hh.emitStatus('A', 'idle')
  await settle()
  a.status = 'running'                   // 模拟"状态已经变了，但 status 事件没到/被吞了"
  await hh.flush()
  ok(hh.readState().claims.length === 1, 'fire 时复核到 running → 撤销，声明仍在', JSON.stringify(hh.readState().claims.map((c) => c.claimId)))
  await hh.fiber.dispose()
}

// ════════════════════════════════════════════════════════════════════════
// 4/5. 设置：关掉不武装；武装后关掉也拦得住（活读，不是快照）
// ════════════════════════════════════════════════════════════════════════
console.log('# 设置 releaseOnLoopEnd：关掉不武装 / 武装后关掉也拦住')
{
  const off = await makeHarness({ claims: [mkClaim({ claimId: 'c_1' })], settings: { releaseOnLoopEnd: false } })
  off.addAgent('A', 'running')
  off.emitStatus('A', 'idle')
  await settle()
  ok(off.timers.length === 0, '开关关掉时连计时器都不建（不是"建了再放行"）', String(off.timers.length))
  await off.flush()
  ok(off.readState().claims.length === 1, '开关关掉时声明不动', JSON.stringify(off.readState().claims.map((c) => c.claimId)))
  await off.fiber.dispose()

  const live = await makeHarness({ claims: [mkClaim({ claimId: 'c_1' })] })
  live.addAgent('A', 'running')
  live.emitStatus('A', 'idle')
  await settle()
  ok(live.timers.length === 1, '前置：默认开着，已武装', String(live.timers.length))
  live.set({ releaseOnLoopEnd: false })  // 到点之前把它关掉
  await live.flush()
  ok(live.readState().claims.length === 1, '武装之后关掉开关：到点也不释放（活读，不是快照）', JSON.stringify(live.readState().claims.map((c) => c.claimId)))
  await live.fiber.dispose()
}

// ════════════════════════════════════════════════════════════════════════
// 6. loopEndGraceSec 可配：计时器毫秒数与文案秒数都跟着走
// ════════════════════════════════════════════════════════════════════════
console.log('# loopEndGraceSec 可配：计时器与文案都跟着走')
{
  const hh = await makeHarness({ claims: [mkClaim({ claimId: 'c_1', readers: ['agent:B'] })], settings: { loopEndGraceSec: 42 } })
  hh.addAgent('A', 'running')
  hh.addAgent('B', 'running')
  hh.emitStatus('A', 'idle')
  await settle()
  ok(hh.timers.length === 1 && hh.timers[0].ms === 42000, '计时器用设置里的 42 秒', String(hh.timers[0] && hh.timers[0].ms))
  await hh.flush()
  const toB = hh.deliveries.find((d) => d.sessionId === 'B')
  ok(hh.readState().claims.length === 0, '到点仍然释放', JSON.stringify(hh.readState().claims.length))
  ok(textOf(toB && toB.message).includes('42 秒'), '通知文案里的秒数与真实宽限期一致（不写死 15）', textOf(toB && toB.message))
  await hh.fiber.dispose()
}

// ════════════════════════════════════════════════════════════════════════
// 7. 无声明 / 已过期声明：不留痕、不投递
// ════════════════════════════════════════════════════════════════════════
console.log('# 无声明 / 只过期声明：不留痕、不投递')
{
  const none = await makeHarness({ claims: [] })
  none.addAgent('A', 'running')
  none.emitStatus('A', 'idle')
  await none.flush()
  ok(none.readState().messages.length === 0 && none.deliveries.length === 0,
    '没有任何声明 → 不留痕、不投递（没有发生释放事件）', JSON.stringify([none.readState().messages.length, none.deliveries.length]))
  await none.fiber.dispose()

  // 已过期声明：既不是"僵尸"（reap 的活）、也不是"循环终止"（本功能的活）—— 它归 sweep。
  // 注意 sweep 只在**真的写盘**的那次 mutate 里落盘；这里的自动释放没有可释放的声明，
  // 所以状态文件里那条过期记录会留到下一次真实写入。视图（list/status）里它**不算占用**。
  const exp = await makeHarness({ claims: [mkClaim({ claimId: 'c_old', expiresAt: NOW - 1000, readers: ['agent:B'] })] })
  exp.addAgent('A', 'running')
  exp.addAgent('B', 'running')
  exp.emitStatus('A', 'idle')
  await exp.flush()
  ok(exp.readState().messages.length === 0, '过期声明不产生留痕', JSON.stringify(exp.readState().messages.length))
  ok(exp.deliveries.length === 0, '过期声明不触发"自动释放"通知（没发生释放事件）', JSON.stringify(exp.deliveries.map((d) => d.sessionId)))
  const stView = await exp.callTool('collab_lock', { op: 'status', paths: ['src/deploy/shared/'] }, { id: 'A', session: { header: { cwd: CWD } } })
  ok(stView && stView.ok === true && stView.data.related.length === 0, '过期声明在视图里不算占用（expire 在内存里生效）',
    JSON.stringify(stView && stView.data && stView.data.related))
  await exp.fiber.dispose()
}

// ════════════════════════════════════════════════════════════════════════
// 8. W7 回归：agent/disposed 不释放未过期声明（含"已武装后 dispose"这条真路径）
// ════════════════════════════════════════════════════════════════════════
console.log('# W7 回归：agent/disposed 不释放未过期声明（含 idle 已武装后 dispose）')
{
  const hh = await makeHarness({ claims: [mkClaim({ claimId: 'c_1' })] })
  hh.addAgent('A', 'idle')
  hh.ctx.emit('agent/disposed', { agent: { id: 'A' } })
  await settle(); await settle()
  ok(hh.readState().claims.length === 1, 'dispose 之后未过期声明仍然在（租约是唯一回收机制，没被本功能改掉）',
    JSON.stringify(hh.readState().claims.map((c) => c.claimId)))
  await hh.fiber.dispose()

  // 真路径：会话先翻到 idle（武装了宽限计时器），随后退场（agent/disposed）。
  // 到点解析不到它 ⇒ **不许**释放：退场的会话常常恢复并继续干活，而它此刻收不到任何告知
  // （agent.inject 对未加载的会话结构上不可达）。这条路径是 W7 的原话，自动释放不得穿透它。
  const armed = await makeHarness({ claims: [mkClaim({ claimId: 'c_1' })] })
  armed.addAgent('A', 'running')
  armed.emitStatus('A', 'idle')
  await settle()
  ok(armed.timers.length === 1, '前置：idle 已武装宽限计时器', String(armed.timers.length))
  armed.dispose('A')
  await armed.flush()
  ok(armed.readState().claims.length === 1, '已武装后 dispose：到点**不释放**（W7 不被计时器穿透）',
    JSON.stringify(armed.readState().claims.map((c) => c.claimId)))
  ok(armed.readState().messages.length === 0 && armed.deliveries.length === 0,
    '这条路径也不留痕、不投递（没有发生释放事件）',
    JSON.stringify([armed.readState().messages.length, armed.deliveries.length]))
  await armed.fiber.dispose()
}

// ════════════════════════════════════════════════════════════════════════
// 8b. 判据不可用 ⇒ 一个也不放（agents.get 抛错 / agents 服务缺失）
// ════════════════════════════════════════════════════════════════════════
console.log('# 判据不可用（get 抛错 / 服务缺失）⇒ 放弃本次释放')
{
  const boom = await makeHarness({ claims: [mkClaim({ claimId: 'c_1' })], agentsGetThrows: true })
  boom.addAgent('A', 'running')
  boom.emitStatus('A', 'idle')
  await boom.flush()
  ok(boom.readState().claims.length === 1, 'agents.get 抛错时**不**放锁（判据坏了 ≠ 会话不存在）',
    JSON.stringify(boom.readState().claims.map((c) => c.claimId)))
  ok(boom.deliveries.length === 0, '判据坏掉时不投递任何通知', JSON.stringify(boom.deliveries.length))
  await boom.fiber.dispose()

  const noSvc = await makeHarness({ claims: [mkClaim({ claimId: 'c_1' })], withAgents: false })
  noSvc.addAgent('A', 'running')
  noSvc.emitStatus('A', 'idle')
  await settle()
  ok(noSvc.timers.length === 1, '前置：没有 agents 服务时仍然武装（服务可能晚到）', String(noSvc.timers.length))
  await noSvc.flush()
  ok(noSvc.readState().claims.length === 1, 'agents 服务缺失时**不**放锁（没有判据就没有释放）',
    JSON.stringify(noSvc.readState().claims.map((c) => c.claimId)))
  await noSvc.fiber.dispose()
}

// ════════════════════════════════════════════════════════════════════════
// 9. 卸载后不再释放
// ════════════════════════════════════════════════════════════════════════
console.log('# 卸载后不再释放（effect disposer 关闸）')
{
  const hh = await makeHarness({ claims: [mkClaim({ claimId: 'c_1' })] })
  hh.addAgent('A', 'running')
  hh.emitStatus('A', 'idle')
  await settle()
  await hh.fiber.dispose()
  await hh.flush()
  ok(hh.readState().claims.length === 1, '插件卸载后到点的计时器不再改状态', JSON.stringify(hh.readState().claims.map((c) => c.claimId)))
}

// ════════════════════════════════════════════════════════════════════════
// 10. 装机时已经 idle 的会话补一次武装（热重载 / 晚装载）
// ════════════════════════════════════════════════════════════════════════
console.log('# 装机时已 idle：补一次武装')
{
  const hh = await makeHarness({
    claims: [mkClaim({ claimId: 'c_1' })],
    agents: { A: 'idle', B: 'running' }
  })
  await settle()
  ok(hh.timers.length === 1, '只对已 idle 的那个 agent 武装（running 的不动）', JSON.stringify(hh.timers.map((t) => t.ms)))
  await hh.flush()
  ok(hh.readState().claims.length === 0, '补武装的那轮同样会释放', JSON.stringify(hh.readState().claims.length))
  await hh.fiber.dispose()
}

// ════════════════════════════════════════════════════════════════════════
// 11. 源码级：绝不唤醒 / 绝不冒充用户
// ════════════════════════════════════════════════════════════════════════
console.log('# 源码级：auto-release 不唤醒会话、不自造消息')
{
  const srcPath = path.join(ROOT, '../src/auto-release.ts')
  if (!existsSync(srcPath)) {
    ok(false, 'src/auto-release.ts 存在', srcPath)
  } else {
    const src = readFileSync(srcPath, 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    ok(!/followup\s*\(/.test(code), '不调用 agent.followup（那会**唤醒** idle 会话）', 'followup')
    ok(!/steer\s*\(/.test(code), '不调用 agent.steer（同样会唤醒）', 'steer')
    ok(!/sessionController/.test(code), '不碰 sessionController.prompt（收 content、来源被宿主写成 kind:user）', 'sessionController')
    ok(!/createUserMessage|createMessage\s*\(|boundContextSummary/.test(code),
      '不自造消息（通知一律经 push.ts —— 那里用真实的 @deepseek-ai/dsh-llm 构造）', 'message-construction')
    ok(/agent\/status/.test(code), '接线在 agent/status 上', 'agent/status')
    ok(/inject/.test(readFileSync(path.join(ROOT, '../src/push.ts'), 'utf8')), 'push.ts 仍是投递面（本功能经它发通知）')
  }
}

h.finish()
