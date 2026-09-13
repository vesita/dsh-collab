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
//    W7（**改了语义**）：dispose **不是**释放信号 —— 声明的生命周期只由租约 expiresAt 决定。
//    原断言是 `claims.length !== 0 → throw 'disposed claims not cleaned'`，它编码的是
//    "dispose 释放声明"，与 W7 决策直接冲突。这里改成如实断言**新**语义（强度不降：
//    既钉住"未过期声明必须留下"，也钉住"它仍属于 agent-1"）。
ctx.emit('agent/disposed', { agent: { id: 'agent-1' } })
await new Promise(r => setTimeout(r, 60))

// 6. check list after dispose：未到期的声明必须还在（dispose 不缩短租约）
const listRes = await lockTool.execute({ op: 'list' }, exec2)
if (!listRes.ok || listRes.data.claims.length !== 1) {
  throw new Error('dispose must NOT release an unexpired claim (W7: the lease is the only reclamation), got ' + JSON.stringify(listRes.data.claims))
}
if (listRes.data.claims[0].holderId !== 'agent:agent-1') {
  throw new Error('the surviving claim must still belong to agent-1, got ' + listRes.data.claims[0].holderId)
}
// 后续步骤沿用旧版"此时已无占用"的前置条件 —— 用**显式 release** 腾出路径
// （agent-1 即便已被 dispose，仍按 holderId 匹配，这正是"dispose 不改变持有关系"的体现）。
const relRes = await lockTool.execute({ op: 'release', claimId: listRes.data.claims[0].claimId }, exec1)
if (!relRes.ok) throw new Error('explicit release after dispose failed, got ' + JSON.stringify(relRes))

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
if (!String(healed.data.warning || '').includes('状态文件损坏')) throw new Error('self-heal must surface a warning')

// 10. A/B 组：损坏自愈与旧落点迁移的失败必须**如实**（不得谎报备份/重置成功、不得静默丢迁移失败）
//     手法统一：起一个**独立 ctx**（installStore 在 apply 时捕获 ctx，故每个案例各自实例化），
//     注入一个会抛错的 fs，然后跑一次 list，读回 data.warning。
//     断言**全部求值后再统一判定**：负向对照时一次就能看到每一条断言各自红在哪，
//     而成功路径的输出与改动前逐字一致（仍是同一行 PASS）。
const newFailures = []
const ok = (label, cond, extra) => {
  if (cond) { console.log('  ok  ' + label); return }
  newFailures.push(label + (extra ? '  <-- ' + extra : ''))
  console.log('  FAIL ' + label + (extra ? '  <-- ' + extra : ''))
}
const bootWithFs = async (fsImpl, cwd) => {
  const c = new Context()
  for (const serviceName of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle']) c.provide(serviceName)
  const tools = []
  c.set('tools', { register: (t) => { tools.push(t); return () => {} } })
  c.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} })
  c.set('fs', fsImpl)
  c.set('sessions', { get: () => ({ header: { cwd } }) })
  c.set('sessionTitle', { get: () => ({ title: 'Heal Worker' }) })
  await c.plugin(collabPlugin)
  return tools.find((t) => t.name === 'collab_lock')
}
const healFs = (map, opts = {}) => ({
  resolve: async (p) => ({ displayPath: p, path: p }),
  stat: async (t) => (map.has(t.path) ? { version: 1 } : null),
  readText: async (t) => map.get(t.path) || '',
  writeText: async (t, content, o) => {
    if (opts.failAllWrites) throw new Error('disk on fire')
    if (opts.failReplace && o && o.kind === 'replaceIfVersion') throw new Error('reset exploded')
    if (opts.failLegacyMigrate && o && o.kind === 'createIfAbsent') throw new Error('migrate write exploded')
    map.set(t.path, content)
    return { operation: 'create', version: 1 }
  },
  processPath: (t) => t.path
})
const listWarning = async (lock, agentId) => {
  const r = await lock.execute({ op: 'list' }, { agent: { id: agentId } })
  if (!r.ok) throw new Error('list must still succeed, got ' + JSON.stringify(r))
  return String((r.data && r.data.warning) || '')
}

// 10a. A1（item 1）：备份写失败 —— warning 不得宣称"已备份"，必须如实说备份失败 + 交代损坏内容的下落
{
  const cwd = '/test/heal/backup-fail'
  const key = projectStateFile(cwd)
  const map = new Map([[key, 'not-json{{{']])
  const lock = await bootWithFs(healFs(map, { failAllWrites: true }), cwd)
  const w = await listWarning(lock, 'agent-a1')
  ok('item 1/A1: 损坏必须仍然被报出来', w.includes('状态文件损坏'), JSON.stringify(w))
  ok('item 1/A1: 备份失败时不得宣称"已备份到 <路径>"', !/;\s*backup:\s/.test(w), JSON.stringify(w))
  ok('item 1/A1: warning 必须如实说明备份失败及其原因', /备份失败：disk on fire/.test(w), JSON.stringify(w))
  ok('item 1/A1: 必须交代原始损坏内容的下落（证据链）', /原始损坏内容仍留在磁盘上/.test(w), JSON.stringify(w))
  ok('item 2/A1: 重置失败时不得宣称"已重新初始化"', !w.includes('已重新初始化'), JSON.stringify(w))
  ok('item 2/A1: warning 必须如实说明重置失败及其原因', /重新初始化失败：disk on fire/.test(w), JSON.stringify(w))
  ok('item 2/A1: 重置失败时原始损坏内容必须原样留在磁盘上', map.get(key) === 'not-json{{{', JSON.stringify(map.get(key)))
}

// 10b. A2（item 2）：备份成功但重置失败 —— 备份路径如实给出，同时不得宣称"已重新初始化"
{
  const cwd = '/test/heal/reset-fail'
  const key = projectStateFile(cwd)
  const map = new Map([[key, 'not-json{{{']])
  const lock = await bootWithFs(healFs(map, { failReplace: true }), cwd)
  const w = await listWarning(lock, 'agent-a2')
  const backupKeys = [...map.keys()].filter((k) => k.includes('.corrupt-'))
  ok('item 2/A2: 备份必须真的写出原始损坏内容', backupKeys.length === 1 && map.get(backupKeys[0]) === 'not-json{{{',
    JSON.stringify({ backupKeys, content: map.get(backupKeys[0]) }))
  ok('item 1/A2: 备份成功时 warning 必须给出真实备份路径', w.includes('备份：' + backupKeys[0]), JSON.stringify(w))
  ok('item 2/A2: warning 必须如实说明重置失败', /重新初始化失败：reset exploded/.test(w), JSON.stringify(w))
  ok('item 2/A2: 重置失败却宣称"已重新初始化"（谎报）', !w.includes('已重新初始化'), JSON.stringify(w))
  ok('item 2/A2: 重置失败时损坏内容仍在磁盘上，warning 必须这么写', /原始损坏内容仍留在磁盘上/.test(w), JSON.stringify(w))
  ok('item 2/A2: 重置失败后主文件必须保持原样（证据仍在）', map.get(key) === 'not-json{{{', JSON.stringify(map.get(key)))
}

// 10c. 回归：两处都成功时，成功措辞必须与此前**逐字一致**（只允许失败时改文案）
{
  const cwd = '/test/heal/both-ok'
  const key = projectStateFile(cwd)
  const map = new Map([[key, 'not-json{{{']])
  const lock = await bootWithFs(healFs(map), cwd)
  const w = await listWarning(lock, 'agent-a3')
  const backupKeys = [...map.keys()].filter((k) => k.includes('.corrupt-'))
  ok('item 1+2/10c: 全成功时的 warning 是「状态文件损坏；已重新初始化；备份：<路径>」',
    /^状态文件损坏；已重新初始化；备份：/.test(w) && w.includes('备份：' + backupKeys[0]), JSON.stringify(w))
  ok('item 1+2/10c: 全成功时不得出现任何失败措辞', !w.includes('失败'), JSON.stringify(w))
}

// 10d. B（item 3）：旧落点（项目内 .dsh-collab.json）迁移写入失败必须留痕，且不阻断工具
{
  const cwd = '/test/heal/legacy-fail'
  const legacyPath = cwd + '/.dsh-collab.json'
  const legacyDoc = JSON.stringify({ schemaVersion: 1, seq: 1, claims: [], messages: [], holders: [] })
  const map = new Map([[legacyPath, legacyDoc]])
  const fsImpl = {
    resolve: async (p, o) => ({ displayPath: p, path: p.startsWith('/') ? p : ((o && o.cwd ? o.cwd : '') + '/' + p) }),
    stat: async (t) => (map.has(t.path) ? { version: 1 } : null),
    readText: async (t) => map.get(t.path) || '',
    writeText: async () => { throw new Error('migrate write exploded') },
    processPath: (t) => t.path
  }
  const lock = await bootWithFs(fsImpl, cwd)
  const w = await listWarning(lock, 'agent-b1')
  ok('item 3/B: 迁移失败必须在 warning 里留痕（旧落点迁移失败：<原因>）',
    /旧落点迁移失败：migrate write exploded/.test(w), JSON.stringify(w))
  ok('item 3/B: 迁移失败不得动到旧文件本身', map.get(legacyPath) === legacyDoc)
}

if (newFailures.length) {
  console.log('')
  for (const f of newFailures) console.log('NEW ASSERTION FAILED: ' + f)
  throw new Error(newFailures.length + ' new assertion(s) failed')
}

console.log('PASS: Cordis plugin integration test passed (0.1.5-rc.1 runtime)')
