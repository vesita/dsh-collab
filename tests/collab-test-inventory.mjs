// tests/collab-test-inventory.mjs
//
// 守护两件事，都**一条命令可判定**：
//   1. `tests/*.mjs` 里的测试文件必须由某个 npm script 真正跑到 —— 没有孤儿；
//   2. README「运行测试」里那份 `node tests/...` 清单与 `npm test` 的命令**逐条同文件、同顺序**。
//
// 为什么需要它：`tests/collab-oracle-liveness.mjs`（408 行 / 12 断言）曾经漏在 `test` 脚本外，
// 于是它断言一个早已整体移除的字段却没人发现 —— 孤儿测试是"看着有覆盖、实际零执行"的静默失效。
//
// 豁免**按命名约定**，不维护名单（名单会腐烂）：
//   · `_*.mjs`   共用脚手架（被 import，不是测试）
//   · `gen-*.mjs` 生成器（人工按需重跑）
// 其余 `tests/*.mjs` 都必须出现在某个 script 的 `node tests/<file>` 里。
//
// 运行：node tests/collab-test-inventory.mjs

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness } from './_harness.mts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 支持 .mjs / .mts / .ts：测试正在从 .mjs 逐步迁移到 TS。
const RUN_RE = /node\s+(tests\/[A-Za-z0-9._-]+\.(?:mjs|mts|ts))/g
const LINE_RE = /^node\s+(tests\/[A-Za-z0-9._-]+\.(?:mjs|mts|ts))/

/** 某个 npm script 命令里按顺序引用的测试文件。 */
const runsIn = (cmd) => [...String(cmd || '').matchAll(RUN_RE)].map(m => m[1])

/**
 * 纯判定：给一份仓库快照，返回全部违规项（不做 IO，便于负向对照直接喂合成快照）。
 * @param {{ files: string[], scripts: Record<string,string>, readme: string }} snap
 *        files: `tests/` 下的文件名（basename）
 * @returns {{ orphans: string[], missing: string[], readmeAhead: string[], readmeBehind: string[] }}
 */
export function auditSuite ({ files, scripts, readme }) {
  const referenced = new Set()
  for (const cmd of Object.values(scripts || {})) for (const f of runsIn(cmd)) referenced.add(f)

  // 1) 孤儿：既不是脚手架/生成器，又没有任何 script 引用它
  const orphans = files
    .filter(f => !f.startsWith('_') && !f.startsWith('gen-'))
    .map(f => 'tests/' + f)
    .filter(f => !referenced.has(f))
    .sort()

  // 2) 悬空引用：script 里 `node tests/x.mjs` 指向磁盘上不存在的文件
  const onDisk = new Set(files.map(f => 'tests/' + f))
  const missing = [...referenced].filter(f => !onDisk.has(f)).sort()

  // 3) README 清单 vs `npm test` 命令：同文件、同顺序（缺一个/顺序不同都算）
  const listed = String(readme).split('\n')
    .map(l => l.trim())
    .filter(l => LINE_RE.test(l))
    .map(l => l.match(LINE_RE)[1])
  const ran = runsIn((scripts || {}).test)
  const readmeAhead = ran.filter((f, i) => listed[i] !== f)  // 脚本有而清单没有/顺序不同
  const readmeBehind = listed.filter((f, i) => ran[i] !== f) // 清单有而脚本没有

  return { orphans, missing, readmeAhead, readmeBehind }
}

const h = createHarness()
const { ok } = h

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const files = readdirSync(path.join(ROOT, 'tests')).filter(f => /\.(?:mjs|mts|ts)$/.test(f)).sort()

console.log('# 1. 仓库现状')
const now = auditSuite({ files, scripts: pkg.scripts, readme })
ok(now.orphans.length === 0,
  '每个 tests/*.mjs 都被某个 npm script 跑到（无孤儿测试）',
  'orphans=' + JSON.stringify(now.orphans))
ok(now.missing.length === 0,
  'script 里的每个 tests/*.mjs 都在磁盘上',
  'missing=' + JSON.stringify(now.missing))
ok(now.readmeAhead.length === 0 && now.readmeBehind.length === 0,
  'README 运行测试清单 = npm test 的命令（同文件同顺序）',
  'README 缺/错序=' + JSON.stringify(now.readmeAhead) + ' README 多=' + JSON.stringify(now.readmeBehind))

console.log('\n# 2. 负向对照（守卫自己必须能红）')

// 2.1 从 test 脚本里摘掉第一条 ⇒ 必须精确点出它
const first = runsIn(pkg.scripts.test)[0]
const dropped = auditSuite({
  files,
  scripts: Object.assign({}, pkg.scripts, { test: String(pkg.scripts.test).replace('node ' + first, '') }),
  readme
})
ok(dropped.orphans.length === 1 && dropped.orphans[0] === first,
  '对照：摘掉 `' + first + '` ⇒ 恰好报出这一个孤儿',
  'orphans=' + JSON.stringify(dropped.orphans))

// 2.2 script 引用一个不存在的文件 ⇒ 必须报悬空引用
const dangling = auditSuite({
  files,
  scripts: Object.assign({}, pkg.scripts, { test: String(pkg.scripts.test) + ' && node tests/collab-no-such-file.mjs' }),
  readme: readme + '\nnode tests/collab-no-such-file.mjs\n'
})
ok(dangling.missing.length === 1 && dangling.missing[0] === 'tests/collab-no-such-file.mjs',
  '对照：script 引用不存在的测试文件 ⇒ 报悬空引用',
  'missing=' + JSON.stringify(dangling.missing))

// 2.3 README 清单漏掉一行 ⇒ 必须报出不一致
const drift = auditSuite({
  files,
  scripts: pkg.scripts,
  readme: readme.split('\n').filter(l => !l.startsWith('node ' + first)).join('\n')
})
ok(drift.readmeAhead.length > 0 || drift.readmeBehind.length > 0,
  '对照：README 清单漏掉 `' + first + '` ⇒ 报清单与脚本不一致',
  'ahead=' + JSON.stringify(drift.readmeAhead) + ' behind=' + JSON.stringify(drift.readmeBehind))

h.finish()
