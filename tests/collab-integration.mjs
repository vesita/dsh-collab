// 解析策略：优先裸包名（pnpm 提升 / profile 安装），回退到项目内 pnpm 虚拟store 路径。
const cordis = await import('@deepseek-ai/cordis').catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
const { Context } = cordis
import collabPlugin from '../lib/index.js'
import os from 'node:os'
import path from 'node:path'
import { projectStateFile, collabDir } from '../lib/paths.js'

// 隔离：把状态目录指到临时 DSH_HOME，避免测试污染真实 ~/.dsh。
// paths.ts 在**调用时**读取 process.env，所以在 import 之后设置依然生效。
process.env.DSH_HOME = path.join(os.tmpdir(), 'dsh-collab-it-' + process.pid)

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

// 跨形态断言：包形态的 tool schema 必须与 collab-core 的 MODES（单一事实源）一致。
// 历史缺陷：动态形态漏了 read，插件自己注入的提示要求 mode=read 而 schema 拒绝它。
{
  const { MODES } = await import('../lib/collab-core.js')
  const modeEnum = lockTool.parameters.properties.mode.enum
  if (!Array.isArray(modeEnum) || !MODES.every(m => modeEnum.includes(m))) {
    throw new Error('packaged form mode enum must advertise every valid mode, got ' + JSON.stringify(modeEnum))
  }
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

// 7. unified error envelope: failures carry a top-level error code
const badRelease = await lockTool.execute({ op: 'release' }, exec2)
if (badRelease.ok || badRelease.error !== 'bad-request') throw new Error('release without id/paths must fail with bad-request at top level')
const badHeartbeat = await lockTool.execute({ op: 'heartbeat', claimId: 'c_nope' }, exec2)
if (badHeartbeat.ok || badHeartbeat.error !== 'not-found') throw new Error('heartbeat of a missing claim must fail with not-found at top level')

// 8. 状态目录必须是**绝对路径**、不含字面量 `~`、且与进程 cwd 无关
//    （历史 bug：hostCode 用 '~/.dsh/...' ⇒ 写进 <HOME>/~/.dsh/...；index.ts 用相对路径 ⇒ 随进程 cwd 漂移）
const listed = await lockTool.execute({ op: 'list' }, exec2)
const statePath = listed.data.statePath
const stateDir = listed.data.stateDir
if (!path.isAbsolute(statePath)) throw new Error('statePath must be absolute, got ' + statePath)
if (statePath.includes('/~') || statePath.includes('~/.dsh')) throw new Error('statePath must not contain a literal ~ segment, got ' + statePath)
if (statePath.startsWith(process.cwd() + path.sep)) throw new Error('statePath must not be anchored to the process cwd, got ' + statePath)
if (stateDir !== collabDir()) throw new Error('stateDir must equal collabDir(), got ' + stateDir + ' vs ' + collabDir())
if (!stateDir.startsWith(process.env.DSH_HOME)) throw new Error('stateDir must honour DSH_HOME, got ' + stateDir)

// 8b. DSH_HOME 边界：开头的 ~ 要展开（否则又造出字面量 ~ 目录）、纯空白视为未设置
{
  const { dshHomeDir, expandHome } = await import('../lib/paths.js')
  const realHome = os.homedir()
  if (dshHomeDir({ DSH_HOME: '~/.dsh' }) !== path.join(realHome, '.dsh')) {
    throw new Error("DSH_HOME='~/.dsh' must expand the tilde, got " + dshHomeDir({ DSH_HOME: '~/.dsh' }))
  }
  if (dshHomeDir({ DSH_HOME: '   ' }) !== path.join(realHome, '.dsh')) {
    throw new Error('a blank DSH_HOME must be treated as unset, got ' + dshHomeDir({ DSH_HOME: '   ' }))
  }
  if (dshHomeDir({ DSH_HOME: '/tmp/abs-dsh' }) !== '/tmp/abs-dsh') throw new Error('absolute DSH_HOME must pass through')
  if (expandHome('~/x', '/home/u') !== '/home/u/x' || expandHome('a/b', '/home/u') !== 'a/b') throw new Error('expandHome semantics drifted')
}

// 9. corrupt state self-heals instead of bricking the tool
const corruptKey = projectStateFile('/test/workspace')
stateStore.set(corruptKey, 'not-json{{{')
const healed = await lockTool.execute({ op: 'list' }, exec2)
if (!healed.ok) throw new Error('corrupt state must self-heal, got ' + JSON.stringify(healed))
if (!String(healed.data.warning || '').includes('corrupted')) throw new Error('self-heal must surface a warning')

console.log('PASS: Cordis plugin integration test passed (0.1.5-rc.1 runtime)')
