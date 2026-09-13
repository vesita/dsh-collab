// tests/collab-message-provenance.mjs
// **项目规范的可执行版本**（见 AGENTS.md §1）：**严禁冒充用户**。
//
// 规范的内核不是"禁止一切消息构造"，而是三条：
//   ① 不许造出 `source.kind === 'user'` 的消息（那是冒充真人输入）；
//   ② 不许在没有显式来源（`source` + `plugin` + `form`）的情况下投递消息；
//   ③ 不许在仓库里手抄构造函数副本 —— 必须用真实的 `@deepseek-ai/dsh-llm`。
// 允许的是：经真实构造链、且**来源显式非 user** 的 notice 消息（例如访问通知），
// 由 `agent.inject` 逐事件投递 —— 客户端按 `source.kind !== 'user'` 把它渲染成 notice 行。
//
// 历史教训（别再把这条读成"禁止构造"）：曾经的口径是"一律禁止构造"，逼得访问通知去挤
// `systemPrompt.context`，代价是每次重提**整份运行时快照**、依赖 `systemPrompt` 可用、
// 且通知没有自己的一行。收窄到"禁止冒充"之后既保住了内核，又回到了生态的通行写法。
//
// 运行：node tests/collab-message-provenance.mjs
// 退出码非 0 表示失败。

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0
const failures = []

function check(name, cond, detail) {
  if (cond) {
    passed++
    console.log('  ok  ' + name)
  } else {
    failed++
    failures.push(detail ? `${name} — ${detail}` : name)
    console.log('  FAIL ' + name + (detail ? '  <-- ' + detail : ''))
  }
}

/**
 * 剥掉注释后再匹配：**注释里要能解释"为什么不用它"**，规范管的是代码。
 * 用状态机而不是正则 —— 正则会被字符串里的 `//`（如 `'https://…'`）截断整行，
 * 从而漏掉同一行后面的违规。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += n === undefined ? '' : n; i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
    if (c === '"' || c === "'" || c === '`') quote = c
    out += c
    i++
  }
  return out
}

/** ① 冒充用户：这两样一出现就违规。 */
const FORBIDDEN = [
  { re: /role\s*:\s*['"]user['"]/, why: '手写了 role=user —— 那是冒充真人输入' },
  { re: /kind\s*:\s*['"]user['"]/, why: "source.kind='user' 会让消息渲染成用户气泡（冒充）" }
]

/** ③ 手抄副本：只禁**定义**，不禁调用。 */
const REPLICA_DEFS = [
  { re: /(?:function|const|let|var)\s+createUserMessage\b/, name: 'createUserMessage' },
  { re: /(?:function|const|let|var)\s+createMessage\b/, name: 'createMessage' },
  { re: /(?:function|const|let|var)\s+freezeMessage\b/, name: 'freezeMessage' },
  { re: /(?:function|const|let|var)\s+boundContextSummary\b/, name: 'boundContextSummary' }
]

const SCAN_DIRS = ['src', 'lib']

function scanDir(rel) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return { present: false, files: [] }
  // .d.ts 是类型声明（不是构造），排除。
  const files = readdirSync(abs)
    .filter((f) => f.endsWith('.js') || (f.endsWith('.ts') && !f.endsWith('.d.ts')))
    .sort()
  return { present: true, files }
}

console.log('# 规范：严禁冒充用户（AGENTS.md §1）')

let totalFiles = 0
const constructors = []
for (const dir of SCAN_DIRS) {
  const { present, files } = scanDir(dir)
  if (dir === 'src') {
    check('src/ 存在且含源码文件', present && files.length > 0, present ? 'no .ts files' : 'missing dir')
  } else if (!present || files.length === 0) {
    // 构建产物缺失时**不静默通过** —— 提示先构建，并判失败。
    check('lib/ 存在且含构建产物（先 npm run build）', false, 'missing lib/ —— 不静默跳过')
    continue
  }
  totalFiles += files.length

  for (const f of files) {
    const raw = readFileSync(join(ROOT, dir, f), 'utf8')
    const text = stripComments(raw)
    for (const { re, why } of FORBIDDEN) {
      const m = re.exec(text)
      if (!m) continue
      const line = text.slice(0, m.index).split('\n').length
      check(`${dir}/${f} 不得冒充用户`, false, `${why}（剥注释后第 ${line} 行）`)
    }
    // ③ 只在源码里禁副本定义；lib/ 是产物，副本定义会以同样形态出现，故一并扫。
    for (const { re, name } of REPLICA_DEFS) {
      if (re.test(text)) check(`${dir}/${f} 不得自定义 ${name}（手抄副本）`, false, '必须用真实的 @deepseek-ai/dsh-llm')
    }
    if (/\bcreateUserMessage\s*\(/.test(text)) constructors.push({ dir, f, text })
  }
}

check('扫描覆盖了源码与构建产物', totalFiles > 0, 'no files scanned')

// ② 有构造，就必须有显式来源：source + plugin + form。
//    没有 source 的消息无法被追溯；没有 form 的消息在客户端会退化成 opaque 行。
for (const { dir, f, text } of constructors) {
  const who = `${dir}/${f}`
  check(`${who} 构造消息时带 source`, /\bsource\s*:/.test(text), '缺 source —— 无来源的消息无法追溯')
  check(`${who} source 带 plugin 标签`, /\bplugin\s*:\s*['"]/.test(text), '缺 plugin 标签 —— 来源不可读')
  check(`${who} source 带 form`, /\bform\s*:\s*['"]/.test(text), "缺 form —— 客户端会退化成 opaque 行")
  // notice 必须带 summary，否则 `contextBody` 的 case "notice" 会返回 opaque。
  if (/\bform\s*:\s*['"]notice['"]/.test(text)) {
    check(`${who} form:'notice' 带 summary`, /\bsummary\s*:/.test(text), '缺 summary ⇒ notice 行退化成 opaque')
  }
  // ③ 必须来自真身，而不是某个本地模块。
  const importedFromReal = /from\s+['"]@deepseek-ai\/dsh-llm['"]/.test(text)
  check(`${who} 的构造函数来自 @deepseek-ai/dsh-llm`, importedFromReal, '没有从真身 import —— 可能是本地副本')
}

// 访问通知是当前唯一的构造点：它必须是逐事件投递，而不是又挤回上下文段。
const access = readFileSync(join(ROOT, 'src/access.ts'), 'utf8')
check('访问通知经 agent.inject 逐事件投递', /\.inject\s*\(/.test(access), 'src/access.ts 里找不到 agent.inject')
check('访问通知不再注册 systemPrompt 上下文段', !/systemPrompt/.test(access), 'src/access.ts 里仍有 systemPrompt —— 载体又变了')
check('访问通知的 source 标注为 dsh-collab', /plugin:\s*'dsh-collab'/.test(access), "source.plugin 不是 'dsh-collab'")

check('手抄的消息副本 src/plugin-message.ts 已删除',
  !existsSync(join(ROOT, 'src/plugin-message.ts')), 'src/plugin-message.ts 仍然存在')

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failed} failed`)
if (failed) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(failed === 0 ? 0 : 1)
