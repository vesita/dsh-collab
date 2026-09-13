import { createHarness } from './_harness.mjs'

// collab-awareness.mjs
// 多 DSH 会话协同的**实时态势注入**回归测试。
//
// 机制（已在真实运行时实测）：
//   prompt 装配时 `agents.currentInitiator()` 返回正在装配的那个会话，
//   取其 `session.header.cwd` 即得项目根；把这与共享状态文件里的
//   “他人未过期声明”合成一句话注入运行时上下文。于是**互相独立的会话**
//   每一步都能自动看到同项目还有谁占着什么，不依赖任何一方记得去查。
//
// 本测试用假 ctx 捕获插件注册的 PromptContext，直接驱动它的 text()，
// 断言：冷缓存返回通用规范；异步刷新后返回含他人占用的实时摘要；无他人占用时回到通用规范。
//
// 运行：node tests/collab-awareness.mjs

import path from 'node:path'
import os from 'node:os'

const cordis = await import('@deepseek-ai/cordis').catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
const { Context } = cordis

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const { projectStateFile } = await import(path.join(ROOT, '../lib/paths.js'))
const { init } = await import(path.join(ROOT, '../lib/collab-core.js'))
const collabPlugin = (await import(path.join(ROOT, '../lib/index.js'))).default

const h = createHarness()
const { ok } = h

const tmp = path.join(os.tmpdir(), 'collab-awareness-' + process.pid)
process.env.DSH_HOME = tmp
// 缩短态势缓存 TTL，让“声明消失后摘要回落”这一条能在百毫秒级验证。
process.env.DSH_COLLAB_DIGEST_TTL_MS = '200'

const PROJECT_CWD = '/fake/project/awareness'
const ME = { id: 'agent-me', session: { header: { cwd: PROJECT_CWD } } }

const store = new Map()
const tools = []
// 按 name 索引：本插件现在会注册**多个** PromptContext（态势 + 委托纪律），
// 只记住"最后一个"会让断言张冠李戴。
const promptContexts = new Map()

const ctx = new Context()
for (const n of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'agents', 'systemPrompt']) ctx.provide(n)

ctx.set('tools', { register: (t) => { tools.push(t); return () => {} } })
ctx.set('timer', {
  timeout: (ms) => new Promise((r) => setTimeout(r, ms)),
  interval: () => () => {} // 不真的起定时器；本测试只走 text() 触发的惰性刷新
})
ctx.set('fs', {
  resolve: async (p) => ({ displayPath: p, path: p }),
  stat: async (t) => (store.has(t.path) ? { version: 1 } : null),
  readText: async (t) => store.get(t.path) || '',
  writeText: async (t, c) => { store.set(t.path, c) },
  processPath: (t) => t.path
})
ctx.set('sessions', { get: (id) => (id === ME.id ? ME.session : undefined) })
ctx.set('sessionTitle', { get: () => ({ title: 'Awareness Worker' }) })
ctx.set('agents', { currentInitiator: () => ME, list: () => [ME] })
ctx.set('systemPrompt', {
  context: (c) => { promptContexts.set(c.name, c); return () => {} }
})

await ctx.plugin(collabPlugin)

const capturedPromptContext = promptContexts.get('dsh-collab/awareness') || null

console.log('# awareness prompt context is registered')
ok(!!capturedPromptContext, 'plugin registers the awareness PromptContext')
ok(!!capturedPromptContext && capturedPromptContext.name === 'dsh-collab/awareness', 'context name is dsh-collab/awareness')
ok(!!capturedPromptContext && capturedPromptContext.order === 130, 'context order is 130 (after sandbox/approval/subagent-delegation)')
ok(!!capturedPromptContext && typeof capturedPromptContext.text === 'function', 'context text is a live provider function')
if (!capturedPromptContext) { console.log(`\nFAILURES: ${h.pass}, ${h.fail}`); process.exit(1) }

const statePath = projectStateFile(PROJECT_CWD)
const now = Date.now()

console.log('# no foreign claims -> generic collaboration guidance')
{
  const first = capturedPromptContext.text()
  ok(typeof first === 'string' && first.length > 0, 'cold cache still yields guidance')
  ok(first.includes('collab_lock'), 'guidance names the collab_lock tool', first)

  // 植入一条**他人**的独占声明
  const s = init()
  s.claims.push({
    claimId: 'c_foreign', holderId: 'agent-someone-else', holderName: 'Other Session',
    paths: ['src/backend/'], mode: 'exclusive', ttlSec: 1800,
    expiresAt: now + 25 * 60 * 1000, note: '', createdAt: now
  })
  // 以及一条**自己**的声明（应当被摘要排除）
  s.claims.push({
    claimId: 'c_mine', holderId: 'agent:' + ME.id, holderName: 'Me',
    paths: ['src/mine/'], mode: 'exclusive', ttlSec: 1800,
    expiresAt: now + 25 * 60 * 1000, note: '', createdAt: now
  })
  store.set(statePath, JSON.stringify(s))
}

console.log('# foreign claim -> live digest with holder, path, absolute lease window and next action')
{
  capturedPromptContext.text()            // 触发一次异步刷新（fire-and-forget）
  await new Promise((r) => setTimeout(r, 80))
  const text = capturedPromptContext.text()
  ok(text.includes('Other Session'), 'digest names the other session', text)
  ok(text.includes('src/backend/'), 'digest names the claimed path', text)
  // 租约用**绝对 UTC 起止时刻**呈现，而不是「剩 N 分」倒计时：
  // 文本时间无关，DSH 的运行时上下文快照去重（rendered === retained.text 即不提交）才能生效。
  ok(/租约 \d+ 分（\d{2}-\d{2} \d{2}:\d{2}Z–\d{2}-\d{2} \d{2}:\d{2}Z）/.test(text),
    'digest reports an absolute UTC lease window', text)
  ok(!/剩 \d+ 分/.test(text), 'digest no longer prints a relative countdown', text)
  ok(text.includes('collab_lock') || text.includes('collab_board'), 'digest points at the negotiation tools', text)
  ok(!text.includes('src/mine/'), 'digest excludes the caller own claim', text)
}

console.log('# expired foreign claim -> back to generic guidance')
{
  const s = JSON.parse(store.get(statePath))
  s.claims = s.claims.filter((c) => c.claimId !== 'c_foreign')
  store.set(statePath, JSON.stringify(s))
  await new Promise((r) => setTimeout(r, 400)) // 超过缩短后的 DIGEST_TTL_MS，强制下次 text() 重新刷新
  capturedPromptContext.text()
  await new Promise((r) => setTimeout(r, 80))
  const text = capturedPromptContext.text()
  ok(!text.includes('Other Session'), 'expired/removed foreign claim disappears from digest', text)
}

console.log('# opt-out: DSH_COLLAB_NO_PROMPT_HINT=1 registers no context')
{
  process.env.DSH_COLLAB_NO_PROMPT_HINT = '1'
  let captured2 = null
  const contexts2 = new Map()
  const ctx2 = new Context()
  for (const n of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'agents', 'systemPrompt']) ctx2.provide(n)
  ctx2.set('tools', { register: () => () => {} })
  ctx2.set('timer', { timeout: () => Promise.resolve(), interval: () => () => {} })
  ctx2.set('fs', {
    resolve: async (p) => ({ displayPath: p, path: p }),
    stat: async () => null,
    readText: async () => '',
    writeText: async () => {},
    processPath: (t) => t.path
  })
  ctx2.set('sessions', { get: () => undefined })
  ctx2.set('sessionTitle', { get: () => undefined })
  ctx2.set('agents', { currentInitiator: () => ME, list: () => [ME] })
  ctx2.set('systemPrompt', { context: (c) => { contexts2.set(c.name, c); return () => {} } })
  await ctx2.plugin(collabPlugin)
  captured2 = contexts2.get('dsh-collab/awareness') || null
  ok(captured2 === null, 'opt-out env var suppresses PromptContext registration', String(captured2 && captured2.name))
  ok(contexts2.size === 0, 'opt-out env var suppresses every runtime PromptContext', [...contexts2.keys()].join(','))
  delete process.env.DSH_COLLAB_NO_PROMPT_HINT
}

h.finish()
