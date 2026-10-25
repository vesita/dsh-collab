// tests/collab-invariants-i1-i4.mjs
// 针对 I1（唯一存活判据）、I2（归属）、I3（有界）、I4（不误收）的专项不变量守卫测试
//
// I1: 存活判据**只有 oracle 一条**（`LivenessFn` 三态）。任何对外呈现（list/overview/status/
//     renderDigest/renderAccessNotice）中，not-live 的持有者及其占用都不得出现；没有第二条
//     时钟口径可与之矛盾。
// I2: 播报文案不得用他人标题作第二人称；必须显式指明是「另一个会话」（带 sessionId 短标识 +
//     截断后的标题）。唯一实现点 holderLabel。
// I3: released 墓碑表不得随时间无界增长；compaction 不得丢掉仍需要的信息（释放语义要保住）。
//     sweep 诊断必须如实记 prunedReleased。
// I4: 拿不到判据（没有 oracle / oracle 自己坏了）时**不淘汰、不误收**（fail-closed 门禁）。
//
// 运行：node tests/collab-invariants-i1-i4.mjs

import { createHarness } from './_harness.mts'
import { init, sweep, holderView, MAX_RELEASED } from '../lib/collab-core.js'
import {
  renderDigest,
  renderAccessNotice,
  holderLabel,
  overview,
  related
} from '../lib/collab-ops.js'

const h = createHarness()
const { ok } = h

const T_NOW = 1791870000000

const livenessOf = (dead) => (holderId) => (dead.includes(holderId) ? 'not-live' : 'live')

// ════════════════════════════════════════════════════════════════════════
// 1. I1（唯一存活判据）：not-live 的 holder 及其占用在对外呈现中不可见
// ════════════════════════════════════════════════════════════════════════
console.log('# 1. I1（唯一存活判据）：not-live 的 holder 及其占用在对外呈现中不可见')
{
  const st = init()
  st.holders.push({
    holderId: 'agent:live-1',
    name: '活会话任务',
    kind: 'agent',
    sessionId: 'live-1',
    lastSeenAt: T_NOW - 10000,
    proc: '1234:5678'
  })
  st.claims.push({
    claimId: 'c_live',
    holderId: 'agent:live-1',
    holderName: '活会话任务',
    paths: ['src/live/'],
    mode: 'exclusive',
    createdAt: T_NOW - 10000,
    readable: true
  })

  // 确证死亡的持有者：oracle 说 not-live。声明**没有过期时间**，所以死亡与
  // 任何时间量都无关 —— 时钟不再有第二句话可说。
  st.holders.push({
    holderId: 'agent:zombie-1',
    name: '你是 Rust 工程师，在一个已有仓库中重构',
    kind: 'agent',
    sessionId: 'zombie-1',
    lastSeenAt: T_NOW - 300000,
    proc: '1234:5678' // 相同 proc，靠 proc 区分不出会话
  })
  st.claims.push({
    claimId: 'c_zombie',
    holderId: 'agent:zombie-1',
    holderName: '你是 Rust 工程师，在一个已有仓库中重构',
    paths: ['src/zombie/'],
    mode: 'exclusive',
    createdAt: T_NOW - 300000,
    readable: true
  })

  const liveness = livenessOf(['agent:zombie-1'])

  // 1.1 holderView 对外呈现名册不得包含 not-live 的 holder
  const visibleHolders = holderView(st, T_NOW, { liveness }).map(x => x.holderId)
  ok(!visibleHolders.includes('agent:zombie-1'),
    'I1: holderView 不得包含 not-live 的 holder',
    JSON.stringify(visibleHolders))
  ok(visibleHolders.includes('agent:live-1'),
    'I1 对照: holderView 保留 live holder',
    JSON.stringify(visibleHolders))

  // 1.2 overview 对外呈现中不得列出 not-live 的 holder 及其占用
  const ov = overview(st, liveness)
  const ovHolderIds = ov.holders.map(x => x.holderId)
  ok(!ovHolderIds.includes('agent:zombie-1'),
    'I1: overview 不得列出 not-live 的 holder',
    JSON.stringify(ovHolderIds))
  ok(ovHolderIds.includes('agent:live-1'),
    'I1 对照: overview 正常列出 live holder',
    JSON.stringify(ovHolderIds))
  ok(ov.totalClaims === 1,
    'I1: overview totalClaims 排除 not-live 的占用 (预期 1，实际 ' + ov.totalClaims + ')',
    'totalClaims=' + ov.totalClaims)

  // 1.3 related (status op 底层) 查询不得返回 not-live 的占用
  const rel = related(st, ['src/zombie/'], { liveness })
  ok(rel.length === 0,
    'I1: related(status) 不得返回 not-live 的占用',
    JSON.stringify(rel.map(c => c.claimId)))

  // 1.4 sweep 回收 not-live 的名册行；没有 oracle 时一行都不动
  const stForSweep = init()
  stForSweep.holders.push({
    holderId: 'agent:dead-idle',
    name: '已确证死亡',
    kind: 'agent',
    sessionId: 'dead-idle',
    lastSeenAt: T_NOW - 300000,
    proc: '1234:5678'
  })
  const swept = sweep(stForSweep, { liveProcs: new Set(['1234:5678']), liveness: livenessOf(['agent:dead-idle']) })
  ok(stForSweep.holders.length === 0,
    'I1: sweep 淘汰 oracle 说 not-live 的名册行（即使宿主 proc 还在）',
    JSON.stringify(stForSweep.holders))
  ok(swept.prunedHolders === 1, 'I1: sweep prunedHolders 计数正确', 'prunedHolders=' + swept.prunedHolders)

  // 1.5 呈现层（态势与访问通知）排除 not-live 的占用
  const liveClaims = st.claims.filter(c => c.holderId !== 'agent:zombie-1')
  const digestText = renderDigest(liveClaims)
  ok(!digestText.includes('src/zombie/'),
    'I1: renderDigest 不得播报 not-live 的占用路径',
    digestText)
  ok(!digestText.includes('zombie-1'),
    'I1: renderDigest 不得包含 not-live 的 holder 标识',
    digestText)
  ok(digestText.includes('src/live/'),
    'I1 对照: renderDigest 照常包含 live holder 占用',
    digestText)

  const accessNotice = renderAccessNotice(liveClaims)
  ok(!accessNotice.includes('src/zombie/'),
    'I1: renderAccessNotice 不得播报 not-live 的占用路径',
    accessNotice)
  ok(accessNotice.includes('src/live/'),
    'I1 对照: renderAccessNotice 照常包含 live 占用',
    accessNotice)
}

// ════════════════════════════════════════════════════════════════════════
// 2. I2（归属）：播报文案不得把他人标题当第二人称，显式标明「另一个会话」且标题截断
// ════════════════════════════════════════════════════════════════════════
console.log('# 2. I2（归属）：不得把他人标题当第二人称，显式标明外部会话且标题截断')
{
  const otherPromptTitle = '你是 Rust 工程师，在一个已有项目中完成重构并提交代码'
  const holderId = 'agent:session-fe6456ca-ddb9-4200-915f-8b6c1dd8675d'

  // 2.1 holderLabel 唯一实现点：必须显式标明是外部/另一个会话，绝不能裸拼「你是...」
  const label = holderLabel(holderId, otherPromptTitle)
  ok(!label.startsWith('你是'),
    'I2: holderLabel 绝不能以「你是」等第二人称裸标题开头',
    label)
  ok(label.includes('另一个会话') || label.includes('会话'),
    'I2: holderLabel 必须显式指明「另一个会话」或「会话」',
    label)
  ok(label.includes('fe6456ca'),
    'I2: holderLabel 必须带上会话短标识（句柄）',
    label)
  ok(label.length <= 40,
    'I2: holderLabel 对超长标题必须截断，长度有界（<= 40 字）',
    'length=' + label.length + ' label=' + label)

  // 2.2 普通名称同样规范呈现且有界
  const normalLabel = holderLabel('agent:session-4942839c-x', 'Same')
  ok(normalLabel.includes('4942839c'), 'I2: 普通名称带句柄', normalLabel)
  ok(normalLabel.includes('Same'), 'I2: 普通名称包含标题', normalLabel)

  // 2.3 在 renderDigest 里的实际呈现不能让读者读成第二人称
  const c = {
    claimId: 'c_test',
    holderId,
    holderName: otherPromptTitle,
    paths: ['src/core/'],
    mode: 'exclusive',
    createdAt: T_NOW
  }
  const digest = renderDigest([c])
  ok(!digest.includes('你是 Rust 工程师'),
    'I2: renderDigest 全文中不得出现未加修饰的他人第二人称原句',
    digest)
}

// ════════════════════════════════════════════════════════════════════════
// 3. I3（有界）：released 墓碑表只按条数上限确定性淘汰
// ════════════════════════════════════════════════════════════════════════
console.log('# 3. I3（有界）：墓碑表按条数上限淘汰，规则只看数据')
{
  const st = init()
  st.released['c_old1@proc'] = 1
  st.released['c_future1@proc'] = 100000

  // 3.1 未超上限：一条都不丢（墓碑与时间无关）
  const swept = sweep(st)
  ok(('c_old1@proc' in st.released) && ('c_future1@proc' in st.released),
    'I3: 未超上限时墓碑全部保留（不再按时钟 GC）', JSON.stringify(st.released))
  ok(swept.prunedReleased === 0, 'I3: 没有淘汰时 prunedReleased=0', 'prunedReleased=' + swept.prunedReleased)

  // 3.2 超过 MAX_RELEASED：确定性丢最旧（值最小的那些）
  for (let i = 0; i < MAX_RELEASED + 10; i++) st.released['c_flood_' + i + '@proc'] = i + 10
  sweep(st)
  const countAfter = Object.keys(st.released).length
  ok(countAfter === MAX_RELEASED, 'I3: released 规模受 MAX_RELEASED 硬上限保护', 'count=' + countAfter)
  ok(!('c_old1@proc' in st.released) && !('c_flood_0@proc' in st.released),
    'I3: 丢掉的是值最小的那些', JSON.stringify(Object.keys(st.released).slice(0, 2)))
}

// ════════════════════════════════════════════════════════════════════════
// 4. I4（不误收）：拿不到判据时 fail-closed
// ════════════════════════════════════════════════════════════════════════
console.log('# 4. I4（不误收）：拿不到判据时 fail-closed')
{
  const st = init()
  st.holders.push({ holderId: 'agent:no-oracle', name: '判据不可用', kind: 'agent', sessionId: 'no-oracle' })
  st.claims.push({
    claimId: 'c_nooracle',
    holderId: 'agent:no-oracle',
    holderName: '判据不可用',
    paths: ['src/unknown/'],
    mode: 'exclusive',
    createdAt: T_NOW - 10000,
    readable: true
  })

  // 4.1 没有 oracle（undefined）⇒ 一条也不淘汰
  const idsNone = holderView(st, T_NOW).map(x => x.holderId)
  ok(idsNone.includes('agent:no-oracle'),
    'I4: 没有 oracle 时 fail-closed 不误收',
    JSON.stringify(idsNone))

  // 4.2 oracle 自己坏了（failed）⇒ 同样不误收
  const idsFailed = holderView(st, T_NOW, { liveness: () => 'failed' }).map(x => x.holderId)
  ok(idsFailed.includes('agent:no-oracle'),
    'I4: oracle 返回 failed 时 fail-closed 不误收',
    JSON.stringify(idsFailed))
}

h.finish()
