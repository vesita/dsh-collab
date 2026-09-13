import { createHarness } from './_harness.mjs'

// collab-access-gate.mjs
// 功能 A（访问时的路径相关通知）与功能 C（可读性 + 原生写保护）的回归测试。
//
// 覆盖面：
//   1) 三个纯函数 accessScope / claimsForAccess / renderAccessNotice（含题面给的边界例）；
//      以及功能 C 用的 claimsCovering、relToProject、isReadable。
//   2) 真正注册出来的 ctx.on('tools/post-execute') 监听器 + **真实的 agent.inject 投递面**：
//      **原样返回 downstream**（不产生 content / value / additionalContexts 任何改动），命中即经
//      `agent.inject` 投递一条**显式标注来源**的 notice 消息
//      （`source.kind='plugin'` / `plugin='dsh-collab'` / `form='notice'` / 非空 `summary`），
//      按 agent 的 accessSignature 去重、block 分支、无路径/无命中/自己的声明/过期一律不投递、
//      正文与 renderAccessNotice(entries) 逐字一致、agent 没有 inject 时**不投递也不退回自造消息**、
//      异常安全、卸载后监听器回收且不再 inject。
//   3) 真正注册出来的 ctx.on('tools/pre-execute') 监听器：ask 判定、原样放行、
//      readable:false 的读拦截、settings 门控关掉后不再拦。
//   4) 功能 C 的 **mode 过滤**回归（0.8.1）：`shared` / `read` 声明既不拦写也不拦读
//      （0.8.0 会拦，导致"另一个会话按提示用 mode=read 做只读调研"就把所有人的写入挡死），
//      `exclusive` 仍然拦（反向对照，防修过头）；并与 claim() 的冲突判据**逐例一致性对照**
//      （同一组声明 + 同一目标路径，两套判据必须给出同一结论 —— 防将来再次漂移）。
//
// 载体（规范见 AGENTS.md §1「严禁冒充用户」）：通知**不再**是 systemPrompt 上下文段
// （`dsh-collab/access` order 132 已随旧载体删除，本文件显式断言它**不许复活**），
// 而是逐事件经 `agent.inject` 投递 `form:'notice'` 的消息 —— 客户端按 `source.kind !== 'user'`
// 把它渲染成 **notice 行、不是用户气泡**；`summary` 缺失才会退化成 opaque 行。
// `id` / `role` / 深冻结全部由真实的 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 补，
// 本仓库不手抄副本。
//
// 为什么可以在 node 里测这两条：它们是 Host 面（cordis 事件 + 假 agent + 假 fs），不涉及浏览器 React。
// 用真实 Cordis Context 注册，再用 ctx.waterfall 驱动 —— 与 dsh-tools 的调用形态同构
// （dsh-tools/lib/index.js:3116 用 ctx.waterfall(carrier, 'tools/pre-execute', exec, next)）。
// `inject` 是**假 agent** 上的记录器：真机上它进的是 next-step 收件箱，这里只钉插件侧契约
// （调用几次 / 消息形状 / 来源标签），不断言"真机一定投得到"。
//
// 运行：node tests/collab-access-gate.mjs

import path from 'node:path'
import os from 'node:os'
import { readFileSync } from 'node:fs'

const cordis = await import('@deepseek-ai/cordis').catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
const { Context } = cordis

const ROOT = path.dirname(new URL(import.meta.url).pathname)
process.env.DSH_HOME = path.join(os.tmpdir(), 'collab-gate-' + process.pid)
delete process.env.DSH_COLLAB_NO_PROMPT_HINT

const core = await import(path.join(ROOT, '../lib/collab-core.js'))
const { projectStateFile } = await import(path.join(ROOT, '../lib/paths.js'))
const mod = await import(path.join(ROOT, '../lib/index.js'))
const collabPlugin = mod.default

const { accessScope, claimsForAccess, renderAccessNotice, claimsCovering, relToProject, isReadable, clockUtc } = core

const h = createHarness()
const { ok } = h

const T0 = Date.UTC(2026, 0, 2, 3, 4, 37)
const HOUR = 3600 * 1000
const mkClaim = (o) => Object.assign({
  claimId: 'c_x', holderId: 'agent:other', holderName: 'Other', paths: ['src/x/'],
  mode: 'exclusive', ttlSec: 1800, expiresAt: T0 + 1800 * 1000, note: '', createdAt: T0
}, o)

// ════════════════════════════════════════════════════════════════════════
// 1. 纯函数
// ════════════════════════════════════════════════════════════════════════
console.log('# accessScope: 父目录、归一化、带尾 /')
{
  ok(accessScope('src/a/1') === 'src/a/', 'src/a/1 -> src/a/', accessScope('src/a/1'))
  ok(accessScope('src/a/') === 'src/', 'src/a/ -> src/', accessScope('src/a/'))
  ok(accessScope('src') === '', 'src -> 空串', JSON.stringify(accessScope('src')))
  ok(accessScope('./src/a/1') === 'src/a/', 'norm 生效：./src/a/1 -> src/a/', accessScope('./src/a/1'))
  ok(accessScope('src//a///1') === 'src/a/', '重复斜杠归一', accessScope('src//a///1'))
  ok(accessScope('') === '', '空串 -> 空串')
  ok(accessScope('/') === '', '根 -> 空串', JSON.stringify(accessScope('/')))
  ok(accessScope('a') === '', '单段 -> 空串')
}

console.log('# claimsForAccess: 题面给的边界例（访问 src/a/1）')
{
  const c2 = mkClaim({ claimId: 'c_2', paths: ['src/a/2'] })
  const c2a = mkClaim({ claimId: 'c_2a', paths: ['src/a/2/A'] })
  const cd = mkClaim({ claimId: 'c_dir', paths: ['src/a/'] })
  const cs = mkClaim({ claimId: 'c_src', paths: ['src/'] })
  const cb = mkClaim({ claimId: 'c_b', paths: ['src/b'] })
  const co = mkClaim({ claimId: 'c_other', paths: ['other/'] })
  const all = [c2, c2a, cd, cs, cb, co]
  const hit = claimsForAccess(all, 'src/a/1', T0).map(c => c.claimId).sort()
  ok(JSON.stringify(hit) === JSON.stringify(['c_2', 'c_2a', 'c_dir', 'c_src']),
    '命中 src/a/2、src/a/2/A、src/a/、src/（且只命中这四个）', JSON.stringify(hit))
  ok(!hit.includes('c_b'), '不命中 src/b')
  ok(!hit.includes('c_other'), '不命中 other/')
  ok(claimsForAccess(all, 'src/a/1', T0 + 10 * HOUR).length === 0, '过期声明全部排除')
  ok(claimsForAccess(all, '', T0).length === 0, '空访问路径 -> 无命中')
  // 访问**目录本身** src/a/ 时父目录是 src/：按题面判据 ov(P, accessScope) ，src/b 落在
  // src/ 之下，因此**会**被算作相关（这是 A 作为"提示"的宽口径；功能 C 的强制口径不用它）。
  ok(claimsForAccess([cb], 'src/a/', T0).length === 1, '访问 src/a/ 会命中 src/ 下的兄弟路径 src/b（宽口径）')
  ok(claimsForAccess([cs], 'src/a/b/c', T0).length === 1, '祖先声明命中深层访问')
  ok(claimsForAccess([c2], 'src/a/1', T0)[0] === c2, '返回的是原 claim 对象（不复制）')
}

console.log('# renderAccessNotice: 紧凑 + 时间稳定（无倒计时）')
{
  const A = mkClaim({ claimId: 'c_a', holderId: 'agent:a', holderName: 'Alpha', paths: ['src/a/'] })
  const B = mkClaim({ claimId: 'c_b', holderId: 'agent:b', holderName: 'Beta', paths: ['src/b/'], mode: 'shared', expiresAt: T0 + 900 * 1000, ttlSec: 900 })
  const C = mkClaim({ claimId: 'c_c', holderId: 'agent:c', holderName: 'Gamma', paths: ['src/c/'], expiresAt: T0 + 2 * HOUR, ttlSec: 2 * 3600 })
  const text = renderAccessNotice([A, B])
  ok(renderAccessNotice([A, B]) === text, '同输入两次调用逐字节相同')
  ok(renderAccessNotice([B, A]) === text, '输入顺序不影响输出（确定性）')
  ok(renderAccessNotice(JSON.parse(JSON.stringify([A, B]))) === text, '结构相等的新对象同输出')
  ok(renderAccessNotice.length === 1, '签名只有一个形参（没有 now/time）', 'length=' + renderAccessNotice.length)
  ok(!/Date\.now|new Date\(\)|performance\.now/.test(renderAccessNotice.toString()), '函数体不读当前时钟')
  ok(/租约 30 分（01-02 03:04Z–01-02 03:34Z）/.test(text), '沿用绝对 UTC 租约窗口写法', text)
  ok(clockUtc(T0) === '01-02 03:04Z', 'clockUtc 锚点仍是 01-02 03:04Z')
  ok(!/剩\s*\d+\s*分/.test(text), '没有「剩 N 分」倒计时', text)
  ok(!/剩余|还剩|倒计时|remaining|countdown/i.test(text), '没有其他相对剩余措辞', text)
  ok(/^\[dsh-collab\] /.test(text), '保留 [dsh-collab] 前缀', text)
  ok(text.includes('Alpha') && text.includes('Beta') && text.includes('src/a/'), '点出持有者与路径', text)
  ok(text.includes('不可读') === false, '默认可读时不出现「不可读」', text)
  const noRead = renderAccessNotice([mkClaim({ claimId: 'c_nr', paths: ['src/nr/'], readable: false })])
  ok(noRead.includes('不可读'), 'readable:false 会渲染成「不可读」', noRead)
  // 回归：readable 只对 exclusive 有门控意义（writeGate 对 shared/read 一律放行），
  // 所以非 exclusive 声明**不得**渲染「不可读」——那会让只读声明显得像在读侧拦人。
  const sharedNoRead = renderAccessNotice([mkClaim({ claimId: 'c_snr', paths: ['src/snr/'], mode: 'shared', readable: false })])
  ok(sharedNoRead.includes('不可读') === false, 'shared + readable:false 不再谎报「不可读」', sharedNoRead)
  const readNoRead = renderAccessNotice([mkClaim({ claimId: 'c_rnr', paths: ['src/rnr/'], mode: 'read', readable: false })])
  ok(readNoRead.includes('不可读') === false, 'read + readable:false 不再谎报「不可读」（OPEN_HINT 推荐用法）', readNoRead)
  ok(sharedNoRead.includes('（shared）') && readNoRead.includes('（read）'), '非 exclusive 仍点出 mode 本身', JSON.stringify([sharedNoRead, readNoRead]))
  ok(renderAccessNotice([mkClaim({ claimId: 'c_ex', paths: ['src/ex/'], readable: false })]).includes('（exclusive，不可读）'),
    'exclusive + readable:false 仍保留完整标注（门控真的生效）')
  const three = renderAccessNotice([A, B, C])
  ok(three.includes('；另有 1 条'), '超过 2 条折叠成计数', three)
  ok(!three.includes('Gamma'), '第 3 条不展开名字', three)
  ok(!renderAccessNotice([A, B]).includes('undefined'), '不泄漏 undefined')
  ok(renderAccessNotice([A, B]) !== renderAccessNotice([A]), '集合变化 -> 文本变化')
}

console.log('# claimsCovering / relToProject / isReadable（功能 C 的判据）')
{
  const cd = mkClaim({ claimId: 'c_dir', paths: ['src/a/'] })
  const c2 = mkClaim({ claimId: 'c_2', paths: ['src/a/2'] })
  ok(claimsCovering([cd], 'src/a/1', T0).length === 1, '目录声明覆盖其下文件')
  ok(claimsCovering([c2], 'src/a/1', T0).length === 0, '兄弟声明**不**覆盖（窄口径，避免假阳性硬拒绝）')
  ok(claimsCovering([c2], 'src/a/2', T0).length === 1, '同路径自己覆盖自己')
  ok(claimsCovering([cd], 'src/a/1', T0 + 10 * HOUR).length === 0, '过期声明排除')
  ok(relToProject('/repo/src/a/1', '/repo') === 'src/a/1', '去掉 cwd 前缀')
  ok(relToProject('/repo/src/a/1', '/repo/') === 'src/a/1', 'cwd 带尾斜杠也能去')
  ok(relToProject('/other/src/a/1', '/repo') === 'other/src/a/1', '不在 cwd 之下则原样归一')
  ok(relToProject('src/a/1', null) === 'src/a/1', '无 cwd 时原样')
  ok(relToProject('/repo', '/repo') === '', '恰好等于 cwd -> 空串')
  ok(isReadable({ readable: false }) === false, 'isReadable: 显式 false -> 不可读')
  ok(isReadable({}) === true, 'isReadable: 缺字段（老状态文件）-> 可读')
  ok(isReadable({ readable: true }) === true, 'isReadable: true -> 可读')
}

// ════════════════════════════════════════════════════════════════════════
// 2. 真实注册出来的监听器
// ════════════════════════════════════════════════════════════════════════
const CWD = '/fake/project/gate'

/** 极简假 fs（内存 + 版本号），语义与 e2e harness 的 fs 对齐（乐观并发那一步用得上）。
 *  calls 用来数读次数：去重断言要靠"重复命中不再走一次反向登记的 mutate"来证伪。 */
function makeFs(store, versions, opts = {}, calls) {
  return {
    resolve: async (p) => ({ displayPath: p, path: p }),
    stat: async (t) => {
      if (calls) calls.stat++
      return store.has(t.path) ? { version: versions.get(t.path) || 1 } : null
    },
    readText: async (t) => {
      if (calls) calls.readText++
      if (opts.readThrows && opts.readThrows(t.path)) throw new Error('boom: read failed')
      return store.get(t.path) || ''
    },
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

const settle = () => new Promise((r) => setTimeout(r, 20))

/**
 * 造一个装着本插件的真实 Cordis Context。
 * @param opts.claims    预置状态文件里的 claims
 * @param opts.readThrows 让 readText 抛错的判据（测异常安全）
 * @param opts.settings  用户设置（缺省 = 两个字段都 true）
 * @param opts.settingsWritable  false 时 installSection 交出一个只读读取器
 * @param opts.initiator 当前会话的 agent（agents.currentInitiator 的返回值；缺省 ME）
 *
 * systemPrompt 服务**照常提供**，但只当**探测器**用：新载体（`agent.inject`）根本不碰它。
 * awareness 段会被它接住，所以"没有注册 dsh-collab/access 段"是一条**非空**断言（见 A 段）。
 */
async function makeHarness(opts = {}) {
  const store = new Map()
  const versions = new Map()
  const calls = { stat: 0, readText: 0, writeText: 0 }
  const tools = []
  const prompts = []
  // 按 name 索引已注册的运行时上下文段（与 tests/collab-awareness.mjs、collab-skill.mjs 的假服务同形）。
  // **只是探测器**：功能 A 的通知已经不走上下文段了。
  const contexts = new Map()
  const statePath = projectStateFile(CWD)
  if (opts.claims) {
    store.set(statePath, JSON.stringify({ schemaVersion: 1, seq: opts.claims.length, claims: opts.claims, messages: [], holders: [] }))
    versions.set(statePath, 1)
  }

  let hooks = null
  let initiator = opts.initiator || ME
  let value = Object.assign({ exposeDelegationDiscipline: true, enforceWriteLock: true }, opts.settings || {})
  const ctx = new Context()
  const services = ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'agents', 'systemPrompt']
  if (opts.settings !== undefined) services.push('settings')
  if (opts.withController) services.push('sessionController')
  for (const n of services) ctx.provide(n)

  ctx.set('tools', { register: (t) => { tools.push(t); return () => {} } })
  ctx.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} })
  ctx.set('fs', makeFs(store, versions, opts, calls))
  ctx.set('sessions', { get: () => ({ header: { cwd: CWD } }) })
  ctx.set('sessionTitle', { get: () => ({ title: 'Gate Worker' }) })
  ctx.set('agents', {
    currentInitiator: () => initiator,
    list: () => [],
    get: (id) => (opts.liveSessions && opts.liveSessions.includes(id) ? { id } : undefined)
  })
  // 假 systemPrompt：只记录注册进来的运行时上下文段。**它不是功能 A 的载体**（那是 agent.inject），
  // 留在这里是为了让"没有注册 dsh-collab/access 段"有一个活着的对照物（awareness 段）。
  ctx.set('systemPrompt', {
    context: (c) => {
      contexts.set(c.name, c)
      return () => { if (contexts.get(c.name) === c) contexts.delete(c.name) }
    }
  })
  if (opts.settings !== undefined) {
    ctx.set('settings', {
      installSection: (_owner, _ns, _schema, _entry, h) => {
        hooks = h
        h.setSource(() => value)
        h.onChange()
      }
    })
  }
  if (opts.withController) {
    ctx.set('sessionController', {
      prompt: async (request, _signal) => { prompts.push(request); return { accepted: true } },
      list: async () => ({ items: (opts.sessionRows || []).slice() })
    })
  }

  const fiber = await ctx.plugin(collabPlugin)
  await settle()

  const readState = () => JSON.parse(store.get(statePath) || '{}')
  const writeState = (doc) => { store.set(statePath, JSON.stringify(doc)); versions.set(statePath, (versions.get(statePath) || 0) + 1) }

  return {
    ctx, tools, store, versions, statePath, prompts, readState, writeState, fiber,
    contexts, calls,
    set(patch) { value = Object.assign({}, value, patch); if (hooks) hooks.onChange() },
    current: () => value,
    /** 当前会话（agents.currentInitiator()）—— 只影响 awareness 段，与功能 A 的投递面无关。 */
    setInitiator(a) { initiator = a },
    /** 驱动 post-execute 瀑布：返回 { decision, downstream, nextCalls }。 */
    async post(exec, downstream = { kind: 'accept' }) {
      const produced = { ...downstream }
      let nextCalls = 0
      const decision = await ctx.waterfall('tools/post-execute', exec, produced, () => {
        nextCalls++
        return Promise.resolve(produced)
      })
      return { decision, downstream: produced, nextCalls }
    },
    /** 驱动 pre-execute 瀑布：返回 { decision, nextCalls }。 */
    async pre(exec) {
      let nextCalls = 0
      const decision = await ctx.waterfall('tools/pre-execute', exec, () => {
        nextCalls++
        return Promise.resolve({ kind: 'allow' })
      })
      return { decision, nextCalls }
    }
  }
}

// ── agent.inject 捕获：新载体（逐事件 notice）的观测点 ──────────────────
// 每个用例开头 resetInject()；ME 自带 inject，NO_INJECT_AGENT **故意没有**。
let injectLog = []
const resetInject = () => { injectLog = [] }
/** 从 inject 记录里取正文（防御性：拿不到就返回空串，让断言失败而不是抛）。 */
const noticeText = (entry) => (entry && entry.message && entry.message.content && entry.message.content[0] && entry.message.content[0].text) || ''
/** 带记录器的假 agent：inject 把每次调用记进 injectLog。 */
const withInject = (id) => ({ id, session: { header: { cwd: CWD } }, inject: (m) => injectLog.push({ agent: id, message: m }) })
const ME = withInject('agent-me')
/** 故意**没有** inject 的 agent：受限宿主上的 agent 形状（契约要求此时不投递、不抛）。 */
const NO_INJECT_AGENT = { id: 'agent-no-inject', session: { header: { cwd: CWD } } }
/** holderId 的形状是 'agent:' + agent.id（与 index.ts 的 holderOf 一致）。 */
const ME_HOLDER = 'agent:' + ME.id
const execOf = (name, args, agent = ME) => ({ name, arguments: args, agent })

// ── 功能 A：post-execute 原样返回 + agent.inject 交出通知 ────────────────
console.log('# A: post-execute 原样返回 downstream，通知经 agent.inject 投递显式来源的 notice')
{
  resetInject()
  const foreign = mkClaim({ claimId: 'c_other', holderId: 'agent:other', holderName: 'Other Session', paths: ['src/a/2'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign] })

  // ── 载体自查：**访问通知不再是 systemPrompt 上下文段** ──
  // 假 systemPrompt 是活的（awareness 段被它接住），所以"没有 access 段"不是空断言。
  ok(h.contexts.has('dsh-collab/awareness'), '假 systemPrompt 确实接住了其它上下文段（否则下一条是空断言）',
    JSON.stringify([...h.contexts.keys()]))
  ok(!h.contexts.has('dsh-collab/access'), '访问通知**不再**注册 dsh-collab/access 上下文段（载体已换）',
    JSON.stringify([...h.contexts.keys()]))
  const accessSrc = readFileSync(path.join(ROOT, '../src/access.ts'), 'utf8')
  ok(!/systemPrompt/.test(accessSrc), 'src/access.ts 源码里不再出现 systemPrompt（载体不许改回去）')
  ok(!/dsh-collab\/access/.test(accessSrc), "src/access.ts 源码里不再出现 'dsh-collab/access'")

  // ── 未命中过的会话：一次 inject 都没有 ──
  ok(injectLog.length === 0, '未命中前没有任何 inject 调用', 'injects=' + injectLog.length)

  // ── 命中：工具结果原样，通知经 inject 投递一条 ──
  const { decision, downstream, nextCalls } = await h.post(execOf('read', { file_path: 'src/a/1' }))
  ok(decision === downstream, 'post-execute 返回的就是 downstream 本身（===，不再造新决策对象）')
  ok(!('additionalContexts' in decision), '决策对象上没有 additionalContexts 字段（载体已换）', Object.keys(decision).join(','))
  ok(decision.kind === 'accept' && JSON.stringify(decision) === JSON.stringify(downstream), '工具结果一字未改', JSON.stringify(decision))
  ok(nextCalls === 1, '命中路径上 next() 恰好一次', 'nextCalls=' + nextCalls)

  // ── 非重复命中 ⇒ inject 恰好一次 ──
  ok(injectLog.length === 1, '非重复命中 -> agent.inject 恰好调用一次', 'injects=' + injectLog.length)
  const delivered = injectLog[0]
  ok(!!delivered && delivered.agent === ME.id, '投递到的是发起本次工具调用的那个 agent', String(delivered && delivered.agent))
  const msg = delivered && delivered.message

  // ── 消息是**显式标注来源**的 notice（不冒充真人）──
  ok(!!msg && !!msg.source && msg.source.kind === 'plugin', "source.kind === 'plugin'（不是 user，不冒充真人）", JSON.stringify(msg && msg.source))
  ok(!!msg && !!msg.source && msg.source.plugin === 'dsh-collab', "source.plugin === 'dsh-collab'", String(msg && msg.source && msg.source.plugin))
  ok(!!msg && !!msg.source && msg.source.form === 'notice', "source.form === 'notice'（客户端据此渲染成 notice 行）", String(msg && msg.source && msg.source.form))
  const summary = msg && msg.source && msg.source.summary
  ok(typeof summary === 'string' && summary.length > 0, 'summary 是非空字符串（notice 缺 summary 会退化成 opaque）', JSON.stringify(summary))
  ok(typeof summary === 'string' && summary.length <= 120, 'summary 不超过 120 字符（boundContextSummary 的上限）', 'len=' + (typeof summary === 'string' ? summary.length : 'n/a'))

  // ── 构造函数补的字段：role / id / 深冻结 ──
  ok(!!msg && msg.role === 'user', "role === 'user' 由 createUserMessage 自动补（不是我们手写）", String(msg && msg.role))
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  ok(!!msg && UUID_V4.test(String(msg.id)), 'id 是 uuid v4 形状（由构造函数生成）', String(msg && msg.id))
  ok(!!msg && Object.isFrozen(msg), '消息对象深冻结（Object.isFrozen）')
  ok(!!msg && Array.isArray(msg.content) && Object.isFrozen(msg.content), 'content 数组深冻结', typeof (msg && msg.content))
  ok(!!msg && !!msg.content && !!msg.content[0] && Object.isFrozen(msg.content[0]), 'content[0] 内容块深冻结')

  // ── 正文与 renderAccessNotice(entries) 逐字一致 ──
  const entries = claimsForAccess(h.readState().claims, 'src/a/1', Date.now())
  const text = renderAccessNotice(entries)
  ok(!!msg && !!msg.content && !!msg.content[0] && msg.content[0].type === 'text', "content[0].type === 'text'", JSON.stringify(msg && msg.content && msg.content[0] && msg.content[0].type))
  ok(noticeText(delivered) === text, '正文与 renderAccessNotice(entries) 逐字一致', JSON.stringify(noticeText(delivered)))
  ok(noticeText(delivered).includes('Other Session'), '通知点出持有者名', noticeText(delivered))
  ok(noticeText(delivered).includes('src/a/2'), '通知点出被占路径', noticeText(delivered))
  ok((text.match(/\[dsh-collab\]/g) || []).length === 1, '正文里只有一条通知（没有叠加两次）', String((text.match(/\[dsh-collab\]/g) || []).length))

  // ── summary 是一行折叠文案，不是正文全文；且含首条被占路径 ──
  ok(summary !== text, 'summary 不等于正文全文（它是一行折叠文案）', JSON.stringify(summary))
  ok(typeof summary === 'string' && summary.includes('src/a/2'), 'summary 包含首条被占路径', JSON.stringify(summary))
  ok(typeof summary === 'string' && summary.length < text.length, 'summary 比正文短（折叠成一行）', 'summary=' + (typeof summary === 'string' ? summary.length : 'n/a') + ' text=' + text.length)

  // ── 读者反向登记（功能 D 接缝未变）──
  ok((h.readState().claims[0].readers || []).includes(ME_HOLDER), '通知的同时把自己反向登记为 reader（功能 D 接缝未变）', JSON.stringify(h.readState().claims[0].readers))

  // ── 重复命中 ⇒ 不再 inject；且不再走一次反向登记的 mutate ──
  // 两个可观测量：inject 次数不涨；且**不再走一次反向登记的 mutate**
  // （重复分支只做 accessEntries 的那一次 load，首次还要多一次 registerAccessReaders 的 load）。
  const firstReads = h.calls.readText
  const again = await h.post(execOf('read', { file_path: 'src/a/1' }))
  ok(again.decision === again.downstream && !('additionalContexts' in again.decision), '重复访问仍然原样放行')
  ok(injectLog.length === 1, '重复命中 -> 不再 inject（仍是一条）', 'injects=' + injectLog.length)
  ok(h.calls.readText - firstReads === 1,
    '重复命中不再做一次反向登记（状态只读 1 次；首次是 2 次：accessEntries + registerReaders）',
    'delta=' + (h.calls.readText - firstReads))

  // ── 另一个 agent 各调一次（去重键是 agent 对象）──
  const otherAgent = withInject('agent-other-me')
  h.setInitiator(otherAgent)
  await h.post(execOf('read', { file_path: 'src/a/1' }, otherAgent))
  ok(injectLog.length === 2, '另一个 agent 命中同一组占用 -> 自己那条 inject', 'injects=' + injectLog.length)
  ok(injectLog.length > 1 && injectLog[1].agent === otherAgent.id, '第二条投递给第二个 agent', String(injectLog[1] && injectLog[1].agent))
  ok(injectLog.length > 1 && noticeText(injectLog[1]) === text, '第二个 agent 拿到的正文与第一个逐字相同')
  ok((h.readState().claims[0].readers || []).includes('agent:' + otherAgent.id), '第二个 agent 也被登记', JSON.stringify(h.readState().claims[0].readers))
  // 第三个 agent 从未命中过：新载体里根本没有"共享槽位"，所以它不会凭空拿到别人的通知。
  const thirdAgent = withInject('agent-third-me')
  h.setInitiator(thirdAgent)
  ok(injectLog.length === 2, '从未命中过的第三个 agent 不会凭空收到别人的通知（没有共享槽位）', 'injects=' + injectLog.length)
  await h.post(execOf('read', { file_path: 'src/a/1' }, thirdAgent))
  ok(injectLog.length === 3 && injectLog[2].agent === thirdAgent.id, '第三个 agent 自己命中 -> 投递自己的一条', 'injects=' + injectLog.length)
  h.setInitiator(ME)
  const back = await h.post(execOf('read', { file_path: 'src/a/1' }))
  ok(back.decision === back.downstream && injectLog.length === 3, '切回原 agent 重复命中仍然不投递（各自的去重键互不影响）', 'injects=' + injectLog.length)
}

console.log('# A: block 分支 / 无命中 / 无候选 / 绝对路径 / 自己的声明 / 过期 —— 一律不投递，读者不被改动')
{
  const foreign = mkClaim({ claimId: 'c_other', holderId: 'agent:other', holderName: 'Other Session', paths: ['src/a/2'], expiresAt: Date.now() + HOUR })
  resetInject()
  const h = await makeHarness({ claims: [foreign] })

  const feedback = [{ type: 'text', text: 'blocked' }]
  const blocked = await h.post(execOf('read', { file_path: 'src/a/1' }), { kind: 'block', feedback })
  ok(blocked.decision.kind === 'block', 'block 决策保持 kind=block', JSON.stringify(blocked.decision.kind))
  ok(blocked.decision.feedback === feedback, 'feedback 原样保留（同一引用）')
  ok(blocked.decision === blocked.downstream, 'block 分支同样原样返回 downstream 本身')
  ok(!('additionalContexts' in blocked.decision), 'block 决策上没有 additionalContexts 字段')
  ok(injectLog.length === 1 && noticeText(injectLog[0]).includes('src/a/2'),
    'block 分支命中后仍然投递通知（通知与工具结果两条路）', 'injects=' + injectLog.length)

  resetInject()
  const h2 = await makeHarness({ claims: [foreign] })
  const miss = await h2.post(execOf('read', { file_path: 'src/zzz/1' }))
  ok(miss.decision === miss.downstream && !('additionalContexts' in miss.decision), '无相关占用 -> 原样放行')
  ok(injectLog.length === 0, '无命中 -> 不投递', 'injects=' + injectLog.length)
  ok((h2.readState().claims[0].readers || []).length === 0, '无命中 -> 读者不被改动', JSON.stringify(h2.readState().claims[0].readers))
  const noPaths = await h2.post(execOf('read', {}))
  ok(noPaths.decision === noPaths.downstream, '提不出候选路径 -> 原样放行')
  ok(injectLog.length === 0, '无候选路径 -> 不投递', 'injects=' + injectLog.length)
  const abs = await h2.post(execOf('read', { file_path: CWD + '/src/a/1' }))
  ok(abs.decision === abs.downstream && !('additionalContexts' in abs.decision),
    '绝对路径按 cwd 归一到项目相对后仍命中（且不改工具结果）')
  ok(injectLog.length === 1 && noticeText(injectLog[0]).includes('src/a/2'),
    '绝对路径归一后命中 -> 投递一条并点出被占路径', 'injects=' + injectLog.length + ' ' + JSON.stringify(noticeText(injectLog[0]).slice(0, 40)))

  resetInject()
  const mine = mkClaim({ claimId: 'c_mine', holderId: ME_HOLDER, holderName: 'Me', paths: ['src/a/2'], expiresAt: Date.now() + HOUR })
  const h3 = await makeHarness({ claims: [mine] })
  const own = await h3.post(execOf('read', { file_path: 'src/a/1' }))
  ok(own.decision === own.downstream, '自己的声明不通知自己')
  ok(injectLog.length === 0, '自己的声明 -> 不投递', 'injects=' + injectLog.length)

  resetInject()
  const expired = mkClaim({ claimId: 'c_old', holderId: 'agent:other', paths: ['src/a/2'], expiresAt: Date.now() - 1000 })
  const h4 = await makeHarness({ claims: [expired] })
  const gone = await h4.post(execOf('read', { file_path: 'src/a/1' }))
  ok(gone.decision === gone.downstream, '过期声明不通知')
  ok(injectLog.length === 0, '声明已过期 -> 不投递', 'injects=' + injectLog.length)

  // 字符串数组里的候选路径（题面要求"含字符串数组"）。用干净实例，避开上面的去重状态。
  resetInject()
  const h5 = await makeHarness({ claims: [foreign] })
  const arr = await h5.post(execOf('collab_board', { op: 'post', body: 'hi', mentions: ['src/a/2'] }))
  ok(arr.decision === arr.downstream && !('additionalContexts' in arr.decision), '字符串数组命中同样不改工具结果')
  ok(injectLog.length === 1 && noticeText(injectLog[0]).includes('src/a/2'),
    'mentions 这类字符串数组里的路径也参与候选提取，命中后通知点出该路径',
    'injects=' + injectLog.length + ' ' + JSON.stringify(noticeText(injectLog[0])))
  // body 里的自由文本同样会被当作候选字符串，但它不是路径（'hi' 没有父目录），不会命中。
  resetInject()
  const h6 = await makeHarness({ claims: [foreign] })
  const bodyOnly = await h6.post(execOf('collab_board', { op: 'post', body: 'hi' }))
  ok(bodyOnly.decision === bodyOnly.downstream, '非路径的自由文本不产生通知（无命中即放行）')
  ok(injectLog.length === 0, '非路径自由文本 -> 不投递', 'injects=' + injectLog.length)
}

console.log('# A: 去重键是 per-agent 的 accessSignature —— 占用集合一变就再投一条（新载体没有 TTL）')
{
  const a1 = mkClaim({ claimId: 'c_one', holderId: 'agent:other', holderName: 'Other Session', paths: ['src/a/2'], expiresAt: Date.now() + HOUR })
  resetInject()
  const h = await makeHarness({ claims: [a1] })

  await h.post(execOf('read', { file_path: 'src/a/1' }))
  ok(injectLog.length === 1, '第一次命中投递一条', 'injects=' + injectLog.length)
  const firstText = noticeText(injectLog[0])

  await h.post(execOf('read', { file_path: 'src/a/1' }))
  ok(injectLog.length === 1, '同一组占用重复命中不再投递', 'injects=' + injectLog.length)

  // 占用集合变化（多了一条他人的声明）-> 新的 accessSignature -> 再投一条。
  const a2 = mkClaim({ claimId: 'c_two', holderId: 'agent:other2', holderName: 'Second Session', paths: ['src/a/3'], expiresAt: Date.now() + HOUR })
  h.writeState(Object.assign(h.readState(), { claims: h.readState().claims.concat([a2]) }))
  await h.post(execOf('read', { file_path: 'src/a/1' }))
  ok(injectLog.length === 2, '占用集合变化 -> 重新投递一条', 'injects=' + injectLog.length)
  const secondText = noticeText(injectLog[1])
  ok(secondText !== firstText && secondText.includes('Second Session'),
    '第二条正文写的是新增后的占用集合（不是重发旧文本）', JSON.stringify(secondText))
  ok(secondText.includes('src/a/3'), '第二条正文点出新占用的路径', JSON.stringify(secondText))

  await h.post(execOf('read', { file_path: 'src/a/1' }))
  ok(injectLog.length === 2, '新签名之后的重复命中同样不再投递', 'injects=' + injectLog.length)

  // 另一个 agent 有自己的去重键：第一次命中就投一条，重复不再投。
  const other = withInject('agent-sig-other')
  await h.post(execOf('read', { file_path: 'src/a/1' }, other))
  ok(injectLog.length === 3, '另一个 agent 有独立的去重键 -> 自己投一条', 'injects=' + injectLog.length)
  await h.post(execOf('read', { file_path: 'src/a/1' }, other))
  ok(injectLog.length === 3, '该 agent 重复命中不再投递', 'injects=' + injectLog.length)
}

console.log('# A: agent 没有 inject（或没有 agent）-> 不投递、不抛，读者反向登记仍发生')
{
  const foreign = mkClaim({ claimId: 'c_noinj', holderId: 'agent:other', holderName: 'Other Session', paths: ['src/a/2'], expiresAt: Date.now() + HOUR })
  resetInject()
  const h = await makeHarness({ claims: [foreign], initiator: NO_INJECT_AGENT })
  ok(typeof NO_INJECT_AGENT.inject === 'undefined', '这个 agent 确实没有 inject 函数')
  let threw = null
  let posted = null
  try { posted = await h.post(execOf('read', { file_path: 'src/a/1' }, NO_INJECT_AGENT)) } catch (e) { threw = e }
  ok(threw === null, '没有 inject 时不抛', threw && String(threw.message))
  ok(posted && posted.decision === posted.downstream && posted.decision.kind === 'accept',
    '工具结果原样返回（绝不退回"自己造一条消息"）', JSON.stringify(posted && posted.decision))
  ok(posted && !('additionalContexts' in posted.decision), '这条路径上同样没有 additionalContexts 字段')
  ok(posted && posted.nextCalls === 1, 'next() 恰好一次', 'nextCalls=' + (posted && posted.nextCalls))
  ok(injectLog.length === 0, '没有 inject -> 一次都不调用', 'injects=' + injectLog.length)
  // 通知的计算本身没有被跳过（只是没有出口）—— 反向登记仍发生，功能 D 不受影响。
  ok((h.readState().claims[0].readers || []).includes('agent:' + NO_INJECT_AGENT.id),
    '读者反向登记仍发生（代价只落在投递上）', JSON.stringify(h.readState().claims[0].readers))

  // 没有 agent（受限宿主 / 非 agent 调用面）：同样不投递、不抛、next() 恰好一次。
  resetInject()
  const h2 = await makeHarness({ claims: [foreign] })
  let threw2 = null
  let posted2 = null
  try { posted2 = await h2.post({ name: 'read', arguments: { file_path: 'src/a/1' }, agent: null }) } catch (e) { threw2 = e }
  ok(threw2 === null, '没有 agent 时不抛', threw2 && String(threw2.message))
  ok(posted2 && posted2.decision === posted2.downstream && posted2.nextCalls === 1,
    '没有 agent -> 工具结果原样返回，next() 恰好一次', JSON.stringify(posted2 && posted2.decision))
  ok(injectLog.length === 0, '没有 agent -> 不投递', 'injects=' + injectLog.length)
}

console.log('# A: 异常绝不进 waterfall')
{
  const foreign = mkClaim({ claimId: 'c_other', holderId: 'agent:other', paths: ['src/a/2'], expiresAt: Date.now() + HOUR })
  resetInject()
  const h = await makeHarness({ claims: [foreign], readThrows: (p) => p.endsWith('.json') })
  let threw = null
  let posted = null
  try { posted = await h.post(execOf('read', { file_path: 'src/a/1' })) } catch (e) { threw = e }
  ok(threw === null, '读盘失败不抛进 waterfall', threw && String(threw.message))
  ok(posted && posted.decision === posted.downstream && posted.decision.kind === 'accept',
    '读盘失败等价于"没有通知"：返回 downstream 本身', JSON.stringify(posted && posted.decision))
  ok(posted && !('additionalContexts' in posted.decision), '异常路径上同样没有 additionalContexts 字段')
  ok(posted && posted.nextCalls === 1, '异常路径上 next() 恰好一次', 'nextCalls=' + (posted && posted.nextCalls))
  ok(injectLog.length === 0, '读盘失败 -> 不投递（失败不会被当成一条通知）', 'injects=' + injectLog.length)
  ok((h.readState().claims[0].readers || []).length === 0, '读盘失败 -> 读者不被改动', JSON.stringify(h.readState().claims[0].readers))
}

console.log('# A: 总开关 DSH_COLLAB_NO_PROMPT_HINT=1 仍然管住访问通知（换载体不许改开关语义）')
{
  const foreign = mkClaim({ claimId: 'c_optout', holderId: 'agent:other', holderName: 'Other Session', paths: ['src/a/2'], expiresAt: Date.now() + HOUR })
  // 开关是 config 期读的（installAccess 里），所以在 makeHarness 之前设。
  process.env.DSH_COLLAB_NO_PROMPT_HINT = '1'
  let h
  try {
    resetInject()
    h = await makeHarness({ claims: [foreign] })
    const posted = await h.post(execOf('read', { file_path: 'src/a/1' }))
    ok(posted.decision === posted.downstream, 'opt-out 下工具结果照样原样返回', JSON.stringify(posted.decision))
    ok(posted.nextCalls === 1, 'opt-out 下 next() 恰好一次', 'nextCalls=' + posted.nextCalls)
    ok(injectLog.length === 0, 'opt-out 下**不投递**访问通知（总开关的契约是关掉所有运行时注入）',
      'injects=' + injectLog.length)
    // 只关投递：读者反向登记（功能 D）照常 —— 这正是换载体前的行为。
    const rd = (h.readState().claims[0].readers || [])
    ok(rd.includes('agent:' + ME.id), 'opt-out 只关投递：读者反向登记照常发生', JSON.stringify(rd))
  } finally {
    delete process.env.DSH_COLLAB_NO_PROMPT_HINT
  }
  // 反向对照：同一个 harness 形状，开关放开后**必须**投递（否则上一条是空断言）。
  resetInject()
  const h2 = await makeHarness({ claims: [foreign] })
  await h2.post(execOf('read', { file_path: 'src/a/1' }))
  ok(injectLog.length === 1, '（对照）开关放开后同一场景投递恰好一条 —— 证明上一条不是恒真',
    'injects=' + injectLog.length)
}

// ── 功能 C：pre-execute 的 ask 判定 ────────────────────────────────────
console.log('# C: 写/改被他人活跃声明覆盖时 ask')
{
  const foreign = mkClaim({ claimId: 'c_dir', holderId: 'agent:other', holderName: 'Other Session', paths: ['src/a/'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign] })

  const write = await h.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(write.decision.kind === 'ask', 'write 命中他人声明 -> ask', JSON.stringify(write.decision))
  ok(write.nextCalls === 0, 'ask 时不调用 next()（不放行）', String(write.nextCalls))
  const reason = String(write.decision.reason || '')
  ok(reason.includes('Other Session'), 'reason 含持有者', reason)
  ok(reason.includes('src/a/1'), 'reason 含目标路径', reason)
  ok(/\d{2}-\d{2} \d{2}:\d{2}Z–\d{2}-\d{2} \d{2}:\d{2}Z/.test(reason), 'reason 含绝对 UTC 租约窗口', reason)
  ok(!/剩\s*\d+\s*分/.test(reason), 'reason 不含倒计时', reason)

  const edit = await h.pre(execOf('edit', { file_path: 'src/a/1', old_string: 'a', new_string: 'b' }))
  ok(edit.decision.kind === 'ask', 'edit 同样被拦')
  const abs = await h.pre(execOf('write', { file_path: CWD + '/src/a/1', content: 'x' }))
  ok(abs.decision.kind === 'ask', '绝对路径归一后同样被拦')
}

console.log('# C: 不触发时原样放行（next() 恰好一次）')
{
  const foreignSibling = mkClaim({ claimId: 'c_sib', holderId: 'agent:other', paths: ['src/a/2'], expiresAt: Date.now() + HOUR })
  const mine = mkClaim({ claimId: 'c_mine', holderId: ME_HOLDER, paths: ['src/a/'], expiresAt: Date.now() + HOUR })
  const expired = mkClaim({ claimId: 'c_old', holderId: 'agent:other', paths: ['src/a/'], expiresAt: Date.now() - 1000 })
  const h = await makeHarness({ claims: [foreignSibling, mine, expired] })

  const sibling = await h.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(sibling.decision.kind === 'allow' && sibling.nextCalls === 1,
    '他人声明在兄弟路径 -> 放行（窄口径，无假阳性）', JSON.stringify(sibling))
  const own = await h.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(own.decision.kind === 'allow' && own.nextCalls === 1, '自己的声明不拦自己')
  const unknownTool = await h.pre(execOf('bash', { command: 'echo hi > src/a/1' }))
  ok(unknownTool.decision.kind === 'allow' && unknownTool.nextCalls === 1,
    'shell 类工具不在写工具表里 -> 放行（已知旁路，见 README）', JSON.stringify(unknownTool))
  const unrelated = await h.pre(execOf('write', { file_path: 'docs/x.md', content: 'x' }))
  ok(unrelated.decision.kind === 'allow' && unrelated.nextCalls === 1, '无关路径放行')
}

console.log('# C: 可读性 —— 只有 readable:false 才拦读')
{
  const openClaim = mkClaim({ claimId: 'c_open', holderId: 'agent:other', paths: ['src/a/'], readable: true, expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [openClaim] })
  const r1 = await h.pre(execOf('read', { file_path: 'src/a/1' }))
  ok(r1.decision.kind === 'allow' && r1.nextCalls === 1, 'readable:true（默认）时读取放行', JSON.stringify(r1))
  const w1 = await h.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(w1.decision.kind === 'ask', '同一 claim 下写入仍被拦（写入对非持有者永远不允许）')

  const closed = mkClaim({ claimId: 'c_closed', holderId: 'agent:other', holderName: 'Closed', paths: ['src/b/'], readable: false, expiresAt: Date.now() + HOUR })
  const h2 = await makeHarness({ claims: [closed] })
  const r2 = await h2.pre(execOf('read', { file_path: 'src/b/1' }))
  ok(r2.decision.kind === 'ask', 'readable:false 时读取也要审批', JSON.stringify(r2))
  ok(String(r2.decision.reason).includes('不可读'), 'reason 说明对方声明了不可读', String(r2.decision.reason))
  const g2 = await h2.pre(execOf('grep', { pattern: 'x', path: 'src/b/' }))
  ok(g2.decision.kind === 'ask', 'grep（path 参数）同样受可读性约束')
  const gl2 = await h2.pre(execOf('glob', { pattern: '**/*.ts', path: 'src/b/' }))
  ok(gl2.decision.kind === 'ask', 'glob（path 参数）同样受可读性约束')

  // 老状态文件：没有 readable 字段 -> 视为可读
  const legacy = mkClaim({ claimId: 'c_legacy', holderId: 'agent:other', paths: ['src/c/'], expiresAt: Date.now() + HOUR })
  delete legacy.readable
  const h3 = await makeHarness({ claims: [legacy] })
  const r3 = await h3.pre(execOf('read', { file_path: 'src/c/1' }))
  ok(r3.decision.kind === 'allow' && r3.nextCalls === 1, '缺 readable 字段（老状态文件）按可读处理', JSON.stringify(r3))
}

console.log('# C: str_replace_editor 按 command 分读写')
{
  const closed = mkClaim({ claimId: 'c_closed', holderId: 'agent:other', paths: ['src/a/'], readable: false, expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [closed] })
  const view = await h.pre(execOf('str_replace_editor', { command: 'view', path: 'src/a/1' }))
  ok(view.decision.kind === 'ask', 'command=view 是读 -> 受 readable:false 约束', JSON.stringify(view))
  const create = await h.pre(execOf('str_replace_editor', { command: 'create', path: 'src/a/1', file_text: 'x' }))
  ok(create.decision.kind === 'ask', 'command=create 是写 -> 被拦', JSON.stringify(create))
  const strReplace = await h.pre(execOf('str_replace_editor', { command: 'str_replace', path: 'src/a/1', old_str: 'a', new_str: 'b' }))
  ok(strReplace.decision.kind === 'ask', 'command=str_replace 是写 -> 被拦')
  const unknown = await h.pre(execOf('str_replace_editor', { path: 'src/a/1' }))
  ok(unknown.decision.kind === 'ask', '认不出的 command 按写处理（fail-safe）')
}

console.log('# C: settings 门控 enforceWriteLock 关掉后不再拦')
{
  const foreign = mkClaim({ claimId: 'c_dir', holderId: 'agent:other', paths: ['src/a/'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], settings: { enforceWriteLock: true } })
  const on = await h.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(on.decision.kind === 'ask', '开关为 true（默认）时拦截')
  h.set({ enforceWriteLock: false })
  await settle()
  const off = await h.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(off.decision.kind === 'allow' && off.nextCalls === 1, '开关关掉后原样放行（活读，无需重启）', JSON.stringify(off))
  h.set({ enforceWriteLock: true })
  await settle()
  const backOn = await h.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(backOn.decision.kind === 'ask', '再打开又拦（活读）')

  // settings 服务缺失 -> 按默认（开）处理
  const h2 = await makeHarness({ claims: [foreign] })
  const noSvc = await h2.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(noSvc.decision.kind === 'ask', 'settings 服务缺失时按默认（开）拦截')
}

console.log('# C: readable 的 claim 入参与兼容映射')
{
  const { init, claim, publish, readersOf } = core
  const st = init()
  const r1 = claim(st, { holderId: 'agent:a', name: 'A' }, { paths: ['src/a/'] }, () => T0)
  ok(r1.ok === true && r1.data.claim.readable === true, '未指定 readable -> 默认可读', JSON.stringify(r1.data.claim))
  ok(Array.isArray(r1.data.claim.readers) && r1.data.claim.readers.length === 0, '新 claim 的 readers 初始为空数组')
  const st2 = init()
  const r2 = claim(st2, { holderId: 'agent:a', name: 'A' }, { paths: ['src/a/'], mode: 'read' }, () => T0)
  ok(r2.ok === true && r2.data.claim.readable === true, "mode:'read' -> 可读（兼容映射）")
  const r3 = claim(st2, { holderId: 'agent:b', name: 'B' }, { paths: ['src/b/'], mode: 'shared', readable: false }, () => T0)
  ok(r3.ok === true && r3.data.claim.readable === false, "mode:'shared' + 显式 readable:false -> 不可读")
  // 兼容：三个老 mode 值都仍然被接受
  for (const m of ['exclusive', 'shared', 'read']) {
    const s = init()
    const r = claim(s, { holderId: 'agent:z', name: 'Z' }, { paths: ['p' + m + '/'], mode: m }, () => T0)
    ok(r.ok === true && r.data.claim.mode === m, '老 mode 值仍被接受：' + m, JSON.stringify(r.data && r.data.claim))
  }
  // publish 归一：老状态文件缺字段
  const legacy = { claimId: 'c_l', holderId: 'agent:x', paths: ['src/x/'], mode: 'exclusive', ttlSec: 60, expiresAt: T0 + 60000, createdAt: T0 }
  const pv = publish(legacy)
  ok(pv.readable === true, 'publish：缺 readable -> true')
  ok(Array.isArray(pv.readers) && pv.readers.length === 0, 'publish：缺 readers -> []')
  ok(readersOf({ readers: ['a', 'a', 'b', 7, ''] }).join(',') === 'a,b', 'readersOf：去重 + 过滤非字符串')
  // 合并：不显式给 readable 时不重置
  const st3 = init()
  claim(st3, { holderId: 'agent:a', name: 'A' }, { paths: ['src/m/'], readable: false }, () => T0)
  claim(st3, { holderId: 'agent:a', name: 'A' }, { paths: ['src/m/sub/'] }, () => T0)
  const merged = st3.claims[0]
  ok(merged.readable === false, '合并且未显式给 readable -> 保留 readable:false', JSON.stringify(merged))
  claim(st3, { holderId: 'agent:a', name: 'A' }, { paths: ['src/m/other/'], readable: true }, () => T0)
  ok(st3.claims[0].readable === true, '合并时显式给 readable:true -> 生效')
}

console.log('# 监听器随 ctx 作用域回收（卸载插件后不再拦截/通知/inject）')
{
  const foreign = mkClaim({ claimId: 'c_dir', holderId: 'agent:other', paths: ['src/a/'], expiresAt: Date.now() + HOUR })
  resetInject()
  const h = await makeHarness({ claims: [foreign] })
  const before = await h.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(before.decision.kind === 'ask', '卸载前拦截')
  await h.post(execOf('read', { file_path: 'src/a/1' }))
  ok(injectLog.length === 1 && noticeText(injectLog[0]).includes('src/a/'), '卸载前访问命中 -> 投递通知',
    'injects=' + injectLog.length + ' ' + JSON.stringify(noticeText(injectLog[0]).slice(0, 30)))
  ok(!h.contexts.has('dsh-collab/access'), '整个生命周期里都不存在 dsh-collab/access 上下文段（载体已换）',
    JSON.stringify([...h.contexts.keys()]))
  await h.fiber.dispose()
  await settle()
  const after = await h.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(after.decision.kind === 'allow' && after.nextCalls === 1, '卸载后 pre-execute 监听器被回收（放行）', JSON.stringify(after))
  const posted = await h.post(execOf('read', { file_path: 'src/a/1' }))
  ok(posted.decision === posted.downstream && !('additionalContexts' in posted.decision),
    '卸载后 post-execute 监听器被回收（不再投递、也不改工具结果）')
  ok(injectLog.length === 1, '卸载后不再 inject（通知数没有增加）', 'injects=' + injectLog.length)
  ok(!h.contexts.has('dsh-collab/awareness'), '卸载后 awareness 上下文段也被 dispose（ctx.effect 生效）',
    JSON.stringify([...h.contexts.keys()]))
}

// ── 功能 C：mode 过滤回归（0.8.1）──────────────────────────────────────
// 0.8.0 的 writeGate 只跳过 c.holderId === mine，没按 mode 过滤，于是任何他人的
// shared/read 声明都会硬拒绝所有人的写入（本部署 ask = deny）。以下逐条钉住修复后的语义。
console.log('# C: 他人 read 声明覆盖路径 -> 不拦我的写/改（0.8.0 的核心 bug）')
{
  const reader = mkClaim({
    claimId: 'c_read', holderId: 'agent:reader', holderName: 'Reader Session',
    paths: ['src/a/'], mode: 'read', expiresAt: Date.now() + HOUR
  })
  const h = await makeHarness({ claims: [reader] })

  const write = await h.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(write.decision.kind === 'allow' && write.nextCalls === 1,
    '他人 mode=read 覆盖 src/a/ -> 我的 write 放行（next() 恰好一次）', JSON.stringify(write))
  const edit = await h.pre(execOf('edit', { file_path: 'src/a/1', old_string: 'a', new_string: 'b' }))
  ok(edit.decision.kind === 'allow' && edit.nextCalls === 1,
    '他人 mode=read -> 我的 edit 同样放行', JSON.stringify(edit))
  const sre = await h.pre(execOf('str_replace_editor', { command: 'str_replace', path: 'src/a/1', old_str: 'a', new_str: 'b' }))
  ok(sre.decision.kind === 'allow' && sre.nextCalls === 1,
    '他人 mode=read -> str_replace_editor 的写同样放行', JSON.stringify(sre))

  // read 声明是纯观测：它上面的 readable:false 也不得拦读（既不排他也不被挡）。
  const readerClosed = mkClaim({
    claimId: 'c_read_closed', holderId: 'agent:reader', holderName: 'Reader Session',
    paths: ['src/a/'], mode: 'read', readable: false, expiresAt: Date.now() + HOUR
  })
  const h2 = await makeHarness({ claims: [readerClosed] })
  const r = await h2.pre(execOf('read', { file_path: 'src/a/1' }))
  ok(r.decision.kind === 'allow' && r.nextCalls === 1,
    'read 声明上的 readable:false 不生效：读取放行（非 exclusive 声明不拦任何人）', JSON.stringify(r))
}

console.log('# C: 他人 shared 声明覆盖路径 -> 不拦我的写（两个共享方互不挡死）')
{
  const sharer = mkClaim({
    claimId: 'c_shared', holderId: 'agent:sharer', holderName: 'Sharer Session',
    paths: ['src/s/'], mode: 'shared', expiresAt: Date.now() + HOUR
  })
  const h = await makeHarness({ claims: [sharer] })
  const write = await h.pre(execOf('write', { file_path: 'src/s/1', content: 'x' }))
  ok(write.decision.kind === 'allow' && write.nextCalls === 1,
    '他人 mode=shared 覆盖路径 -> 我的 write 放行', JSON.stringify(write))
  const edit = await h.pre(execOf('edit', { file_path: 'src/s/1', old_string: 'a', new_string: 'b' }))
  ok(edit.decision.kind === 'allow' && edit.nextCalls === 1, 'edit 同样放行', JSON.stringify(edit))

  const sharerClosed = mkClaim({
    claimId: 'c_shared_closed', holderId: 'agent:sharer', paths: ['src/s/'], mode: 'shared',
    readable: false, expiresAt: Date.now() + HOUR
  })
  const h2 = await makeHarness({ claims: [sharerClosed] })
  const r = await h2.pre(execOf('read', { file_path: 'src/s/1' }))
  ok(r.decision.kind === 'allow' && r.nextCalls === 1,
    'shared 声明上的 readable:false 不生效：读取放行', JSON.stringify(r))
}

console.log('# C: 反向对照 —— 他人 exclusive 声明仍然拦（防止修过头）')
{
  const owner = mkClaim({
    claimId: 'c_excl', holderId: 'agent:owner', holderName: 'Owner Session',
    paths: ['src/a/'], mode: 'exclusive', expiresAt: Date.now() + HOUR
  })
  const h = await makeHarness({ claims: [owner] })
  const write = await h.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(write.decision.kind === 'ask', '他人 exclusive 覆盖路径 -> write 仍被拦（ask）', JSON.stringify(write))
  ok(write.nextCalls === 0, 'ask 时 next() 不被调用（不放行）', String(write.nextCalls))
  ok(String(write.decision.reason).includes('Owner Session'), 'reason 仍含持有者', String(write.decision.reason))
  const edit = await h.pre(execOf('edit', { file_path: 'src/a/1', old_string: 'a', new_string: 'b' }))
  ok(edit.decision.kind === 'ask', 'edit 仍被拦', JSON.stringify(edit))
}

console.log('# C: 两个会话各自 mode=shared 同一路径 -> 互不拦（真实 claim() 装箱）')
{
  const NOW = Date.now()
  const st = core.init()
  const otherAgent = { id: 'agent-other-me', session: { header: { cwd: CWD } } }
  const OTHER_HOLDER = 'agent:' + otherAgent.id
  // 真实 claim()：先他人、后我，两边都声明 shared 同一路径。
  const r1 = core.claim(st, { holderId: OTHER_HOLDER, name: 'Other' }, { paths: ['src/two/'], mode: 'shared' }, () => NOW)
  let r2 = null, threw = null
  try { r2 = core.claim(st, { holderId: ME_HOLDER, name: 'Me' }, { paths: ['src/two/'], mode: 'shared' }, () => NOW) } catch (e) { threw = e }
  ok(r1.ok === true && r2 && r2.ok === true && threw === null,
    'claim() 允许两个会话各自 shared 同一路径（互不冲突）', threw && String(threw.message))
  const h = await makeHarness({ claims: st.claims })
  const mine = await h.pre(execOf('write', { file_path: 'src/two/1', content: 'x' }))
  ok(mine.decision.kind === 'allow' && mine.nextCalls === 1, '我写 -> 放行（不被对方的 shared 挡）', JSON.stringify(mine))
  const theirs = await h.pre(execOf('write', { file_path: 'src/two/1', content: 'x' }, otherAgent))
  ok(theirs.decision.kind === 'allow' && theirs.nextCalls === 1, '对方写 -> 同样放行（互不拦）', JSON.stringify(theirs))
}

console.log('# C: 一致性 —— writeGate 阻塞集合 ≡ claim() 冲突集合（逐例对照，防漂移）')
{
  const { init, claim } = core
  const NOW = Date.now()
  const target = 'src/cons/1'
  // 每条 case = 他人的一条声明。两套判据都从**真实函数**驱动：
  //   A) 真实插件 + 真实 cordis waterfall 的 writeGate 决策；
  //   B) 真实 claim()（把同一条声明放进真实 state，再让 ME 去声明同一目标路径）。
  const cases = [
    { label: 'exclusive 覆盖父目录', paths: ['src/cons/'], mode: 'exclusive' },
    { label: 'exclusive 覆盖文件本身', paths: ['src/cons/1'], mode: 'exclusive' },
    { label: 'exclusive + readable:false', paths: ['src/cons/'], mode: 'exclusive', readable: false },
    { label: 'shared 覆盖父目录', paths: ['src/cons/'], mode: 'shared' },
    { label: 'shared + readable:false（不生效）', paths: ['src/cons/'], mode: 'shared', readable: false },
    { label: 'read 覆盖父目录', paths: ['src/cons/'], mode: 'read' },
    { label: 'read + readable:false（不生效）', paths: ['src/cons/'], mode: 'read', readable: false },
    { label: 'exclusive 在兄弟路径（窄口径，不该命中）', paths: ['src/cons/2'], mode: 'exclusive' },
    { label: 'exclusive 祖先路径（src/）', paths: ['src/'], mode: 'exclusive' },
    { label: 'exclusive 但已过期', paths: ['src/cons/'], mode: 'exclusive', expiresAt: NOW - 1000 },
  ]
  for (const cs of cases) {
    const foreign = mkClaim({
      claimId: 'c_cons', holderId: 'agent:other', holderName: 'Other Session',
      paths: cs.paths, mode: cs.mode,
      expiresAt: cs.expiresAt !== undefined ? cs.expiresAt : NOW + HOUR
    })
    if ('readable' in cs) foreign.readable = cs.readable
    // A) 真实门控
    const h = await makeHarness({ claims: [foreign] })
    const gate = await h.pre(execOf('write', { file_path: target, content: 'x' }))
    const gateBlocked = gate.decision.kind === 'ask'
    // B) 真实 claim()
    const st = init()
    st.claims.push({ ...foreign })
    let conflicts = null
    try { claim(st, { holderId: ME_HOLDER, name: 'Me' }, { paths: [target] }, () => NOW) }
    catch (e) { conflicts = (e && e.conflicts) || [] }
    const coreBlocked = Array.isArray(conflicts) && conflicts.length > 0
    ok(gateBlocked === coreBlocked, 'writeGate 阻塞 ≡ claim() 冲突：' + cs.label,
      'gate=' + gateBlocked + ' claim=' + coreBlocked)
  }

  // 集合级：shared/read 不进阻塞集合，两条 exclusive 都进；门控报出的第一位阻塞者
  // 必须与 claim() 的 cs[0] 是同一条（两边都按 state.claims 顺序扫描）。
  const multi = [
    mkClaim({ claimId: 'c_sh', holderId: 'agent:sh', holderName: 'Sharer', paths: ['src/cons/'], mode: 'shared', expiresAt: NOW + HOUR }),
    mkClaim({ claimId: 'c_rd', holderId: 'agent:rd', holderName: 'Reader', paths: ['src/cons/'], mode: 'read', expiresAt: NOW + HOUR }),
    mkClaim({ claimId: 'c_x1', holderId: 'agent:x1', holderName: 'X1', paths: ['src/cons/'], mode: 'exclusive', expiresAt: NOW + HOUR }),
    mkClaim({ claimId: 'c_x2', holderId: 'agent:x2', holderName: 'X2', paths: ['src/cons/1'], mode: 'exclusive', expiresAt: NOW + HOUR }),
  ]
  const h = await makeHarness({ claims: multi })
  const gate = await h.pre(execOf('write', { file_path: target, content: 'x' }))
  const st = init()
  for (const c of multi) st.claims.push({ ...c })
  let conflicts = []
  try { claim(st, { holderId: ME_HOLDER, name: 'Me' }, { paths: [target] }, () => NOW) } catch (e) { conflicts = (e && e.conflicts) || [] }
  ok(gate.decision.kind === 'ask' && conflicts.length === 2,
    '多条声明：阻塞集合恰好是两条 exclusive（shared/read 不在内）',
    'gate=' + gate.decision.kind + ' conflicts=' + JSON.stringify(conflicts.map(c => c.claimId)))
  ok(conflicts.length === 2 && String(gate.decision.reason).includes(conflicts[0].holderName),
    '门控报出的第一位阻塞者与 claim() 的 cs[0] 同一条', String(gate.decision.reason))
}

h.finish()
