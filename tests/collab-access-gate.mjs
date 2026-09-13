// collab-access-gate.mjs
// 功能 A（访问时的路径相关通知，旁路投递）与功能 C（可读性 + 原生写保护）的回归测试。
//
// 覆盖面：
//   1) 三个纯函数 accessScope / claimsForAccess / renderAccessNotice（含题面给的边界例）；
//      以及功能 C 用的 claimsCovering、relToProject、isReadable。
//   2) 真正注册出来的 ctx.on('tools/post-execute') 监听器：合并进 additionalContexts、
//      block 分支、按 agent 去重、无路径原样放行、异常安全。
//   3) 真正注册出来的 ctx.on('tools/pre-execute') 监听器：ask 判定、原样放行、
//      readable:false 的读拦截、settings 门控关掉后不再拦。
//   4) 功能 C 的 **mode 过滤**回归（0.8.1）：`shared` / `read` 声明既不拦写也不拦读
//      （0.8.0 会拦，导致"另一个会话按提示用 mode=read 做只读调研"就把所有人的写入挡死），
//      `exclusive` 仍然拦（反向对照，防修过头）；并与 claim() 的冲突判据**逐例一致性对照**
//      （同一组声明 + 同一目标路径，两套判据必须给出同一结论 —— 防将来再次漂移）。
//
// 为什么可以在 node 里测这两条：它们是 Host 面（cordis 事件 + 假 fs），不涉及浏览器 React。
// 用真实 Cordis Context 注册，再用 ctx.waterfall 驱动 —— 与 dsh-tools 的调用形态同构
// （dsh-tools/lib/index.js:3116 用 ctx.waterfall(carrier, 'tools/pre-execute', exec, next)）。
//
// 运行：node tests/collab-access-gate.mjs

import path from 'node:path'
import os from 'node:os'

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

let pass = 0, fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label) }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  <-- ' + extra : '')) }
}

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

/** 极简假 fs（内存 + 版本号），语义与 e2e harness 的 fs 对齐（乐观并发那一步用得上）。 */
function makeFs(store, versions, opts = {}) {
  return {
    resolve: async (p) => ({ displayPath: p, path: p }),
    stat: async (t) => (store.has(t.path) ? { version: versions.get(t.path) || 1 } : null),
    readText: async (t) => {
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
 */
async function makeHarness(opts = {}) {
  const store = new Map()
  const versions = new Map()
  const tools = []
  const prompts = []
  const statePath = projectStateFile(CWD)
  if (opts.claims) {
    store.set(statePath, JSON.stringify({ schemaVersion: 1, seq: opts.claims.length, claims: opts.claims, messages: [], holders: [] }))
    versions.set(statePath, 1)
  }

  let hooks = null
  let value = Object.assign({ exposeDelegationDiscipline: true, enforceWriteLock: true }, opts.settings || {})
  const ctx = new Context()
  for (const n of ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'agents']) ctx.provide(n)
  const names = ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'agents']
  if (opts.settings !== undefined) { ctx.provide('settings'); names.push('settings') }
  if (opts.withController) { ctx.provide('sessionController'); names.push('sessionController') }

  ctx.set('tools', { register: (t) => { tools.push(t); return () => {} } })
  ctx.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} })
  ctx.set('fs', makeFs(store, versions, opts))
  ctx.set('sessions', { get: () => ({ header: { cwd: CWD } }) })
  ctx.set('sessionTitle', { get: () => ({ title: 'Gate Worker' }) })
  ctx.set('agents', {
    currentInitiator: () => undefined,
    list: () => [],
    get: (id) => (opts.liveSessions && opts.liveSessions.includes(id) ? { id } : undefined)
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
    set(patch) { value = Object.assign({}, value, patch); if (hooks) hooks.onChange() },
    current: () => value,
    /** 驱动 post-execute 瀑布：返回 { decision, downstream }。 */
    async post(exec, downstream = { kind: 'accept' }) {
      const produced = { ...downstream }
      const decision = await ctx.waterfall('tools/post-execute', exec, produced, () => Promise.resolve(produced))
      return { decision, downstream: produced }
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

const ME = { id: 'agent-me', session: { header: { cwd: CWD } } }
/** holderId 的形状是 'agent:' + agent.id（与 index.ts 的 holderOf 一致）。 */
const ME_HOLDER = 'agent:' + ME.id
const execOf = (name, args, agent = ME) => ({ name, arguments: args, agent })

// ── 功能 A：post-execute 合并与去重 ─────────────────────────────────────
console.log('# A: post-execute 把通知合并进 additionalContexts')
{
  const foreign = mkClaim({ claimId: 'c_other', holderId: 'agent:other', holderName: 'Other Session', paths: ['src/a/2'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign] })
  const { decision, downstream } = await h.post(execOf('read', { file_path: 'src/a/1' }))
  ok(decision.additionalContexts && decision.additionalContexts.length === 1,
    '恰好合并一条 additionalContexts', JSON.stringify(decision.additionalContexts && decision.additionalContexts.length))
  const msg = decision.additionalContexts[0]
  ok(msg && msg.role === 'user', '消息 role 是 user', msg && msg.role)
  ok(msg && Array.isArray(msg.content) && msg.content[0].type === 'text' && msg.content[0].text.includes('Other Session'),
    '文本点出其他会话', msg && JSON.stringify(msg.content))
  ok(msg && msg.content[0].text.includes('src/a/2'), '文本点出被占用的路径', msg && msg.content[0].text)
  ok(msg && msg.source && msg.source.kind === 'plugin' && msg.source.plugin === 'dsh-collab' && msg.source.form === 'notice' && typeof msg.source.summary === 'string',
    'source 是 {kind:plugin, plugin:dsh-collab, form:notice, summary}', msg && JSON.stringify(msg.source))
  ok(msg && typeof msg.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(msg.id),
    'id 是 uuid v4', msg && msg.id)
  ok(msg && Object.isFrozen(msg) && Object.isFrozen(msg.content) && Object.isFrozen(msg.content[0]) && Object.isFrozen(msg.source),
    '消息与内容块深冻结', msg && Object.isFrozen(msg))
  ok(decision !== downstream, '合并时返回的是新决策对象（不原地改结果）')
  ok(!('content' in decision) && !('value' in decision), '只加 additionalContexts，不重建 content/value', Object.keys(decision).join(','))
  ok(h.readState().claims[0].readers.includes(ME_HOLDER), '通知的同时把自己反向登记为 reader', JSON.stringify(h.readState().claims[0].readers))

  // 去重：同一 agent 对同一组占用再访问一次 -> 原样放行
  const again = await h.post(execOf('read', { file_path: 'src/a/1' }))
  ok(again.decision === again.downstream, '重复访问返回 downstream 本身（原样放行）')
  ok(!again.decision.additionalContexts, '重复访问不追加 additionalContexts', JSON.stringify(again.decision))

  // 另一个 agent 不受去重影响
  const otherAgent = { id: 'agent-other-me', session: { header: { cwd: CWD } } }
  const third = await h.post(execOf('read', { file_path: 'src/a/1' }, otherAgent))
  ok(third.decision.additionalContexts && third.decision.additionalContexts.length === 1, '去重按 agent 隔离')
  ok(h.readState().claims[0].readers.includes('agent:' + otherAgent.id), '第二个 agent 也被登记', JSON.stringify(h.readState().claims[0].readers))
}

console.log('# A: block 分支 / 无命中 / 无候选 / 绝对路径 / 自己的声明 / 过期')
{
  const foreign = mkClaim({ claimId: 'c_other', holderId: 'agent:other', holderName: 'Other Session', paths: ['src/a/2'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign] })

  const feedback = [{ type: 'text', text: 'blocked' }]
  const blocked = await h.post(execOf('read', { file_path: 'src/a/1' }), { kind: 'block', feedback })
  ok(blocked.decision.kind === 'block', 'block 决策保持 kind=block', JSON.stringify(blocked.decision.kind))
  ok(blocked.decision.feedback === feedback, 'feedback 原样保留（同一引用）')
  ok(blocked.decision.additionalContexts && blocked.decision.additionalContexts.length === 1, 'block 也带上 additionalContexts')

  const h2 = await makeHarness({ claims: [foreign] })
  const miss = await h2.post(execOf('read', { file_path: 'src/zzz/1' }))
  ok(miss.decision === miss.downstream && !miss.decision.additionalContexts, '无相关占用 -> 原样放行')
  const noPaths = await h2.post(execOf('read', {}))
  ok(noPaths.decision === noPaths.downstream, '提不出候选路径 -> 原样放行')
  const abs = await h2.post(execOf('read', { file_path: CWD + '/src/a/1' }))
  ok(abs.decision.additionalContexts && abs.decision.additionalContexts.length === 1, '绝对路径按 cwd 归一到项目相对后仍命中')

  const mine = mkClaim({ claimId: 'c_mine', holderId: ME_HOLDER, holderName: 'Me', paths: ['src/a/2'], expiresAt: Date.now() + HOUR })
  const h3 = await makeHarness({ claims: [mine] })
  const own = await h3.post(execOf('read', { file_path: 'src/a/1' }))
  ok(own.decision === own.downstream, '自己的声明不通知自己')

  const expired = mkClaim({ claimId: 'c_old', holderId: 'agent:other', paths: ['src/a/2'], expiresAt: Date.now() - 1000 })
  const h4 = await makeHarness({ claims: [expired] })
  const gone = await h4.post(execOf('read', { file_path: 'src/a/1' }))
  ok(gone.decision === gone.downstream, '过期声明不通知')

  // 字符串数组里的候选路径（题面要求"含字符串数组"）。用干净实例，避开上面的去重状态。
  const h5 = await makeHarness({ claims: [foreign] })
  const arr = await h5.post(execOf('collab_board', { op: 'post', body: 'hi', mentions: ['src/a/2'] }))
  ok(arr.decision.additionalContexts && arr.decision.additionalContexts.length === 1,
    'mentions 这类字符串数组里的路径也参与候选提取',
    JSON.stringify(arr.decision.additionalContexts && arr.decision.additionalContexts.length))
  ok(arr.decision.additionalContexts[0].content[0].text.includes('src/a/2'), '数组里的路径命中后文本正确')
  // body 里的自由文本同样会被当作候选字符串，但它不是路径（'hi' 没有父目录），不会命中。
  const h6 = await makeHarness({ claims: [foreign] })
  const bodyOnly = await h6.post(execOf('collab_board', { op: 'post', body: 'hi' }))
  ok(bodyOnly.decision === bodyOnly.downstream, '非路径的自由文本不产生通知（无命中即放行）')
}

console.log('# A: 异常绝不进 waterfall')
{
  const foreign = mkClaim({ claimId: 'c_other', holderId: 'agent:other', paths: ['src/a/2'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign], readThrows: (p) => p.endsWith('.json') })
  let threw = null
  let decision = null
  try { decision = (await h.post(execOf('read', { file_path: 'src/a/1' }))).decision } catch (e) { threw = e }
  ok(threw === null, '读盘失败不抛进 waterfall', threw && String(threw.message))
  ok(decision && decision.kind === 'accept' && !decision.additionalContexts, '读盘失败等价于"没有通知"', JSON.stringify(decision))
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

console.log('# 监听器随 ctx 作用域回收（卸载插件后不再拦截/通知）')
{
  const foreign = mkClaim({ claimId: 'c_dir', holderId: 'agent:other', paths: ['src/a/'], expiresAt: Date.now() + HOUR })
  const h = await makeHarness({ claims: [foreign] })
  const before = await h.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(before.decision.kind === 'ask', '卸载前拦截')
  await h.fiber.dispose()
  await settle()
  const after = await h.pre(execOf('write', { file_path: 'src/a/1', content: 'x' }))
  ok(after.decision.kind === 'allow' && after.nextCalls === 1, '卸载后 pre-execute 监听器被回收（放行）', JSON.stringify(after))
  const posted = await h.post(execOf('read', { file_path: 'src/a/1' }))
  ok(posted.decision === posted.downstream && !posted.decision.additionalContexts, '卸载后 post-execute 监听器被回收（不追加通知）')
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

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
