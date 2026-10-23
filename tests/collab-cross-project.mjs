// tests/collab-cross-project.mjs
//
// 0.2.10：状态层的「本实例副本」（`createStateCore()` 里的 `replica`）必须按**目标状态文件**隔离。
//
// 为什么需要它：一个 dsh 进程只有**一份** `createStateCore()`，而副本按目标状态文件隔离之前它是
// 闭包级变量 —— `mutate()` 每次写盘都用 `mergeDocs(本项目的盘上状态, 副本)`，于是一个进程里
// A 项目的声明会被写进 B 项目的状态文件（实测：~/.dsh/collab/projects/ 下四个项目文件里同时
// 出现同一批 6 个 claimId，而每条只属于其中一个项目）。
//
// 这里钉住三件事：
//   1) 跨文件：A 的声明不得出现在 B 的状态文件里；
//   2) 跨文件反向：B 的声明不得出现在 A 的状态文件里（A 再写一次同样不带 B 的）；
//   3) 同文件：副本的**唯一理由**不能丢 —— 另一个写者用陈旧基线覆盖盘上状态后，下一次写盘
//      仍要把被覆盖掉的声明 join 回来（否则等于把副本整个砍掉）。
//
// 运行：node tests/collab-cross-project.mjs

import path from 'node:path'
import os from 'node:os'
import { createHarness } from './_harness.mjs'

const cordis = await import('@deepseek-ai/cordis').catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
const { Context } = cordis
import collabPlugin from '../lib/index.js'
import { projectStateFile } from '../lib/paths.js'

// 隔离：状态目录指到临时 DSH_HOME。paths.ts 在**调用时**读 process.env，故 import 后设置也生效。
const FAKE_HOME = path.join(os.tmpdir(), 'dsh-collab-xp-' + process.pid)
process.env.DSH_HOME = FAKE_HOME

const h = createHarness()
const { ok } = h

// 两个不同的会话 cwd = 两个项目 ⇒ 两个互不相干的状态文件。同一个插件实例（同一进程）驱动它们。
const CWD_A = '/test/xp/alpha'
const CWD_B = '/test/xp/beta'
const STATE_A = projectStateFile(CWD_A)
const STATE_B = projectStateFile(CWD_B)
const AGENT_A = { agent: { id: 'agent-A' } }
const AGENT_B = { agent: { id: 'agent-B' } }
const CWD_OF = { 'agent-A': CWD_A, 'agent-B': CWD_B }

// ---------- 假 fs：内存 Map，语义与 DSH fs 服务一致（含 createIfAbsent / replaceIfVersion）----------
function makeFs (initial) {
  const store = new Map(initial || [])
  const versions = new Map()
  let v = 0
  return {
    store, versions,
    fs: {
      resolve: async (p) => ({ displayPath: p, path: p }),
      stat: async (t) => (store.has(t.path) ? { version: versions.get(t.path) || 1 } : null),
      readText: async (t) => store.get(t.path) || '',
      writeText: async (t, content, o) => {
        const kind = (o && o.kind) || 'replace'
        if (kind === 'createIfAbsent' && store.has(t.path)) {
          const e = new Error('cannot overwrite existing "' + t.path + '" without reading it first')
          e.code = 'FS_NOT_OBSERVED'
          throw e
        }
        if (kind === 'replaceIfVersion') {
          if (!store.has(t.path)) {
            const e = new Error('cannot write "' + t.path + '": file changed since it was read')
            e.code = 'FS_STALE_VERSION'
            throw e
          }
          if (Number(o && o.version) !== (versions.get(t.path) || 1)) {
            const e = new Error('cannot write "' + t.path + '": file changed since it was read')
            e.code = 'FS_STALE_VERSION'
            throw e
          }
        }
        store.set(t.path, content)
        versions.set(t.path, ++v)
        return { operation: 'create', version: v }
      },
      processPath: (t) => t.path,
      listDir: async (d) => {
        const dir = typeof d === 'string' ? d : d.path
        return [...store.keys()]
          .filter((k) => path.dirname(k) === dir)
          .map((k) => ({ name: path.basename(k), type: 'file', target: { displayPath: k, path: k } }))
      }
    }
  }
}

async function boot (env) {
  const c = new Context()
  for (const n of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle']) c.provide(n)
  const tools = []
  c.set('tools', { register: (t) => { tools.push(t); return () => {} } })
  c.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} })
  c.set('fs', env.fs)
  c.set('sessions', { get: (id) => ({ header: { cwd: CWD_OF[id] || CWD_A } }) })
  c.set('sessionTitle', { get: () => ({ title: 'XP Worker' }) })
  await c.plugin(collabPlugin)
  return { lock: tools.find((t) => t.name === 'collab_lock'), board: tools.find((t) => t.name === 'collab_board') }
}

const docOf = (env, p) => JSON.parse(env.store.get(p) || '{}')
const claimsOf = (env, p) => (docOf(env, p).claims || [])
const claimIdsOf = (env, p) => claimsOf(env, p).map((c) => c.claimId)
const claimPathsOf = (c) => (c && Array.isArray(c.paths) ? c.paths : [])
const claimOfPath = (env, p, claimPath) => claimsOf(env, p).find((x) => claimPathsOf(x).indexOf(claimPath) >= 0) || null
const claimIdOfPath = (env, p, claimPath) => {
  const c = claimOfPath(env, p, claimPath)
  return c ? c.claimId : null
}
const pathsOf = (env, p) => claimsOf(env, p).flatMap(claimPathsOf)
const holderIdsOf = (env, p) => claimsOf(env, p).map((c) => c && c.holderId)

// ════════════════════════════════════════════════════════════════════════
// 1+2. 跨项目：A 的声明不进 B 的文件，B 的声明不进 A 的文件
// ════════════════════════════════════════════════════════════════════════
console.log('# 1+2. 副本跨项目隔离（A → B / B → A）')
{
  const env = makeFs([])
  const { lock } = await boot(env)

  const ra1 = await lock.execute({ op: 'claim', paths: ['src/alpha/'] }, AGENT_A)
  ok(ra1.ok === true, 'A 项目 claim 成功', JSON.stringify(ra1))
  const aClaim1 = claimOfPath(env, STATE_A, 'src/alpha/')
  ok(aClaim1 !== null, 'A 的声明写进了 A 的状态文件', JSON.stringify(claimIdsOf(env, STATE_A)))

  // B 项目的一次写盘。修前：副本里还留着 A 的声明 ⇒ 被 merge 进 B 的文件。
  const rb1 = await lock.execute({ op: 'claim', paths: ['src/beta/'] }, AGENT_B)
  ok(rb1.ok === true, 'B 项目 claim 成功', JSON.stringify(rb1))
  const bClaim1 = claimOfPath(env, STATE_B, 'src/beta/')
  ok(bClaim1 !== null, 'B 的声明写进了 B 的状态文件', JSON.stringify(claimIdsOf(env, STATE_B)))

  const bPaths = pathsOf(env, STATE_B)
  ok(bPaths.indexOf('src/alpha/') < 0,
    'A 的声明**没有**被写进 B 的状态文件（跨项目不污染）',
    'B 文件里的声明路径=' + JSON.stringify(bPaths) + '，A 的=' + aClaim1.claimId)
  ok(holderIdsOf(env, STATE_B).indexOf(aClaim1.holderId) < 0,
    'B 的状态文件里不含 A 的持有者（holderId）',
    'B 的 holderId=' + JSON.stringify(holderIdsOf(env, STATE_B)) + '，A=' + aClaim1.holderId)

  // A 再写一次。修前：此时副本是 B 的文档 ⇒ A 的文件被写入 B 的声明。
  const ra2 = await lock.execute({ op: 'claim', paths: ['src/alpha-two/'] }, AGENT_A)
  ok(ra2.ok === true, 'A 项目第二次 claim 成功', JSON.stringify(ra2))
  const aPaths = pathsOf(env, STATE_A)
  ok(aPaths.indexOf('src/beta/') < 0,
    'B 的声明**没有**被写进 A 的状态文件（反向）',
    'A 文件里的 claimId=' + JSON.stringify(claimIdsOf(env, STATE_A)))
  ok(holderIdsOf(env, STATE_A).indexOf(bClaim1.holderId) < 0,
    'A 的状态文件里不含 B 的持有者（holderId）',
    'A 的 holderId=' + JSON.stringify(holderIdsOf(env, STATE_A)) + '，B=' + bClaim1.holderId)
  ok(aPaths.indexOf('src/alpha/') >= 0 && aPaths.indexOf('src/alpha-two/') >= 0,
    'A 自己的两条声明都还在 A 的状态文件里',
    JSON.stringify(aPaths))

  // B 再写一次：仍然不得把 A 的声明带进来。
  const rb2 = await lock.execute({ op: 'claim', paths: ['src/beta-two/'] }, AGENT_B)
  ok(rb2.ok === true, 'B 项目第二次 claim 成功', JSON.stringify(rb2))
  const bPaths2 = pathsOf(env, STATE_B)
  ok(bPaths2.indexOf('src/alpha/') < 0 && bPaths2.indexOf('src/alpha-two/') < 0,
    'B 第二次写盘后仍不含 A 的任何声明',
    JSON.stringify(bPaths2))
  ok(bPaths2.indexOf('src/beta/') >= 0 && bPaths2.indexOf('src/beta-two/') >= 0,
    'B 自己的两条声明都还在 B 的状态文件里',
    JSON.stringify(bPaths2))
}

// ════════════════════════════════════════════════════════════════════════
// 3. 收敛性正向对照：**同一个文件**的写者仍必须靠副本把丢掉的改动 join 回来
//    （不能为了通过 1/2 把副本作用整个砍掉）
// ════════════════════════════════════════════════════════════════════════
console.log('# 3. 收敛性正向对照（同一状态文件）')
{
  const env = makeFs([])
  const { lock } = await boot(env)

  const r1 = await lock.execute({ op: 'claim', paths: ['src/keep/'] }, AGENT_A)
  ok(r1.ok === true, 'A 项目 claim（第一次写盘）成功', JSON.stringify(r1))
  const keptId = claimIdOfPath(env, STATE_A, 'src/keep/')
  ok(typeof keptId === 'string', '第一次写盘的声明在盘上', JSON.stringify(claimIdsOf(env, STATE_A)))

  // 模拟另一个写者用**陈旧基线**覆盖盘上状态（它没看见 keep 那条）：副本存在的唯一理由就是
  // 下一次写盘时把它 join 回来。
  env.store.set(STATE_A, JSON.stringify({ schemaVersion: 1, seq: 0, writer: 'other-writer', claims: [], holders: [], released: {} }))

  const r2 = await lock.execute({ op: 'claim', paths: ['src/after/'] }, AGENT_A)
  ok(r2.ok === true, '被陈旧写者覆盖后再写一次成功', JSON.stringify(r2))
  const ids = claimIdsOf(env, STATE_A)
  ok(ids.indexOf(keptId) >= 0,
    '同文件写者仍靠副本收敛：被覆盖的声明在下次写盘时回来了',
    '盘上=' + JSON.stringify(ids) + '，期望含=' + keptId)
  ok(pathsOf(env, STATE_A).indexOf('src/after/') >= 0, '本次新声明也写进了同一个文件', JSON.stringify(pathsOf(env, STATE_A)))
}

h.finish()
