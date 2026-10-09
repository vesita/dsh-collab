// tests/collab-inline-parity.mjs
//
// 守护什么
//   dsh-collab 曾经两形态**各写一份**纯逻辑与状态层：
//     · 包形态      src/collab-core.ts → lib/collab-core.js（可 import）
//                   与 src/state-core.ts → lib/state-core.js（同一份状态机，store.ts 只做适配）
//     · 动态宿主形态 hostCode 字符串里内联的手写自包含副本
//   0.14.0 起宿主形态的纯逻辑**不再手写**、0.15.0 起状态层也不再手写：
//   scripts/build-host.mjs 把 lib/collab-core.js 与 lib/state-core.js 剥掉顶层 export 前缀后
//   原样内联进 src/host-shell.js 的两个标记处，生成 lib/collab-plugin.host.js。两形态因此
//   逐字节同源 —— 漂移这一整类问题从根上消失。
//
//   本文件守这条链路的**同源事实**（旧版"31 个同名函数逐输出对拍"在内联之后是同一份代码，
//   比对不可能失败，已删除）：
//     1. hostCode 内联的核心与 lib/collab-core.js 去 export 后**逐字节一致**；
//     1b. hostCode 内联的状态层与 lib/state-core.js 去 export 后**逐字节一致**；
//     2. 两段内联区各自自包含（无 import/export/require/process/os），能被 new Function 独立求值；
//     3. 外壳层没有把任何 collab-core 导出的名字再写一遍（不遮蔽、不复刻），
//        每个核心导出在 hostCode 里恰好声明一次且都在内联区里；外壳也不再自带状态层的
//        任何一件（load / mutate / writeState / 只读 op / 磁盘布局 / 损坏自愈）；
//     4. hostCode 仍能被 new Function 直接构造，宿主真实 I/O op（overview / status）
//        与几条继承来的核心语义（sweep 消费 opts、filterMessages 的 tail/forward）仍然工作。
//
// 与 tests/collab-hostcode-parity.mjs 的分工（互补，不要合并）
//   · collab-hostcode-parity.mjs 把 hostCode 装进 fake ctx 跑锁语义/路径解析/事件接线的端到端；
//   · 本文件做"源码同源 + 外壳不越权"的结构守卫，加两条宿主 op 冒烟。
//
// 运行：node tests/collab-inline-parity.mjs   退出码非 0 即失败

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createHarness } from './_harness.mjs'

const h = createHarness()
const { ok } = h

const BEGIN = '/*__COLLAB_CORE_BEGIN__*/'
const END = '/*__COLLAB_CORE_END__*/'
// 外壳模板里的内联点（构建时被换成 BEGIN + 核心 + END）。生成物里不许再有它。
const MARKER_LINE = '    /*__COLLAB_CORE__*/'
// 状态层（第二个源码内联区）：唯一事实源 src/state-core.ts，包形态 src/store.ts 与之同源。
const SBEGIN = '/*__COLLAB_STATE_CORE_BEGIN__*/'
const SEND = '/*__COLLAB_STATE_CORE_END__*/'
const SMARKER_LINE = '    /*__COLLAB_STATE_CORE__*/'

const show = (v) => {
  let s
  try { s = JSON.stringify(v) } catch (e) { s = String(v) }
  if (s === undefined) s = String(v)
  return s.length > 240 ? s.slice(0, 240) + '…' : s
}
const firstDiff = (got, want) => {
  const n = Math.min(got.length, want.length)
  for (let i = 0; i < n; i++) {
    if (got[i] !== want[i]) return 'i=' + i + ' got=' + JSON.stringify(got.slice(i, i + 40)) + ' want=' + JSON.stringify(want.slice(i, i + 40))
  }
  return got.length === want.length ? '' : 'length got=' + got.length + ' want=' + want.length
}
// 声明名抽取：只认**apply 顶层**（内联核心在 0 空格，外壳在 4 空格）。局部遮蔽（更深缩进）不算。
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const declaredAt = (src, name) => [...src.matchAll(new RegExp('^(?: {4})?(?:async\\s+)?(?:function|const|let)\\s+' + escapeRe(name) + '\\b', 'gm'))]
const shellDeclNames = (src) => {
  const out = new Set()
  for (const m of src.matchAll(/^ {4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1])
  for (const m of src.matchAll(/^ {4}(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm)) out.add(m[1])
  return out
}

// ---------------------------------------------------------------- 装载产物（缺失即失败，不 SKIP）
let hostCode = null
let core = null
let coreSrc = ''
let stateCoreSrc = ''
try {
  hostCode = (await import(new URL('../lib/collab-plugin.host.js', import.meta.url))).hostCode
  core = await import(new URL('../lib/collab-core.js', import.meta.url))
  coreSrc = readFileSync(new URL('../lib/collab-core.js', import.meta.url), 'utf8')
  stateCoreSrc = readFileSync(new URL('../lib/state-core.js', import.meta.url), 'utf8')
} catch (e) {
  console.log('FAIL cannot load built artifacts (run `npm run build`): ' + String((e && e.message) || e))
  console.log('\nFAILURES: 0 passed, 1 failed')
  process.exit(1)
}

console.log('# 生成物形态')
ok(typeof hostCode === 'string' && hostCode.length > 1000, 'lib/collab-plugin.host.js 导出非空 hostCode 字符串',
  'len=' + String(hostCode && hostCode.length))
ok(typeof core === 'object' && core !== null, 'lib/collab-core.js 可 import')
ok(Boolean(core && core.MODES && core.MODES.length === 3), 'lib/collab-core.js 是构建产物（MODES 就位）')
ok(stateCoreSrc.startsWith('// src/state-core.ts'), 'lib/state-core.js 是构建产物（文件头注释就位）',
  stateCoreSrc.slice(0, 40))
if (typeof hostCode !== 'string') {
  console.log('\nFAILURES: ' + h.pass + ' passed, ' + h.fail + ' failed')
  process.exit(1)
}

// ---------------------------------------------------------------- 1. 内联区位置
const bi = hostCode.indexOf(BEGIN)
const ei = hostCode.indexOf(END)
const sbi = hostCode.indexOf(SBEGIN)
const sei = hostCode.indexOf(SEND)
ok(bi >= 0, 'hostCode 含核心内联区起点标记 ' + BEGIN, 'i=' + bi)
ok(ei > bi, 'hostCode 含核心内联区终点标记 ' + END, 'i=' + ei)
const region = (bi >= 0 && ei > bi) ? hostCode.slice(bi + BEGIN.length + 1, ei) : ''
// 外壳层 = 生成物**去掉两段源码内联区**之后剩下的那一层。两段内联区里的函数会被 tsc 重新
// 缩进到 4 空格，所以不切掉的话它们会被当成"外壳自己的声明"（本文件下面就是按 4 空格缩进判的）。
const shellRegion = (bi >= 0 && ei > bi && sbi > ei && sei > sbi)
  ? hostCode.slice(0, bi) + hostCode.slice(ei + END.length, sbi) + hostCode.slice(sei + SEND.length)
  : ''
ok(hostCode.indexOf(MARKER_LINE) === -1, '外壳模板里的内联点标记已被替换（生成物里不残留）')
ok(region.length > 1000 && region.indexOf(BEGIN) === -1 && region.indexOf(END) === -1,
  '内联区唯一且非空', 'len=' + region.length)

// ---------------------------------------------------------------- 2. 逐字节同源（本文件的核心守卫）
{
  const coreStripped = coreSrc.replace(/^export /gm, '')
  ok(coreStripped.length > 1000, 'lib/collab-core.js 去 export 后非空', 'len=' + coreStripped.length)
  ok(region === coreStripped,
    '内联核心与 lib/collab-core.js 去 export 后逐字节一致（两形态纯逻辑同源的根）',
    firstDiff(region, coreStripped))
  ok(!/^\s*(?:import|export)\b/m.test(region), '内联核心不含顶层 import/export（自包含）')
  ok(!/\brequire\s*\(/.test(region), '内联核心不含 require（动态宿主里没有 require）')
  ok(!/\bprocess\b/.test(region), '内联核心不引用 process（受限动态宿主里 undefined）')
  ok(!/\bos\b/.test(region), '内联核心不引用 os（受限动态宿主里 undefined）')
}

// ---------------------------------------------------------------- 1b. 状态层内联区（第二个源码内联点）
// 唯一事实源 src/state-core.ts：包形态 src/store.ts 与动态外壳共用它（外壳那份是构建期内联）。
// 这一条就是"状态层不再有两份"的机器判据 —— 与核心那条同形：逐字节 + 自包含。
console.log('# 状态层内联区（src/state-core.ts → lib/state-core.js）')
{
  ok(sbi > ei, '状态层内联区排在核心内联区之后（它引用的纯函数名来自核心那段）',
    'coreEnd=' + ei + ' stateBegin=' + sbi)
  ok(sbi >= 0, 'hostCode 含状态层内联区起点标记 ' + SBEGIN, 'i=' + sbi)
  ok(sei > sbi, 'hostCode 含状态层内联区终点标记 ' + SEND, 'i=' + sei)
  ok(hostCode.indexOf(SMARKER_LINE) === -1, '外壳模板里的状态层内联点标记已被替换（生成物里不残留）')
  const sregion = (sbi >= 0 && sei > sbi) ? hostCode.slice(sbi + SBEGIN.length + 1, sei) : ''
  const sStripped = stateCoreSrc.replace(/^export /gm, '')
  ok(sregion.length > 5000, '状态层内联区非空', 'len=' + sregion.length)
  ok(sregion === sStripped,
    '内联状态层与 lib/state-core.js 去 export 后逐字节一致（两形态状态层同源的根）',
    firstDiff(sregion, sStripped))
  ok(!/^\s*(?:import|export)\b/m.test(sregion), '内联状态层不含顶层 import/export（自包含）')
  ok(!/\brequire\s*\(/.test(sregion), '内联状态层不含 require（动态宿主里没有 require）')
  ok(!/\bprocess\b/.test(sregion), '内联状态层不引用 process（受限动态宿主里 undefined）')
  ok(!/\bos\b/.test(sregion), '内联状态层不引用 os（受限动态宿主里 undefined）')
  // 状态机本体确实在区里（而不是一个空壳标记），且真的被外壳装配用上。
  ok(/function createStateCore\s*\(/.test(sregion), '状态层内联区定义了 createStateCore')
  const shellAfterState = hostCode.slice(sei + SEND.length)
  ok(/createStateCore\(\{/.test(shellAfterState), '外壳用 createStateCore 装配状态层（注入环境面）')
  for (const port of ['fs', 'core', 'now', 'targetFor', 'legacyTargets', 'liveProcsOf', 'selfProcToken', 'sleep', 'liveAgentHolderIds', 'teamTasks', 'log']) {
    ok(new RegExp('\\b' + port + ':').test(shellAfterState), '外壳注入了环境面 ' + port)
  }
}

// ---------------------------------------------------------------- 2b. 纪律文本内联区（第二处内联）
// 委托纪律文本（order 131）从 lib/spec.js 取值内联 —— 它同样是动态宿主里的受限内容，
// 且**只有值**（JSON 字符串字面量），不是源码切片：spec.js 有顶层 import，整份进不来。
const DBEGIN = '/*__COLLAB_DISCIPLINE_BEGIN__*/'
const DEND = '/*__COLLAB_DISCIPLINE_END__*/'
const DMARKER_LINE = '    /*__COLLAB_DISCIPLINE_TEXT__*/'
{
  const dbi = hostCode.indexOf(DBEGIN)
  const dei = hostCode.indexOf(DEND)
  ok(dbi >= 0, 'hostCode 含纪律文本内联区起点标记 ' + DBEGIN, 'i=' + dbi)
  ok(dei > dbi, 'hostCode 含纪律文本内联区终点标记 ' + DEND, 'i=' + dei)
  ok(hostCode.indexOf(DMARKER_LINE) === -1, '外壳模板里的纪律内联点标记已被替换（生成物里不残留）')
  const dregion = (dbi >= 0 && dei > dbi) ? hostCode.slice(dbi + DBEGIN.length + 1, dei) : ''
  ok(!/^\s*(?:import|export)\b/m.test(dregion), '纪律内联区不含顶层 import/export（自包含）')
  ok(!/\brequire\s*\(/.test(dregion), '纪律内联区不含 require（动态宿主里没有 require）')
  ok(!/\bprocess\b/.test(dregion) && !/\bos\b/.test(dregion), '纪律内联区不引用 process/os')
  ok(/const\s+DELEGATION_DISCIPLINE_TEXT\s*=\s*"/.test(dregion),
    '纪律文本以 JSON 字符串字面量内联（值取自 spec，不是手抄的数组源码）', show(dregion.slice(0, 80)))
}

// ---------------------------------------------------------------- 2c. 路径规格内联区（第三处内联）
// 功能 C 的写门控要按工具名/入参判读写路径，事实源是 src/spec.ts 的 TOOL_PATH_SPECS /
// COMMAND_AWARE_TOOL / pathArgsFor。spec.js **不自包含**（顶层 import schemastery + collab-core），
// 所以构建期只取**值与函数源码**内联 —— 外壳里一个字都不手抄，改 spec.ts 只需重新 build。
const PBEGIN = '/*__COLLAB_PATH_SPECS_BEGIN__*/'
const PEND = '/*__COLLAB_PATH_SPECS_END__*/'
const PMARKER_LINE = '    /*__COLLAB_PATH_SPECS__*/'
{
  const spec = await import(new URL('../lib/spec.js', import.meta.url))
  const pbi = hostCode.indexOf(PBEGIN)
  const pei = hostCode.indexOf(PEND)
  ok(pbi >= 0, 'hostCode 含路径规格内联区起点标记 ' + PBEGIN, 'i=' + pbi)
  ok(pei > pbi, 'hostCode 含路径规格内联区终点标记 ' + PEND, 'i=' + pei)
  ok(hostCode.indexOf(PMARKER_LINE) === -1, '外壳模板里的路径规格内联点标记已被替换（生成物里不残留）')
  const pregion = (pbi >= 0 && pei > pbi) ? hostCode.slice(pbi + PBEGIN.length + 1, pei) : ''
  ok(!/^\s*(?:import|export)\b/m.test(pregion), '路径规格内联区不含顶层 import/export（自包含）')
  ok(!/\brequire\s*\(/.test(pregion), '路径规格内联区不含 require（动态宿主里没有 require）')
  ok(!/\bprocess\b/.test(pregion) && !/\bos\b/.test(pregion), '路径规格内联区不引用 process/os')

  let pinlined = null
  let perr = null
  try {
    // 独立求值：证明这段不依赖任何外部符号就定义出三个名字。
    pinlined = new Function(pregion + '\n;return { TOOL_PATH_SPECS, COMMAND_AWARE_TOOL, pathArgsFor };')()
  } catch (e) { perr = String((e && e.stack) || e) }
  ok(!!pinlined, '路径规格内联区可独立求值（不依赖外部符号）', perr)

  // 漂移守卫：内联的表与 lib/spec.js（= src/spec.ts 的构建产物）**逐字段一致**。
  // 漏一行就会让某个核心 fs 工具静默不受门控保护（read_image 就是这么漏过一次的）。
  ok(!!pinlined && JSON.stringify(pinlined.TOOL_PATH_SPECS) === JSON.stringify(spec.TOOL_PATH_SPECS),
    '内联的 TOOL_PATH_SPECS 与 lib/spec.js 的值逐字段一致',
    show(pinlined && Object.keys(pinlined.TOOL_PATH_SPECS || {})))
  ok(!!pinlined && pinlined.COMMAND_AWARE_TOOL === spec.COMMAND_AWARE_TOOL,
    '内联的 COMMAND_AWARE_TOOL 与 lib/spec.js 的值一致', show(pinlined && pinlined.COMMAND_AWARE_TOOL))
  // 行为守卫：同一批入参下内联函数与真身输出逐个相同（含 command 分读写的分支）。
  const CASES = [
    ['write', { file_path: 'a/b.ts' }],
    ['edit', { file_path: 'a/b.ts' }],
    ['read', { file_path: 'a/b.ts' }],
    ['read_image', { file_path: 'a/b.png' }],
    ['glob', { path: 'src/' }],
    ['grep', { path: 'src/', pattern: 'x' }],
    ['str_replace_editor', { command: 'view', path: 'a/b.ts' }],
    ['str_replace_editor', { command: 'create', path: 'a/b.ts' }],
    ['str_replace_editor', { command: 'wat', path: 'a/b.ts' }],
    ['bash', { command: 'echo hi' }],
    ['unknown_tool', { file_path: 'a/b.ts' }]
  ]
  const diffs = []
  for (const [tool, args] of CASES) {
    const got = pinlined && JSON.stringify(pinlined.pathArgsFor(tool, args))
    const want = JSON.stringify(spec.pathArgsFor(tool, args))
    if (got !== want) diffs.push(tool + ': got=' + got + ' want=' + want)
  }
  ok(diffs.length === 0, '内联 pathArgsFor 与 lib/spec.js 的行为逐例一致（含 command 分读写）', show(diffs))
}

// ---------------------------------------------------------------- 3. 内联区可独立求值
let inlined = null
let inlinedErr = null
try {
  // 把内联区当成一段独立脚本求值：证明它不依赖任何外部符号就能定义出核心函数。
  inlined = new Function(region + '\n;return { sweep, expire, holderView, filterMessages, channelRosterNote, claim, publish, HOLDER_VIEW_LIMIT, MAX_MESSAGES };')()
} catch (e) { inlinedErr = String((e && e.stack) || e) }
ok(!!inlined, '内联核心可独立求值（new Function 里不依赖任何外部符号）', inlinedErr)
ok(inlined && typeof inlined.sweep === 'function' && typeof inlined.claim === 'function',
  '内联区确实定义了核心函数（sweep / claim）')

// ---------------------------------------------------------------- 4. 外壳不越权
{
  const coreNames = new Set(Object.keys(core))
  const shellDecls = shellDeclNames(shellRegion)
  const shadow = [...shellDecls].filter((n) => coreNames.has(n)).sort()
  console.log('  外壳顶层声明(' + shellDecls.size + ')：' + show([...shellDecls].sort()))
  ok(shellDecls.size > 0, '外壳层有顶层声明（不是被掏空的外壳）', 'n=' + shellDecls.size)
  ok(shadow.length === 0, '外壳层不声明任何 collab-core 导出的名字（不遮蔽、不复刻）', show(shadow))
  // 唯一被逼改名的接缝：核心有纯函数 overview(state)，状态层的 I/O op 因此叫 overviewOp，
  // 外壳只把 op=overview 转发过去 —— 它自己不再声明这一层的任何名字。
  ok(!shellDecls.has('overview'),
    '外壳层不声明 overview（核心纯函数名不被遮蔽）', show([...shellDecls].filter((n) => n === 'overview')))
  ok(/store\.overviewOp\(/.test(shellRegion),
    'op=overview 由状态层的 overviewOp 提供（外壳只转发，不再自己实现一份）')

  // 状态层曾经在外壳里也有手写的一份（load / mutate / writeState / 只读 op / 磁盘布局 /
  // 损坏自愈）。0.15.0 起这些名字不许再出现在外壳层 —— 出现了就是把副本写回来了。
  const stateLayerNames = ['load', 'mutate', 'writeState', 'list', 'status', 'msgs', 'waitFor', 'overviewOf',
    'overviewOp', 'otherProjects', 'pruneCorruptBackups', 'sidecarNameOf', 'mainDocOf', 'sideDocOf',
    'msgFingerprint', 'sweepOpts', 'stale', 'withWarn', 'describeError', 'SIDECAR_EXT', 'createStateCore']
  const revived = stateLayerNames.filter((n) => shellDecls.has(n)).sort()
  ok(revived.length === 0, '外壳层不再自带状态层的任何一件（没有第二份 load/mutate/只读 op/磁盘布局）', show(revived))
  ok(/^ {4}const store = createStateCore\(/m.test(shellRegion),
    '外壳把状态层装配成一个 store（唯一入口）', show([...shellDecls].filter((n) => n === 'store')))

  const missing = [], dup = [], outside = []
  for (const n of coreNames) {
    const hits = declaredAt(hostCode, n)
    if (hits.length === 0) missing.push(n)
    else if (hits.length > 1) dup.push(n + 'x' + hits.length)
    else if (hits[0].index <= bi || hits[0].index >= ei) outside.push(n)
  }
  ok(coreNames.size > 40, '核心导出足够多（说明在扫真的模块）', 'n=' + coreNames.size)
  ok(missing.length === 0, '每个 collab-core 导出都在 hostCode 里出现', show(missing))
  ok(dup.length === 0, '没有哪个核心名在 apply 顶层被声明两次（外壳没有复刻）', show(dup))
  ok(outside.length === 0, '每个核心声明的唯一出现都落在内联区里', show(outside))

  // 缺陷 2：外壳曾自带 storageNameFor —— 与核心 projectStorageFileName 异名同义的双胞胎，
  // 恰好落在所有对拍之外（名字不同，逐输出对拍认不出它）。它必须彻底消失：
  // 文件名只在核心里组装一次，外壳只调核心。下面三条各自能独立失败。
  ok(!/\b(?:function|const|let)\s+storageNameFor\b/.test(shellRegion),
    '外壳不再声明自己的文件名函数（storageNameFor 已删除）')
  ok(!/\bhashProjectKey\b/.test(shellRegion),
    '外壳不再自己拼文件名（hashProjectKey 只出现在内联核心区）')
  ok(/\bprojectStorageFileName\s*\(/.test(shellRegion),
    '外壳的文件名来自核心的 projectStorageFileName（唯一事实源）')
}

// ---------------------------------------------------------------- 5. hostCode 可构造 + 宿主真实 I/O op 冒烟
console.log('# hostCode 装载 + 宿主 I/O op（overview / status）')
{
  const HOME = path.join('/tmp', 'dsh-collab-inline-' + process.pid)
  const SETTINGS_DOC = path.join(HOME, 'settings.yaml')
  const PROJECT_CWD = '/fake/project/alpha'
  const store = new Map()
  const makeTarget = (abs) => {
    const t = { displayPath: abs, path: abs, targetKey: abs }
    const plain = () => ({ displayPath: abs, path: abs, targetKey: abs })
    t.then = (f, r) => Promise.resolve(plain()).then(f, r)
    return t
  }
  const fs = {
    resolve: (p, opts) => makeTarget(path.isAbsolute(p) ? p : path.resolve(opts && opts.cwd ? opts.cwd : process.cwd(), p)),
    stat: async (t) => (store.has(t.path) ? { version: 1, type: 'file' } : undefined),
    readText: async (t) => store.get(t.path) || '',
    writeText: async (t, c) => { store.set(t.path, c); return { operation: 'create', version: 1 } },
    processPath: (t) => t.path,
    listDir: async () => []
  }
  const tools = []
  const harness = {
    defineTool: (def) => def,
    registerTool: (_ctx, tool) => { tools.push(tool); return () => {} },
    handle: () => () => {}
  }
  const ctx = {
    fs,
    timer: { timeout: (ms) => new Promise((r) => setTimeout(r, ms)) },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: () => () => {},
    get: (name) => {
      if (name === 'settings') return { prepareDocument: async () => SETTINGS_DOC }
      if (name === 'sessions') return { get: () => ({ header: { cwd: PROJECT_CWD } }) }
      if (name === 'sessionTitle') return { get: () => ({ title: 'Inline Worker' }) }
      return undefined
    }
  }
  let lock = null
  try {
    const plugin = new Function('harness', 'ctx', hostCode)(harness, ctx)
    ok(plugin && typeof plugin.apply === 'function' && Array.isArray(plugin.inject),
      'hostCode 能被 new Function 构造出带 apply 的插件对象', show(plugin && Object.keys(plugin)))
    await plugin.apply(ctx)
    lock = tools.find((t) => t.name === 'collab_lock')
  } catch (e) {
    ok(false, 'hostCode 装载不抛错', String((e && e.stack) || e))
  }
  ok(!!lock, 'hostCode 注册出 collab_lock', show(tools.map((t) => t.name)))

  if (lock) {
    const A = { agent: { id: 'agent-A' } }
    const call = (args) => lock.execute(args, A)
    const expectedPath = path.join(HOME, 'collab', 'projects', path.basename(PROJECT_CWD) + '-' + core.hashProjectKey(PROJECT_CWD) + '.json')
    // 两形态（外壳 / 核心）对同一 cwd 必须产出**同一个文件名**：这里先把测试自己的独立推导
    // （basename + hash）钉到核心的 projectStorageFileName 上，再由下面的 statePath 断言钉到外壳。
    ok(expectedPath === path.join(HOME, 'collab', 'projects', core.projectStorageFileName(PROJECT_CWD)),
      '同一 cwd 下，独立推导与核心 projectStorageFileName 产出同一文件名', show(expectedPath))

    const c1 = await call({ op: 'claim', paths: ['src/a/'], mode: 'exclusive', ttlSec: 1800 })
    ok(c1 && c1.ok === true && c1.data && c1.data.claim && c1.data.claim.holderId === 'agent:agent-A',
      '宿主 op=claim 建档成功', show(c1))

    const ov = await call({ op: 'overview' })
    ok(ov && ov.ok === true, '宿主 op=overview 成功', show(ov))
    ok(ov && ov.data && ov.data.statePath === expectedPath,
      'overview 报出的 statePath 是 settings.prepareDocument() 同目录下的绝对路径', show(ov && ov.data && ov.data.statePath))
    ok(ov && ov.data && ov.data.totalClaims === 1, 'overview 聚合出 1 条声明', show(ov && ov.data && ov.data.totalClaims))
    ok(ov && ov.data && Array.isArray(ov.data.holders) && ov.data.holders.length === 1 &&
      ov.data.holders[0].holderId === 'agent:agent-A' && ov.data.holders[0].claimCount === 1 &&
      ov.data.holders[0].mode === 'exclusive',
      'overview 按 holder 聚合（holderId / claimCount / mode）', show(ov && ov.data && ov.data.holders))

    const st = await call({ op: 'status', paths: ['src/'] })
    ok(st && st.data && Array.isArray(st.data.related) && st.data.related.length === 1 &&
      Array.isArray(st.data.exclusive) && st.data.exclusive.length === 1,
      '宿主 op=status 按路径前缀筛出 related / exclusive', show(st && st.data))

    // 真跑一遍 expire 路径：把声明改成已过期，再 overview 应看不到它（宿主 op 内部先 sweep）。
    let doc = null
    try { doc = JSON.parse(store.get(expectedPath)) } catch (e) { doc = null }
    ok(doc && Array.isArray(doc.claims) && doc.claims.length === 1,
      'claim 落盘到 settings.prepareDocument() 同目录的绝对路径', show(store.get(expectedPath)))
    if (doc && Array.isArray(doc.claims) && doc.claims.length) {
      doc.claims[0].expiresAt = 1
      store.set(expectedPath, JSON.stringify(doc))
      const ov2 = await call({ op: 'overview' })
      ok(ov2 && ov2.ok === true && ov2.data && ov2.data.totalClaims === 0,
        'overview 内部先做惰性清理（过期声明不再出现）', show(ov2 && ov2.data && ov2.data.totalClaims))
    }
  }
}

// ---------------------------------------------------------------- 6. 宿主形态继承核心语义（不再是手写副本）
console.log('# 内联核心的行为样本（旧手写副本在这几处不同）')
{
  const mkMessages = (n) => Array.from({ length: n }, (_, i) => ({
    msgId: 'm_' + (i + 1), seq: i + 1, channel: 'general', author: 'agent:A', ts: i, body: 'b' + i
  }))
  // 旧的宿主 sweep 写死上限 2000、忽略 opts.maxMessages；内联之后它就是 core 的 sweep。
  if (inlined) {
    const s = { schemaVersion: 1, seq: 0, claims: [], messages: mkMessages(10), holders: [] }
    const r = inlined.sweep(s, 0, { maxMessages: 3 })
    ok(r && r.droppedMessages === 7 && s.messages.length === 3,
      '内联的 sweep 消费 opts.maxMessages（宿主不再有忽略 opts 的手写副本）',
      show({ dropped: r && r.droppedMessages, left: s.messages.length }))
    const s2 = { schemaVersion: 1, seq: 0, claims: [], messages: mkMessages(5), holders: [] }
    const r2 = inlined.sweep(s2, 0)
    ok(r2 && r2.droppedMessages === 0 && s2.messages.length === 5 && 'expiredClaims' in r2 && 'prunedHolders' in r2,
      'sweep 缺省 opts 仍是 2000 上限，且诊断字段形状不变', show(r2))

    // 0.12.2 的实测缺陷：tail 取 matched 的末尾、forward 从游标往后；两条方向都要能独立成立。
    const st = { messages: mkMessages(100) }
    const tail = inlined.filterMessages(st, { limit: 5 })
    ok(tail.mode === 'tail' && tail.messages.map((m) => m.seq).join(',') === '96,97,98,99,100' &&
      tail.hasMore === true && tail.nextSince === 100 && tail.earliestSeq === 1,
      'filterMessages 缺省 tail：返回最新 limit 条 + hasMore/nextSince/earliestSeq', show(tail))
    const fwd = inlined.filterMessages(st, { since: 50, limit: 10 })
    ok(fwd.mode === 'forward' && fwd.messages.map((m) => m.seq).join(',') === '51,52,53,54,55,56,57,58,59,60' &&
      fwd.hasMore === true && fwd.nextSince === 60,
      'filterMessages since>0：从游标往后（旧→新）', show(fwd))
    const note = inlined.channelRosterNote({ messages: [{ channel: 'general' }, { channel: 'general' }, { channel: 'path:src/a/' }] })
    ok(note === '该频道没有消息。现有频道：general（2 条）、path:src/a/（1 条）。channel 是精确匹配的字符串：写什么就得按什么读（path: 频道与 claim 用同一套相对路径写法）。',
      'channelRosterNote 文档化文案', show(note))
  }
}

h.finish()
