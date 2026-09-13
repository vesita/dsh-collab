// tests/collab-awareness-cross-session.mjs
// **跨会话态势泄漏**回归测试（E2 RED 测试）。
//
// 复现的缺陷（src/awareness.ts）：
//   digestCache 只按 cwd 做键，而缓存内容是**按刷新者过滤后**渲染的文本
//   （:52 `mine = id ? 'agent:'+id : 'human:console'`，:53 `c.holderId !== mine`）。
//   于是只要有一次刷新发生在 `id` 为空的会话（mine='human:console'，谁都不排除）上，
//   同 cwd 的所有会话随后都会读到这份"不排除任何人"的缓存 —— **持有者会看到自己的锁**，
//   被自己的占用误导（以为自己被挡着）。
//
// 本测试用假 ctx 捕获 dsh-collab/awareness 的 PromptContext 与 timer 回调，驱动：
//   (a) 负向对照：B（id 为空）先刷新 → 切到持有者 A 读缓存 → 自己的锁**不许**出现（未修复时 RED）
//   (b) 正向对照：同一份缓存下 B 读 → 他人占用**必须**照常显示
//   (c) 反向对照：删除 claim 并强制刷新 → 双方都回落为通用规范
//
// 运行：node tests/collab-awareness-cross-session.mjs

import path from 'node:path'
import os from 'node:os'
import { createHarness } from './_harness.mjs'

const ROOT = path.dirname(new URL(import.meta.url).pathname)

const tmp = path.join(os.tmpdir(), 'collab-awareness-cross-session-' + process.pid)
// DSH_HOME 指到临时目录：状态文件落在 /tmp，绝不碰真实协作状态。
process.env.DSH_HOME = tmp
// TTL 调大：断言期间缓存必须保持"命中"，否则 A 那次 text() 会触发新刷新，
// 就把 bug 掩盖了（这是本测试唯一允许的时序控制手段，不睡等 TTL）。
process.env.DSH_COLLAB_DIGEST_TTL_MS = '60000'

const { projectStateFile } = await import(path.join(ROOT, '../lib/paths.js'))
const { init } = await import(path.join(ROOT, '../lib/collab-core.js'))
const collabPlugin = (await import(path.join(ROOT, '../lib/index.js'))).default

const cordis = await import('@deepseek-ai/cordis').catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
const { Context } = cordis

const h = createHarness()
const { ok } = h

const PROJECT_CWD = '/fake/project/cross-session'
// 通用规范的唯一前缀：用于把"回落为通用规范"与"仍是一份占用摘要"严格区分开。
// （摘要正文末尾也含 'collab_lock' 字样，只看 includes('collab_lock') 会漏判。）
const GENERIC = '多会话协作（dsh-collab）：'
// B 的 id 为空：refreshDigest 里 mine 退化成 'human:console'，谁都不排除。
const A = { id: 'agent-A', session: { header: { cwd: PROJECT_CWD } } }
const B = { id: '', session: { header: { cwd: PROJECT_CWD } } }

const store = new Map()
const promptContexts = new Map()
let intervalFn = null
let current = B

const ctx = new Context()
for (const n of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'agents', 'systemPrompt']) ctx.provide(n)

ctx.set('tools', { register: () => () => {} })
ctx.set('timer', {
  timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
  interval: (fn) => { intervalFn = fn; return () => {} } // 捕获回调：需要强制刷新时手动调用
})
ctx.set('fs', {
  resolve: async (p) => ({ displayPath: p, path: p }),
  stat: async (t) => (store.has(t.path) ? { version: 1 } : null),
  readText: async (t) => store.get(t.path) || '',
  writeText: async (t, c) => { store.set(t.path, c) },
  processPath: (t) => t.path
})
ctx.set('sessions', { get: () => undefined })
ctx.set('sessionTitle', { get: () => ({ title: 'Cross Session Worker' }) })
ctx.set('agents', {
  currentInitiator: () => current,
  list: () => [A, B]
})
ctx.set('systemPrompt', { context: (c) => { promptContexts.set(c.name, c); return () => {} } })

await ctx.plugin(collabPlugin)

const pc = promptContexts.get('dsh-collab/awareness') || null
console.log('# awareness PromptContext is registered')
ok(!!pc && typeof pc.text === 'function', 'plugin registers the awareness PromptContext with a live text()')
if (!pc) { console.log(`\nFAILURES: ${h.pass}, ${h.fail}`); process.exit(1) }

const statePath = projectStateFile(PROJECT_CWD)
const now = Date.now()

// 植入**持有者 A 自己**的一条未过期独占声明。
const s = init()
s.claims.push({
  claimId: 'c_mine', holderId: 'agent:' + A.id, holderName: 'Session A',
  paths: ['src/mine/'], mode: 'exclusive', ttlSec: 1800,
  expiresAt: now + 25 * 60 * 1000, note: '', createdAt: now
})
store.set(statePath, JSON.stringify(s))

console.log('# B (id-less) refreshes the shared cwd cache first')
current = B
ok(typeof pc.text() === 'string', 'B cold-cache text() returns guidance')
await new Promise((r) => setTimeout(r, 120)) // 等 fire-and-forget 刷新落缓存
const textB1 = pc.text()
ok(textB1.includes('src/mine/'), '(b) 他人（B）的摘要必须照常显示 A 的占用 src/mine/', textB1)

console.log('# (a) the holder A must NOT see its own claim in the same cache')
current = A
const textA = pc.text() // TTL=60s，命中同一份缓存（B 刷新的那份）
ok(!textA.includes('src/mine/'), '(a) 持有者 A 的摘要不得出现自己的锁 src/mine/', textA)
ok(textA.startsWith(GENERIC), '(a) A 在无他人占用时回落为通用规范（前缀判据）', textA)

console.log('# (c) claim removed + forced refresh -> both fall back to generic guidance')
{
  const doc = JSON.parse(store.get(statePath))
  doc.claims = doc.claims.filter((c) => c.claimId !== 'c_mine')
  store.set(statePath, JSON.stringify(doc))
  ok(typeof intervalFn === 'function', 'timer interval callback was captured (forced refresh available)')
  if (typeof intervalFn === 'function') intervalFn()
  await new Promise((r) => setTimeout(r, 120))
  const textA2 = pc.text()
  current = B
  const textB2 = pc.text()
  ok(!textA2.includes('src/mine/') && textA2.startsWith(GENERIC), '(c) A 回落为通用规范', textA2)
  ok(!textB2.includes('src/mine/') && textB2.startsWith(GENERIC), '(c) B 回落为通用规范', textB2)
}

h.finish()
