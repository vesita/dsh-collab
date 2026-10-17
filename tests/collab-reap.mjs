// tests/collab-reap.mjs
//
// 守护什么（改用活体 oracle 之后，op=reap 显式回收确证死亡的声明）
//   1) 默认 dry-run：候选齐备，且**状态文件逐字节不变**（不是"看起来没变"）；
//   2) confirm:true 只删 oracle 说 not-live 的声明，活着的 holder 一条都不动（正例/负例成对）；
//   3) **确证死亡不看 age**：刚创建 1 秒的声明只要持有者 not-live 就是候选；活得再久
//      只要持有者 live 就绝不入选（这一节就是"删掉 age 门槛"的验收）；
//   4) 自己的声明即便 not-live 也不回收（提示用 release）；
//   5) 已过期声明不由 reap 处理（那是 sweep 的活）；
//   6) paths 限定：只回收相交的；
//   7) 活体判据不可用（没有 agents 服务）⇒ 一个也不收（fail-closed）。
//
// 为什么（不要重新论证）
//   判据只有一条 —— 会话 oracle（`agents.get` 有 ⇒ live）。运行时注册表无法区分
//   "休眠可唤回"与"真死"，所以 reap **只能**由显式 op 驱动：默认 dry-run，`confirm:true`
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

/** 一条仍未到期、刚创建 1 秒的声明（默认形态）。 */
const claimRec = (over) => Object.assign({
  claimId: 'c_1', holderId: 'agent:DEAD', holderName: 'Dead Worker', paths: ['src/'],
  mode: 'exclusive', createdAt: NOW - 1000,
  note: '', readable: true
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
 * @param opts.claims    预置声明
 * @param opts.live      () => string[] —— 每次调用现取"活着"的 sessionId（= agents.get 命中）
 * @param opts.withOracle false = 完全不给 agents 服务（判据不可用 ⇒ 一个也不收）
 */
async function boot (opts = {}) {
  const store = new Map()
  const versions = new Map()
  const tools = []
  const live = opts.live || (() => [])
  const liveNow = () => { try { return live() } catch (e) { return [] } }
  const agentFor = (id) => ({ id, inject: () => {} })
  if (opts.claims) {
    store.set(statePath, JSON.stringify({ schemaVersion: 1, seq: opts.claims.length, claims: opts.claims, messages: [], holders: [] }))
    versions.set(statePath, 1)
  }
  const ctx = new Context()
  const services = ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'systemPrompt']
  if (opts.withOracle !== false) services.push('agents')
  for (const n of services) ctx.provide(n)
  ctx.set('tools', { register: (t) => { tools.push(t); return () => {} } })
  ctx.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} })
  ctx.set('fs', makeFs(store, versions))
  ctx.set('sessions', { get: () => ({ header: { cwd: CWD } }) })
  ctx.set('sessionTitle', { get: () => ({ title: 'Other Session' }) })
  ctx.set('systemPrompt', { context: () => () => {} })
  if (opts.withOracle !== false) {
    ctx.set('agents', {
      currentInitiator: () => undefined,
      // 现行判据：get 命中 ⇒ live；未命中 ⇒ not-live（确证死亡）。
      get: (id) => (liveNow().includes(id) ? agentFor(id) : undefined)
    })
  }
  await ctx.plugin(collabPlugin)
  await new Promise((r) => setTimeout(r, 20))
  const lock = tools.find((t) => t.name === 'collab_lock')
  // 0.2.9：sweep 会自动回收确证死亡的声明。所以**预置的死声明必须先绕过 sweep 才能被测到**：
  // 插件装载后（此时已完成它自己的首次 sweep）再把 opts.claims 原样写回盘上。
  // 这样每条用例测的仍是 reap 本身，而不是"sweep 有没有把数据先吃掉"。
  if (opts.claims) {
    const doc = { schemaVersion: 1, seq: opts.claims.length, claims: opts.claims, messages: [], holders: [] }
    store.set(statePath, JSON.stringify(doc))
    versions.set(statePath, (versions.get(statePath) || 0) + 1)
  }
  return {
    lock,
    stateRaw: () => store.get(statePath) || '',
    readState: () => JSON.parse(store.get(statePath) || '{}'),
    claims: () => (JSON.parse(store.get(statePath) || '{}').claims || []),
    // 0.2.9 起 sweep 会自动回收确证死亡的声明，所以"把一个死声明摆到 reap 面前"这件事
    // 在正常流程里已经不可能发生了 —— 要测 reap 本身，就得**绕过 sweep** 把它塞回盘上，
    // 这正是它真实存在的场景：另一个副本把一条已终结的声明并回来（删除在 join 下不单调，
    // 墓碑挡住它，但如果墓碑被 GC 或副本更旧，reap 是最后一道显式回收）。
    reinject: (rec) => {
      const doc = JSON.parse(store.get(statePath) || '{}')
      doc.claims = (doc.claims || []).filter((c) => c.claimId !== rec.claimId)
      doc.claims.push(rec)
      if (doc.released && rec.claimId in doc.released) delete doc.released[rec.claimId]
      store.set(statePath, JSON.stringify(doc))
      versions.set(statePath, (versions.get(statePath) || 0) + 1)
    }
  }
}

const call = (b, args, agentId = 'W12') => b.lock.execute(args, { agent: { id: agentId, session: { header: { cwd: CWD } } } })

// ════════════════════════════════════════════════════════════════════════
// 1. dry-run：候选齐备 + 状态零变化
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 1. dry-run（缺 confirm / confirm:false）')

{
  const b = await boot({
    // oracle：W12（调用者，也持有声明）+ LIVE 活着。DEAD 未命中 ⇒ not-live。
    live: () => ['W12', 'LIVE'],
    claims: [
      claimRec({ claimId: 'c_dead', holderId: 'agent:DEAD', paths: ['src/dead/'] }),
      claimRec({ claimId: 'c_live', holderId: 'agent:LIVE', paths: ['src/live/'] }),
      claimRec({ claimId: 'c_mine', holderId: 'agent:W12', paths: ['src/mine/'] })
    ]
  })
  const before = b.stateRaw()
  const res = await call(b, { op: 'reap' })

  ok(res.ok === true, '1.1 dry-run 返回 ok:true', JSON.stringify(res))
  const d = res.data || {}
  ok(d.dryRun === true, '1.2 明确标注 dryRun:true', JSON.stringify(d.dryRun))
  ok(d.livenessCheck === 'ok', '1.3 判据可用（livenessCheck=ok）', JSON.stringify(d.livenessCheck))
  ok(Array.isArray(d.candidates) && d.candidates.length === 1, '1.4 只有 1 条候选（活着的与自己的都不列）', JSON.stringify(d.candidates))
  ok(!('reaped' in d), '1.5 dry-run 不出现 reaped 字段（形状不混）', JSON.stringify(Object.keys(d)))
  ok(!('olderThanSec' in d) && !('ageSec' in d) && !('remainingSec' in d), '1.6 age 一族字段已从返回里删除', JSON.stringify(Object.keys(d)))
  const c = (d.candidates || [])[0] || {}
  ok(c.claimId === 'c_dead' && c.holderId === 'agent:DEAD' && Array.isArray(c.paths) && c.paths[0] === 'src/dead/',
    '1.7 候选条目带 claimId / holderId / paths', JSON.stringify(c))
  ok(Array.isArray(c.reasons) && c.reasons.includes('holder-not-live') &&
    c.reasons.includes('agent-holder') && c.reasons.includes('not-self') && !c.reasons.includes('age-over-threshold'),
    '1.8 reasons 可复述判据，且不含任何 age 理由', JSON.stringify(c.reasons))
  ok(b.stateRaw() === before, '1.9 dry-run 后状态文件**逐字节不变**', 'before===' + JSON.stringify(before.slice(0, 40)))

  const res2 = await call(b, { op: 'reap', confirm: false })
  ok(res2.ok === true && res2.data.dryRun === true, '1.10 显式 confirm:false 仍是 dry-run', JSON.stringify(res2.data && res2.data.dryRun))
  ok(b.stateRaw() === before, '1.11 confirm:false 后状态文件仍逐字节不变')
}

// ════════════════════════════════════════════════════════════════════════
// 2. confirm:true：只删 not-live 的，活着的/自己的/过期的都不动（正负成对）
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
    '2.2 正例：确证死亡的声明被回收（reaped 只含它）', JSON.stringify(d.reaped))
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
// 3. 确证死亡**不看 age**（这一节就是"删掉 age 门槛"的验收）
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 3. 确证死亡不看 age')

{
  const young = claimRec({ claimId: 'c_young', holderId: 'agent:DEAD', paths: ['src/young/'], createdAt: NOW - 1000 })
  const b = await boot({ live: () => ['W12', 'LIVE'], claims: [young] })
  const dry = await call(b, { op: 'reap' })
  ok(dry.data.candidates.length === 1 && dry.data.candidates[0].claimId === 'c_young',
    '3.1 刚创建 1 秒但持有者 not-live ⇒ 立即是候选（age 完全不参与）', JSON.stringify(dry.data.candidates))
  const conf = await call(b, { op: 'reap', confirm: true })
  ok(conf.data.reaped.length === 1 && b.claims().length === 0, '3.2 confirm 立即回收它（无需等任何门槛）', JSON.stringify(conf.data.reaped))

  // 负向对照：活得再久，只要 oracle 说 live 就绝不入选
  const ancientLive = claimRec({ claimId: 'c_ancient_live', holderId: 'agent:LIVE', paths: ['src/old/'], createdAt: NOW - 30 * 24 * 3600 * 1000 })
  const b2 = await boot({ live: () => ['W12', 'LIVE'], claims: [ancientLive] })
  const dry2 = await call(b2, { op: 'reap' })
  ok(dry2.data.candidates.length === 0,
    '3.3 活了 30 天的 live holder 绝不入选（age 大不是死亡证据）', JSON.stringify(dry2.data.candidates))
}

// ════════════════════════════════════════════════════════════════════════
// 4. 自己的声明不回收（即便 oracle 说自己 not-live）
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 4. 自己的声明不回收')

{
  const b = await boot({ live: () => [], claims: [claimRec({ claimId: 'c_mine', holderId: 'agent:W12', paths: ['src/mine/'] })] })
  const dry = await call(b, { op: 'reap' })
  ok(dry.data.candidates.length === 0, '4.1 自己的声明不列为候选（即便 oracle 说自己 not-live）', JSON.stringify(dry.data.candidates))
  const conf = await call(b, { op: 'reap', confirm: true })
  ok(conf.data.reaped.length === 0 && JSON.stringify(b.claims().map((c) => c.claimId)) === JSON.stringify(['c_mine']),
    '4.2 confirm 也不回收自己的声明（提示用 op=release）', JSON.stringify(conf.data.reaped))
}

// ════════════════════════════════════════════════════════════════════════
// 5. 声明没有过期一说：只要持有者 not-live 就一律是候选
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 5. 声明没有过期时间（回收只看 oracle）')

{
  const b = await boot({ live: () => ['W12'], claims: [claimRec({ claimId: 'c_dead', holderId: 'agent:DEAD', paths: ['src/e/'] })] })
  const dry = await call(b, { op: 'reap' })
  ok(dry.data.candidates.length === 1 && dry.data.candidates[0].claimId === 'c_dead',
    '5.1 无论创建多久，持有者 not-live 就是候选', JSON.stringify(dry.data.candidates))
  const conf = await call(b, { op: 'reap', confirm: true })
  ok(conf.data.reaped.length === 1, '5.2 confirm 回收它', JSON.stringify(conf.data.reaped))
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
// 7. 判据不可用：一个也不收
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 7. 判据不可用（没有 agents 服务）⇒ 一个也不收')

{
  const b = await boot({ withOracle: false, claims: [claimRec({ claimId: 'c_dead', holderId: 'agent:DEAD', paths: ['src/dead/'] })] })
  const dry = await call(b, { op: 'reap' })
  ok(dry.ok === true && dry.data.livenessCheck === 'unavailable', '7.1 如实标注 livenessCheck=unavailable', JSON.stringify(dry.data && dry.data.livenessCheck))
  ok(dry.data.candidates.length === 0, '7.2 拿不到判据 ⇒ dry-run 候选为空', JSON.stringify(dry.data.candidates))
  const conf = await call(b, { op: 'reap', confirm: true })
  ok(conf.data.reaped.length === 0 && JSON.stringify(b.claims().map((c) => c.claimId)) === JSON.stringify(['c_dead']),
    '7.3 confirm 也一个都不收（fail-safe 方向是"不改状态"）', JSON.stringify(conf.data.reaped))
}

// ════════════════════════════════════════════════════════════════════════
// 8. 静态断言：reap 只由工具 handler 显式调用 —— 没有任何自动路径
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 8. 静态：reap 只由工具 handler 调用（无自动触发路径）')

{
  const rel = (p) => readFileSync(join(ROOT, p), 'utf8')
  // 8.1 真正"碰到 reap"（调用或定义，带括号）的文件必须是有限的几个：
  //     纯逻辑定义（collab-ops.ts）+ 状态层接线 + 包形态适配 + 工具 handler + 宿主外壳。
  const srcFiles = ['collab-core.ts', 'collab-ops.ts', 'state-core.ts', 'store.ts', 'tools.ts', 'host-shell.js', 'contract.ts', 'index.ts', 'push.ts', 'gate.ts', 'access.ts', 'awareness.ts', 'spec.ts', 'paths.ts', 'delegation.ts', 'client.ts']
  const withReap = srcFiles.filter((f) => /\breap[a-zA-Z]*\s*\(/.test(rel('src/' + f)))
  ok(JSON.stringify(withReap) === JSON.stringify(['collab-ops.ts', 'state-core.ts', 'store.ts', 'tools.ts', 'host-shell.js']),
    '8.1 调用/定义 reap 的 src 文件恰好是纯逻辑(ops)/状态层/包适配/工具/宿主外壳五份', JSON.stringify(withReap))
  // 8.2 sweep() 的函数体里没有 reap（它只能回收过期声明，不得碰死亡判定）。
  const coreSrc = rel('src/collab-core.ts')
  const sweepBody = coreSrc.slice(coreSrc.indexOf('export function sweep('), coreSrc.indexOf('// holder 存活视图'))
  ok(sweepBody.length > 0 && !/\breap\s*\(/.test(sweepBody), '8.2 sweep() 不调用 reap（读/写前的惰性清理不碰死亡判定）')
  // 8.3 宿主形态同理：只有 handler 里那一处**转发**（store.reapOp），没有定时器/读路径调用。
  const hostSrc = rel('src/host-shell.js')
  const reapCalls = [...hostSrc.matchAll(/store\.reapOp\(a, h, aId, agent\)/g)].length
  ok(reapCalls === 1, '8.3 宿主里 op=reap 的转发点恰好 1 处（工具 handler 那一句）', String(reapCalls))
  ok(!/\breap\s*\(/.test(hostSrc), '8.3b 宿主不直接调核心 reap（接线只在状态层里发生一次）')
  const stateCoreSrc = rel('src/state-core.ts')
  const stateReapCalls = [...stateCoreSrc.matchAll(/core\.reap\(/g)].length
  ok(stateReapCalls === 1, '8.3c 状态层里 reap 的接线点恰好 1 处（op=reap 专用）', String(stateReapCalls))
  const timerBody = hostSrc.slice(hostSrc.indexOf('ctx.timer.interval'), hostSrc.indexOf('ctx.on(\'agent/disposed\''))
  ok(timerBody.length > 0 && !/reap/i.test(timerBody), '8.4 宿主的定时器（态势刷新）不含 reap')
}

// ════════════════════════════════════════════════════════════════════════
// 9. 验收原文：op=reap 两次调用的真实返回 JSON（供人工复核，不手写）
// ════════════════════════════════════════════════════════════════════════
console.log('\n# 9. 真实返回 JSON（dry-run / confirm）')
{
  const b = await boot({
    live: () => ['W12', 'LIVE'],
    claims: [
      claimRec({ claimId: 'c_dead', holderId: 'agent:DEAD', paths: ['src/dead/'] }),
      claimRec({ claimId: 'c_live', holderId: 'agent:LIVE', paths: ['src/live/'] })
    ]
  })
  const dry = await call(b, { op: 'reap' })
  console.log('  RAW dry-run: ' + JSON.stringify(dry))
  const conf = await call(b, { op: 'reap', confirm: true })
  console.log('  RAW confirm: ' + JSON.stringify(conf))
  ok(dry.data.dryRun === true && dry.data.candidates.length === 1, '9.1 原文：dry-run 列 1 条候选', JSON.stringify(dry.data.candidates.length))
  ok(conf.data.dryRun === false && conf.data.reaped.length === 1, '9.2 原文：confirm 回收 1 条', JSON.stringify(conf.data.reaped.length))
}

h.finish()
