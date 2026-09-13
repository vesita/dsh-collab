// tests/collab-reap.mjs
//
// 守护什么（0.9.8，op=reap 僵尸声明显式回收）
//   1) 默认 dry-run：候选齐备，且**状态文件逐字节不变**（不是"看起来没变"）；
//   2) confirm:true 只删命中判据的声明，活着的 holder 一条都不动（正例/负例成对）；
//   3) age 门槛：未到 olderThanSec 的不动；显式传更小值时可回收；
//   4) 自己的声明即便满足其它条件也不回收（提示用 release）；
//   5) 已过期声明不由 reap 处理（那是 sweep 的活）；
//   6) paths 限定：只回收相交的；
//   7) 回收后读者收到通知，来源形状仍是 plugin/notice（复用 notifyReaders 管道）；
//   8) 活体检查不可用（agents.list 缺失）⇒ 一个也不收（拿不到名单时"不在名单"没有信息量）。
//
// 为什么（不要重新论证）
//   `agents.get()/list()` 对**休眠但可唤回**的会话返回 undefined/缺席 —— 这正是 0.8.2 按
//   liveness 清 readers 静默丢通知、W7 禁止 dispose 提前释放声明的来源。运行时注册表无法
//   区分"休眠可唤回"与"真死"，所以 reap **只能**由显式 op 驱动：默认 dry-run，`confirm:true`
//   才动手。本文件同时用静态断言钉死"没有任何自动路径会调用 reap"。
//
// 运行：node tests/collab-reap.mjs   退出码非 0 即失败

import { createHarness } from './_harness.mjs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

// 隔离：把状态目录指到临时 DSH_HOME，避免测试污染真实 ~/.dsh。
// paths.ts 在**调用时**读取 process.env，所以在 import 之后设置依然生效。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-collab-reap-' + process.pid)

const cordis = await import('@deepseek-ai/cordis').catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
const { Context } = cordis
const collabPlugin = (await import('../lib/index.js')).default
const { projectStateFile } = await import('../lib/paths.js')

const h = createHarness()
const { ok } = h
const CWD = '/test/reap-workspace'
const statePath = projectStateFile(CWD)
const NOW = Date.now()

/** 一条"1000 秒前创建、仍未到期"的声明（默认僵尸形态）。 */
const claimRec = (over) => Object.assign({
  claimId: 'c_1', holderId: 'agent:DEAD', holderName: 'Dead Worker', paths: ['src/'],
  mode: 'exclusive', ttlSec: 1800, expiresAt: NOW + 600 * 1000, createdAt: NOW - 1000 * 1000,
  note: '', readable: true, readers: []
}, over)

function makeFs (store, versions) {
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
 * 起一个隔离的包形态实例。
 * @param opts.claims       预置声明
 * @param opts.live         () => string[] —— 每次调用现取"活着"的 sessionId 列表（便于中途改）
 * @param opts.withList     false = agents 服务没有 list（活体检查不可用）
 * @param opts.readersLive  哪些 sessionId 能被 agents.get 解析成带 inject 的假 agent（默认 = live）
 */
async function boot (opts = {}) {
  const store = new Map()
  const versions = new Map()
  const tools = []
  const injects = []
  const live = opts.live || (() => [])
  const liveNow = () => { try { return live() } catch (e) { return [] } }
  const agentFor = (id) => ({ id, inject: (message) => injects.push({ sessionId: id, message }) })
  if (opts.claims) {
    store.set(statePath, JSON.stringify({ schemaVersion: 1, seq: opts.claims.length, claims: opts.claims, messages: [], holders: [] }))
    versions.set(statePath, 1)
  }
  const ctx = new Context()
  for (const n of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'systemPrompt', 'agents']) ctx.provide(n)
  ctx.set('tools', { register: (t) => { tools.push(t); return () => {} } })
  ctx.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} })
  ctx.set('fs', makeFs(store, versions))
  ctx.set('sessions', { get: () => ({ header: { cwd: CWD } }) })
  ctx.set('sessionTitle', {
    get: (s) => ({ title: s && s.id === 'W12' ? 'W12 Reaper' : (s && s.id === 'READER' ? 'Reader Session' : 'Other Session') })
  })
  ctx.set('systemPrompt', { context: () => () => {} })
  const agentsSvc = {
    currentInitiator: () => undefined,
    get: (id) => (liveNow().includes(id) ? agentFor(id) : undefined)
  }
  if (opts.withList !== false) agentsSvc.list = () => liveNow().map((id) => ({ id }))
  ctx.set('agents', agentsSvc)
  await ctx.plugin(collabPlugin)
  await new Promise((r) => setTimeout(r, 20))
  const lock = tools.find((t) => t.name === 'collab_lock')
  return {
    lock,
    injects,
    stateRaw: () => store.get(statePath) || '',
    readState: () => JSON.parse(store.get(statePath) || '{}'),
    claims: () => (JSON.parse(store.get(statePath) || '{}').claims || [])
  }
}

const call = (b, args, agentId = 'W12') => b.lock.execute(args, { agent: { id: agentId, session: { header: { cwd: CWD } } } })

// ════════════════════════════════════════════════════════════════════════
// 1. dry-run：候选齐备 + 状态零变化
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 1. dry-run（缺 confirm / confirm:false）')

{
  const b = await boot({
    // 活体名单：W12（调用者，也持有声明）+ LIVE（另有活会话）。DEAD 不在名单里。
    live: () => ['W12', 'LIVE'],
    claims: [
      claimRec({ claimId: 'c_dead', holderId: 'agent:DEAD', paths: ['src/dead/'], readers: ['agent:READER'] }),
      claimRec({ claimId: 'c_live', holderId: 'agent:LIVE', paths: ['src/live/'] }),
      claimRec({ claimId: 'c_mine', holderId: 'agent:W12', paths: ['src/mine/'] })
    ]
  })
  const before = b.stateRaw()
  const res = await call(b, { op: 'reap' })

  ok(res.ok === true, '1.1 dry-run 返回 ok:true', JSON.stringify(res))
  const d = res.data || {}
  ok(d.dryRun === true, '1.2 明确标注 dryRun:true', JSON.stringify(d.dryRun))
  ok(d.livenessCheck === 'ok', '1.3 活体检查跑成了（livenessCheck=ok）', JSON.stringify(d.livenessCheck))
  ok(d.olderThanSec === 600, '1.4 默认 age 门槛 600 秒', JSON.stringify(d.olderThanSec))
  ok(Array.isArray(d.candidates) && d.candidates.length === 1, '1.5 只有 1 条候选（活着的与自己的都不列）', JSON.stringify(d.candidates))
  ok(!('reaped' in d), '1.6 dry-run 不出现 reaped 字段（形状不混）', JSON.stringify(Object.keys(d)))
  const c = (d.candidates || [])[0] || {}
  ok(c.claimId === 'c_dead' && c.holderId === 'agent:DEAD' && Array.isArray(c.paths) && c.paths[0] === 'src/dead/',
    '1.7 候选条目带 claimId / holderId / paths', JSON.stringify(c))
  ok(typeof c.ageSec === 'number' && c.ageSec >= 1000, '1.8 候选条目带 ageSec（实测 ≥1000）', JSON.stringify(c.ageSec))
  ok(typeof c.remainingSec === 'number' && c.remainingSec > 0 && c.remainingSec <= 600,
    '1.9 候选条目带剩余租约 remainingSec（未过期）', JSON.stringify(c.remainingSec))
  ok(Array.isArray(c.reasons) && c.reasons.includes('unexpired') && c.reasons.includes('agent-holder') &&
    c.reasons.includes('not-self') && c.reasons.includes('holder-not-in-agents-list') && c.reasons.includes('age-over-threshold'),
    '1.10 每条判据都在 reasons 里可解释', JSON.stringify(c.reasons))
  ok(b.stateRaw() === before, '1.11 dry-run 后状态文件**逐字节不变**', 'before===' + JSON.stringify(before.slice(0, 40)))

  const res2 = await call(b, { op: 'reap', confirm: false })
  ok(res2.ok === true && res2.data.dryRun === true, '1.12 显式 confirm:false 仍是 dry-run', JSON.stringify(res2.data && res2.data.dryRun))
  ok(b.stateRaw() === before, '1.13 confirm:false 后状态文件仍逐字节不变')
}

// ════════════════════════════════════════════════════════════════════════
// 2. confirm:true：只删命中判据的，活着的/自己的/过期的都不动（正负成对）
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 2. confirm:true（正例/负例成对）')

{
  const b = await boot({
    live: () => ['W12', 'LIVE'],
    claims: [
      claimRec({ claimId: 'c_dead', holderId: 'agent:DEAD', paths: ['src/dead/'] }),
      claimRec({ claimId: 'c_live', holderId: 'agent:LIVE', paths: ['src/live/'] }),
      claimRec({ claimId: 'c_mine', holderId: 'agent:W12', paths: ['src/mine/'] })
    ]
  })
  const before = b.stateRaw()
  const res = await call(b, { op: 'reap', confirm: true })
  const d = res.data || {}
  ok(res.ok === true && d.dryRun === false, '2.1 confirm:true 返回 dryRun:false', JSON.stringify(d.dryRun))
  ok(Array.isArray(d.reaped) && d.reaped.length === 1 && d.reaped[0].claimId === 'c_dead',
    '2.2 正例：僵尸声明被回收（reaped 只含它）', JSON.stringify(d.reaped))
  ok(!('candidates' in d), '2.3 confirm 不出现 candidates 字段（形状不混）', JSON.stringify(Object.keys(d)))
  const ids = b.claims().map((c) => c.claimId).sort()
  ok(JSON.stringify(ids) === JSON.stringify(['c_live', 'c_mine']),
    '2.4 负例：活着的 holder 与自己的声明**一条都没动**', JSON.stringify(ids))
  ok(b.stateRaw() !== before, '2.5 confirm:true 确实写盘（与 dry-run 成对）')

  // 重复一次 confirm：没有候选时也不该误伤
  const again = await call(b, { op: 'reap', confirm: true })
  ok(again.ok === true && Array.isArray(again.data.reaped) && again.data.reaped.length === 0,
    '2.6 已无可回收项时 reaped 为空、不误伤', JSON.stringify(again.data && again.data.reaped))
  ok(JSON.stringify(b.claims().map((c) => c.claimId).sort()) === JSON.stringify(['c_live', 'c_mine']),
    '2.7 第二次 confirm 后剩余声明仍原样')
}

// ════════════════════════════════════════════════════════════════════════
// 3. age 门槛
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 3. age 门槛（默认 600s；可显式放宽）')

{
  const young = claimRec({ claimId: 'c_young', holderId: 'agent:DEAD', paths: ['src/young/'], createdAt: NOW - 100 * 1000 })
  const b = await boot({ live: () => ['W12'], claims: [young] })
  const before = b.stateRaw()
  const dry = await call(b, { op: 'reap' })
  ok(dry.data.candidates.length === 0, '3.1 age=100s < 600s ⇒ 默认不列为候选', JSON.stringify(dry.data.candidates))
  const conf = await call(b, { op: 'reap', confirm: true })
  ok(conf.data.reaped.length === 0 && JSON.stringify(b.claims().map((c) => c.claimId)) === JSON.stringify(['c_young']),
    '3.2 默认门槛下 confirm 不动它', JSON.stringify(conf.data.reaped))
  ok(b.stateRaw() === before, '3.3 未命中时状态不变')
  const loose = await call(b, { op: 'reap', confirm: true, olderThanSec: 10 })
  ok(loose.data.reaped.length === 1 && loose.data.reaped[0].claimId === 'c_young',
    '3.4 显式传更小 olderThanSec=10 时可回收', JSON.stringify(loose.data.reaped))
  ok(loose.data.olderThanSec === 10, '3.5 返回值回显本次生效的门槛', JSON.stringify(loose.data.olderThanSec))
  ok(b.claims().length === 0, '3.6 回收后状态里确实没有了')
}

// ════════════════════════════════════════════════════════════════════════
// 4. 自己的声明不回收（即便活体检查里也缺席 —— 只按 holderId 排除自己）
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 4. 自己的声明不回收')

{
  const b = await boot({ live: () => [], claims: [claimRec({ claimId: 'c_mine', holderId: 'agent:W12', paths: ['src/mine/'] })] })
  const dry = await call(b, { op: 'reap' })
  ok(dry.data.candidates.length === 0, '4.1 自己的声明不列为候选（即便不在活体名单里）', JSON.stringify(dry.data.candidates))
  const conf = await call(b, { op: 'reap', confirm: true })
  ok(conf.data.reaped.length === 0 && JSON.stringify(b.claims().map((c) => c.claimId)) === JSON.stringify(['c_mine']),
    '4.2 confirm 也不回收自己的声明（提示用 op=release）', JSON.stringify(conf.data.reaped))
}

// ════════════════════════════════════════════════════════════════════════
// 5. 已过期声明不由 reap 处理
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 5. 已过期声明不由 reap 处理（那是 sweep 的活）')

{
  const b = await boot({ live: () => ['W12'], claims: [claimRec({ claimId: 'c_expired', holderId: 'agent:DEAD', paths: ['src/e/'], expiresAt: NOW - 1 })] })
  const dry = await call(b, { op: 'reap' })
  ok(dry.data.candidates.length === 0, '5.1 已过期声明不进入候选', JSON.stringify(dry.data.candidates))
  const conf = await call(b, { op: 'reap', confirm: true })
  ok(conf.data.reaped.length === 0, '5.2 confirm 也不回收它（reaped 为空）', JSON.stringify(conf.data.reaped))
}

// ════════════════════════════════════════════════════════════════════════
// 6. paths 限定
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 6. paths 限定：只回收相交的')

{
  const b = await boot({
    live: () => ['W12'],
    claims: [
      claimRec({ claimId: 'c_src', holderId: 'agent:DEAD', paths: ['src/x/'] }),
      claimRec({ claimId: 'c_other', holderId: 'agent:DEAD2', paths: ['other/y/'] })
    ]
  })
  const dry = await call(b, { op: 'reap', paths: ['other/'] })
  ok(dry.data.candidates.length === 1 && dry.data.candidates[0].claimId === 'c_other',
    '6.1 paths 限定后只列相交的候选', JSON.stringify(dry.data.candidates))
  ok(dry.data.candidates[0].reasons.includes('paths-intersect'), '6.2 候选 reasons 里有 paths-intersect', JSON.stringify(dry.data.candidates[0].reasons))
  const conf = await call(b, { op: 'reap', confirm: true, paths: ['other/'] })
  ok(conf.data.reaped.length === 1 && conf.data.reaped[0].claimId === 'c_other',
    '6.3 confirm + paths 只回收相交的那条', JSON.stringify(conf.data.reaped))
  ok(JSON.stringify(b.claims().map((c) => c.claimId)) === JSON.stringify(['c_src']),
    '6.4 不相交的声明原样保留', JSON.stringify(b.claims().map((c) => c.claimId)))
}

// ════════════════════════════════════════════════════════════════════════
// 7. 回收后读者收到通知：来源形状仍是 plugin/notice
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 7. 回收后读者收到通知（复用 notifyReaders 管道）')

{
  const b = await boot({
    live: () => ['W12', 'READER'],
    claims: [claimRec({ claimId: 'c_dead', holderId: 'agent:DEAD', paths: ['src/dead/'], readers: ['agent:READER'] })]
  })
  const res = await call(b, { op: 'reap', confirm: true })
  ok(res.ok === true && res.data.reaped.length === 1, '7.1 回收成功', JSON.stringify(res.data && res.data.reaped))
  ok(b.injects.length === 1 && b.injects[0].sessionId === 'READER',
    '7.2 读者经 agent.inject 收到 1 条通知', JSON.stringify(b.injects.map((x) => x.sessionId)))
  const msg = b.injects[0] && b.injects[0].message
  const source = msg && msg.source
  ok(!!source && source.kind === 'plugin' && source.plugin === 'dsh-collab' && source.form === 'notice',
    '7.3 来源形状仍是 {kind:plugin, plugin:dsh-collab, form:notice}', JSON.stringify(source))
  ok(!!source && typeof source.summary === 'string' && source.summary.length > 0 && source.summary.length <= 120,
    '7.4 summary 非空且 ≤120 字符（否则会退化成 opaque 行）', JSON.stringify(source && source.summary))
  const text = String((msg && msg.content && msg.content[0] && msg.content[0].text) || '')
  ok(text.includes('回收'), '7.5 文案说"回收"而不是"释放"（回收者不是原持有者）', JSON.stringify(text))
  ok(res.data.notify && Array.isArray(res.data.notify.pushed) && res.data.notify.pushed.includes('READER'),
    '7.6 返回里带 notify 汇总，pushed 含 READER', JSON.stringify(res.data.notify))

  // 负例：读者不在线（没有 inject / 不在 agents 里）时，不投递也不报成"已推"
  const b2 = await boot({
    live: () => ['W12'],
    claims: [claimRec({ claimId: 'c_dead2', holderId: 'agent:DEAD', paths: ['src/dead/'], readers: ['agent:READER'] })]
  })
  const res2 = await call(b2, { op: 'reap', confirm: true })
  ok(b2.injects.length === 0, '7.7 负例：读者不 live ⇒ 不投递（绝不唤醒冷会话）', JSON.stringify(b2.injects.length))
  ok(res2.data.reaped.length === 1 && res2.data.notify && res2.data.notify.pushed.length === 0,
    '7.8 回收仍成功，notify.pushed 为空（跳过如实记账）', JSON.stringify(res2.data && res2.data.notify))
}

// ════════════════════════════════════════════════════════════════════════
// 8. 活体检查不可用：一个也不收
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 8. 活体检查不可用（agents 服务没有 list）⇒ 一个也不收')

{
  const b = await boot({ withList: false, live: () => ['W12'], claims: [claimRec({ claimId: 'c_dead', holderId: 'agent:DEAD', paths: ['src/dead/'] })] })
  const dry = await call(b, { op: 'reap' })
  ok(dry.ok === true && dry.data.livenessCheck === 'unavailable', '8.1 如实标注 livenessCheck=unavailable', JSON.stringify(dry.data && dry.data.livenessCheck))
  ok(dry.data.candidates.length === 0, '8.2 拿不到名单 ⇒ dry-run 候选为空（"不在名单"没有信息量）', JSON.stringify(dry.data.candidates))
  const conf = await call(b, { op: 'reap', confirm: true })
  ok(conf.data.reaped.length === 0 && JSON.stringify(b.claims().map((c) => c.claimId)) === JSON.stringify(['c_dead']),
    '8.3 confirm 也一个都不收（fail-safe 方向是"不改状态"）', JSON.stringify(conf.data.reaped))
}

// ════════════════════════════════════════════════════════════════════════
// 9. 静态断言：reap 只由工具 handler 显式调用 —— 没有任何自动路径
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 9. 静态：reap 只由工具 handler 调用（无自动触发路径）')

{
  const rel = (p) => readFileSync(join(ROOT, p), 'utf8')
  // 9.1 真正"碰到 reap"（调用或定义，带括号）的文件必须是有限的几个：
  //     核心定义 + 状态接线 + 工具 handler + 宿主内联副本。注释里提到 reap 的（contract/push）不算。
  const srcFiles = ['collab-core.ts', 'store.ts', 'tools.ts', 'collab-plugin.host.ts', 'contract.ts', 'index.ts', 'push.ts', 'gate.ts', 'access.ts', 'awareness.ts', 'spec.ts', 'paths.ts', 'delegation.ts', 'client.ts']
  const withReap = srcFiles.filter((f) => /\breap[a-zA-Z]*\s*\(/.test(rel('src/' + f)))
  ok(JSON.stringify(withReap) === JSON.stringify(['collab-core.ts', 'store.ts', 'tools.ts', 'collab-plugin.host.ts']),
    '9.1 调用/定义 reap 的 src 文件恰好是核心/状态/工具/宿主四份', JSON.stringify(withReap))
  // 9.2 sweep() 的函数体里没有 reap（它只能回收过期声明，不得碰未过期的僵尸判定）。
  const coreSrc = rel('src/collab-core.ts')
  const sweepBody = coreSrc.slice(coreSrc.indexOf('export function sweep('), coreSrc.indexOf('// 惰性清理过期声明'))
  ok(sweepBody.length > 0 && !/reap/i.test(sweepBody), '9.2 sweep() 函数体里不含 reap（读/写前的惰性清理不碰僵尸判定）')
  // 9.3 宿主内联形态同理：只有 handler 里那一处调用，没有定时器/读路径调用。
  const hostSrc = rel('src/collab-plugin.host.ts')
  const reapCalls = [...hostSrc.matchAll(/reap\(s, h, a, liveAgentHolderIds\(\), now\(\)\)/g)].length
  ok(reapCalls === 1, '9.3 宿主里 reap 的调用点恰好 1 处（工具 handler 内联的那一句）', String(reapCalls))
  const timerBody = hostSrc.slice(hostSrc.indexOf('ctx.timer.interval'), hostSrc.indexOf('ctx.on(\'agent/disposed\''))
  ok(timerBody.length > 0 && !/reap/i.test(timerBody), '9.4 宿主的定时器（态势刷新）不含 reap')
}

// ════════════════════════════════════════════════════════════════════════
// 10. 验收原文：op=reap 两次调用的真实返回 JSON（供人工复核，不手写）
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 10. 真实返回 JSON（dry-run / confirm）')
{
  const b = await boot({
    live: () => ['W12', 'LIVE', 'READER'],
    claims: [
      claimRec({ claimId: 'c_dead', holderId: 'agent:DEAD', paths: ['src/dead/'], readers: ['agent:READER'] }),
      claimRec({ claimId: 'c_live', holderId: 'agent:LIVE', paths: ['src/live/'] })
    ]
  })
  const dry = await call(b, { op: 'reap' })
  console.log('  RAW dry-run: ' + JSON.stringify(dry))
  const conf = await call(b, { op: 'reap', confirm: true, olderThanSec: 600 })
  console.log('  RAW confirm: ' + JSON.stringify(conf))
  ok(dry.data.dryRun === true && dry.data.candidates.length === 1, '10.1 原文：dry-run 列 1 条候选', JSON.stringify(dry.data.candidates.length))
  ok(conf.data.dryRun === false && conf.data.reaped.length === 1, '10.2 原文：confirm 回收 1 条', JSON.stringify(conf.data.reaped.length))
}

h.finish()
