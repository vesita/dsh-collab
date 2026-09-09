import { Context } from '../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'
import collabPlugin from '../src/index.js'

const ctx = new Context()
ctx.provide('tools')
ctx.provide('timer')
ctx.provide('fs')
ctx.provide('sessions')
ctx.provide('sessionTitle')

const tools = []
ctx.set('tools', { register: (t) => tools.push(t) })
ctx.set('timer', { timeout: (ms) => new Promise(r => setTimeout(r, ms)) })
const stateStore = new Map()
ctx.set('fs', {
  resolve: async (p) => ({ displayPath: p, path: p }),
  stat: async (target) => stateStore.has(target.path) ? { version: 1 } : null,
  readText: async (target) => stateStore.get(target.path) || '',
  writeText: async (target, content) => { stateStore.set(target.path, content) },
  processPath: (target) => target.path
})

ctx.set('sessions', {
  get: (_id) => ({ header: { cwd: '/test/workspace' } })
})
ctx.set('sessionTitle', {
  get: (_session) => ({ title: 'Worker Alpha' })
})

await ctx.plugin(collabPlugin)

const lockTool = tools.find(t => t.name === 'collab_lock')
const boardTool = tools.find(t => t.name === 'collab_board')

if (!lockTool || !boardTool) {
  throw new Error('collab_lock or collab_board not registered')
}

const exec1 = { agent: { id: 'agent-1' } }
const exec2 = { agent: { id: 'agent-2' } }

// 1. claim
const claimRes = await lockTool.execute({ op: 'claim', paths: ['src/core/'], ttlSec: 60, note: 'refactoring' }, exec1)
if (!claimRes.ok) throw new Error('claim failed')

// 2. overview
const overviewRes = await lockTool.execute({ op: 'overview' }, exec1)
if (!overviewRes.ok || overviewRes.data.totalClaims !== 1) throw new Error('overview failed')

// 3. conflicting claim from agent-2
const conflictRes = await lockTool.execute({ op: 'claim', paths: ['src/core/module.ts'] }, exec2)
if (conflictRes.ok || conflictRes.error !== 'conflict') throw new Error('conflict not caught')

// 4. board post & read
const postRes = await boardTool.execute({ op: 'post', channel: 'general', body: 'Hold on, working on core' }, exec1)
if (!postRes.ok) throw new Error('post failed')

const readRes = await boardTool.execute({ op: 'read', channel: 'general' }, exec2)
if (!readRes.ok || readRes.data.messages.length !== 1) throw new Error('read failed')

// 5. agent-1 disposed
ctx.emit('agent/disposed', { agent: { id: 'agent-1' } })
await new Promise(r => setTimeout(r, 60))

// 6. check list after dispose
const listRes = await lockTool.execute({ op: 'list' }, exec2)
if (!listRes.ok || listRes.data.claims.length !== 0) throw new Error('disposed claims not cleaned')

console.log('PASS: Cordis plugin integration test passed (0.1.5-alpha.1 runtime)')
