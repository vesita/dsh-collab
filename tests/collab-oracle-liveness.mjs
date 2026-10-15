// tests/collab-oracle-liveness.mjs
//
// 验证两大核心改动（活体 oracle 与只读不写状态）：
// 1. claim 有效性 = livenessOf，不再靠时钟推算。
//    - dead 会话（not-live）的 claim 立刻失效、不阻塞新 claim、不阻挡写门控、且立即成为 reap 候选（不看 TTL/age）。
//    - live 会话的 claim 依然有效阻塞（负向对照）。
//    - failed（基础设施故障）fail-closed 保持现状（不误放行、不误收）。
// 2. 只读不写状态：切掉"只读触发写盘"。
//    - 在他人独占路径下做 read，notice 依然 inject，但状态文件逐字节不变（写盘次数为 0）。
//
// 运行：node tests/collab-oracle-liveness.mjs

import { readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cordis = await import('@deepseek-ai/cordis').catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
const { Context } = cordis

const ROOT = path.dirname(new URL(import.meta.url).pathname)
process.env.DSH_HOME = path.join(os.tmpdir(), 'collab-oracle-' + process.pid)

const collabPlugin = (await import('../lib/index.js')).default
const { projectStateFile } = await import('../lib/paths.js')

let passed = 0
let failed = 0
const failures = []

function ok(cond, msg, detail) {
  if (cond) {
    passed++
    console.log('  ok  ' + msg)
  } else {
    failed++
    const text = '  FAIL: ' + msg + (detail ? ' (' + detail + ')' : '')
    console.error(text)
    failures.push(text)
  }
}

const CWD = '/test/oracle-workspace'
const statePath = projectStateFile(CWD)
const NOW = Date.now()

function makeFs(store, versions, stats) {
  return {
    resolve: async (p) => ({ displayPath: p, path: p }),
    stat: async (t) => (store.has(t.path) ? { version: versions.get(t.path) || 1 } : null),
    readText: async (t) => {
      if (stats) stats.reads = (stats.reads || 0) + 1
      return store.get(t.path) || ''
    },
    writeText: async (t, c, o) => {
      if (stats) stats.writes = (stats.writes || 0) + 1
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

async function createEnv(opts = {}) {
  const store = new Map()
  const versions = new Map()
  const stats = { reads: 0, writes: 0 }
  const tools = []
  const injects = []

  if (opts.initialState) {
    store.set(statePath, JSON.stringify(opts.initialState))
    versions.set(statePath, 1)
  }

  const ctx = new Context()
  for (const n of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'systemPrompt', 'agents']) {
    ctx.provide(n)
  }

  ctx.set('tools', { register: (t) => { tools.push(t); return () => {} } })
  ctx.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} })
  ctx.set('fs', makeFs(store, versions, stats))
  ctx.set('sessions', { get: () => ({ header: { cwd: CWD } }) })
  ctx.set('sessionTitle', { get: (s) => ({ title: 'Session ' + (s && s.id) }) })
  ctx.set('systemPrompt', { context: () => () => {} })

  // 存活 mock：根据 opts.agentLiveness 字典或函数
  ctx.set('agents', {
    currentInitiator: () => undefined,
    list: () => {
      if (typeof opts.agentList === 'function') return opts.agentList()
      return Object.entries(opts.agentLiveness || {})
        .filter(([_, v]) => v === 'live')
        .map(([id]) => ({ id }))
    },
    get: (id) => {
      if (typeof opts.agentLiveness === 'function') {
        const state = opts.agentLiveness(id)
        if (state === 'failed') throw new Error('infrastructure error in agents.get')
        if (state === 'live') return { id, session: { header: { cwd: CWD } }, inject: (m) => injects.push({ id, message: m }) }
        return undefined
      }
      const st = (opts.agentLiveness || {})[id]
      if (st === 'failed') throw new Error('infrastructure error in agents.get')
      if (st === 'live') return { id, session: { header: { cwd: CWD } }, inject: (m) => injects.push({ id, message: m }) }
      return undefined
    }
  })

  await ctx.plugin(collabPlugin, {
    exposeDelegationDiscipline: true,
    enforceWriteLock: true
  })
  await new Promise((r) => setTimeout(r, 20))

  const lock = tools.find((t) => t.name === 'collab_lock')
  return {
    ctx,
    lock,
    stats,
    injects,
    stateRaw: () => store.get(statePath) || '',
    readState: () => JSON.parse(store.get(statePath) || '{}'),
    executeLock: (args, agentId = 'worker-self') => {
      const agent = { id: agentId, session: { header: { cwd: CWD } }, inject: (m) => injects.push({ id: agentId, message: m }) }
      return lock.execute(args, { name: 'collab_lock', arguments: args, agent })
    },
    pre: async (name, args, agentId = 'worker-self') => {
      const agent = { id: agentId, session: { header: { cwd: CWD } }, inject: (m) => injects.push({ id: agentId, message: m }) }
      const exec = { name, arguments: args, agent }
      return ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
    },
    post: async (name, args, agentId = 'worker-self') => {
      const agent = { id: agentId, session: { header: { cwd: CWD } }, inject: (m) => injects.push({ id: agentId, message: m }) }
      const exec = { name, arguments: args, agent }
      const downstream = { kind: 'accept' }
      return ctx.waterfall('tools/post-execute', exec, downstream, () => Promise.resolve(downstream))
    }
  }
}

console.log('=== 检查：claim 有效性 = livenessOf，不再靠时钟 ===')

// A1: 现场复现与负向对照：死会话 claim 立刻不阻塞，真活会话 claim 仍然阻塞
{
  const env = await createEnv({
    agentLiveness: {
      'dead-session': 'not-live', // 不在 agents 里的死会话
      'live-session': 'live'      // 活会话
    },
    initialState: {
      schemaVersion: 1,
      seq: 2,
      claims: [
        {
          claimId: 'c_dead',
          holderId: 'agent:dead-session',
          holderName: 'Dead Worker',
          paths: ['dsh-collab/'],
          mode: 'exclusive', // TTL 还有 1500 秒！
          createdAt: NOW - 300 * 1000,
          readable: true,
        },
        {
          claimId: 'c_live',
          holderId: 'agent:live-session',
          holderName: 'Live Worker',
          paths: ['src/live/'],
          mode: 'exclusive',
          createdAt: NOW - 300 * 1000,
          readable: true,
        }
      ],
      messages: [],
      holders: []
    }
  })

  // 1. 死会话占用的 dsh-collab/：发起 claim，断言立刻不阻塞（ok: true）
  let deadClaimRes = null
  let deadClaimError = null
  try {
    deadClaimRes = await env.executeLock({ op: 'claim', paths: ['dsh-collab/'] }, 'my-worker')
  } catch (e) {
    deadClaimError = e
  }
  ok(deadClaimError === null && deadClaimRes && deadClaimRes.ok === true,
    'A1.1: 死会话的独占 claim（TTL 还剩 1500s）立刻不阻塞新 claim（livenessOf=not-live）',
    deadClaimError ? deadClaimError.message : JSON.stringify(deadClaimRes))

  // 2. 负向对照：活会话占用的 src/live/：发起 claim，断言仍然阻塞（报 conflict）
  let liveClaimRes = null
  let liveClaimError = null
  try {
    liveClaimRes = await env.executeLock({ op: 'claim', paths: ['src/live/'] }, 'my-worker')
  } catch (e) {
    liveClaimError = e
  }
  ok((liveClaimError !== null && liveClaimError.collabConflict === true) ||
    (liveClaimRes !== null && liveClaimRes !== undefined && liveClaimRes.ok === false && liveClaimRes.error === 'conflict'),
    'A1.2 (负向对照): 活会话的独占 claim 仍然阻塞（报 conflict）',
    liveClaimError ? 'conflict caught' : JSON.stringify(liveClaimRes))
}

// A2: gate 门控检查：死会话不拦写，活会话依然拦写
{
  const env = await createEnv({
    agentLiveness: {
      'dead-session': 'not-live',
      'live-session': 'live'
    },
    initialState: {
      schemaVersion: 1,
      seq: 2,
      claims: [
        {
          claimId: 'c_dead',
          holderId: 'agent:dead-session',
          paths: ['dsh-collab/'],
          mode: 'exclusive',
          createdAt: NOW - 300 * 1000,
          readable: true,
        },
        {
          claimId: 'c_live',
          holderId: 'agent:live-session',
          paths: ['src/live/'],
          mode: 'exclusive',
          createdAt: NOW - 300 * 1000,
          readable: true,
        }
      ],
      messages: [],
      holders: []
    }
  })

  // 写死会话占用的路径：门控应该放行（kind === 'allow'）
  const decDead = await env.pre('write', { file_path: 'dsh-collab/foo.ts' }, 'worker-b')
  ok(decDead && decDead.kind === 'allow', 'A2.1: 写门控对死会话占用的路径放行（不阻塞写入）', JSON.stringify(decDead))

  // 写活会话占用的路径：门控应该拦截（kind === 'ask'）
  const decLive = await env.pre('write', { file_path: 'src/live/bar.ts' }, 'worker-b')
  ok(decLive && decLive.kind === 'ask', 'A2.2 (负向对照): 写门控对活会话占用的路径拦截（ask）', JSON.stringify(decLive))
}

// A3: op=reap 立即回收死会话 claim（不看 TTL，不看 age 门槛）
{
  const env = await createEnv({
    agentLiveness: {
      'dead-young': 'not-live',
      'live-session': 'live'
    },
    initialState: {
      schemaVersion: 1,
      seq: 2,
      claims: [
        {
          claimId: 'c_young',
          holderId: 'agent:dead-young',
          paths: ['src/young/'],
          mode: 'exclusive', // 刚创建 10 秒
          createdAt: NOW - 10 * 1000,    // ageSec = 10 << 600
          readable: true,
        },
        {
          claimId: 'c_live',
          holderId: 'agent:live-session',
          paths: ['src/live/'],
          mode: 'exclusive',
          createdAt: NOW - 10 * 1000,
          readable: true,
        }
      ],
      messages: [],
      holders: []
    }
  })

  // dry-run reap: c_young 必须立即列入 candidates（不看 age 门槛，不看 TTL 还剩多久）
  const dry = await env.executeLock({ op: 'reap' }, 'caller-agent')
  ok(dry.ok === true && dry.data && Array.isArray(dry.data.candidates) &&
    dry.data.candidates.some(c => c.claimId === 'c_young'),
    'A3.1: dead 会话即便刚创建 10s 也立即列入 reap 候选（不看 600s age 门槛）',
    JSON.stringify(dry.data && dry.data.candidates))

  ok(dry.data.candidates.every(c => c.claimId !== 'c_live'),
    'A3.2 (负向对照): live 会话绝不列入 reap 候选',
    JSON.stringify(dry.data && dry.data.candidates))
}

// A4: failed 状态（基础设施故障）fail-closed 保持现状
{
  const env = await createEnv({
    agentLiveness: {
      'failed-session': 'failed' // agents.get 抛错
    },
    initialState: {
      schemaVersion: 1,
      seq: 1,
      claims: [
        {
          claimId: 'c_failed',
          holderId: 'agent:failed-session',
          paths: ['src/failed/'],
          mode: 'exclusive',
          createdAt: NOW - 100 * 1000,
          readable: true,
        }
      ],
      messages: [],
      holders: []
    }
  })

  // 1. claim 遇到 failed-session：fail-closed 保持现状（报 conflict，不误放行）
  let claimErr = null
  let claimRes = null
  try {
    claimRes = await env.executeLock({ op: 'claim', paths: ['src/failed/'] }, 'caller-agent')
  } catch (e) {
    claimErr = e
  }
  // 工具层把冲突**返回**成 {ok:false,error:'conflict'}（也可能抛带 collabConflict 的错）——两种都算冲突 ✓
  const conflicted = (claimErr !== null && claimErr.collabConflict === true) ||
    (claimRes !== null && claimRes.ok === false && claimRes.error === 'conflict')
  ok(conflicted,
    'A4.1: liveness=failed 时 fail-closed 保持现状（仍然判定冲突，不误放行）',
    conflicted ? 'conflict' : 'no-conflict')

  // 2. reap 遇到 failed-session：fail-closed 绝不误收
  const dry = await env.executeLock({ op: 'reap' }, 'caller-agent')
  ok(dry.ok === true && Array.isArray(dry.data.candidates) &&
    !dry.data.candidates.some(c => c.claimId === 'c_failed'),
    'A4.2: liveness=failed 时 fail-closed 保持现状（绝不误收进 reap 候选）',
    JSON.stringify(dry.data && dry.data.candidates))
}

console.log('\n=== 检查：切掉只读触发写盘 ===')

// S1: 在别人独占路径下做 read，notice 依然 inject，但状态文件完全不写盘（writes === 0）
{
  const initialDoc = {
    schemaVersion: 1,
    seq: 1,
    claims: [
      {
        claimId: 'c_other',
        holderId: 'agent:other-holder',
        holderName: 'Other Holder',
        paths: ['src/busy/'],
        mode: 'exclusive',
        createdAt: NOW - 100 * 1000,
        readable: true, // 初始为空
      }
    ],
    messages: [],
    holders: []
  }

  const env = await createEnv({
    agentLiveness: {
      'other-holder': 'live',
      'reader-me': 'live'
    },
    initialState: initialDoc
  })

  const rawBefore = env.stateRaw()
  env.stats.writes = 0

  // 读他人独占目录下的文件
  await env.post('read', { file_path: 'src/busy/file.ts' }, 'reader-me')

  // 1. 验证 notice 依然通过 inject 投递
  ok(env.injects.length === 1,
    'S1.1: read 触发访问通知，依然通过 agent.inject 投递',
    'injects=' + env.injects.length)

  // 2. 验证状态文件写盘次数恰好为 0！
  ok(env.stats.writes === 0,
    'S1.2: read 绝不触发写盘（writes === 0，无写放大）',
    'writes=' + env.stats.writes)

  // 3. 验证状态文件逐字节不变，且声明上没有任何"读者"痕迹（只读不写状态 ⇒ 不反向登记读者）
  const rawAfter = env.stateRaw()
  ok(rawAfter === rawBefore,
    'S1.3: 状态文件逐字节不变（mtime/version 不变）',
    'changed=' + (rawAfter !== rawBefore))

  const docAfter = env.readState()
  const withReaders = docAfter.claims.filter(c => c && Object.prototype.hasOwnProperty.call(c, 'readers'))
  ok(withReaders.length === 0,
    'S1.4: read 不在声明上留痕迹（claims 里没有 readers 字段）',
    '带 readers 的声明数=' + withReaders.length)
}

console.log(`\n结果：${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
