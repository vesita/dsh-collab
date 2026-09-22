import { createHarness } from './_harness.mjs'

// tests/collab-agent-teams.mjs
// 0.11.0 **只读、advisory** 桥接官方 Agent Teams 的回归测试。
//
// 被钉住的接缝（`ctx.get('agentTeams')` 服务契约：`listTasks(caller)` 返回
// `{ id, subject, status, ownerName?, writeScopes }`，只把 status==='in_progress' 且
// writeScopes 非空的行当"在跑任务"）：
//   1) **服务缺席 ⇒ 输出一字不变**（本文件的核心负向对照）。三处出口都要证明：
//      awareness 文本没有团队字样、overview 的 data 没有 teamTasks/teamTasksNote、
//      claim 的 data 没有 teamOverlaps、delegation 纪律文本 === 纯常量。
//   2) 服务在场且**有在跑任务** ⇒ awareness 多一行 advisory；overview 多 teamTasks(+Note)；
//      在跑任务与 pending / 空 writeScopes 的行要能被区分开（后者必须被过滤）。
//   3) **读不到 ≠ 空**：listTasks 抛错（TEAM_NOT_MEMBER）必须与"服务缺席"逐字节等价，
//      而不是退化成"服务在场但没有任务"。
//   4) claim 的 advisory：`data.teamOverlaps` 只在服务在场时出现，且**不改锁结果**
//      （正例命中 / 负例不命中 / 服务缺席时同一 claim 的锁结果逐字段相同）。
//   5) 反向预警（tools/pre-execute 上的 `team_task_create`）：外部会话的 collab 声明
//      与团队 write_scopes 重叠时经 `agent.inject` 投一条显式来源的 notice，
//      **永不阻断**（每个分支都断言 next() 恰好一次）。
//   6) 启用团队时的委托纪律追加段（order 131）。
//
// 假 ctx 的形态照 tests/collab-awareness.mjs（捕获 systemPrompt.context + 驱动 text()）
// 与 tests/collab-access-gate.mjs（假 fs/工具注册表、tools/pre-execute 瀑布、agent.inject 记录器）。
// 一律从 lib/ 导入（构建产物），不碰 src/。
//
// 载体纪律（AGENTS.md §1）：投递只经 `agent.inject`，消息来源显式标注
// `source.kind='dsh-collab'` / `form='notice'`，本文件不构造也不断言任何"像真人"的消息来源。
//
// 运行：node tests/collab-agent-teams.mjs

import path from 'node:path'
import os from 'node:os'

const tmp = path.join(os.tmpdir(), 'collab-agent-teams-' + process.pid)
// DSH_HOME 指到临时目录：状态文件落在 /tmp，绝不碰真实协作状态。
process.env.DSH_HOME = tmp
delete process.env.DSH_COLLAB_NO_PROMPT_HINT

const cordis = await import('@deepseek-ai/cordis').catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
const { Context } = cordis

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const core = await import(path.join(ROOT, '../lib/collab-core.js'))
const spec = await import(path.join(ROOT, '../lib/spec.js'))
const { projectStateFile } = await import(path.join(ROOT, '../lib/paths.js'))
const collabPlugin = (await import(path.join(ROOT, '../lib/index.js'))).default

const { teamTaskScopeLine, teamScopeOverlaps, teamCrossWarnLine } = core
const { DELEGATION_DISCIPLINE_TEXT, TEAM_DISCIPLINE_ADDENDUM } = spec

const h = createHarness()
const { ok } = h

const CWD = '/fake/project/teams'
const HOUR = 3600 * 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 外部会话的独占声明（默认落在 docs/）。 */
const mkClaim = (o) => Object.assign({
  claimId: 'c_x', holderId: 'agent:someone-else', holderName: 'Other Session', paths: ['docs/'],
  mode: 'exclusive', readable: true, ttlSec: 1800,
  expiresAt: Date.now() + HOUR, note: '', createdAt: Date.now() - 1000, readers: []
}, o)

// 官方任务的三种行：在跑（要） / pending（过滤） / 在跑但 writeScopes 为空（过滤）。
const TASK = { id: 't-1', subject: 'Docs task', status: 'in_progress', ownerName: 'teammate-a', writeScopes: ['docs/'] }
const PENDING = { id: 't-2', subject: 'Pending task', status: 'pending', ownerName: 'teammate-b', writeScopes: ['src/'] }
const NO_SCOPES = { id: 't-3', subject: 'No scopes', status: 'in_progress', ownerName: 'teammate-c', writeScopes: [] }
const serviceWith = (rows) => ({ listTasks: () => rows })
/** 逐字节对照专用的**同一个** claim 对象：#1 与 #3 必须渲染出同一串文本，
 *  所以不能各自 mkClaim（两次 Date.now() 跨分钟边界时租约窗口会差一分钟，断言会假失败）。 */
const BYTE_FOREIGN = mkClaim({ claimId: 'c_bytes', paths: ['docs/'] })
/** 读不到（非成员 / 宿主抛错）：整个 listTasks 调用炸掉。 */
const THROWING_SERVICE = {
  listTasks: () => {
    const e = new Error('TEAM_NOT_MEMBER')
    e.code = 'TEAM_NOT_MEMBER'
    throw e
  }
}

// ── 假 agent：inject 是记录器（真机上它进 next-step 收件箱；这里只钉插件侧契约）──
let injectLog = []
const resetInject = () => { injectLog = [] }
const noticeText = (entry) => (entry && entry.message && entry.message.content && entry.message.content[0] && entry.message.content[0].text) || ''
const withInject = (id, parentSession) => ({
  id,
  session: { header: parentSession ? { cwd: CWD, parentSession } : { cwd: CWD } },
  inject: (m) => injectLog.push({ agent: id, message: m })
})
const ME = withInject('agent-me')
const OTHER_AGENT = withInject('agent-other')
const PARENT_AGENT = withInject('agent-parent')
/** 其父会话是 agent-parent：与 PARENT_AGENT 同家族。 */
const CHILD_OF_PARENT = withInject('agent-child', 'agent-parent')

/** 极简假 fs（内存 + 版本号），语义与 access-gate / e2e harness 对齐。 */
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
 * 造一个装着本插件的真实 Cordis Context。
 * @param opts.claims       预置状态文件里的 claims
 * @param opts.teamsPresent 是否 `ctx.provide('agentTeams')`（三态之外的那把开关）
 * @param opts.service      teamsPresent 时挂上去的服务对象（缺省 = 空任务列表）
 * @param opts.initiator    agents.currentInitiator() 的返回值（缺省 ME）
 * @param opts.agentList    agents.list() 的返回值（缺省 [initiator]）
 */
async function makeHarness (opts = {}) {
  const store = new Map()
  const versions = new Map()
  const tools = []
  const contexts = new Map()
  const statePath = projectStateFile(CWD)
  if (opts.claims) {
    store.set(statePath, JSON.stringify({ schemaVersion: 1, seq: opts.claims.length, claims: opts.claims, messages: [], holders: [] }))
    versions.set(statePath, 1)
  }

  const ctx = new Context()
  const services = ['tools', 'timer', 'fs', 'sessions', 'sessionTitle', 'agents', 'systemPrompt']
  if (opts.teamsPresent) services.push('agentTeams')
  for (const n of services) ctx.provide(n)

  ctx.set('tools', { register: (t) => { tools.push(t); return () => {} } })
  ctx.set('timer', { timeout: (ms) => new Promise((r) => setTimeout(r, ms)), interval: () => () => {} })
  ctx.set('fs', makeFs(store, versions))
  ctx.set('sessions', { get: () => ({ header: { cwd: CWD } }) })
  ctx.set('sessionTitle', { get: () => ({ title: 'Teams Worker' }) })
  const initiator = opts.initiator || ME
  ctx.set('agents', {
    currentInitiator: () => initiator,
    list: () => opts.agentList || [initiator],
    get: (id) => (opts.agentsById && opts.agentsById[id]) || undefined
  })
  ctx.set('systemPrompt', {
    context: (c) => {
      contexts.set(c.name, c)
      return () => { if (contexts.get(c.name) === c) contexts.delete(c.name) }
    }
  })
  if (opts.teamsPresent) ctx.set('agentTeams', opts.service || serviceWith([]))

  await ctx.plugin(collabPlugin)
  await sleep(30)

  const readState = () => JSON.parse(store.get(statePath) || '{}')
  return {
    ctx, store, statePath, readState, contexts,
    lock: tools.find((t) => t.name === 'collab_lock') || null,
    awareness: contexts.get('dsh-collab/awareness') || null,
    discipline: contexts.get('dsh-collab/delegation') || null,
    /** 驱动 awareness 的 text()：先触发一次 fire-and-forget 刷新，再读命中缓存的文本。 */
    async awarenessText () {
      const pc = contexts.get('dsh-collab/awareness')
      if (!pc) return null
      pc.text()
      await sleep(140)
      return pc.text()
    },
    /** 驱动 pre-execute 瀑布：返回 { decision, nextCalls }。 */
    async pre (exec) {
      let nextCalls = 0
      const decision = await ctx.waterfall('tools/pre-execute', exec, () => {
        nextCalls++
        return Promise.resolve({ kind: 'allow' })
      })
      return { decision, nextCalls }
    }
  }
}

const execOf = (name, args, agent) => ({ name, arguments: args, agent })

// ════════════════════════════════════════════════════════════════════════
// 0. 纯逻辑（新导出的三个函数）
// ════════════════════════════════════════════════════════════════════════
console.log('# 0. 纯逻辑：teamTaskScopeLine / teamScopeOverlaps / teamCrossWarnLine')
{
  ok(teamTaskScopeLine(null) === null, 'null 任务集 -> null（负向对照）', String(teamTaskScopeLine(null)))
  ok(teamTaskScopeLine([]) === null, '空任务集 -> null（负向对照）', String(teamTaskScopeLine([])))
  const line = teamTaskScopeLine([TASK])
  ok(typeof line === 'string' && line.includes('t-1') && line.includes('docs/') && line.includes('advisory'),
    '有在跑任务 -> 文本含 id / 写域 / advisory', String(line))
  ok(teamTaskScopeLine([NO_SCOPES]) === null, 'in_progress 但 writeScopes 为空 -> null（负向对照）',
    String(teamTaskScopeLine([NO_SCOPES])))

  ok(teamScopeOverlaps([TASK], ['other/']).length === 0, '不重叠的路径 -> 空数组（负向对照）',
    JSON.stringify(teamScopeOverlaps([TASK], ['other/'])))
  ok(teamScopeOverlaps([TASK], []).length === 0, '空路径 -> 空数组（负向对照）',
    JSON.stringify(teamScopeOverlaps([TASK], [])))
  const ovs = teamScopeOverlaps([TASK], ['docs/a.md'])
  ok(ovs.length === 1 && ovs[0].taskId === 't-1' && ovs[0].scope === 'docs/' && ovs[0].path === 'docs/a.md',
    '重叠 -> 一条 {taskId, scope, path}（path 已归一化）', JSON.stringify(ovs))

  ok(teamCrossWarnLine([TASK], []) === null, '没有声明 -> null（负向对照）', String(teamCrossWarnLine([TASK], [])))
  ok(teamCrossWarnLine([TASK], [mkClaim({ paths: ['other/'] })]) === null,
    '声明不重叠 -> null（负向对照）', String(teamCrossWarnLine([TASK], [mkClaim({ paths: ['other/'] })])))
  const xw = teamCrossWarnLine([TASK], [mkClaim({ paths: ['docs/'] })])
  ok(typeof xw === 'string' && xw.includes('交叉预警') && xw.includes('docs/'),
    '声明重叠 -> 交叉预警文本点出路径', String(xw))
}

// ════════════════════════════════════════════════════════════════════════
// 1. 服务缺席 ⇒ 输出一字不变（核心负向对照）
// ════════════════════════════════════════════════════════════════════════
console.log('# 1. 服务缺席：awareness / overview / claim / delegation 四路输出都不含团队字段')
let ABSENT_AWARENESS_TEXT = null
{
  const foreign = BYTE_FOREIGN
  const absent = await makeHarness({ claims: [foreign] })
  ok(!!absent.awareness, '服务缺席的 harness 里 awareness PromptContext 仍注册（断言不是空的）')
  ok(!!absent.discipline, '服务缺席的 harness 里 delegation PromptContext 仍注册（对照物活着）')

  ABSENT_AWARENESS_TEXT = await absent.awarenessText()
  ok(!ABSENT_AWARENESS_TEXT.includes('官方 Agent Teams'),
    '服务缺席：awareness 文本不含「官方 Agent Teams」', ABSENT_AWARENESS_TEXT)
  ok(!ABSENT_AWARENESS_TEXT.includes('交叉预警'),
    '服务缺席：awareness 文本不含「交叉预警」', ABSENT_AWARENESS_TEXT)
  ok(ABSENT_AWARENESS_TEXT.includes('Other Session') && ABSENT_AWARENESS_TEXT.includes('docs/'),
    '（对照）awareness 照常渲染外部 collab 声明 —— 上面两条不是恒真', ABSENT_AWARENESS_TEXT)

  const ov = await absent.lock.execute({ op: 'overview' }, { agent: ME })
  ok(ov.ok === true, '服务缺席：overview 成功', JSON.stringify(ov).slice(0, 140))
  ok(!('teamTasks' in ov.data), '服务缺席：overview data **没有** teamTasks 键', Object.keys(ov.data || {}).join(','))
  ok(!('teamTasksNote' in ov.data), '服务缺席：overview data **没有** teamTasksNote 键', Object.keys(ov.data || {}).join(','))

  const cl = await absent.lock.execute({ op: 'claim', paths: ['free/'], ttlSec: 600 }, { agent: ME })
  ok(cl.ok === true, '服务缺席：claim 成功（用不与外部声明冲突的路径）', JSON.stringify(cl).slice(0, 140))
  ok(!('teamOverlaps' in cl.data), '服务缺席：claim data **没有** teamOverlaps 键', Object.keys(cl.data || {}).join(','))

  ok(absent.discipline.text() === DELEGATION_DISCIPLINE_TEXT,
    '服务缺席：order-131 文本 === DELEGATION_DISCIPLINE_TEXT（逐字节）',
    JSON.stringify(absent.discipline.text().slice(-60)))
}

// ════════════════════════════════════════════════════════════════════════
// 2. 服务在场，有在跑任务 / 没有在跑任务
// ════════════════════════════════════════════════════════════════════════
console.log('# 2. 服务在场 + 在跑任务：awareness 加 advisory 行；overview 带 teamTasks')
{
  const present = await makeHarness({ teamsPresent: true, service: serviceWith([TASK, PENDING, NO_SCOPES]) })
  const text = await present.awarenessText()
  ok(text.includes('t-1'), 'awareness 点出在跑任务 id', text)
  ok(text.includes('docs/'), 'awareness 点出在跑任务的写域', text)
  ok(text.includes('advisory'), 'awareness 把团队写域标成 advisory', text)
  ok(!text.includes('t-2'), 'awareness 不含 pending 任务（只认 in_progress）', text)
  ok(!text.includes('t-3'), 'awareness 不含 writeScopes 为空的在跑任务（过滤）', text)
  ok(text.startsWith('多会话协作（dsh-collab）：'), 'awareness 仍在通用规范基础上追加（首行未变）', text.slice(0, 40))

  const ov = await present.lock.execute({ op: 'overview' }, { agent: ME })
  const tt = ov.data && ov.data.teamTasks
  ok(Array.isArray(tt), 'overview data.teamTasks 是数组（服务在场）', JSON.stringify(tt))
  ok(Array.isArray(tt) && tt.length === 1, 'teamTasks 恰好只含在跑任务（pending / 空写域被过滤）', JSON.stringify(tt))
  ok(Array.isArray(tt) && tt[0] && tt[0].id === 't-1', 'teamTasks[0].id === t-1', JSON.stringify(tt && tt[0]))
  ok(Array.isArray(tt) && tt[0] && JSON.stringify(tt[0].writeScopes) === JSON.stringify(['docs/']),
    'teamTasks[0].writeScopes 原样带出', JSON.stringify(tt && tt[0] && tt[0].writeScopes))
  ok(Array.isArray(tt) && !tt.some((t) => t && (t.id === 't-2' || t.id === 't-3')),
    'pending / 空写域两类行都不在 teamTasks 里', JSON.stringify(tt))
  ok(typeof ov.data.teamTasksNote === 'string' && ov.data.teamTasksNote.length > 0,
    '服务在场：teamTasksNote 是非空字符串', JSON.stringify(ov.data.teamTasksNote))

  // 服务在场但此刻没有在跑任务：[] + note，且 awareness 不加团队行。
  const idle = await makeHarness({ teamsPresent: true, service: serviceWith([]) })
  const iov = await idle.lock.execute({ op: 'overview' }, { agent: ME })
  ok(Array.isArray(iov.data.teamTasks) && iov.data.teamTasks.length === 0,
    '服务在场但空闲 -> teamTasks: []（在场与缺席可分辨）', JSON.stringify(iov.data.teamTasks))
  ok(typeof iov.data.teamTasksNote === 'string' && iov.data.teamTasksNote.length > 0,
    '服务在场但空闲 -> teamTasksNote 仍在', JSON.stringify(iov.data.teamTasksNote))
  const itext = await idle.awarenessText()
  ok(!itext.includes('官方 Agent Teams') && !itext.includes('t-1') && !itext.includes('交叉预警'),
    '服务在场但空闲 -> awareness 不加团队行', itext)
  ok(itext.startsWith('多会话协作（dsh-collab）：'), '（对照）空闲时 awareness 仍是通用规范', itext.slice(0, 40))

  // 服务在场 + 在跑任务写域与**外部**声明重叠 -> awareness 追加反向预警行
  // （官方读不到本插件的声明，awareness 是能同时看到两边的唯一位置）。
  const cross = await makeHarness({
    teamsPresent: true,
    service: serviceWith([TASK]),
    claims: [mkClaim({ claimId: 'c_cross', paths: ['docs/'] })]
  })
  const ctext = await cross.awarenessText()
  ok(ctext.includes('官方 Agent Teams') && ctext.includes('docs/'), '重叠场景：awareness 有团队写域行', ctext)
  ok(ctext.includes('交叉预警') && ctext.includes('Other Session'),
    '重叠场景：awareness 追加交叉预警并点出外部持有者', ctext)
  ok(ctext.indexOf('官方 Agent Teams') < ctext.indexOf('交叉预警'),
    '重叠场景：团队写域行在前、交叉预警在后（渲染顺序稳定）', ctext)

  // 负向对照：外部声明与团队写域不重叠 -> 有团队行、但**没有**交叉预警。
  const nocross = await makeHarness({
    teamsPresent: true,
    service: serviceWith([TASK]),
    claims: [mkClaim({ claimId: 'c_nocross', paths: ['other/'] })]
  })
  const ntext = await nocross.awarenessText()
  ok(ntext.includes('官方 Agent Teams') && !ntext.includes('交叉预警'),
    '不重叠场景：有团队行、无交叉预警（负向对照）', ntext)
}

// ════════════════════════════════════════════════════════════════════════
// 3. 读不到 ≠ 空（负向对照）
// ════════════════════════════════════════════════════════════════════════
console.log('# 3. listTasks 抛错：与「服务缺席」逐字节等价，不是「服务在场但没有任务」')
{
  const foreign = BYTE_FOREIGN
  const broke = await makeHarness({ teamsPresent: true, service: THROWING_SERVICE, claims: [foreign] })
  const textBroke = await broke.awarenessText()
  ok(textBroke === ABSENT_AWARENESS_TEXT,
    '抛错 -> awareness 文本与「服务缺席」逐字节相同', JSON.stringify([ABSENT_AWARENESS_TEXT, textBroke]))
  ok(!textBroke.includes('官方 Agent Teams') && !textBroke.includes('交叉预警'),
    '抛错 -> awareness 无团队字样', textBroke)

  const ov = await broke.lock.execute({ op: 'overview' }, { agent: ME })
  ok(ov.ok === true, '抛错：overview 本身仍成功（读不到只降级团队字段）', JSON.stringify(ov).slice(0, 140))
  ok(!('teamTasks' in ov.data), '抛错 -> overview **没有** teamTasks 键（不是 []）', Object.keys(ov.data || {}).join(','))
  ok(!('teamTasksNote' in ov.data), '抛错 -> overview **没有** teamTasksNote 键', Object.keys(ov.data || {}).join(','))

  const cl = await broke.lock.execute({ op: 'claim', paths: ['free/'], ttlSec: 600 }, { agent: ME })
  ok(cl.ok === true, '抛错：claim 仍成功', JSON.stringify(cl).slice(0, 140))
  ok(!('teamOverlaps' in cl.data), '抛错 -> claim **没有** teamOverlaps 键（不是 []）', Object.keys(cl.data || {}).join(','))
}

// ════════════════════════════════════════════════════════════════════════
// 4. claim 的 advisory：不改锁语义
// ════════════════════════════════════════════════════════════════════════
console.log('# 4. claim 的 teamOverlaps：命中 / 不命中 / 服务缺席三态')
{
  const present = await makeHarness({ teamsPresent: true, service: serviceWith([TASK]) })
  const r = await present.lock.execute({ op: 'claim', paths: ['docs/a.md'], ttlSec: 600 }, { agent: ME })
  ok(r.ok === true, 'claim docs/a.md 仍然 ok:true（advisory 不拒绝、不改判据）', JSON.stringify(r).slice(0, 160))
  const ovs = r.data && r.data.teamOverlaps
  ok(Array.isArray(ovs) && ovs.length === 1, 'teamOverlaps 恰好一条', JSON.stringify(ovs))
  ok(Array.isArray(ovs) && ovs[0] && ovs[0].taskId === 't-1', 'teamOverlaps[0].taskId === t-1', JSON.stringify(ovs && ovs[0]))
  ok(Array.isArray(ovs) && ovs[0] && ovs[0].scope === 'docs/', 'teamOverlaps[0].scope === docs/', JSON.stringify(ovs && ovs[0]))
  ok(Array.isArray(ovs) && ovs[0] && ovs[0].path === 'docs/a.md', 'teamOverlaps[0].path 是归一化后的声明路径', JSON.stringify(ovs && ovs[0]))
  ok(!!(r.data && r.data.claim) && JSON.stringify(r.data.claim.paths) === JSON.stringify(['docs/a.md']),
    'claim 本身照常落库（paths 一字不变）', JSON.stringify(r.data && r.data.claim && r.data.claim.paths))

  // 负向对照：同一 harness、服务仍在场，但声明路径不与任何团队写域重叠。
  const r2 = await present.lock.execute({ op: 'claim', paths: ['other/'], ttlSec: 600 }, { agent: ME })
  ok(r2.ok === true, '不重叠的 claim 也成功', JSON.stringify(r2).slice(0, 140))
  ok(Array.isArray(r2.data.teamOverlaps) && r2.data.teamOverlaps.length === 0,
    '不重叠 -> teamOverlaps: []（不是在场的恒真数组）', JSON.stringify(r2.data && r2.data.teamOverlaps))

  // 对称对照：服务缺席时跑**同一个 claim**，锁结果逐字段相同，只是没有 advisory 字段。
  const absent = await makeHarness({})
  const r3 = await absent.lock.execute({ op: 'claim', paths: ['docs/a.md'], ttlSec: 600 }, { agent: ME })
  ok(r3.ok === true && !('teamOverlaps' in r3.data),
    '服务缺席：同一 claim 也没有 teamOverlaps 键', Object.keys(r3.data || {}).join(','))
  const lockShape = (x) => JSON.stringify({
    ok: x.ok,
    claimId: x.data.claim.claimId,
    holderId: x.data.claim.holderId,
    paths: x.data.claim.paths,
    mode: x.data.claim.mode,
    readable: x.data.claim.readable,
    merged: x.data.merged,
    warning: x.data.warning
  })
  ok(lockShape(r) === lockShape(r3),
    '锁结果本身（claimId/holderId/paths/mode/readable/merged/warning）在有/无服务时相同 —— advisory 只加字段',
    lockShape(r) + ' vs ' + lockShape(r3))
}

// ════════════════════════════════════════════════════════════════════════
// 5. 反向预警：tools/pre-execute 上的 team_task_create
// ════════════════════════════════════════════════════════════════════════
console.log('# 5. 反向预警：外部声明 × 团队写域重叠时 inject 一条 notice，且永不阻断')
{
  const external = mkClaim({ claimId: 'c_ext', holderId: 'agent:someone-else', holderName: 'Other Session', paths: ['docs/'] })
  const teamArgs = { subject: 's', description: 'd', write_scopes: ['docs/'] }

  // ── 正例 ──
  resetInject()
  const pos = await makeHarness({ teamsPresent: true, service: serviceWith([TASK]), claims: [external] })
  const pr = await pos.pre(execOf('team_task_create', teamArgs, OTHER_AGENT))
  ok(pr.decision.kind === 'allow' && pr.nextCalls === 1,
    '正例：advisory **不阻断** —— next() 恰好一次、决策是 allow', JSON.stringify(pr))
  ok(injectLog.length === 1, '正例：重叠 -> 恰好投递一条 notice', 'injects=' + injectLog.length)
  const msg = injectLog[0] && injectLog[0].message
  ok(!!msg && !!msg.source && msg.source.kind === 'dsh-collab',
    "正例：source.kind === 'dsh-collab'（显式来源）", JSON.stringify(msg && msg.source))
  ok(!!msg && !!msg.source && msg.source.form === 'notice',
    "正例：source.form === 'notice'", String(msg && msg.source && msg.source.form))
  ok(!!msg && !!msg.source && typeof msg.source.summary === 'string' && msg.source.summary.length > 0,
    '正例：source.summary 是非空字符串（notice 缺它会退化成 opaque）',
    JSON.stringify(msg && msg.source && msg.source.summary))
  const txt = noticeText(injectLog[0])
  ok(txt.includes('交叉预警'), '正例：正文含「交叉预警」', txt)
  ok(txt.includes('docs/'), '正例：正文点出重叠的写域', txt)
  ok(txt.includes('Other Session'), '正例：正文点出外部持有者', txt)

  // ── 负向对照 (a)：write_scopes 不重叠 ──
  resetInject()
  const a = await makeHarness({ teamsPresent: true, service: serviceWith([TASK]), claims: [external] })
  const ar = await a.pre(execOf('team_task_create', { subject: 's', description: 'd', write_scopes: ['elsewhere/'] }, OTHER_AGENT))
  ok(injectLog.length === 0, '(a) 写域不重叠 -> 不投递', 'injects=' + injectLog.length)
  ok(ar.decision.kind === 'allow' && ar.nextCalls === 1, '(a) 不重叠也照常 next() 一次', JSON.stringify(ar))

  // ── 负向对照 (b1)：声明就是调用者自己的 ──
  resetInject()
  const own = mkClaim({ claimId: 'c_own', holderId: 'agent:' + OTHER_AGENT.id, holderName: 'Other', paths: ['docs/'] })
  const b1 = await makeHarness({ teamsPresent: true, service: serviceWith([TASK]), claims: [own] })
  const b1r = await b1.pre(execOf('team_task_create', teamArgs, OTHER_AGENT))
  ok(injectLog.length === 0, '(b1) 声明属于调用者自己 -> 不投递', 'injects=' + injectLog.length)
  ok(b1r.decision.kind === 'allow' && b1r.nextCalls === 1, '(b1) 照常 next() 一次', JSON.stringify(b1r))

  // ── 负向对照 (b2)：声明属于调用者的**祖先会话**（同一家族）──
  resetInject()
  const anc = mkClaim({ claimId: 'c_anc', holderId: 'agent:agent-parent', holderName: 'Parent', paths: ['docs/'] })
  const b2 = await makeHarness({
    teamsPresent: true,
    service: serviceWith([TASK]),
    claims: [anc],
    initiator: CHILD_OF_PARENT,
    agentList: [CHILD_OF_PARENT, PARENT_AGENT]
  })
  const b2r = await b2.pre(execOf('team_task_create', teamArgs, CHILD_OF_PARENT))
  ok(injectLog.length === 0, '(b2) 声明属于同家族（祖先）-> 不投递（家族豁免）', 'injects=' + injectLog.length)
  ok(b2r.decision.kind === 'allow' && b2r.nextCalls === 1, '(b2) 照常 next() 一次', JSON.stringify(b2r))

  // ── 正例 2：第二个团队任务工具名 team_task_update 同样触发 ──
  resetInject()
  const pos2 = await makeHarness({ teamsPresent: true, service: serviceWith([TASK]), claims: [external] })
  const p2r = await pos2.pre(execOf('team_task_update', { task_id: 'x', write_scopes: ['docs/'] }, OTHER_AGENT))
  ok(injectLog.length === 1, '正例 2：team_task_update 同样投递一条', 'injects=' + injectLog.length)
  ok(p2r.decision.kind === 'allow' && p2r.nextCalls === 1, '正例 2：照常 next() 一次', JSON.stringify(p2r))

  // ── 负向对照 (b3)：非 exclusive 声明不算「外部占用」（shared / read 一律不投）──
  resetInject()
  const shared = mkClaim({ claimId: 'c_shared', holderName: 'Shared Session', paths: ['docs/'], mode: 'shared' })
  const b3 = await makeHarness({ teamsPresent: true, service: serviceWith([TASK]), claims: [shared] })
  const b3r = await b3.pre(execOf('team_task_create', teamArgs, OTHER_AGENT))
  ok(injectLog.length === 0, '(b3) 外部 shared 声明 -> 不投递（不是独占占用）', 'injects=' + injectLog.length)
  ok(b3r.decision.kind === 'allow' && b3r.nextCalls === 1, '(b3) 照常 next() 一次', JSON.stringify(b3r))

  resetInject()
  const readOnly = mkClaim({ claimId: 'c_read', holderName: 'Read Session', paths: ['docs/'], mode: 'read' })
  const b4 = await makeHarness({ teamsPresent: true, service: serviceWith([TASK]), claims: [readOnly] })
  const b4r = await b4.pre(execOf('team_task_create', teamArgs, OTHER_AGENT))
  ok(injectLog.length === 0, '(b4) 外部 read 声明 -> 不投递（纯观测）', 'injects=' + injectLog.length)
  ok(b4r.decision.kind === 'allow' && b4r.nextCalls === 1, '(b4) 照常 next() 一次', JSON.stringify(b4r))

  // ── 负向对照 (b5)：过期声明不算外部占用 ──
  resetInject()
  const expired = mkClaim({ claimId: 'c_old', holderName: 'Gone Session', paths: ['docs/'], expiresAt: Date.now() - 1000 })
  const b5 = await makeHarness({ teamsPresent: true, service: serviceWith([TASK]), claims: [expired] })
  const b5r = await b5.pre(execOf('team_task_create', teamArgs, OTHER_AGENT))
  ok(injectLog.length === 0, '(b5) 已过期的外部声明 -> 不投递', 'injects=' + injectLog.length)
  ok(b5r.decision.kind === 'allow' && b5r.nextCalls === 1, '(b5) 照常 next() 一次', JSON.stringify(b5r))

  // ── 负向对照 (c)：非团队任务工具名 ──
  resetInject()
  const c = await makeHarness({ teamsPresent: true, service: serviceWith([TASK]), claims: [external] })
  // file_path 特意选不覆盖的路径：这样写门控本身也放行，能干净地只看"工具名"这一条判据。
  const cr = await c.pre(execOf('write', { file_path: 'unrelated/x.md', write_scopes: ['docs/'] }, OTHER_AGENT))
  ok(injectLog.length === 0, '(c) 非团队工具名 write -> 即便参数里带了重叠的 write_scopes 也不投递', 'injects=' + injectLog.length)
  ok(cr.decision.kind === 'allow' && cr.nextCalls === 1, '(c) 照常 next() 一次', JSON.stringify(cr))

  // ── 服务缺席：反向预警这条支路整体不生效（降级契约要字面成立）──
  // 0.11.0 起 `teamScopeNotice` 自己读 `ctx.get('agentTeams')`，不再依赖
  // "官方工具只在该服务在场时存在"这条外部事实兜底。
  resetInject()
  const d = await makeHarness({ claims: [external] })
  const dr = await d.pre(execOf('team_task_create', teamArgs, OTHER_AGENT))
  ok(injectLog.length === 0,
    '服务缺席：即便工具名与写域都命中，也不投递团队预警（服务缺席 ⇒ 一字不变）',
    'injects=' + injectLog.length)
  ok(dr.decision.kind === 'allow' && dr.nextCalls === 1, '服务缺席：照常 next() 一次', JSON.stringify(dr))

  // ── camelCase `writeScopes` 回退分支（service 面用 camelCase，官方工具参数用 snake_case）──
  resetInject()
  const cc = await makeHarness({ teamsPresent: true, service: serviceWith([TASK]), claims: [external] })
  const ccr = await cc.pre(execOf('team_task_update', { task_id: 't-1', expected_revision: 1, action: 'edit', writeScopes: ['docs/'] }, OTHER_AGENT))
  ok(injectLog.length === 1, 'camelCase writeScopes 同样触发预警（回退分支被覆盖）', 'injects=' + injectLog.length)
  ok(ccr.decision.kind === 'allow' && ccr.nextCalls === 1, 'camelCase 分支照常 next() 一次', JSON.stringify(ccr))

  // ── 门控与预警的先后：被门控拒掉的调用不该再收到预警 ──
  resetInject()
  const e = await makeHarness({ teamsPresent: true, service: serviceWith([TASK]), claims: [external] })
  const er = await e.pre(execOf('write', { file_path: 'docs/a.md', content: 'x' }, OTHER_AGENT))
  ok(er.decision.kind === 'ask', '对照：写门控命中外部分声明时仍然 ask（预警不接管门控）', JSON.stringify(er))
  ok(er.nextCalls === 0, '对照：被门控拒掉时不调用 next()', 'nextCalls=' + er.nextCalls)
  ok(injectLog.length === 0, '对照：被门控拒掉时也不再补一条团队预警（预警在放行之后）', 'injects=' + injectLog.length)
}

// ════════════════════════════════════════════════════════════════════════
// 6. 委托纪律追加段（order 131）
// ════════════════════════════════════════════════════════════════════════
console.log('# 6. 服务在场 -> order-131 文本 = 纯常量 + "\\n" + TEAM_DISCIPLINE_ADDENDUM')
{
  const present = await makeHarness({ teamsPresent: true, service: serviceWith([]) })
  ok(!!present.discipline, '服务在场：delegation PromptContext 注册')
  ok(!!present.discipline && present.discipline.order === 131, 'order === 131', String(present.discipline && present.discipline.order))
  const withTeam = present.discipline ? present.discipline.text() : null
  ok(withTeam === DELEGATION_DISCIPLINE_TEXT + '\n' + TEAM_DISCIPLINE_ADDENDUM,
    '服务在场：文本 === DELEGATION_DISCIPLINE_TEXT + "\\n" + TEAM_DISCIPLINE_ADDENDUM',
    JSON.stringify(withTeam && withTeam.slice(-70)))
  ok(typeof withTeam === 'string' && withTeam.length > DELEGATION_DISCIPLINE_TEXT.length,
    '追加段确实让文本变长（上一条不是恒真）', 'len=' + (withTeam ? withTeam.length : 'n/a'))
  ok(!/[0-9]/.test(TEAM_DISCIPLINE_ADDENDUM),
    'TEAM_DISCIPLINE_ADDENDUM 不含阿拉伯数字（tests/collab-skill.mjs 的守护）', TEAM_DISCIPLINE_ADDENDUM)
  ok(TEAM_DISCIPLINE_ADDENDUM.includes('Agent Teams') && TEAM_DISCIPLINE_ADDENDUM.includes('send_message'),
    '追加段讲的是官方 Agent Teams 的唤醒路径', TEAM_DISCIPLINE_ADDENDUM)

  // 负向对照：服务缺席时文本回到纯常量（逐字节），两串必须不同。
  const absent = await makeHarness({})
  const plain = absent.discipline ? absent.discipline.text() : null
  ok(plain === DELEGATION_DISCIPLINE_TEXT, '服务缺席：文本 === DELEGATION_DISCIPLINE_TEXT', JSON.stringify(plain && plain.slice(-40)))
  ok(plain !== withTeam, '两串不同（正例断言不是恒真）')
}

h.finish()
