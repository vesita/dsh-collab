#!/usr/bin/env node
// scripts/build-host.mjs
//
// 生成动态宿主形态的 hostCode（唯一事实源是两半：外壳 + 核心）。
//
//   src/host-shell.js        外壳模板（inject/apply 接线、状态文件读写、工具注册、事件接线）
//   lib/collab-core.js       ← src/collab-core.ts（构建产物，可 import 的纯逻辑唯一事实源）
//   lib/spec.js              ← src/spec.ts（构建产物；取 DELEGATION_DISCIPLINE_TEXT 的**值**，
//                              以及功能 C 的路径规格 TOOL_PATH_SPECS / COMMAND_AWARE_TOOL 的值
//                              与 pathArgsFor 的源码）
//   ────────────────────────
//   lib/collab-plugin.host.js  生成物：export const hostCode = <整段 JS 源码字符串>
//
// Cordis 动态插件的 code.host 是**纯文本**，不接受 import/打包。所以核心源码在这里被
// 原样内联进外壳的 /*__COLLAB_CORE__*/ 标记处 —— 只剥掉顶层 `export ` 前缀；由于
// lib/collab-core.js 完全自包含（0 个 import/require），剥完就是一段可直接求值的 JS。
//
// 委托纪律文本（order 131）走**另一条路**：lib/spec.js **不自包含**（顶层 import
// schemastery 与 collab-core），整份内联进不去动态宿主。所以这里不内联其源码，而是
// 在构建期 import lib/spec.js 取出 DELEGATION_DISCIPLINE_TEXT 的**值**，用 JSON.stringify
// 包成字符串字面量内联到 /*__COLLAB_DISCIPLINE_TEXT__*/ 标记处。唯一事实源仍是
// src/spec.ts：外壳里一个字都不手抄，改 spec.ts 只需重新 build。
//
// 为什么用 JSON.stringify 包整段字符串：核心与外壳里有反引号、`${}`、`\u0000`、正则里的
// 反斜杠层级；JSON 字符串字面量（双引号）对这些全部免转义，只有 JSON 自己处理的那几个
// 字符会被正确转义。手写模板字符串的转义层级是这条链路上最容易腐烂的地方。
//
// 确定性：不写时间戳、不依赖环境。同一个 lib/collab-core.js + src/host-shell.js
// 连续跑两次，字节完全相同（tests/collab-inline-parity.mjs 亦断言两半同源）。

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { hostShell } from '../src/host-shell.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORE_JS = join(ROOT, 'lib', 'collab-core.js')
const SPEC_JS = join(ROOT, 'lib', 'spec.js')
const OUT_JS = join(ROOT, 'lib', 'collab-plugin.host.js')

// 标记：外壳模板里独占一行（4 空格缩进）；生成时整行换成"BEGIN\n内联内容\nEND"。
const MARKER_LINE = '    /*__COLLAB_CORE__*/'
const DISCIPLINE_MARKER_LINE = '    /*__COLLAB_DISCIPLINE_TEXT__*/'
const PATH_SPECS_MARKER_LINE = '    /*__COLLAB_PATH_SPECS__*/'
export const CORE_BEGIN = '/*__COLLAB_CORE_BEGIN__*/'
export const CORE_END = '/*__COLLAB_CORE_END__*/'
export const DISCIPLINE_BEGIN = '/*__COLLAB_DISCIPLINE_BEGIN__*/'
export const DISCIPLINE_END = '/*__COLLAB_DISCIPLINE_END__*/'
export const PATH_SPECS_BEGIN = '/*__COLLAB_PATH_SPECS_BEGIN__*/'
export const PATH_SPECS_END = '/*__COLLAB_PATH_SPECS_END__*/'

/** 剥掉顶层 `export ` 前缀（只匹配行首，不碰字符串/注释里的 export）。 */
function stripTopLevelExports (src) {
  return src.replace(/^export /gm, '')
}

/** 自包含性检查：剥完 export 之后不许再有 import/export/require，否则 new Function 装不起来。 */
function assertSelfContained (src, label) {
  const importExport = /^\s*(?:import|export)\b/m.exec(src)
  if (importExport) {
    throw new Error(label + ' 仍有顶层 import/export（第 ' + lineOf(src, importExport.index) + ' 行）：' + importExport[0])
  }
  const req = /\brequire\s*\(/.exec(src)
  if (req) {
    throw new Error(label + ' 含 require()（第 ' + lineOf(src, req.index) + ' 行）：动态宿主里没有 require')
  }
}

function lineOf (src, index) {
  return src.slice(0, index).split('\n').length
}

/** 受限宿主里必然 undefined 的两个全局名：撞上就是内联区装不起来。 */
function assertNoProcessOs (src, label) {
  for (const bad of ['process', 'os']) {
    const re = new RegExp('\\b' + bad + '\\b')
    const m = re.exec(src)
    if (m) throw new Error(label + ' 引用了 ' + bad + '（受限动态宿主里 undefined，第 ' + lineOf(src, m.index) + ' 行）')
  }
}

/** 给整段源码统一加 4 空格缩进（空行保持空，不带尾随空格）。 */
function indent4 (src) {
  return src.split('\n').map(line => (line ? '    ' + line : line)).join('\n')
}

async function main () {
  const coreSrc = readFileSync(CORE_JS, 'utf8')
  const coreStripped = stripTopLevelExports(coreSrc)

  if (!coreSrc.startsWith('// collab-core.ts')) {
    throw new Error('lib/collab-core.js 看起来不是 collab-core 的构建产物（缺少文件头注释）')
  }
  assertSelfContained(coreStripped, 'lib/collab-core.js')

  // 委托纪律文本：从**构建产物** lib/spec.js 读值（唯一事实源 src/spec.ts）。
  // 不内联源码，因为 spec.js 有顶层 import（schemastery / collab-core），不是自包含段。
  const spec = await import(pathToFileURL(SPEC_JS).href)
  const disciplineText = spec.DELEGATION_DISCIPLINE_TEXT
  if (typeof disciplineText !== 'string' || !disciplineText.length) {
    throw new Error('lib/spec.js 没有导出可用的 DELEGATION_DISCIPLINE_TEXT（动态宿主形态的纪律块会缺文本）')
  }

  // 功能 C 的路径事实源（宿主形态写门控用）：同样只从构建产物取值/取源码，不手抄一个字。
  //   - TOOL_PATH_SPECS / COMMAND_AWARE_TOOL 是**数据**，JSON 序列化内联；
  //   - pathArgsFor 是**函数**，JSON 装不下，取 Function.prototype.toString()（V8 返回原始源码，
  //     确定性、无时间戳）—— 它是唯一读这张表的代码，手抄一份就等于给"新增核心 fs 工具要加一行"
  //     这条纪律开了第二个腐烂点。它引用的两个符号必须与上面内联的值同名，否则构建直接失败。
  if (typeof spec.pathArgsFor !== 'function' || !spec.TOOL_PATH_SPECS || typeof spec.COMMAND_AWARE_TOOL !== 'string') {
    throw new Error('lib/spec.js 缺少功能 C 的路径规格（pathArgsFor / TOOL_PATH_SPECS / COMMAND_AWARE_TOOL）')
  }
  const pathArgsForSrc = spec.pathArgsFor.toString()
  if (!/^function pathArgsFor\s*\(/.test(pathArgsForSrc)) {
    throw new Error('lib/spec.js 的 pathArgsFor 源码形状变了（内联依赖它是一条独立函数声明）：' + pathArgsForSrc.slice(0, 60))
  }
  for (const need of ['TOOL_PATH_SPECS', 'COMMAND_AWARE_TOOL']) {
    if (!pathArgsForSrc.includes(need)) {
      throw new Error('lib/spec.js 的 pathArgsFor 不再引用 ' + need + '：内联后会缺依赖，别静默生成半截代码')
    }
  }
  const pathSpecsSrc = 'const TOOL_PATH_SPECS = ' + JSON.stringify(spec.TOOL_PATH_SPECS, null, 2) + ';\n'
    + 'const COMMAND_AWARE_TOOL = ' + JSON.stringify(spec.COMMAND_AWARE_TOOL) + ';\n'
    + 'const pathArgsFor = ' + pathArgsForSrc
  assertSelfContained(pathSpecsSrc, 'lib/spec.js 的路径规格内联区')
  assertNoProcessOs(pathSpecsSrc, 'lib/spec.js 的路径规格内联区')

  for (const [marker, label] of [[MARKER_LINE, '核心'], [DISCIPLINE_MARKER_LINE, '纪律文本'], [PATH_SPECS_MARKER_LINE, '路径规格']]) {
    const n = hostShell.split(marker).length - 1
    if (n !== 1) {
      throw new Error('src/host-shell.js 必须恰好有一行 `' + marker + '`（' + label + '内联点），实际 ' + n + ' 处')
    }
  }

  const block = CORE_BEGIN + '\n' + coreStripped + CORE_END
  let hostCode = hostShell.split(MARKER_LINE).join(block)

  // 只内联**值**（JSON.stringify 包成字符串字面量），不做任何手抄：重新 build 即同步。
  const disciplineBlock = DISCIPLINE_BEGIN + '\n'
    + '    // 委托纪律文本（order 131）。构建期从 lib/spec.js 的 DELEGATION_DISCIPLINE_TEXT 取值；\n'
    + '    // 唯一事实源是 src/spec.ts，外壳里没有第二份副本。\n'
    + '    const DELEGATION_DISCIPLINE_TEXT = ' + JSON.stringify(disciplineText) + ';\n'
    + '    ' + DISCIPLINE_END
  hostCode = hostCode.split(DISCIPLINE_MARKER_LINE).join(disciplineBlock)

  // 功能 C 的路径规格内联区（第三个内联点）：值 + 函数源码，都来自 lib/spec.js。
  const pathSpecsBlock = PATH_SPECS_BEGIN + '\n'
    + '    // 功能 C 的路径事实源：工具名 -> 入参里的读写路径参数。构建期从 lib/spec.js 取出\n'
    + '    // TOOL_PATH_SPECS / COMMAND_AWARE_TOOL 的**值**与 pathArgsFor 的**源码**（Function.prototype.toString）。\n'
    + '    // 唯一事实源仍是 src/spec.ts；外壳里没有第二份副本，重新 build 即同步。\n'
    + indent4(pathSpecsSrc) + '\n'
    + '    ' + PATH_SPECS_END
  hostCode = hostCode.split(PATH_SPECS_MARKER_LINE).join(pathSpecsBlock)

  // 语法自检：hostCode 必须能被 new Function 直接求值（现有测试就是这么装它的）。
  try {
    // eslint-disable-next-line no-new-func
    new Function('harness', 'ctx', hostCode)
  } catch (e) {
    throw new Error('生成的 hostCode 无法被 new Function 构造：' + String((e && e.message) || e))
  }

  const out = [
    '// AUTO-GENERATED by scripts/build-host.mjs —— 不要手改这个文件。',
    '// 源：src/host-shell.js（外壳）+ src/collab-core.ts → lib/collab-core.js（核心，剥掉顶层 `export ` 后内联）。',
    '// 内联的核心与 lib/collab-core.js 逐字节同源，由 tests/collab-inline-parity.mjs 守护。',
    '// 委托纪律文本与功能 C 的路径规格取自 src/spec.ts → lib/spec.js（只内联值，路径规格另含 pathArgsFor 源码）。',
    'export const hostCode = ' + JSON.stringify(hostCode) + ';',
    'export default { hostCode };',
    ''
  ].join('\n')

  writeFileSync(OUT_JS, out)
  console.log('build-host: ' + OUT_JS + '  (' + hostCode.length + ' 字符 hostCode, ' + Buffer.byteLength(out) + ' 字节文件)')
}

await main()
