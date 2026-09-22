#!/usr/bin/env node
// collab-contract-derivation.mjs
//
// 契约派生守卫：`src/schema/collab.schema.json` 自称单一事实源（SSOT），
// src/types/collab.d.ts（TS）/ scripts/collab_models.py（Python）/ crates/collab-cli/src/main.rs（Rust）
// 都是它的派生产物。本测试**只读文本与 JSON**、不 import lib/，一旦四份产物再次漂移就失败。
//
// 判定规则（机械、可复现）：
//   必填/可选以 SSOT 的 `required` 为准，要求四个产物对同一类型的
//   required 集合与 optional 集合**逐字段相等**；
//   - TS：字段带 `?` = 可选；
//   - Python：dataclass 字段无默认值 = 必填；
//   - Rust：字段为 `Option<T>` 或带 `#[serde(default...)]` = 可选；
//   - 字段名按 camelCase 对齐（Rust 端做 snake_case → camelCase 归一）。
//
// 另附：`$defs.colabLockParams` / `$defs.colabBoardParams`（注意拼写是 colab，不是 collab）
// 的 op 枚举、属性名集合、required，必须与包形态里**真实注册**的工具 schema 一致（不假定在哪个文件）
// —— 这把原本无人引用的 $defs 钉在发布态工具契约上，使它成为承重的镜像契约。
//
// 任何产物缺失 / 解析失败都记为失败，绝不静默跳过。
//
// 运行：node tests/collab-contract-derivation.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const SCHEMA_PATH = 'src/schema/collab.schema.json'
const TS_PATH = 'src/types/collab.d.ts'
const PY_PATH = 'scripts/collab_models.py'
const RUST_PATH = 'crates/collab-cli/src/main.rs'
// 真实工具 schema 的对照源：**不写死文件名**。它曾经在 src/index.ts，一次纯重构把它搬到了
// src/tools.ts —— 写死会让契约守卫在"只是搬家"时误报，而误报会被当成噪音被关掉。
// 所以扫 src/ 下全部 .ts，但**排除动态形态的内联副本**：那是刻意存在的另一份独立实现。
const SRC_DIR = 'src'
const HOST_FORM_FILE = 'collab-plugin.host.ts'

let passed = 0
let failed = 0
const failures = []

function check(name, cond, detail) {
  if (cond) passed++
  else {
    failed++
    failures.push(detail ? `${name} — ${detail}` : name)
  }
}

/** 读文件；缺失或读取失败不抛，返回 {error}，由调用方记成失败。 */
function load(rel) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return { error: `missing file: ${rel}` }
  try {
    return { text: readFileSync(abs, 'utf8') }
  } catch (e) {
    return { error: `unreadable file: ${rel} (${e && e.message})` }
  }
}

/**
 * 装载"包形态里真实注册的工具 schema"所在的全部 TS 源（拼接后供 parseRealTool 检索）。
 * 找不到任何源时返回 {error}（记成失败），**绝不静默通过**。
 */
function loadToolSchemaSource() {
  let files = []
  try {
    files = readdirSync(join(ROOT, SRC_DIR))
      .filter((f) => f.endsWith('.ts') && f !== HOST_FORM_FILE)
      .sort()
  } catch (e) {
    return { error: `cannot list ${SRC_DIR}/: ${e && e.message}` }
  }
  if (!files.length) return { error: `no .ts sources under ${SRC_DIR}/` }
  const parts = []
  for (const f of files) {
    const r = load(join(SRC_DIR, f))
    if (!r.error) parts.push(r.text)
  }
  if (!parts.length) return { error: `no readable .ts sources under ${SRC_DIR}/` }
  return { text: parts.join('\n'), files }
}

// ---------------------------------------------------------------- TS 解析

/** 解析 `export interface X { ... }` 与 `export type Mode = 'a' | 'b'`。 */
function parseTs(text) {
  const ifaces = {}
  const unions = {}
  const ire = /export interface (\w+)\s*\{([\s\S]*?)\n\}/g
  let m
  while ((m = ire.exec(text))) {
    const required = new Set()
    const optional = new Set()
    for (const raw of m[2].split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('*') || line.startsWith('/*') || line.startsWith('//')) continue
      const fm = /^([A-Za-z_$][\w$]*)(\?)?\s*:\s*(.+?);?$/.exec(line)
      if (!fm) continue
      if (fm[2]) optional.add(fm[1])
      else required.add(fm[1])
    }
    ifaces[m[1]] = { required, optional }
  }
  const ure = /export type (\w+)\s*=\s*([^\n;]+);/g
  while ((m = ure.exec(text))) {
    unions[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map(x => x[1])
  }
  return { ifaces, unions }
}

/** 从 TS 类型表达式里抽字符串字面量联合（如 op 的取值域）。 */
function tsUnionOf(expr) {
  return [...String(expr).matchAll(/'([^']+)'/g)].map(x => x[1])
}

// ------------------------------------------------------------ Python 解析

function parsePython(text) {
  const models = {}
  const literals = {}
  let cur = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const cm = /^class (\w+)\s*[:(]/.exec(line)
    if (cm) {
      cur = { required: new Set(), optional: new Set() }
      models[cm[1]] = cur
      continue
    }
    const lm = /^(\w+)\s*=\s*Literal\[(.+)\]\s*$/.exec(line)
    if (lm) {
      literals[lm[1]] = [...lm[2].matchAll(/"([^"]+)"/g)].map(x => x[1])
      cur = null
      continue
    }
    if (!cur) continue
    // 有默认值 = 可选（field(default_factory=...) 也算）
    const withDefault = /^ {4}(\w+)\s*:\s*([^=]+?)\s*=\s*.+$/.exec(line)
    if (withDefault) {
      cur.optional.add(withDefault[1])
      continue
    }
    const noDefault = /^ {4}(\w+)\s*:\s*(.+)$/.exec(line)
    if (noDefault) cur.required.add(noDefault[1])
  }
  return { models, literals }
}

// -------------------------------------------------------------- Rust 解析

function snakeToCamel(s) {
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
}

/** 解析 `pub struct X { ... }` / `pub enum X { ... }`（含 serde 属性对必填性的影响）。 */
function parseRust(text) {
  const models = {}
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const head = /^pub (struct|enum) (\w+)\s*\{/.exec(lines[i])
    if (!head) continue
    const kind = head[1]
    const name = head[2]
    const required = new Set()
    const optional = new Set()
    const variants = []
    let pendingDefault = false
    for (i++; i < lines.length && !/^\}/.test(lines[i]); i++) {
      const line = lines[i].trim()
      if (line === '' || line.startsWith('///') || line.startsWith('//')) continue
      if (line.startsWith('#[')) {
        if (/^#\[serde\(/.test(line) && /\bdefault\b/.test(line)) pendingDefault = true
        continue
      }
      if (kind === 'enum') {
        const vm = /^(\w+),?$/.exec(line)
        if (vm) variants.push(vm[1])
        continue
      }
      const fm = /^pub (\w+):\s*(.+?),?$/.exec(line)
      if (!fm) continue
      const isOptional = pendingDefault || /^Option</.test(fm[2])
      if (isOptional) optional.add(snakeToCamel(fm[1]))
      else required.add(snakeToCamel(fm[1]))
      pendingDefault = false
    }
    models[name] = { kind, required, optional, variants }
  }
  return models
}

// ------------------------------------------------- 包形态真实工具 schema

/**
 * 从包形态 TS 源里抽出一个真实注册工具的参数契约：
 * 属性名集合、required、以及每个属性上出现的 enum 取值域。
 */
function parseRealTool(text, toolName) {
  const marker = `name: '${toolName}'`
  const start = text.indexOf(marker)
  if (start < 0) return null
  const nextTool = text.indexOf("name: 'collab_", start + marker.length)
  const seg = text.slice(start, nextTool > 0 ? nextTool : start + 2600)
  const pm = /properties:\s*\{([\s\S]*?)\n\s*required:\s*\[([^\]]*)\]/.exec(seg)
  if (!pm) return null
  const names = [...pm[1].matchAll(/^\s+(\w+):\s*\{/gm)].map(x => x[1])
  const required = [...pm[2].matchAll(/'([^']+)'/g)].map(x => x[1])
  const enums = {}
  for (const nm of names) {
    const em = new RegExp(`${nm}:\\s*\\{[^}]*enum:\\s*\\[([^\\]]*)\\]`).exec(seg)
    if (em) enums[nm] = [...em[1].matchAll(/'([^']+)'/g)].map(x => x[1])
  }
  return { names: new Set(names), required: new Set(required), enums }
}

// ------------------------------------------------------------------ 装载

const rawSchema = load(SCHEMA_PATH)
const rawTs = load(TS_PATH)
const rawPy = load(PY_PATH)
const rawRust = load(RUST_PATH)
const rawIndex = loadToolSchemaSource()

check('SSOT 存在且可读', !rawSchema.error, rawSchema.error)
check('TS 派生产物存在且可读', !rawTs.error, rawTs.error)
check('Python 派生产物存在且可读', !rawPy.error, rawPy.error)
check('Rust 派生产物存在且可读', !rawRust.error, rawRust.error)
check('包形态工具 schema 源存在且可读（src/*.ts，排除动态形态内联副本）', !rawIndex.error, rawIndex.error)

let schema = null
let ts = { ifaces: {}, unions: {} }
let py = { models: {}, literals: {} }
let rust = {}
let realLock = null
let realBoard = null

try {
  schema = JSON.parse(rawSchema.text)
} catch (e) {
  check('SSOT 是合法 JSON', false, e && e.message)
}
try {
  ts = parseTs(rawTs.text)
  check('TS 解析出接口（>0）', Object.keys(ts.ifaces).length > 0, 'no interface parsed')
} catch (e) {
  check('TS 解析', false, e && e.message)
}
try {
  py = parsePython(rawPy.text)
  check('Python 解析出 class（>0）', Object.keys(py.models).length > 0, 'no class parsed')
} catch (e) {
  check('Python 解析', false, e && e.message)
}
try {
  rust = parseRust(rawRust.text)
  check('Rust 解析出 pub struct/enum（>0）', Object.keys(rust).length > 0, 'no pub type parsed')
} catch (e) {
  check('Rust 解析', false, e && e.message)
}
try {
  realLock = parseRealTool(rawIndex.text, 'collab_lock')
  realBoard = parseRealTool(rawIndex.text, 'collab_board')
  check('包形态源里解析出 collab_lock / collab_board 参数', !!realLock && !!realBoard)
} catch (e) {
  check('包形态工具 schema 解析', false, e && e.message)
}

const defs = (schema && schema.$defs) || {}
const EMPTY = { required: new Set(), optional: new Set() }

function eqSets(a, b) {
  if (!a || !b || a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}
function show(set) {
  return set ? [...set].sort().join(',') : '<missing>'
}

// ------------------------------------------- 一、类型字段集：四份产物逐字段相等

// TeamScopeTask / TeamScopeOverlap 是输出侧 advisory 类型（官方 Agent Teams 写域 vs collab_lock 声明），
// 与前面五个模型同为 SSOT 派生，故用同一条逐字段判据。required ∪ optional 已等于 SSOT 的
// properties 全集，属性名集合无需再单独断言。
const TYPES = ['Claim', 'Message', 'Holder', 'StateDocument', 'ConflictInfo', 'TeamScopeTask', 'TeamScopeOverlap']

for (const T of TYPES) {
  const sd = defs[T]
  const sReq = sd && Array.isArray(sd.required) ? new Set(sd.required) : null
  const sAll = sd && sd.properties ? new Set(Object.keys(sd.properties)) : null
  const sOpt = sReq && sAll ? new Set([...sAll].filter(x => !sReq.has(x))) : null

  check(`SSOT 声明 $defs.${T}`, !!sd)
  if (!sd) continue
  check(`SSOT $defs.${T} 有 required`, !!sReq, JSON.stringify(sd.required))
  check(`SSOT $defs.${T} 有 properties`, !!sAll)

  const tsI = ts.ifaces[T] || EMPTY
  const pyM = py.models[T] || EMPTY
  const rsM = rust[T] || EMPTY

  check(`TS 声明 ${T}`, !!ts.ifaces[T])
  check(`Python 声明 ${T}`, !!py.models[T])
  check(`Rust 声明 ${T}`, !!rust[T])

  check(`${T} TS.required == SSOT.required`, eqSets(tsI.required, sReq), `TS=[${show(tsI.required)}] SSOT=[${show(sReq)}]`)
  check(`${T} TS.optional == SSOT.optional`, eqSets(tsI.optional, sOpt), `TS=[${show(tsI.optional)}] SSOT=[${show(sOpt)}]`)
  check(`${T} Python.required == SSOT.required`, eqSets(pyM.required, sReq), `Py=[${show(pyM.required)}] SSOT=[${show(sReq)}]`)
  check(`${T} Python.optional == SSOT.optional`, eqSets(pyM.optional, sOpt), `Py=[${show(pyM.optional)}] SSOT=[${show(sOpt)}]`)
  check(`${T} Rust.required == SSOT.required`, eqSets(rsM.required, sReq), `Rs=[${show(rsM.required)}] SSOT=[${show(sReq)}]`)
  check(`${T} Rust.optional == SSOT.optional`, eqSets(rsM.optional, sOpt), `Rs=[${show(rsM.optional)}] SSOT=[${show(sOpt)}]`)

  // 同一产物内部不得把同一字段既算必填又算可选
  for (const [who, m] of [['TS', tsI], ['Python', pyM], ['Rust', rsM]]) {
    const overlap = [...(m.required || [])].filter(x => m.optional && m.optional.has(x))
    check(`${T} ${who} 必填与可选互斥`, overlap.length === 0, overlap.join(','))
  }
}

// --------------------------------------------------------- 二、Mode 枚举一致

const sMode = defs.Mode && Array.isArray(defs.Mode.enum) ? defs.Mode.enum : null
const tsMode = ts.unions.Mode || null
const pyMode = py.literals.Mode || null
const rsMode = rust.Mode && Array.isArray(rust.Mode.variants) ? rust.Mode.variants.map(v => v.toLowerCase()) : null

check('SSOT $defs.Mode 是枚举', !!sMode, JSON.stringify(defs.Mode))
check('TS Mode 是字符串联合', !!tsMode)
check('Python Mode 是 Literal', !!pyMode)
check('Rust Mode 是 pub enum', !!(rust.Mode && rust.Mode.kind === 'enum'))

for (const [who, val] of [['TS', tsMode], ['Python', pyMode], ['Rust', rsMode]]) {
  check(`Mode 枚举 ${who} == SSOT`, eqSets(val ? new Set(val) : null, sMode ? new Set(sMode) : null),
    `${who}=[${val ? val.join(',') : '<missing>'}] SSOT=[${sMode ? sMode.join(',') : '<missing>'}]`)
}
check("Mode 含 'read'", !!sMode && sMode.includes('read'), `SSOT=[${sMode ? sMode.join(',') : '<missing>'}]`)

// ------------------------- 三、工具参数 $defs 与包形态真实 schema 一致

const TOOLS = [
  { defName: 'colabLockParams', tsName: 'CollabLockParams', pyName: 'OpLock', real: realLock, tool: 'collab_lock' },
  { defName: 'colabBoardParams', tsName: 'CollabBoardParams', pyName: 'OpBoard', real: realBoard, tool: 'collab_board' }
]

for (const t of TOOLS) {
  const d = defs[t.defName]
  check(`SSOT 声明 $defs.${t.defName}`, !!d)
  check(`包形态注册了 ${t.tool}`, !!t.real)
  if (!d) continue

  const sProps = new Set(Object.keys(d.properties || {}))
  const sReq = new Set(d.required || [])
  const sOp = (d.properties && d.properties.op && d.properties.op.enum) || null

  const tsI = ts.ifaces[t.tsName] || EMPTY
  // TS 的 op 取值域：从接口体里 op 字段的类型表达式（字符串字面量联合）解析
  const tsText = rawTs.text || ''
  const tsIfaceMatch = new RegExp(`export interface ${t.tsName}\\s*\\{[\\s\\S]*?\\n\\}`).exec(tsText)
  const tsOpLine = tsIfaceMatch ? /(?:^|\n)\s*op\??:\s*([^;\n]+);/.exec(tsIfaceMatch[0]) : null
  const tsOpVals = tsOpLine ? tsUnionOf(tsOpLine[1]) : null
  const pyOp = py.literals[t.pyName] || null

  check(`${t.defName} SSOT op 是枚举`, !!sOp, JSON.stringify(sOp))
  check(`${t.defName} TS ${t.tsName} 声明`, !!ts.ifaces[t.tsName])
  check(`${t.defName} Python ${t.pyName} 声明`, !!py.literals[t.pyName])

  for (const [who, val] of [['TS', tsOpVals], ['Python', pyOp], [`注册态(${t.tool})`, t.real && t.real.enums.op]]) {
    check(`${t.defName} op 枚举 ${who} == SSOT`, eqSets(val ? new Set(val) : null, sOp ? new Set(sOp) : null),
      `${who}=[${val ? val.join(',') : '<missing>'}] SSOT=[${sOp ? sOp.join(',') : '<missing>'}]`)
  }

  if (t.real) {
    check(`${t.defName} 属性名集合 == 注册态(${t.tool})`, eqSets(sProps, t.real.names),
      `SSOT=[${show(sProps)}] index=[${show(t.real.names)}]`)
    check(`${t.defName} required == 注册态(${t.tool})`, eqSets(sReq, t.real.required),
      `SSOT=[${show(sReq)}] index=[${show(t.real.required)}]`)
  }
  // TS 派生的参数接口同样必须与 SSOT 的属性集合一致
  check(`${t.defName} 属性名集合 == TS ${t.tsName}`,
    eqSets(sProps, new Set([...(tsI.required || [])].concat([...(tsI.optional || [])]))),
    `SSOT=[${show(sProps)}] TS=[${show(new Set([...(tsI.required || [])].concat([...(tsI.optional || [])])))}]`)
}

// ------------------------------------------------------------------ 收尾

for (const f of failures) console.log('FAIL: ' + f)
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
