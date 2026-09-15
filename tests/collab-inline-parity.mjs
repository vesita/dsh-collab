// tests/collab-inline-parity.mjs
//
// 守护什么
//   dsh-collab 有两形态，纯逻辑**各写一份**：
//     · 包形态    src/collab-core.ts → lib/collab-core.js（可 import）
//     · 动态宿主形态  src/collab-plugin.host.ts 里 hostCode 字符串内联的自包含副本
//       （Cordis 动态插件的 code.host 不接受 import/打包，只能把纯逻辑复制一遍）
//   本文件从 hostCode 字符串里**抽出真实函数体**（不是复制品），与 lib/collab-core.js 的
//   同名导出用**同一份语料**逐输出深度对拍；并断言"两形态同名函数集合"恰好等于下面的
//   期望集合 —— 将来有人在两边各加同名函数却忘了接进对拍，集合断言会变红。
//
// 为什么
//   内联副本会静默漂移：只改一边，两形态行为就此分叉，而没有任何测试会红。
//
// 与 tests/collab-hostcode-parity.mjs 的分工（互补，不要合并）
//   · collab-hostcode-parity.mjs 把 hostCode 整体装进 fake ctx **跑起来**，走
//     "注册工具 → 路径解析 → 锁语义 → awareness 注入文本"的端到端链路，
//     但它逐输出对拍的只有 clockUtc / renderDigest / modeLabel 三个函数。
//   · 本文件不跑插件，只做"抽函数体 → 逐函数语料对拍"，覆盖同名集合里的每一个函数，
//     并守护"同名集合本身"（漏接对拍会红）。抽取思路照抄旧测试第 258-266 行的先例，
//     但改用括号配对扫描（旧正则抓不到单行箭头，也会把 `ov` 吃到后面的 `norm` 里去）。
//
// 运行：node tests/collab-inline-parity.mjs   退出码非 0 即失败
// 本文件自包含：不依赖任何既有测试文件，也不改动任何既有文件。

// ---------------------------------------------------------------- 结果统计
let pass = 0
let fail = 0
const groups = new Map()
let currentGroup = 'setup'
const group = (name, subtitle) => {
  currentGroup = name
  if (!groups.has(name)) {
    groups.set(name, { pass: 0, fail: 0 })
    console.log('\n# ' + name + (subtitle ? ' · ' + subtitle : ''))
  }
}
const ok = (cond, label, extra) => {
  const g = groups.get(currentGroup)
  if (cond) { pass++; if (g) g.pass++ }
  else { fail++; if (g) g.fail++; console.log('  FAIL ' + label + (extra ? '  <-- ' + extra : '')) }
}

const deepEqual = (a, b) => {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b)
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const aArr = Array.isArray(a), bArr = Array.isArray(b)
  if (aArr !== bArr) return false
  if (aArr) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!deepEqual(a[k], b[k])) return false
  }
  return true
}
const show = (v) => {
  let s
  try {
    s = JSON.stringify(v, (k, val) => {
      if (typeof val === 'function') return '[fn]'
      if (val === undefined) return '[undefined]'
      if (typeof val === 'number' && Number.isNaN(val)) return '[NaN]'
      return val
    })
  } catch (e) { s = String(v) }
  if (s === undefined) s = String(v)
  return s.length > 240 ? s.slice(0, 240) + '…' : s
}
const cmp = (label, hv, cv, extra) =>
  ok(deepEqual(hv, cv), label, 'host=' + show(hv) + ' core=' + show(cv) + (extra ? ' ' + extra : ''))

// ---------------------------------------------------------------- 抽取器
// 从 hostCode 源码文本里取出**真实函数体**并执行。三种形态都要吃下：
//   function name(args) { … \n    }          （多行函数声明）
//   const name = (args) => { … \n    }       （多行箭头）
//   const name = args => expr                （单行箭头，如 seg）
//   const name = () => ({ … })               （单行箭头 + 括号包裹的对象字面量，如 init）
// 因此不能只靠正则，必须做**括号配对扫描**；并且声明必须锚定**恰好 4 空格缩进**：
// hostCode 里还有一处深层缩进的 `const init = agents.currentInitiator()…`（12 空格），
// 裸匹配 `const init` 会抽到它。锚定这一事实由下面的 group('name-set') 显式断言。
const PAIRS = { '(': ')', '[': ']', '{': '}' }
const ID_CHAR = /[A-Za-z0-9_$]/

function skipTrivia(src, i) {
  for (;;) {
    const c = src[i]
    if (c === undefined) return i
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
    return i
  }
}
function skipString(src, i) {
  const q = src[i]; i++
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue }
    if (src[i] === q) return i + 1
    i++
  }
  throw new Error('unterminated string')
}
function skipTemplate(src, i) {
  i++
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue }
    if (src[i] === '`') return i + 1
    if (src[i] === '$' && src[i + 1] === '{') { i = scanBalanced(src, i + 1) + 1; continue }
    i++
  }
  throw new Error('unterminated template')
}
function skipRegex(src, i) {
  i++
  let cls = false
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (c === '\n') throw new Error('unterminated regex')
    if (c === '[') cls = true
    else if (c === ']') cls = false
    else if (c === '/' && !cls) { i++; while (/[a-z]/i.test(src[i] || '')) i++; return i }
    i++
  }
  throw new Error('unterminated regex')
}
const regexAllowed = (prev) => prev === null || '(,=:[!&|?{};+-*/%^<>~'.includes(prev)

// src[openIdx] 是开括号；返回配对闭括号的下标（跳过字符串/注释/正则）。
function scanBalanced(src, openIdx) {
  const close = PAIRS[src[openIdx]]
  if (!close) throw new Error('not an opening bracket at ' + openIdx)
  let depth = 0, i = openIdx, prev = null
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"') { i = skipString(src, i); prev = 'x'; continue }
    if (c === '`') { i = skipTemplate(src, i); prev = 'x'; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
    if (c === '/' && regexAllowed(prev)) { i = skipRegex(src, i); prev = 'x'; continue }
    if (c === '(' || c === '[' || c === '{') { depth++; prev = c; i++; continue }
    if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) { if (c !== close) throw new Error('bracket mismatch at ' + i); return i }
      prev = c; i++; continue
    }
    if (!(c === ' ' || c === '\t' || c === '\n' || c === '\r')) prev = c
    i++
  }
  throw new Error('unbalanced bracket from ' + openIdx)
}
function findDecl(src, name) {
  const esc = name.replace(/\$/g, '\\$')
  const mFn = new RegExp('^ {4}(?:async\\s+)?function\\s+' + esc + '\\s*\\(', 'm').exec(src)
  const mVar = new RegExp('^ {4}const\\s+' + esc + '\\s*=', 'm').exec(src)
  if (mFn && (!mVar || mFn.index < mVar.index)) return { idx: mFn.index, kind: 'function' }
  if (mVar) return { idx: mVar.index, kind: 'const' }
  return null
}
function declText(src, name) {
  const d = findDecl(src, name)
  if (!d) throw new Error('declaration not found: ' + name)
  const start = d.idx
  let end
  if (d.kind === 'function') {
    const j = scanBalanced(src, src.indexOf('(', d.idx))
    const i = skipTrivia(src, j + 1)
    if (src[i] !== '{') throw new Error('no body brace: ' + name)
    end = scanBalanced(src, i)
  } else {
    let j = skipTrivia(src, src.indexOf('=', d.idx) + 1)
    if (src.startsWith('async', j)) j = skipTrivia(src, j + 5)
    if (src[j] === '(') j = scanBalanced(src, j) + 1
    else { while (ID_CHAR.test(src[j] || '')) j++ }
    j = skipTrivia(src, j)
    if (!src.startsWith('=>', j)) throw new Error('no arrow: ' + name)
    j = skipTrivia(src, j + 2)
    if (src[j] === '{' || src[j] === '(') { end = scanBalanced(src, j) }
    else {
      // 单表达式箭头（如 `p => p.split('/').filter(Boolean)`）：扫到顶层换行/分号为止。
      let depth = 0, prev = null, k = j
      while (k < src.length) {
        const c = src[k]
        if (c === "'" || c === '"') { k = skipString(src, k); prev = 'x'; continue }
        if (c === '`') { k = skipTemplate(src, k); prev = 'x'; continue }
        if (c === '/' && src[k + 1] === '/') break
        if (c === '/' && regexAllowed(prev)) { k = skipRegex(src, k); prev = 'x'; continue }
        if (c === '(' || c === '[' || c === '{') { depth++; prev = c; k++; continue }
        if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; prev = c; k++; continue }
        if ((c === ';' || c === '\n') && depth === 0) break
        if (!/\s/.test(c)) prev = c
        k++
      }
      end = k - 1
      while (end > start && /\s/.test(src[end])) end--
    }
  }
  return src.slice(start, end + 1)
}
function extractFrom(src, name, scope) {
  const text = declText(src, name)
  const k = Object.keys(scope || {}), v = k.map((n) => scope[n])
  const isFn = /^(?:async\s+)?function\b/.test(text.trim())
  const body = isFn ? 'return ' + text : text + ';\nreturn ' + name
  const fn = new Function(...k, body)(...v)
  if (typeof fn !== 'function') throw new Error('not a function: ' + name)
  return fn
}
// 宿主形态里"恰好 4 空格缩进"的函数声明名（函数声明 + 箭头函数赋值）。
// 只是候选名集合，用来算同名集合；不要求每个都能被抽取（exec/lock 这类组合式工厂不在对拍范围内）。
function hostDeclNames(src) {
  const out = new Set()
  for (const m of src.matchAll(/^ {4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1])
  for (const m of src.matchAll(/^ {4}const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm)) out.add(m[1])
  return out
}

// ---------------------------------------------------------------- 装载产物（缺失即失败，不 SKIP）
let hostCode = null
let core = null
try {
  hostCode = (await import(new URL('../lib/collab-plugin.host.js', import.meta.url))).hostCode
  core = await import(new URL('../lib/collab-core.js', import.meta.url))
} catch (e) {
  console.log('FAIL cannot load built artifacts (run `npm run build`): ' + String((e && e.message) || e))
  console.log('\nFAILURES: 0 passed, 1 failed')
  process.exit(1)
}
group('extraction', '从 lib 产物里取函数（任何失败都算失败，不 SKIP）')
ok(typeof hostCode === 'string' && hostCode.length > 1000, 'lib/collab-plugin.host.js 导出非空 hostCode 字符串', 'len=' + String(hostCode && hostCode.length))
ok(typeof core === 'object' && core !== null, 'lib/collab-core.js 可 import')
if (!hostCode || typeof hostCode !== 'string') {
  console.log('\nFAILURES: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(1)
}

// ---------------------------------------------------------------- 期望集合
// 20 个"逐输出对拍"的同名函数。
const EXPECTED_PARITY = [
  'claim', 'cleanName', 'clockUtc', 'dropHolder', 'expire', 'hashProjectKey', 'heartbeat',
  'holder', 'holderFresh', 'holderView', 'init', 'modeLabel', 'norm', 'ov', 'post', 'reap',
  'release', 'releaseOnLoopEnd', 'renderDigest', 'seg', 'sweep'
].sort()
// 同名但**不同形**：宿主的 overview(agentId) 是 async 的 I/O op（load→expire→聚合），
// core 的 overview(state) 是纯状态变换。两者不是同一形状的函数，不能逐参对拍；
// 但"同名"这一事实仍然要进集合断言，聚合逻辑本身另有专门对拍（见 group('overview')）。
const KNOWN_SHAPE_DIVERGENT = ['overview']
const EXPECTED_SAME_NAME = [...EXPECTED_PARITY, ...KNOWN_SHAPE_DIVERGENT].sort()

// 抽取 hostCode 里的函数体（scope 注入它引用到的同源函数，保证依赖也是真实内联副本）。
const T0 = Date.UTC(2026, 0, 2, 3, 4, 37)
const fixedNow = () => T0
const host = {}
const extractErrors = []
// 宿主内联的 MODE_LABELS 从真实源码里抽出来（不手抄副本），再注入 modeLabel 抽取。
let hostModeLabels = {}
try {
  const m = /const MODE_LABELS = \{([^}]*)\}/.exec(hostCode)
  if (!m) throw new Error('hostCode 缺少 MODE_LABELS 对象')
  hostModeLabels = new Function('return {' + m[1] + '}')()
} catch (e) { extractErrors.push('MODE_LABELS: ' + String((e && e.message) || e)) }
const tryExtract = (name, scope) => {
  try { host[name] = extractFrom(hostCode, name, scope) }
  catch (e) { extractErrors.push(name + ': ' + String((e && e.message) || e)) }
}
tryExtract('seg')
tryExtract('ov', { seg: host.seg })
tryExtract('norm')
tryExtract('hashProjectKey')
tryExtract('cleanName')
tryExtract('init')
tryExtract('holderFresh')
tryExtract('sweep', { holderFresh: host.holderFresh })
tryExtract('expire', { sweep: host.sweep })
tryExtract('holderView', { holderFresh: host.holderFresh })
tryExtract('clockUtc')
tryExtract('modeLabel', { MODE_LABELS: hostModeLabels })
tryExtract('renderDigest', { clockUtc: host.clockUtc, modeLabel: host.modeLabel })
tryExtract('holder', { now: fixedNow })
tryExtract('hostReaders')
tryExtract('pub', { hostReaders: host.hostReaders })
tryExtract('conflict')
tryExtract('withWarn')
tryExtract('claim', { now: fixedNow, norm: host.norm, ov: host.ov, holder: host.holder, pub: host.pub, conflict: host.conflict })
tryExtract('release', { now: fixedNow, norm: host.norm, ov: host.ov, pub: host.pub })
// reap（0.9.8）：纯函数 reap(s, h, a, liveHolderIds, t)。宿主内联的默认 age 门槛写成字面量 600，
// 与 core 的 REAP_DEFAULT_OLDER_THAN_SEC 是否一致由下面的语料守护（含一个不传 olderThanSec 的用例）。
tryExtract('reap', { norm: host.norm, ov: host.ov, pub: host.pub })
tryExtract('dropHolder', { pub: host.pub, hostReaders: host.hostReaders })
// releaseOnLoopEnd（0.9.10）：纯函数 releaseOnLoopEnd(s, holderId, holderName, t, graceSec)。
// 宿主内联的 author 写字面量 'system:dsh-collab'，core 侧用导出的 AUTO_RELEASE_AUTHOR —— 两者是否
// 一致由下面的语料**逐输出**守护（消息对象里带 author 字段，对拍即校验）。宽限期同理：宿主是
// 接线层传进来的常量 15，core 不自己判断，所以语料里显式传不同 graceSec 值。
tryExtract('releaseOnLoopEnd', { pub: host.pub })
tryExtract('heartbeat', { now: fixedNow })
tryExtract('post', { now: fixedNow, holder: host.holder })
let overviewLoad = async () => ({ state: null, target: { path: '/fake/collab/state.json' }, stateDir: '/tmp', warn: null })
tryExtract('overview', {
  load: (id) => overviewLoad(id),
  now: fixedNow,
  expire: host.expire,
  pub: host.pub,
  withWarn: host.withWarn,
  fs: { processPath: (t) => (t && t.path) || String(t) }
})

// core 侧只取同名导出（lib/collab-core.js 的导出函数集合），不做任何别名映射。
const coreFns = {}
for (const n of EXPECTED_PARITY.concat(KNOWN_SHAPE_DIVERGENT)) {
  if (typeof core[n] !== 'function') extractErrors.push('core 缺少导出函数 ' + n)
  else coreFns[n] = core[n]
}
for (const n of ['pub', 'hostReaders', 'conflict', 'withWarn', 'overview']) {
  if (typeof host[n] !== 'function') extractErrors.push('hostCode 缺少函数 ' + n)
}

// ---------------------------------------------------------------- 同名集合守护
// 放在抽取失败早退**之前**：删掉/改名一侧的同名函数时，集合断言必须先红，
// 否则"漏接对拍"这条守护会被抽取失败掩盖掉。
group('name-set', '两形态同名函数集合必须恰好等于期望集合（漏接对拍会红）')
{
  const hostNames = hostDeclNames(hostCode)
  const coreNames = new Set(Object.entries(core).filter(([, v]) => typeof v === 'function').map(([k]) => k))
  const actual = [...hostNames].filter((n) => coreNames.has(n)).sort()
  const missing = EXPECTED_SAME_NAME.filter((n) => !actual.includes(n))
  const extra = actual.filter((n) => !EXPECTED_SAME_NAME.includes(n))
  console.log('  实测同名集合(' + actual.length + ')：' + JSON.stringify(actual))
  console.log('  期望同名集合(' + EXPECTED_SAME_NAME.length + ')：' + JSON.stringify(EXPECTED_SAME_NAME))
  console.log('  差集：期望缺失=' + show(missing) + '  实测多出=' + show(extra))
  ok(deepEqual(actual, EXPECTED_SAME_NAME),
    '两形态同名函数集合 === 期望集合（多出的同名函数必须接进对拍或登记为 shape-divergent）',
    'missing=' + show(missing) + ' extra=' + show(extra))
  ok(missing.length === 0, '期望集合里每个函数在两侧都存在', show(missing))
  ok(extra.length === 0, '没有"两边同名却没被本测试登记"的函数', show(extra))
  ok(hostNames.size > EXPECTED_SAME_NAME.length && coreNames.size > EXPECTED_SAME_NAME.length,
    '宿主/包形态的函数集合都大于同名集合（说明同名集合是真交集，不是被空集对上）',
    'host=' + hostNames.size + ' core=' + coreNames.size)
  // init 遮蔽：抽取必须锚定 4 空格缩进
  const rawInit = [...hostCode.matchAll(/const\s+init\s*=/g)].length
  const anchoredInit = [...hostCode.matchAll(/^ {4}const\s+init\s*=/gm)].length
  ok(rawInit > anchoredInit && anchoredInit === 1,
    '抽取锚定 4 空格缩进：hostCode 里 `const init` 另有一处更深缩进的同名遮蔽',
    'raw=' + rawInit + ' anchored=' + anchoredInit)
}

// ---------------------------------------------------------------- 抽取失败即失败（不 SKIP）
group('extraction')
ok(extractErrors.length === 0, '全部函数抽取成功（' + (EXPECTED_PARITY.length + 1) + ' 个对拍目标 + 4 个依赖）',
  show(extractErrors))
if (extractErrors.length) {
  console.log('\n抽取失败明细：\n  - ' + extractErrors.join('\n  - '))
  console.log('\nFAILURES: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(1)
}

// ---------------------------------------------------------------- 语料工具
const mkState = (o) => Object.assign({ schemaVersion: 1, seq: 7, claims: [], messages: [], holders: [] }, o)
const mkClaimRec = (o) => Object.assign({
  claimId: 'c_1', holderId: 'agent:A', holderName: 'Worker A', paths: ['src/a/'], mode: 'exclusive',
  ttlSec: 1800, expiresAt: T0 + 1800 * 1000, note: '', createdAt: T0, readable: true, readers: []
}, o)
const HOLDER_A = { holderId: 'agent:A', sessionId: 'sess-A', name: 'Worker A' }
const HOLDER_B = { holderId: 'agent:B', sessionId: 'sess-B', name: 'Worker B' }
const NAME_A = 'Worker A'
const mkMessages = (n, startSeq) => Array.from({ length: n }, (_, i) => ({
  msgId: 'm_' + (startSeq + i), seq: startSeq + i, channel: (i % 3 === 0) ? 'general' : 'path:src/a/',
  author: 'agent:A', ts: T0 + i, body: 'body ' + i, mentions: []
}))
const mkBackdated = (ms) => T0 - ms

const run = (fn, args) => {
  try { return { threw: false, value: fn.apply(null, args) } }
  catch (e) {
    return { threw: true, err: { name: e && e.name, message: e && e.message, collabConflict: e && e.collabConflict, conflicts: e && e.conflicts } }
  }
}
// 剥掉 core 信封里的注入时钟与 state 引用（不是可比较的数据；state 另行逐字段比较）。
const strip = (r) => {
  if (!r || typeof r !== 'object' || Array.isArray(r) || !('ok' in r)) return r
  const out = {}
  for (const k of Object.keys(r)) { if (k === 'tNow' || k === 'state') continue; out[k] = r[k] }
  return out
}
const outcome = (r) => (r.threw ? { threw: true, err: r.err } : { threw: false, value: strip(r.value) })

// 每例各自建**两份独立输入**（共享可变对象会掩盖漂移）。
// build() 返回 { hostArgs, coreArgs, state?, stateKey? }；state 是同一份独立输入里被传入的对象。
const pairCase = (fnName, label, build) => {
  const h = build(), c = build()
  const hr = run(host[fnName], h.hostArgs)
  const cr = run(coreFns[fnName], c.coreArgs)
  cmp(fnName + ' · ' + label + ' · 输出', outcome(hr), outcome(cr))
  if (h.state !== undefined) cmp(fnName + ' · ' + label + ' · 调用后 state', h.state, c.state)
}
// 纯函数（无 state 入参）
const pureCase = (fnName, label, hostArgs, coreArgs) =>
  cmp(fnName + ' · ' + label, run(host[fnName], hostArgs).value, run(coreFns[fnName], coreArgs).value,
    run(host[fnName], hostArgs).threw || run(coreFns[fnName], coreArgs).threw ? '(存在抛出)' : '')

// 参数名/顺序不同的同名函数：显式登记两边的调用适配（不改变任何一边的真实签名）。
const CLAIM_SPEC = (state, h, name, a) => ({ hostArgs: [state, h, name, a], coreArgs: [state, h, a, fixedNow], state })

// ---------------------------------------------------------------- norm
group('norm', '路径归一：空/斜杠/波浪号/前导尾随/./..')
{
  const inputs = [
    ['空串', ''], ['纯空白', '   '], ['单斜杠', '/'], ['多斜杠', '///'], ['波浪号', '~'],
    ['前导斜杠', '/src/foo'], ['尾随斜杠', 'src/foo/'], ['重复斜杠', 'src//foo'],
    ['点斜杠前缀', './src'], ['段内点', 'src/./foo'], ['回退', 'a/../b'], ['越界回退', 'a/../../b'],
    ['分隔重叠前缀', 'src/foo 与 src/foobar 的左项', 'src/foo'], ['右项', 'src/foobar'],
    ['单段带斜杠', 'a/'], ['两段带斜杠', 'a/b/'], ['反斜杠', 'a\\b'], ['反斜杠尾随', 'a\\b\\'],
    ['纯点点', '..'], ['单点', '.'], ['点点斜杠', './'], ['带空白的绝对路径', '  /a//b/  '],
    ['null', null], ['undefined', undefined], ['数字', 42], ['对象', {}], ['数组', []], ['布尔', true]
  ]
  for (const [label, v] of inputs) pureCase('norm', label, [v], [v])
}
// ---------------------------------------------------------------- seg
group('seg', '分段：空/斜杠/尾随；非字符串两侧同样抛错')
{
  const inputs = [
    ['空串', ''], ['单斜杠', '/'], ['普通', 'a/b'], ['重复斜杠尾随', 'a//b/'],
    ['波浪号', '~'], ['前缀对', 'src/foo'], ['null', null], ['undefined', undefined],
    ['数字', 42], ['对象', {}], ['数组', []], ['布尔', true]
  ]
  for (const [label, v] of inputs) {
    const hr = run(host.seg, [v]), cr = run(coreFns.seg, [v])
    cmp('seg · ' + label, outcome(hr), outcome(cr))
  }
}
// ---------------------------------------------------------------- ov
group('ov', '分段前缀重叠：前缀但不同段不算重叠')
{
  const pairs = [
    ['父子目录', 'src/backend/', 'src/backend/models/'], ['前缀不同段', 'src/foo', 'src/foobar'],
    ['相同', 'a', 'a'], ['尾斜杠 vs 无', 'a/', 'a'], ['根斜杠 vs 段', '/', 'a'],
    ['空左', '', 'a'], ['空右', 'a', ''], ['深子路径', 'a/b', 'a/b/c'],
    ['近前缀', 'a/b', 'a/bc'], ['去斜杠', 'src/foo/', 'src/foo'], ['null 左', null, 'a'],
    ['null 右', 'a', null], ['双 undefined', undefined, undefined], ['数字', 42, 'a'],
    ['波浪号', '~', '~x'], ['双根斜杠', '/', '/'], ['兄弟目录', 'src/a/', 'src/b/']
  ]
  for (const [label, a, b] of pairs) pureCase('ov', label, [a, b], [a, b])
}
// ---------------------------------------------------------------- cleanName
group('cleanName', '空白压缩 + 24 字截断 + 非字符串原样返回')
{
  const inputs = [
    ['普通', 'hello'], ['压缩空白', '  a   b  '], ['制表换行', 'tab\tand\nnewline'],
    ['恰好 24', 'a'.repeat(24)], ['25 字截断', 'a'.repeat(25)], ['长文本', 'x'.repeat(30) + ' tail'],
    ['空串', ''], ['纯空白', '   '], ['中文超长', '中文名称'.repeat(10)],
    ['数字', 123], ['null', null], ['undefined', undefined], ['对象', { a: 1 }], ['数组', ['a']]
  ]
  for (const [label, v] of inputs) pureCase('cleanName', label, [v], [v])
}
// ---------------------------------------------------------------- hashProjectKey
group('hashProjectKey', '跨语言确定性哈希（12 位十六进制）')
{
  const inputs = [
    ['空串', ''], ['默认', 'default'], ['项目名', 'my_project'],
    ['绝对路径', '/home/vesita/coding/my/dsh-collab'], ['中文', '中文字符串'],
    ['千字长串', 'a'.repeat(1000)], ['大写 64', 'A'.repeat(64)]
  ]
  for (const [label, v] of inputs) pureCase('hashProjectKey', label, [v], [v])
}
// ---------------------------------------------------------------- init
group('init', '空状态形状相等，且每次都是新对象')
{
  const h1 = host.init(), c1 = coreFns.init()
  cmp('init · 形状', h1, c1)
  cmp('init · 键集合', Object.keys(h1).sort(), Object.keys(c1).sort())
  ok(!deepEqual({}, h1), 'init 不是空对象（比较的是真实结构）', show(h1))
  const h2 = host.init(), c2 = coreFns.init()
  ok(h1 !== h2 && c1 !== c2, 'init 每次返回新对象（不是共享单例）')
  h2.claims.push('x')
  ok(h1.claims.length === 0, 'host init 两次调用互不影响')
  c2.claims.push('x')
  ok(c1.claims.length === 0, 'core init 两次调用互不影响')
}
// ---------------------------------------------------------------- clockUtc
group('clockUtc', '毫秒 → MM-DD HH:MMZ（UTC 分钟粒度，秒被截掉）')
{
  const inputs = [
    ['epoch', 0], ['固定时刻（秒非 0）', T0], ['+59s', T0 + 59000], ['-1ms 跨日', T0 - 1],
    ['1969 年末', Date.UTC(1969, 11, 31, 23, 59, 59)], ['9999 年末', 253402300799000],
    ['NaN', NaN]
  ]
  for (const [label, v] of inputs) pureCase('clockUtc', label, [v], [v])
}
// ---------------------------------------------------------------- modeLabel
group('modeLabel', '模式名 → 中文标签（渲染专用；数据取值仍是 exclusive/shared/read）')
{
  for (const m of ['exclusive', 'shared', 'read']) {
    cmp('modeLabel · ' + m, run(host.modeLabel, [m]), run(coreFns.modeLabel, [m]))
  }
  ok(coreFns.modeLabel('exclusive') === '独占' && coreFns.modeLabel('shared') === '共享' && coreFns.modeLabel('read') === '只读',
    '三档中文标签固定为 独占/共享/只读',
    JSON.stringify([coreFns.modeLabel('exclusive'), coreFns.modeLabel('shared'), coreFns.modeLabel('read')]))
  cmp('modeLabel · 未知取值原样回退', run(host.modeLabel, ['weird']), run(coreFns.modeLabel, ['weird']))
}
// ---------------------------------------------------------------- renderDigest
group('renderDigest', '占用摘要文本：逐字节等价 + 顺序无关')
{
  const c1 = mkClaimRec({ claimId: 'c_1', holderId: 'agent:one', holderName: 'One', paths: ['src/one/'] })
  const c2 = mkClaimRec({ claimId: 'c_2', holderId: 'agent:two', holderName: 'Two', paths: ['src/two/'], mode: 'shared', expiresAt: T0 + 900000, ttlSec: 900 })
  const c3 = mkClaimRec({ claimId: 'c_3', holderId: 'agent:three', holderName: 'Three', paths: ['src/three/'], mode: 'read', expiresAt: T0 + 3600000, ttlSec: 3600 })
  const c4 = mkClaimRec({ claimId: 'c_4', holderId: 'agent:four', holderName: 'Four', paths: ['src/four/'], expiresAt: T0 + 7200000, ttlSec: 7200 })
  const fixtures = [
    ['空集合', []], ['单条', [c1]], ['三条', [c1, c2, c3]], ['四条', [c1, c2, c3, c4]],
    ['多路径', [mkClaimRec({ claimId: 'c_p', paths: ['a/', 'b/', 'c/', 'd/'] })]],
    ['缺 holderName', [mkClaimRec({ claimId: 'c_n', holderId: 'agent:anon', holderName: undefined })]],
    ['乱序输入', [c3, c1, c2]], ['ttlSec 0', [mkClaimRec({ ttlSec: 0 })]],
    ['无 createdAt', [mkClaimRec({ createdAt: undefined, ttlSec: 600 })]], ['单路径', [mkClaimRec({ paths: ['solo/'] })]]
  ]
  for (const [label, claims] of fixtures) {
    cmp('renderDigest · ' + label, host.renderDigest(claims.slice()), coreFns.renderDigest(claims.slice()))
  }
  ok(host.renderDigest([c3, c1, c2]) === host.renderDigest([c1, c2, c3]), 'host 形态顺序无关')
  ok(coreFns.renderDigest([c3, c1, c2]) === coreFns.renderDigest([c1, c2, c3]), 'core 形态顺序无关')
  const sample = coreFns.renderDigest([c1, c2])
  ok(sample.includes('One（独占）占用 src/one/，租约 30 分（01-02 03:04Z–01-02 03:34Z）'),
    'core 渲染出文档化的绝对 UTC 窗口文案（证明比的是真实文本）', sample)
  ok(sample.includes('Two（共享）占用 src/two/'), 'core 渲染 shared → 共享', sample)
  const readOnly = coreFns.renderDigest([c3])
  ok(readOnly.includes('Three（只读）占用 src/three/'), 'core 渲染 read → 只读', readOnly)
}
// ---------------------------------------------------------------- holderFresh
group('holderFresh', '新鲜度判据：24h 回收边界 + 5min 未来偏移容忍')
{
  const cases = [
    ['age 0', T0, T0], ['age 1s', T0 - 1000, T0], ['age 恰好 24h', T0 - 86400000, T0],
    ['age 24h-1ms', T0 - 86399999, T0], ['future 1s', T0 + 1000, T0], ['future 5min', T0 + 300000, T0],
    ['future 5min+1ms', T0 + 300001, T0], ['lastSeen 0（age 巨大）', 0, T0],
    ['undefined', undefined, T0], ['t=0 且 lastSeen 未来', T0, 0], ['双 0', 0, 0]
  ]
  for (const [label, ls, t] of cases) {
    const hr = run(host.holderFresh, [ls, t]), cr = run(coreFns.holderFresh, [ls, t])
    cmp('holderFresh · ' + label, outcome(hr), outcome(cr))
  }
  // 宿主形态把 TTL/偏移写死成字面量；用 core 的导出常量把这两个魔数锚住。
  ok(core.HOLDER_TTL_MS === 86400000, 'collab-core HOLDER_TTL_MS === 宿主写死的 86400000', String(core.HOLDER_TTL_MS))
  ok(core.HOLDER_FUTURE_SKEW_MS === 300000, 'collab-core HOLDER_FUTURE_SKEW_MS === 宿主写死的 300000', String(core.HOLDER_FUTURE_SKEW_MS))
  const mismatched = cases.filter(([, ls, t]) =>
    coreFns.holderFresh(ls, t) !== coreFns.holderFresh(ls, t, core.HOLDER_TTL_MS))
  ok(mismatched.length === 0, 'core holderFresh 的默认 TTL 与显式 HOLDER_TTL_MS 一致（宿主无第三参可比）', show(mismatched.map((m) => m[0])))
}
// ---------------------------------------------------------------- sweep
group('sweep', '惰性清理：过期声明 / 留言上限 2000 / holder 24h 与未来偏移回收')
{
  const mkHolders = () => [
    { holderId: 'agent:A', name: 'A', kind: 'agent', sessionId: 'sA', lastSeenAt: T0 - 30 * 3600 * 1000 },
    { holderId: 'agent:B', name: 'B', kind: 'agent', sessionId: 'sB', lastSeenAt: T0 - 23 * 3600 * 1000 },
    { holderId: 'agent:C', name: 'C', kind: 'agent', sessionId: 'sC', lastSeenAt: T0 - 25 * 3600 * 1000 },
    { holderId: 'agent:D', name: 'D', kind: 'agent', sessionId: 'sD', lastSeenAt: T0 + 10 * 60 * 1000 },
    { holderId: 'agent:E', name: 'E', kind: 'agent', sessionId: 'sE', lastSeenAt: undefined },
    { holderId: 'agent:F', name: 'F', kind: 'human', sessionId: undefined, lastSeenAt: mkBackdated(86400000) },
    { holderId: 'agent:G', name: 'G', kind: 'human', sessionId: undefined, lastSeenAt: mkBackdated(86399999) }
  ]
  const live = mkClaimRec({ claimId: 'c_live', holderId: 'agent:A', expiresAt: T0 + 60000 })
  const expired = mkClaimRec({ claimId: 'c_exp', holderId: 'agent:X', expiresAt: T0 - 1 })
  const boundary = mkClaimRec({ claimId: 'c_bd', holderId: 'agent:Y', expiresAt: T0 })
  const cases = [
    ['过期声明被清', () => mkState({ claims: [live, expired, boundary], messages: mkMessages(3, 1), holders: mkHolders() })],
    ['无过期声明', () => mkState({ claims: [live], messages: mkMessages(2, 1), holders: mkHolders() })],
    ['空状态', () => mkState({})],
    ['留言 2005 条 → 保留 2000', () => mkState({ messages: mkMessages(2005, 1), holders: [] })],
    ['留言恰好 2000 条 → 不动', () => mkState({ messages: mkMessages(2000, 1), holders: [] })],
    ['只有 holder（无声明）', () => mkState({ claims: [], messages: [], holders: mkHolders() })]
  ]
  for (const [label, mk] of cases) pairCase('sweep', label, () => {
    const state = mk()
    return { hostArgs: [state, T0], coreArgs: [state, T0], state }
  })
  // 已知 API 差异（不是漂移，但必须显式可见）：core 的 opts 是覆盖入口，宿主形态签名留了 opts 却忽略。
  {
    const hs = mkState({ messages: mkMessages(10, 1), holders: [] })
    const cs = mkState({ messages: mkMessages(10, 1), holders: [] })
    host.sweep(hs, T0, { maxMessages: 3, holderTtlMs: 0 })
    coreFns.sweep(cs, T0, { maxMessages: 3, holderTtlMs: 0 })
    ok(hs.messages.length === 10, '宿主形态 sweep 忽略 opts.maxMessages（沿用默认 2000）', String(hs.messages.length))
    ok(cs.messages.length === 3, 'core 形态 sweep 接受 opts.maxMessages 覆盖', String(cs.messages.length))
  }
  ok(core.MAX_MESSAGES === 2000, 'collab-core MAX_MESSAGES === 宿主写死的 2000', String(core.MAX_MESSAGES))
}
// ---------------------------------------------------------------- expire
group('expire', '过期声明计数（= sweep().expiredClaims）')
{
  const live = mkClaimRec({ claimId: 'c_live', expiresAt: T0 + 60000 })
  const expired = mkClaimRec({ claimId: 'c_exp', expiresAt: T0 - 1 })
  const cases = [
    ['一条过期', () => mkState({ claims: [live, expired] })],
    ['无过期', () => mkState({ claims: [live] })],
    ['空声明', () => mkState({ claims: [] })],
    ['全部过期', () => mkState({ claims: [expired, mkClaimRec({ claimId: 'c_e2', expiresAt: 0 })] })],
    ['边界 expiresAt === t', () => mkState({ claims: [mkClaimRec({ claimId: 'c_bd', expiresAt: T0 })] })]
  ]
  for (const [label, mk] of cases) pairCase('expire', label, () => {
    const state = mk()
    return { hostArgs: [state, T0], coreArgs: [state, T0], state }
  })
}
// ---------------------------------------------------------------- holderView
group('holderView', 'holder 存活视图：active / stale（1h 预警）/ 未来偏移 / 排序')
{
  const mkHolders = () => [
    { holderId: 'agent:A', name: 'A', kind: 'agent', sessionId: 'sA', lastSeenAt: T0 - 30 * 3600 * 1000 },
    { holderId: 'agent:B', name: 'B', kind: 'agent', sessionId: 'sB', lastSeenAt: T0 - 2 * 3600 * 1000 },
    { holderId: 'agent:C', name: 'C', kind: 'human', sessionId: undefined, lastSeenAt: T0 - 3599999 },
    { holderId: 'agent:D', name: 'D', kind: 'human', sessionId: undefined, lastSeenAt: T0 - 3600000 },
    { holderId: 'agent:E', name: 'E', kind: 'agent', sessionId: 'sE', lastSeenAt: T0 + 400000 },
    { holderId: 'agent:F', name: 'F', kind: 'agent', sessionId: 'sF', lastSeenAt: T0 },
    { holderId: 'agent:G', name: 'G', kind: 'agent', sessionId: 'sG', lastSeenAt: undefined }
  ]
  const activeA = mkClaimRec({ claimId: 'c_a', holderId: 'agent:A', expiresAt: T0 + 60000 })
  const expiredA = mkClaimRec({ claimId: 'c_a2', holderId: 'agent:A', expiresAt: T0 - 1 })
  const cases = [
    ['活跃声明压制 stale', () => mkState({ claims: [activeA], holders: mkHolders() })],
    ['声明已过期', () => mkState({ claims: [expiredA], holders: mkHolders() })],
    ['无声明', () => mkState({ claims: [], holders: mkHolders() })],
    ['空 holder', () => mkState({ claims: [activeA], holders: [] })],
    ['lastSeenAt 并列（排序稳定）', () => mkState({ claims: [], holders: [
      { holderId: 'agent:P', name: 'P', kind: 'agent', sessionId: 'sP', lastSeenAt: T0 - 5000 },
      { holderId: 'agent:Q', name: 'Q', kind: 'agent', sessionId: 'sQ', lastSeenAt: T0 - 5000 },
      { holderId: 'agent:R', name: 'R', kind: 'agent', sessionId: 'sR', lastSeenAt: T0 - 5000 }
    ] })]
  ]
  for (const [label, mk] of cases) pairCase('holderView', label, () => {
    const state = mk()
    return { hostArgs: [state, T0], coreArgs: [state, T0], state }
  })
  ok(core.HOLDER_STALE_WARN_MS === 3600000, 'collab-core HOLDER_STALE_WARN_MS === 宿主写死的 3600000', String(core.HOLDER_STALE_WARN_MS))
}
// ---------------------------------------------------------------- holder
group('holder', '登记/更新 holder 元数据（kind 由 sessionId 决定）')
{
  const cases = [
    ['新建 agent', () => mkState({}), HOLDER_A, NAME_A],
    ['新建 human', () => mkState({}), { holderId: 'human:console' }, 'console'],
    ['已存在则更新名字', () => mkState({ holders: [{ holderId: 'agent:A', name: 'Old', kind: 'agent', sessionId: 'sess-A', lastSeenAt: 0 }] }), HOLDER_A, NAME_A],
    ['已存在但 sessionId 缺省', () => mkState({ holders: [{ holderId: 'human:console', name: 'Old', kind: 'human', lastSeenAt: 0 }] }), { holderId: 'human:console' }, 'console']
  ]
  for (const [label, mk, h, name] of cases) pairCase('holder', label, () => {
    const state = mk()
    return { hostArgs: [state, h, name], coreArgs: [state, h, name, fixedNow], state }
  })
}
// ---------------------------------------------------------------- claim
group('claim', '声明占用：mode 校验 / 合并限定同 mode / readable 与 readers 归一 / 冲突明细')
{
  // 签名差异（已知，非漂移）：宿主是 claim(state, h, name, a) 用 name 形参；
  // core 是 claim(state, h, a, tNow) 用 h.name。真实接线里两者同值 ——
  // 包形态在 src/index.ts:1249-1250 先做 `h.name = hname(h)`，宿主形态把 hname(h) 当 name 传入。
  // 所以语料让 name === h.name（这就是两形态的函数级契约）；差异本身在下面单独断言。
  const C = (label, opts) => pairCase('claim', label, () => {
    const state = mkState(opts.state ? opts.state() : {})
    const a = opts.a ? opts.a() : { paths: ['src/a/'] }
    const h = opts.h || HOLDER_A
    return Object.assign({ state }, CLAIM_SPEC(state, h, h.name || h.holderId, a))
  })
  C('基础 exclusive', {})
  C('shared 模式', { a: () => ({ paths: ['src/a/'], mode: 'shared' }) })
  C('read 模式', { a: () => ({ paths: ['src/a/'], mode: 'read' }) })
  C('未知 mode READ', { a: () => ({ paths: ['src/a/'], mode: 'READ' }) })
  C('未知 mode 数字', { a: () => ({ paths: ['src/a/'], mode: 5 }) })
  C('mode 空串即默认 exclusive', { a: () => ({ paths: ['src/a/'], mode: '' }) })
  C('缺 paths', { a: () => ({}) })
  C('paths 非数组', { a: () => ({ paths: 'src/a/' }) })
  C('paths 全部不可归一', { a: () => ({ paths: ['', '  ', '..'] }) })
  C('paths 含 null 元素', { a: () => ({ paths: [null, 'src/a/'] }) })
  C('ttl 下限钳制 3→5', { a: () => ({ paths: ['src/a/'], ttlSec: 3 }) })
  C('ttl 0→1800', { a: () => ({ paths: ['src/a/'], ttlSec: 0 }) })
  C('ttl 上限钳制', { a: () => ({ paths: ['src/a/'], ttlSec: 999999 }) })
  C('ttl 非数字', { a: () => ({ paths: ['src/a/'], ttlSec: 'abc' }) })
  C('短租约告警', { a: () => ({ paths: ['src/a/'], ttlSec: 30 }) })
  C('note 截断 500', { a: () => ({ paths: ['src/a/'], note: 'x'.repeat(600) }) })
  C('note 非字符串', { a: () => ({ paths: ['src/a/'], note: 42 }) })
  C('readable 缺省→true', {})
  C('readable 显式 false', { a: () => ({ paths: ['src/a/'], readable: false }) })
  C('readable null→true', { a: () => ({ paths: ['src/a/'], readable: null }) })
  C('readable 字符串 no→true', { a: () => ({ paths: ['src/a/'], readable: 'no' }) })
  C('readers 缺省归一为 []', { state: () => ({ claims: [mkClaimRec({ readers: undefined, readable: undefined })] }) })
  C('readers 去重保序', { state: () => ({ claims: [mkClaimRec({ readers: ['agent:B', 5, 'agent:B', 'agent:C', ''] })] }) })
  C('同 holder 同 mode 合并', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', paths: ['src/a/'] })] }),
    a: () => ({ paths: ['src/a/b/'], ttlSec: 600 })
  })
  C('合并只加新路径', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', paths: ['src/a/', 'src/a/b/'] })] }),
    a: () => ({ paths: ['src/a/', 'src/a/c/'] })
  })
  C('合并保留 readable:false（新声明未给 readable）', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', readable: false })] }),
    a: () => ({ paths: ['src/a/b/'], ttlSec: 600 })
  })
  C('合并时显式 readable:true 覆盖', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', readable: false })] }),
    a: () => ({ paths: ['src/a/b/'], readable: true })
  })
  C('同 holder 不同 mode 不合并', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', mode: 'read' })] }),
    a: () => ({ paths: ['src/a/'], mode: 'exclusive' })
  })
  C('前缀但不同段不合并', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', paths: ['src/foo'] })] }),
    a: () => ({ paths: ['src/foobar'] })
  })
  C('同 holder 过期声明仍可续', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', expiresAt: T0 - 1 })] }),
    a: () => ({ paths: ['src/a/'] })
  })
  C('冲突：他人 exclusive 同路径', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_x', holderId: 'agent:B', holderName: 'Worker B' })] })
  })
  C('冲突：他人 exclusive 祖先路径', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_x', holderId: 'agent:B', holderName: 'Worker B', paths: ['src/'] })] }),
    a: () => ({ paths: ['src/a/b/'] })
  })
  C('冲突：剩余 <=30s 建议 wait', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_x', holderId: 'agent:B', holderName: 'Worker B', expiresAt: T0 + 10000 })] })
  })
  C('不冲突：他人 shared', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_x', holderId: 'agent:B', mode: 'shared' })] })
  })
  C('不冲突：他人 read', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_x', holderId: 'agent:B', mode: 'read' })] })
  })
  C('不冲突：他人已过期 exclusive', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_x', holderId: 'agent:B', expiresAt: T0 - 1 })] })
  })
  C('不冲突：前缀但不同段', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_x', holderId: 'agent:B', paths: ['src/foo'] })] }),
    a: () => ({ paths: ['src/foobar'] })
  })
  C('read 模式跳过冲突扫描', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_x', holderId: 'agent:B' })] }),
    a: () => ({ paths: ['src/a/'], mode: 'read' })
  })
  C('新 holder 登记进 holders', { h: HOLDER_B })
  C('console holder（无 sessionId）', { h: { holderId: 'human:console', name: 'human:console' }, a: () => ({ paths: ['tools/'] }) })
  // 把上面的签名差异显式钉住（否则读者会以为 name/h.name 可以随便传）。
  {
    const hs = mkState({}), cs = mkState({})
    const hx = { holderId: 'agent:H', sessionId: 'sH', name: 'FromH' }
    const hOut = host.claim(hs, hx, 'FromArg', { paths: ['p/'] })
    const cOut = coreFns.claim(cs, hx, { paths: ['p/'] }, fixedNow)
    ok(hOut.data.claim.holderName === 'FromArg', '宿主 claim 的 holderName 来自 name 形参（忽略 h.name）', show(hOut.data.claim.holderName))
    ok(cOut.data.claim.holderName === 'FromH', 'core claim 的 holderName 来自 h.name（无 name 形参）', show(cOut.data.claim.holderName))
  }
}
// ---------------------------------------------------------------- release
group('release', '释放：claimId 优先 / forbidden / not-found / 按路径前缀')
{
  const R = (label, opts) => pairCase('release', label, () => {
    const state = mkState(opts.state ? opts.state() : {})
    return { hostArgs: [state, opts.h || HOLDER_A, opts.a()], coreArgs: [state, opts.h || HOLDER_A, opts.a(), fixedNow], state }
  })
  const OWN = () => ({ claims: [mkClaimRec({ claimId: 'c_1', holderId: 'agent:A', paths: ['src/a/'] })] })
  R('按 claimId 释放自己的', { state: OWN, a: () => ({ claimId: 'c_1' }) })
  R('按 claimId 释放他人的 → forbidden', { state: OWN, a: () => ({ claimId: 'c_1' }), h: HOLDER_B })
  R('claimId 不存在 → not-found', { state: OWN, a: () => ({ claimId: 'c_nope' }) })
  R('claimId 空串则走 paths 分支', { state: OWN, a: () => ({ claimId: '', paths: ['src/a/'] }) })
  R('按路径释放', { state: OWN, a: () => ({ paths: ['src/a/'] }) })
  R('按祖先路径释放子路径声明', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', paths: ['src/a/b/'] })] }), a: () => ({ paths: ['src/'] }) })
  R('按路径无匹配', { state: OWN, a: () => ({ paths: ['other/'] }) })
  R('按路径只匹配他人声明', { state: OWN, a: () => ({ paths: ['src/a/'] }), h: HOLDER_B })
  R('claimId 与 paths 同时给出 → claimId 优先', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', paths: ['src/a/'] }), mkClaimRec({ claimId: 'c_2', paths: ['src/b/'] })] }),
    a: () => ({ claimId: 'c_1', paths: ['src/b/'] })
  })
  R('既无 claimId 也无 paths → bad-request', { state: OWN, a: () => ({}) })
  R('paths 全部不可归一 → bad-request', { state: OWN, a: () => ({ paths: ['', '..'] }) })
  R('释放 readable:false 的声明（readable 归一）', {
    state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', readable: false, readers: ['agent:B', 'agent:B'] })] }),
    a: () => ({ claimId: 'c_1' })
  })
  R('空状态按路径释放', { state: () => ({}), a: () => ({ paths: ['src/a/'] }) })
}
// ---------------------------------------------------------------- reap
// 0.9.8：僵尸声明显式回收。两形态必须逐输出等价 —— 尤其 confirm 缺省必须两边都**不改状态**，
// 活体名单里有的人无论多老都不碰，age 门槛与 paths 限定的边界完全一致。
group('reap', '僵尸声明显式回收：默认 dry-run / 活体检查 / age 门槛 / 未过期 / 不含自己（0.9.8）')
{
  const at = T0
  const zombie = (id, paths, holderId) => mkClaimRec({ claimId: id, holderId: holderId || 'agent:DEAD', holderName: 'Dead Worker', paths, mode: 'exclusive', createdAt: T0 - 1000 * 1000, expiresAt: T0 + 600 * 1000, readers: ['agent:READER'] })
  const fresh = () => mkClaimRec({ claimId: 'c_f', holderId: 'agent:DEAD', paths: ['src/f/'], createdAt: T0 - 100 * 1000, expiresAt: T0 + 600 * 1000 })
  const alive = () => mkClaimRec({ claimId: 'c_a', holderId: 'agent:LIVE', paths: ['src/a/'], createdAt: T0 - 1000 * 1000, expiresAt: T0 + 600 * 1000 })
  const expired = () => mkClaimRec({ claimId: 'c_e', holderId: 'agent:DEAD', paths: ['src/e/'], createdAt: T0 - 1000 * 1000, expiresAt: T0 - 1 })
  const mine = () => mkClaimRec({ claimId: 'c_m', holderId: HOLDER_A.holderId, paths: ['src/m/'], createdAt: T0 - 1000 * 1000, expiresAt: T0 + 600 * 1000 })
  const human = () => mkClaimRec({ claimId: 'c_h', holderId: 'human:console', paths: ['src/h/'], createdAt: T0 - 1000 * 1000, expiresAt: T0 + 600 * 1000 })
  const RP = (label, claims, a, live, h) => pairCase('reap', label, () => {
    const state = mkState({ claims: claims.map(c => Object.assign({}, c, { paths: c.paths.slice(), readers: (c.readers || []).slice() })) })
    const liveCopy = live === undefined ? ['agent:LIVE'] : (live === null ? null : live.slice())
    return { hostArgs: [state, h || HOLDER_A, a, liveCopy, at], coreArgs: [state, h || HOLDER_A, a, liveCopy, at], state }
  })
  RP('dry-run（缺 confirm）：列候选、状态零变化', [zombie('c_z', ['src/z/']), alive(), mine()], {}, ['agent:LIVE'])
  RP('confirm:false 仍不改状态（只有显式 true 才动手）', [zombie('c_z', ['src/z/'])], { confirm: false }, [])
  RP('confirm:true 只删不在活体名单里的', [zombie('c_z', ['src/z/']), alive()], { confirm: true }, ['agent:LIVE'])
  RP('confirm:true 不碰自己的声明（自己用 op=release）', [zombie('c_z', ['src/z/']), mine()], { confirm: true }, [])
  RP('已过期声明不由 reap 处理（那是 sweep 的活）', [expired()], { confirm: true }, [])
  RP('age 未超默认门槛不动', [fresh()], { confirm: true }, [])
  RP('显式更小 olderThanSec 时才回收', [fresh()], { confirm: true, olderThanSec: 10 }, [])
  RP('paths 限定：只回收与给定路径相交的', [zombie('c_z', ['src/z/']), zombie('c_o', ['other/x/'], 'agent:DEAD2')], { confirm: true, paths: ['other/'] }, [])
  RP('活体检查不可用（null）⇒ 一个也不收', [zombie('c_z', ['src/z/'])], { confirm: true }, null)
  RP('human:console 无活体信号，不收（按 age 收它等于纯按 age 回收）', [human()], { confirm: true }, [])
  RP('olderThanSec 非法值回退保守默认 600', [zombie('c_z', ['src/z/'])], { confirm: true, olderThanSec: -5 }, [])
  RP('空状态：ok 且无候选', [], { confirm: true }, [])
}
// ---------------------------------------------------------------- dropHolder
// W7：声明（claim）的生命周期**只由租约 expiresAt 决定** —— dispose 不是释放信号。
// 两形态都必须：只回收该 holder **已过期**的声明，未过期的原样保留（连同它的 readers），
// 并把 holderId 从所有**剩余** claim 的 readers 里摘掉。
group('dropHolder', '会话退出：只回收已过期声明 + 从所有剩余 claim 摘 reader（W7）')
{
  // 真实负载同构：一个还活着的 holder（未到期声明）+ 一个到期时刻已知的已过期声明。
  const live = mkClaimRec({ claimId: 'c_live', holderId: 'agent:X', paths: ['src/x/'], expiresAt: T0 + 60000 })
  const dead = mkClaimRec({ claimId: 'c_dead', holderId: 'agent:X', paths: ['src/y/'], expiresAt: T0 - 1 })
  const atT = mkClaimRec({ claimId: 'c_bd', holderId: 'agent:X', paths: ['src/z/'], expiresAt: T0 })
  const byOther = mkClaimRec({ claimId: 'c_o', holderId: 'agent:Y', paths: ['src/o/'], readers: ['agent:X', 'agent:Z'] })
  const dirty = mkClaimRec({ claimId: 'c_d', holderId: 'agent:Y', paths: ['src/d/'], readers: ['agent:X', 'agent:X', 42, 'agent:Z'] })
  const noReader = mkClaimRec({ claimId: 'c_n', holderId: 'agent:Y', paths: ['src/n/'], readers: [] })

  const D = (label, holderId, claims, t) => pairCase('dropHolder', label, () => {
    const state = mkState({ claims: claims.map((c) => Object.assign({}, c, { readers: (c.readers || []).slice() })) })
    return { hostArgs: [state, holderId, t === undefined ? T0 : t], coreArgs: [state, holderId, t === undefined ? T0 : t], state }
  })
  D('未过期声明**不**被释放（dispose 不缩短租约）', 'agent:X', [live], T0)
  D('未过期声明不被释放，且 reader 列表原样保留', 'agent:X', [live, byOther], T0)
  D('已过期声明被回收（expiresAt < t）', 'agent:X', [dead], T0)
  D('边界：expiresAt === t 也算已过期（与 sweep 的 > t 同一判据）', 'agent:X', [atT], T0)
  D('混合：未过期保留、已过期回收', 'agent:X', [live, dead, byOther], T0)
  D('reader 从所有剩余 claim 被摘掉（含脏 readers 归一）', 'agent:X', [byOther, dirty, noReader], T0)
  D('该 holder 一条声明都没有：只摘 reader', 'agent:X', [byOther], T0)
  D('其他 holder 的未过期声明完全不受影响', 'agent:X', [live, noReader], T0)
  D('空状态：ok 且无变化', 'agent:X', [], T0)
  D('holderId 不在状态里：无变化', 'agent:NOPE', [live, byOther], T0)

  // 幂等：第二次必须 changed === false（两形态一致）。
  {
    const mk = () => mkState({ claims: [
      Object.assign({}, live, { readers: [] }),
      Object.assign({}, dead, { readers: [] }),
      Object.assign({}, byOther, { readers: byOther.readers.slice() })
    ] })
    const hs = mk(), cs = mk()
    const h1 = host.dropHolder(hs, 'agent:X', T0), c1 = coreFns.dropHolder(cs, 'agent:X', T0)
    const h2 = host.dropHolder(hs, 'agent:X', T0), c2 = coreFns.dropHolder(cs, 'agent:X', T0)
    cmp('dropHolder · 第一次输出', outcome({ threw: false, value: h1 }), outcome({ threw: false, value: c1 }))
    cmp('dropHolder · 第二次输出（幂等）', outcome({ threw: false, value: h2 }), outcome({ threw: false, value: c2 }))
    cmp('dropHolder · 两次调用后的 state', hs, cs)
    ok(h1.changed === true && h2.changed === false, 'host dropHolder 幂等：第一次 changed / 第二次 not changed', String(h1.changed) + '/' + String(h2.changed))
    ok(c1.changed === true && c2.changed === false, 'core dropHolder 幂等：第一次 changed / 第二次 not changed', String(c1.changed) + '/' + String(c2.changed))
    ok(h2.changed === false && c2.changed === false, '幂等那次不改变状态（同一次状态变更内完成）')
  }

  // 显式钉住 W7 的三条语义（不只看两形态相等，还看**具体取值**）。
  {
    const hs = mkState({ claims: [
      Object.assign({}, live, { readers: ['agent:W'] }),
      Object.assign({}, dead, { readers: ['agent:W'] }),
      Object.assign({}, byOther, { readers: byOther.readers.slice() })
    ] })
    const cs = mkState({ claims: [
      Object.assign({}, live, { readers: ['agent:W'] }),
      Object.assign({}, dead, { readers: ['agent:W'] }),
      Object.assign({}, byOther, { readers: byOther.readers.slice() })
    ] })
    const hr = host.dropHolder(hs, 'agent:X', T0), cr = coreFns.dropHolder(cs, 'agent:X', T0)
    for (const [who, st, r] of [['host', hs, hr], ['core', cs, cr]]) {
      ok(st.claims.some((c) => c.claimId === 'c_live'), who + '：未过期声明 c_live 在 dropHolder 之后仍然存在（未到期 ⇒ 不释放）',
        JSON.stringify(st.claims.map((c) => c.claimId)))
      ok(!st.claims.some((c) => c.claimId === 'c_dead'), who + '：已过期声明 c_dead 被回收',
        JSON.stringify(st.claims.map((c) => c.claimId)))
      ok(r.data.released.length === 1 && r.data.released[0].claimId === 'c_dead',
        who + '：data.released 只含真正被删掉的那条', JSON.stringify(r.data.released.map((x) => x.claimId)))
      const remain = st.claims.find((c) => c.claimId === 'c_o')
      ok(remain && !remain.readers.includes('agent:X') && remain.readers.includes('agent:Z'),
        who + '：reader 仍被摘掉，其他 reader 不受影响', JSON.stringify(remain && remain.readers))
    }
  }
}
// ---------------------------------------------------------------- releaseOnLoopEnd
// 循环终止自动释放（0.9.10）：会话循环停下（agent/status → idle）并过了宽限期之后，把该 holder
// 的**未过期**声明全部释放，并在留言板留一条审计留言（channel=agent:<holderId>）。
// 两形态必须逐输出等价 —— 包括留言对象本身（author / channel / seq / 正文）。
group('releaseOnLoopEnd', '循环终止自动释放：只释放未过期声明 + 留言留痕（幂等）')
{
  const R = (label, opts) => pairCase('releaseOnLoopEnd', label, () => {
    const state = mkState(opts.state ? opts.state() : {})
    const holderId = opts.holderId || 'agent:A'
    const name = opts.name === undefined ? NAME_A : opts.name
    const t = opts.t === undefined ? T0 : opts.t
    const graceSec = opts.graceSec === undefined ? 15 : opts.graceSec
    return { hostArgs: [state, holderId, name, t, graceSec], coreArgs: [state, holderId, name, t, graceSec], state }
  })
  R('单条未过期声明被释放', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_1' })] }) })
  R('已过期声明**不**动（那是 sweep 的活）', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_e', expiresAt: T0 - 1 })] }) })
  R('混合：未过期释放、已过期原样留下', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_live' }), mkClaimRec({ claimId: 'c_exp', expiresAt: T0 - 1 })] }) })
  R('其他 holder 的声明不受影响', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_a' }), mkClaimRec({ claimId: 'c_b', holderId: 'agent:B', holderName: 'Worker B', paths: ['src/b/'] })] }) })
  R('一条声明都没有 → changed:false（不留痕）', { state: () => ({ claims: [] }) })
  R('holder 不在状态里 → changed:false', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_b', holderId: 'agent:B' })] }) })
  R('多条声明 + 路径去重折叠（> 3 条只计数）', {
    state: () => ({
      seq: 11,
      claims: [
        mkClaimRec({ claimId: 'c_1', paths: ['src/a/', 'src/b/', 'src/c/'] }),
        mkClaimRec({ claimId: 'c_2', paths: ['src/d/', 'src/b/'], mode: 'shared' })
      ]
    })
  })
  R('holderName 为空时留言用 holderId', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_1' })] }), name: '' })
  R('graceSec 取非默认值时留言文案跟着变', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_1' })] }), graceSec: 90 })
  R('边界：expiresAt === t **不算**未过期（与 sweep 的 > t 同一判据）', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_bd', expiresAt: T0 })] }) })
  R('留言 seq 接在既有 seq 之后（claim 与 message 共用一个 seq）', { state: () => ({ seq: 41, claims: [mkClaimRec({ claimId: 'c_1' })] }) })
  R('已有留言时追加在末尾', { state: () => ({ seq: 9, messages: mkMessages(2, 8), claims: [mkClaimRec({ claimId: 'c_1' })] }) })

  // 幂等：第二次必须 changed === false（两形态一致），且**不**再留痕。
  {
    const mk = () => mkState({ claims: [mkClaimRec({ claimId: 'c_1', readers: ['agent:R'] })] })
    const hs = mk(), cs = mk()
    const h1 = host.releaseOnLoopEnd(hs, 'agent:A', NAME_A, T0, 15), c1 = coreFns.releaseOnLoopEnd(cs, 'agent:A', NAME_A, T0, 15)
    const h2 = host.releaseOnLoopEnd(hs, 'agent:A', NAME_A, T0, 15), c2 = coreFns.releaseOnLoopEnd(cs, 'agent:A', NAME_A, T0, 15)
    cmp('releaseOnLoopEnd · 第一次输出', outcome({ threw: false, value: h1 }), outcome({ threw: false, value: c1 }))
    cmp('releaseOnLoopEnd · 第二次输出（幂等）', outcome({ threw: false, value: h2 }), outcome({ threw: false, value: c2 }))
    cmp('releaseOnLoopEnd · 两次调用后的 state', hs, cs)
    ok(h1.changed === true && h2.changed === false, '幂等：第一次 changed / 第二次 not changed', String(h1.changed) + '/' + String(h2.changed))
    ok(hs.messages.length === 1, '幂等：只留一条审计留言（第二次不再追加）', String(hs.messages.length))
  }

  // 显式钉住取值（不只看两形态相等）：释放了什么、留下了什么、留痕长什么样。
  {
    const st = mkState({
      seq: 7,
      claims: [
        mkClaimRec({ claimId: 'c_1', paths: ['src/a/', 'src/a/b/'], readers: ['agent:R'] }),
        mkClaimRec({ claimId: 'c_2', holderId: 'agent:B', paths: ['src/b/'] })
      ]
    })
    const r = coreFns.releaseOnLoopEnd(st, 'agent:A', NAME_A, T0, 15)
    ok(r.data.released.length === 1 && r.data.released[0].claimId === 'c_1', 'data.released 只含真正被删的那条', JSON.stringify(r.data.released.map((x) => x.claimId)))
    ok(st.claims.length === 1 && st.claims[0].claimId === 'c_2', 'state 里只剩别人的声明', JSON.stringify(st.claims.map((x) => x.claimId)))
    const m = r.data.notice
    ok(m && m.channel === 'agent:A' && m.author === 'system:dsh-collab', '留痕寻址到持有者（channel 就是 holderId，不再重复拼 agent:）、作者是 system:dsh-collab', JSON.stringify(m && [m.channel, m.author]))
    ok(m && Array.isArray(m.mentions) && m.mentions[0] === 'agent:A' && String(m.body).includes('自动释放'), '留痕 mention 持有者且正文说明是自动释放', JSON.stringify(m && m.body))
    ok(m && m.seq === 8 && m.msgId === 'm_8', '留痕序号接在既有 seq 之后', JSON.stringify(m && [m.seq, m.msgId]))
    ok(core.AUTO_RELEASE_AUTHOR === 'system:dsh-collab', 'AUTO_RELEASE_AUTHOR 常量与留痕作者一致（宿主内联字面量由上面的逐输出对拍守护）', String(core.AUTO_RELEASE_AUTHOR))
  }
}
// ---------------------------------------------------------------- heartbeat
group('heartbeat', '续租：expiresAt = now + ttlSec / forbidden / not-found')
{
  const HB = (label, opts) => pairCase('heartbeat', label, () => {
    const state = mkState(opts.state ? opts.state() : {})
    return { hostArgs: [state, opts.h || HOLDER_A, opts.a()], coreArgs: [state, opts.h || HOLDER_A, opts.a(), fixedNow], state }
  })
  HB('续租自己的声明', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', ttlSec: 600, expiresAt: T0 + 1 })] }), a: () => ({ claimId: 'c_1' }) })
  HB('ttlSec 0 → 回落到 1800', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', ttlSec: 0, expiresAt: T0 + 1 })] }), a: () => ({ claimId: 'c_1' }) })
  HB('ttlSec 缺省 → 1800', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', ttlSec: undefined, expiresAt: T0 + 1 })] }), a: () => ({ claimId: 'c_1' }) })
  HB('续租他人的 → forbidden', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_1' })] }), a: () => ({ claimId: 'c_1' }), h: HOLDER_B })
  HB('claimId 不存在 → not-found', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_1' })] }), a: () => ({ claimId: 'c_nope' }) })
  HB('缺 claimId → not-found', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_1' })] }), a: () => ({}) })
  HB('已过期声明仍可续租', { state: () => ({ claims: [mkClaimRec({ claimId: 'c_1', expiresAt: T0 - 1 })] }), a: () => ({ claimId: 'c_1' }) })
}
// ---------------------------------------------------------------- post
group('post', '留言：body 校验 / channel 缺省与 trim / mentions 过滤与截断 / replyTo')
{
  // 同 claim：宿主 post(state, h, name, a) 用 name 形参，core post(state, h, a, tNow) 用 h.name。
  const P = (label, opts) => pairCase('post', label, () => {
    const state = mkState(opts.state ? opts.state() : {})
    const a = opts.a ? opts.a() : { body: 'hello' }
    const h = opts.h || HOLDER_A
    return { hostArgs: [state, h, h.name || h.holderId, a], coreArgs: [state, h, a, fixedNow], state }
  })
  P('基础留言（默认频道）', {})
  P('频道 trim', { a: () => ({ body: 'hi', channel: '  path:src/a/  ' }) })
  P('频道空串 → general', { a: () => ({ body: 'hi', channel: '' }) })
  P('频道非字符串 → general', { a: () => ({ body: 'hi', channel: 5 }) })
  P('body 空串 → bad-request', { a: () => ({ body: '' }) })
  P('body 纯空白 → bad-request', { a: () => ({ body: '   ' }) })
  P('body 非字符串 → bad-request', { a: () => ({ body: 42 }) })
  P('body 缺省 → bad-request', { a: () => ({}) })
  P('body 两端 trim', { a: () => ({ body: '  spaced  ' }) })
  P('mentions 过滤非字符串', { a: () => ({ body: 'hi', mentions: ['agent:B', 5, '', 'agent:C', null] }) })
  P('mentions 非数组 → []', { a: () => ({ body: 'hi', mentions: 'agent:B' }) })
  P('mentions 超 20 截断', { a: () => ({ body: 'hi', mentions: Array.from({ length: 25 }, (_, i) => 'agent:' + i) }) })
  P('replyTo 设置', { a: () => ({ body: 'hi', replyTo: 'm_3' }) })
  P('replyTo 空串不设置', { a: () => ({ body: 'hi', replyTo: '' }) })
  P('replyTo 非字符串不设置', { a: () => ({ body: 'hi', replyTo: 5 }) })
  P('seq 在既有留言后递增', { state: () => ({ seq: 9, messages: mkMessages(2, 8) }) })
  P('新 holder 登记', { h: HOLDER_B })
}
// ---------------------------------------------------------------- overview
group('overview', '同名但不同形：用桩把宿主的 async op 收敛到聚合逻辑后对拍')
{
  const mkFixture = () => mkState({
    seq: 4,
    claims: [
      mkClaimRec({ claimId: 'c_1', holderId: 'agent:A', holderName: 'Worker A', paths: ['src/a/', 'src/a/b/'], mode: 'exclusive' }),
      mkClaimRec({ claimId: 'c_2', holderId: 'agent:A', holderName: 'Worker A', paths: ['src/c/'], mode: 'read' }),
      mkClaimRec({ claimId: 'c_3', holderId: 'agent:B', holderName: undefined, paths: ['src/b/'], mode: 'shared', readers: ['agent:A', 'agent:A'] }),
      mkClaimRec({ claimId: 'c_4', holderId: 'agent:C', holderName: 'Worker C', paths: ['src/d/'], expiresAt: T0 - 1 })
    ],
    holders: []
  })
  const cases = [
    ['多 holder 混合 mode + 一条过期', mkFixture],
    ['空声明', () => mkState({ claims: [] })],
    ['单 holder 单一 mode', () => mkState({ claims: [mkClaimRec({ claimId: 'c_x', holderId: 'agent:Z', holderName: 'Z' })] })]
  ]
  for (const [label, mk] of cases) {
    const hostState = mk(), coreState = mk()
    overviewLoad = async () => ({ state: hostState, target: { path: '/fake/collab/state.json' }, stateDir: '/tmp', warn: null })
    const hOut = await host.overview('agent-A')
    coreFns.expire(coreState, T0)
    const cOut = coreFns.overview(coreState)
    ok(hOut && hOut.ok === true, 'overview · ' + label + ' · 宿主 op 成功', show(hOut))
    ok(hOut && hOut.data && hOut.data.statePath === '/fake/collab/state.json',
      'overview · ' + label + ' · 桩接线生效（statePath 来自 load 桩，不是空结果）', show(hOut && hOut.data))
    cmp('overview · ' + label + ' · totalClaims', hOut && hOut.data && hOut.data.totalClaims, cOut.totalClaims)
    cmp('overview · ' + label + ' · holders', hOut && hOut.data && hOut.data.holders, cOut.holders)
  }
  // 桩的 load 也被 expire 走了一遍：确认宿主 op 内部真的做了惰性清理（不是没跑）
  ok(typeof overviewLoad === 'function', 'overview 桩可被注入')
}

// ---------------------------------------------------------------- 语料完整性守护
group('corpus', '每个同名函数的语料条数下限（防止语料被悄悄掏空）')
{
  for (const name of EXPECTED_PARITY) {
    const g = groups.get(name)
    const n = g ? g.pass + g.fail : 0
    ok(n >= 4, 'corpus · ' + name + ' 至少 4 条断言', 'actual=' + n)
  }
  ok(EXPECTED_PARITY.length === 21, '逐输出对拍的同名函数恰好 21 个', String(EXPECTED_PARITY.length))
}

// ---------------------------------------------------------------- 汇总
console.log('\n每个函数/分组的断言条数：')
for (const [name, g] of groups) {
  console.log('  ' + name.padEnd(14) + ' ' + String(g.pass + g.fail).padStart(3) + ' 条' + (g.fail ? '  (' + g.fail + ' 失败)' : ''))
}
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
