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
//   6) loopEndGraceSec 可配（0.9.11 起默认 120s，此前 15s）→ 计时器毫秒数与文案秒数都跟着走；
//   7) 两个群体的告知：读者（release 同一条投递面，文案说"自动释放"）+ 被释放会话本人
//      （"你已不再持锁，重新 claim 再写"）；每一条来源都显式非 user；
//   8) 审计留痕：状态文件里追加一条 channel=agent:<holderId> 的留言，`collab_board op=read` 读得到；
//   9) 无声明 → 不留痕、不投递（"没有发生释放事件"与"通道坏了"可分辨）；
//  10) 句柄结束 ⇒ 自动删除（0.13.0，推翻 0.9.6 起的 W7 取舍）：`agent/disposed` 立即释放未过期
//      声明 + 留痕（"句柄已结束"）+ 通知读者；含真路径「先 idle 武装、再 dispose」不重复留痕；
//  10b) 判据不可用（`agents.get` 抛错 / `agents` 服务缺失）⇒ **放弃本次释放**，不是当成"会话不存在"；
//  11) 卸载后不再释放（effect disposer 关闸）；
//  12) 装机时已经 idle 的会话补一次武装（插件热重载 / 晚装载不至于漏掉那一轮）；
//  13) 源码级：auto-release 绝不调用 followup/steer/sessionController（不唤醒、不冒充用户）。
//  14) 第四道闸门的**有界延期**（0.12.0）：后代卡在 running 时最多延期 10 轮，到顶照常释放；
//      会话恢复 running 后预算清零；后代退场 / 判据抛错 / 没有 list 都按"没人在跑"释放。
//
// 运行：node tests/collab-auto-release.mjs

import path from 'node:path'
import os from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
import { createHarness } from './_harness.mjs'
import { loadCosmokit } from './_harness.mjs'

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
 * 把一份普通配置包装成 Loader 交给插件的形态：`.volatile()` 字段是**稳定引用**
 * （`{ get() }`），改值 = 更新引用内容 + 发 `loader/volatile-update`，
 * 与 `cordis-plugin-loader` 的 `_commitVolatile` 同形，插件**不重载**。
 */
const { updateVolatile } = await loadCosmokit()

function pluginConfig(values) {
  // 普通值交给 ctx.plugin：cordis 自己按 Config schema 校验并生成 volatile 引用。
  return values
}

/** 按 Loader 的 volatile 通道改一个字段：更新引用内容 + 把路径发给插件。 */
function volatileWrite(fiber, ctx, patch) {
  const paths = []
  for (const key of Object.keys(patch)) {
    updateVolatile(fiber.config[key], { get: () => patch[key] })
    paths.push([key])
  }
  ctx.emit('loader/volatile-update', paths)
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
 * @param opts.settings  用户设置（缺省 = releaseOnLoopEnd:true / loopEndGraceSec:120，与 spec.ts 的默认值一致）
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
  const addAgent = (id, status, parentSession) => {
    const agent = {
      id,
      status,
      session: { header: parentSession ? { cwd: CWD, parentSession } : { cwd: CWD }, id },
      inject: (message) => { deliveries.push({ sessionId: id, message }) }
    }
    registry.set(id, agent)
    return agent
  }
  for (const [id, status] of Object.entries(opts.agents || {})) addAgent(id, status)

  const ctx = new Context()
  const withAgents = opts.withAgents !== false
  const services = ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'systemPrompt']
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

  // 0.1.7 起偏好是本插件的 Config：`.volatile()` 字段是稳定引用，由 Loader 就地更新。
  const fiber = await ctx.plugin(collabPlugin, pluginConfig(Object.assign(
    { exposeDelegationDiscipline: true, enforceWriteLock: true, releaseOnLoopEnd: true, loopEndGraceSec: 120 },
    opts.settings || {}
  )))
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
    set: (patch) => { volatileWrite(fiber, ctx, patch) },
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
  return !!s && s.kind === 'dsh-collab' && s.form === 'notice' &&
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
  ok(hh.timers[0] && hh.timers[0].ms === 120000, '默认宽限期是 120 秒（120000ms，0.9.11 从 15 调长）', String(hh.timers[0] && hh.timers[0].ms))
  ok(hh.readState().claims.length === 2, '宽限期内**还没**释放', JSON.stringify(hh.readState().claims.map((c) => c.claimId)))

  await hh.flush()
  const st = hh.readState()
  ok(!st.claims.some((c) => c.claimId === 'c_44'), '宽限到点后 c_44 被自动释放', JSON.stringify(st.claims.map((c) => c.claimId)))
  ok(st.claims.some((c) => c.claimId === 'c_b'), '别人（agent:B）的声明不受影响', JSON.stringify(st.claims.map((c) => c.claimId)))
  ok(st.messages.length === 1, '状态文件里留了一条审计留言', JSON.stringify(st.messages.length))
  const m = st.messages[0]
  ok(m && m.channel === 'agent:A', '留痕频道寻址到持有者本人（agent:<sessionId>，不重复拼前缀）', String(m && m.channel))
  ok(m && m.author === 'system:dsh-collab', '留痕作者是 system:dsh-collab（不是任何会话）', String(m && m.author))
  ok(m && !('mentions' in m), '留痕不再带 mentions（0.13.0 移除：本板没有投递面）', JSON.stringify(m && m.mentions))
  ok(m && String(m.body).includes('自动释放') && String(m.body).includes('120 秒'), '留痕正文写明触发条件与宽限期', String(m && m.body))

  // 两个群体：读者 agent:B + 被释放的 agent:A。
  const toB = hh.deliveries.find((d) => d.sessionId === 'B')
  const toA = hh.deliveries.find((d) => d.sessionId === 'A')
  ok(!!toB, '读者（agent:B）收到"锁已自动释放"的告知', JSON.stringify(hh.deliveries.map((d) => d.sessionId)))
  ok(!!toA, '被释放的会话本人（agent:A）也收到告知（它恢复时才知道自己已不再持锁）', JSON.stringify(hh.deliveries.map((d) => d.sessionId)))
  ok(hh.deliveries.every((d) => noticeShapeOk(d.message)), '投出去的每一条消息来源都显式非 user（dsh-collab/notice + 非空 summary）',
    JSON.stringify(hh.deliveries.map((d) => d.message && d.message.source)))
  ok(!textOf(toB && toB.message).includes('已释放 c_44') && textOf(toB && toB.message).includes('自动释放'),
    '读者文案说的是"自动释放"，不是"X 主动释放"', textOf(toB && toB.message))
  ok(!textOf(toB && toB.message).includes('120 秒') === false, '读者文案带上宽限期秒数', textOf(toB && toB.message))
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
// 8. 句柄结束 ⇒ 自动删除（0.13.0，用户决策；推翻 0.9.6 起的 W7 取舍）
// ════════════════════════════════════════════════════════════════════════
console.log('# 句柄结束 ⇒ 自动删除（agent/disposed 释放未过期声明 + 留痕 + 通知读者）')
{
  const hh = await makeHarness({
    claims: [mkClaim({ claimId: 'c_1', readers: ['agent:B'] }), mkClaim({ claimId: 'c_b', holderId: 'agent:B' })]
  })
  hh.addAgent('A', 'idle')
  hh.addAgent('B', 'running')
  hh.ctx.emit('agent/disposed', { agent: { id: 'A' } })
  await settle(); await settle()
  const st = hh.readState()
  ok(!st.claims.some((c) => c.claimId === 'c_1'), 'dispose 后**未过期**声明被立即释放（句柄结束 = 自动删除）',
    JSON.stringify(st.claims.map((c) => c.claimId)))
  ok(st.claims.some((c) => c.claimId === 'c_b'), '别人的声明不受影响', JSON.stringify(st.claims.map((c) => c.claimId)))
  const m = st.messages.find((x) => x.channel === 'agent:A')
  ok(!!m && String(m.body).includes('句柄已结束') && String(m.body).includes('agent/disposed'),
    '留痕说的是实话：句柄结束（不是"空闲超过 N 秒"）', String(m && m.body))
  ok(hh.deliveries.some((d) => d.sessionId === 'B' && /已释放/.test(JSON.stringify(d.message))),
    '读者（agent:B）收到"锁已释放"的通知', JSON.stringify(hh.deliveries.map((d) => d.sessionId)))
  await hh.fiber.dispose()

  // 已武装（先 idle）再退场：dispose 路径自己就放了，计时器到点无事可做（幂等，不重复留痕）。
  const armed = await makeHarness({ claims: [mkClaim({ claimId: 'c_1' })] })
  armed.addAgent('A', 'running')
  armed.emitStatus('A', 'idle')
  await settle()
  ok(armed.timers.length === 1, '前置：idle 已武装宽限计时器', String(armed.timers.length))
  armed.dispose('A')
  await settle(); await settle()
  ok(armed.readState().claims.length === 0, '已武装后 dispose：声明也已被释放（两条路径都指向"句柄没了"）',
    JSON.stringify(armed.readState().claims.map((c) => c.claimId)))
  const before = armed.readState().messages.length
  await armed.flush()
  ok(armed.readState().messages.length === before, '计时器到点不再重复留痕（没有发生第二次释放事件）',
    JSON.stringify([before, armed.readState().messages.length]))
  await armed.fiber.dispose()
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

// ════════════════════════════════════════════════════════════════════════
// 12. 第四道闸门（0.9.11）：有自家子代理在 running → 不释放
// ════════════════════════════════════════════════════════════════════════
console.log('# 第四道闸门：有子代理在 running 时不释放，跑完再放')
{
  const hh = await makeHarness({
    claims: [mkClaim({ claimId: 'c_p', holderId: 'agent:P', paths: ['src/deploy/'] })]
  })
  hh.addAgent('P', 'running')
  hh.addAgent('C', 'running', 'P') // 子代理：session.header.parentSession = 'P'
  hh.emitStatus('P', 'idle')
  await settle()
  ok(hh.timers.length === 1, 'idle 武装了宽限计时器', JSON.stringify(hh.timers.map((t) => t.ms)))
  await hh.flush()
  ok(hh.readState().claims.length === 1, '子代理在 running ⇒ 父会话声明**不**被释放',
    JSON.stringify(hh.readState().claims.map((c) => c.claimId)))
  ok(hh.timers.length === 1, '重新武装了一轮（下一轮回来看，而不是放着不管）', String(hh.timers.length))
  ok(hh.readState().messages.length === 0, '没发生释放 ⇒ 不留痕', String(hh.readState().messages.length))

  // 子代理跑完 → 再一轮到点就该正常释放。
  hh.emitStatus('C', 'idle')
  await hh.flush()
  ok(hh.readState().claims.length === 0, '子代理停下后再到点：正常释放',
    JSON.stringify(hh.readState().claims.map((c) => c.claimId)))

  // 负向对照：没有血缘的第三方在跑，不该拦住我。
  const solo = await makeHarness({
    claims: [mkClaim({ claimId: 'c_p2', holderId: 'agent:P2', paths: ['src/deploy/'] })]
  })
  solo.addAgent('P2', 'running')
  solo.addAgent('X', 'running') // 无 parentSession：不是我的子代理
  solo.emitStatus('P2', 'idle')
  await settle()
  await solo.flush()
  ok(solo.readState().claims.length === 0, '无血缘的第三方在 running 不拦我（判据只看自己的后代）',
    JSON.stringify(solo.readState().claims.map((c) => c.claimId)))
  await hh.fiber.dispose(); await solo.fiber.dispose()
}

// ════════════════════════════════════════════════════════════════════════
// 13. 降噪（0.9.11）：窗口内重复释放只注入一条，审计留言一条不少
// ════════════════════════════════════════════════════════════════════════
console.log('# 降噪：同一 holder 反复释放，注入通知合并，审计留言不合并')
{
  const hh = await makeHarness({
    claims: [mkClaim({ claimId: 'c_n1', holderId: 'agent:N', paths: ['src/deploy/'] })]
  })
  hh.addAgent('N', 'running')
  const agentN = hh.registry.get('N')
  hh.emitStatus('N', 'idle')
  await settle()
  await hh.flush()
  const first = hh.deliveries.filter((d) => d.sessionId === 'N').length
  ok(first === 1, '第一次释放：本人的注入通知投出去了', String(first))

  // 重新 claim → 再次 idle → 再次释放（同一 holder，落在合并窗口内）
  await hh.callTool('collab_lock', { op: 'claim', paths: ['src/deploy/'] }, agentN)
  ok(hh.readState().claims.length === 1, '前置：重新 claim 成功', JSON.stringify(hh.readState().claims.length))
  hh.emitStatus('N', 'idle')
  await settle()
  await hh.flush()
  const second = hh.deliveries.filter((d) => d.sessionId === 'N').length
  ok(second === 1, '窗口内第二次释放：注入被合并（仍然只有 1 条）', String(second))
  ok(hh.readState().claims.length === 0, '声明照旧被释放（降噪只动通知，不动锁语义）',
    JSON.stringify(hh.readState().claims.length))
  ok(hh.readState().messages.length === 2, '审计留言**一条都没合并**（取证账目完整）',
    JSON.stringify(hh.readState().messages.length))
  await hh.fiber.dispose()
}

// ════════════════════════════════════════════════════════════════════════
// 14. 第四道闸门的有界延期（0.12.0）：后代卡在 running 不再无限扣住父锁
// ════════════════════════════════════════════════════════════════════════
console.log('# 有界延期：最多 10 轮，到顶照常释放')
{
  const hh = await makeHarness({
    claims: [mkClaim({ claimId: 'c_stuck', holderId: 'agent:P', paths: ['src/deploy/'] })]
  })
  hh.addAgent('P', 'running')
  hh.addAgent('C', 'running', 'P') // 子代理状态永远停在 running（回合 error / 空收尾后没落地）
  hh.emitStatus('P', 'idle')
  await settle()
  ok(hh.timers.length === 1, 'idle 武装了第一轮', String(hh.timers.length))

  // 前 10 轮：每轮都被"后代在 running"挡回、重新武装，声明仍在。
  let deferred = 0
  for (let round = 1; round <= 10; round++) {
    await hh.flush()
    if (hh.readState().claims.length === 1 && hh.timers.length === 1) deferred++
  }
  ok(deferred === 10, '前 10 轮都被挡回并重新武装（计数：' + deferred + '/10）', JSON.stringify(hh.timers.map((t) => t.ms)))
  ok(hh.readState().claims.length === 1, '10 轮之内父锁仍在（延期不是立刻放弃）', JSON.stringify(hh.readState().claims.length))

  // 第 11 轮：刷新（预算已到顶）→ 照常释放。
  await hh.flush()
  ok(hh.readState().claims.length === 0, '延期到顶：后代仍显示 running，父锁照常释放',
    JSON.stringify(hh.readState().claims.map((c) => c.claimId)))
  ok(hh.timers.length === 0, '释放后不再武装', String(hh.timers.length))
  await hh.fiber.dispose()
}

console.log('# 有界延期：会话恢复 running 后预算清零（下一次延期从头算）')
{
  const hh = await makeHarness({
    claims: [mkClaim({ claimId: 'c_reset', holderId: 'agent:P2', paths: ['src/deploy/'] })]
  })
  hh.addAgent('P2', 'running')
  hh.addAgent('C2', 'running', 'P2')
  hh.emitStatus('P2', 'idle')
  await settle()
  for (let round = 1; round <= 10; round++) await hh.flush()
  ok(hh.readState().claims.length === 1, '前置：恰好 10 轮延期后仍未释放', JSON.stringify(hh.readState().claims.length))

  // 会话回来干了一轮活 → running 事件把武装与**延期预算**一起清零。
  const stale = hh.timers.length // 上一轮延期留下的计时器仍在数组里（代次已作废）
  hh.emitStatus('P2', 'running')
  hh.emitStatus('P2', 'idle')
  await settle()
  ok(hh.timers.length === stale + 1, '重新武装（旧代次的计时器留在数组里，但是新的这一轮在生效）',
    stale + ' -> ' + hh.timers.length)
  await hh.flush()
  ok(hh.readState().claims.length === 1, '预算清零：新一轮延期从头算，不立刻释放',
    JSON.stringify(hh.readState().claims.map((c) => c.claimId)))
  await hh.fiber.dispose()
}

console.log('# 边界：后代从注册表消失 / 判据抛错 / 没有 list —— 都按"没人在跑"释放')
{
  // (a) 后代被 dispose（从 agents.list 里消失）
  const a = await makeHarness({
    claims: [mkClaim({ claimId: 'c_gone', holderId: 'agent:P3', paths: ['src/deploy/'] })]
  })
  a.addAgent('P3', 'running')
  a.addAgent('C3', 'running', 'P3')
  a.emitStatus('P3', 'idle')
  await settle()
  await a.flush()
  ok(a.readState().claims.length === 1, '(a) 前置：后代在 running 时被挡回', JSON.stringify(a.readState().claims.length))
  a.dispose('C3') // 真退场：先从注册表摘掉，再发 agent/disposed
  ok(a.timers.length === 1, '(a) 前置：新武装已排上', String(a.timers.length))
  await a.flush()
  ok(a.readState().claims.length === 0, '(a) 后代退场后父锁正常释放', JSON.stringify(a.readState().claims.map((c) => c.claimId)))
  await a.fiber.dispose()

  // (b) 某个后代的 get() 抛错（注册表抖动）⇒ 按"没人在跑"处理，照常释放
  const b = await makeHarness({
    claims: [mkClaim({ claimId: 'c_throw', holderId: 'agent:P4', paths: ['src/deploy/'] })]
  })
  b.addAgent('P4', 'running')
  b.addAgent('C4', 'running', 'P4')
  b.ctx.set('agents', {
    currentInitiator: () => undefined,
    list: () => [...b.registry.values()],
    get: (id) => {
      if (id === 'C4') throw new Error('registry jitter')
      return b.registry.get(id)
    }
  })
  b.emitStatus('P4', 'idle')
  await settle()
  await b.flush()
  ok(b.readState().claims.length === 0, '(b) 后代判据抛错 ⇒ 当成没人在跑，照常释放',
    JSON.stringify(b.readState().claims.map((c) => c.claimId)))
  await b.fiber.dispose()

  // (c) agents 服务没有 list（拿不到后代名单）⇒ 同上
  const c = await makeHarness({
    claims: [mkClaim({ claimId: 'c_nolist', holderId: 'agent:P5', paths: ['src/deploy/'] })]
  })
  c.addAgent('P5', 'running')
  c.addAgent('C5', 'running', 'P5')
  c.ctx.set('agents', {
    currentInitiator: () => undefined,
    get: (id) => c.registry.get(id)
  })
  c.emitStatus('P5', 'idle')
  await settle()
  await c.flush()
  ok(c.readState().claims.length === 0, '(c) agents.list 缺失 ⇒ 拿不到后代，照常释放',
    JSON.stringify(c.readState().claims.map((x) => x.claimId)))
  await c.fiber.dispose()
}

h.finish()
