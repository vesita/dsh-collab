import { createHarness, skippedOrRejected } from './_harness.mjs'

// collab-skill-real.mjs
// 委托纪律（随包 skill + 常驻 PromptContext + dsh-collab 偏好设置）的**真实服务**端到端测试。
//
// 前置条件（本文件不是 `npm test` 的一部分，因为不是每台机器都装了 dsh）：
//   - 本机存在一份 dsh 部署，且以下三个包可从其 node_modules 解析：
//       <deploy>/@deepseek-ai/cordis
//       <deploy>/@deepseek-ai/dsh-skill
//       <deploy>/@deepseek-ai/dsh-settings-file
//   - 部署 node_modules 的根用 `DSH_DEPLOY_NODE_MODULES` 指定；
//     未设置时退回到本机默认路径（/usr/lib/node_modules/@deepseek-ai/dsh/node_modules）。
//   - 插件从**本仓库自己的构建产物**加载（默认 ../lib/index.js，可用
//     `DSH_COLLAB_PLUGIN_ENTRY` 覆盖，便于对打包产物做同样一遍验证）。
//   - 找不到部署或构建产物时**默认按失败退出（exit 1）**——"没跑"不伪装成"通过"。
//     只有显式 `COLLAB_ALLOW_SKIP=1` 才放行（exit 0），并打印含"未验证"字样的横幅。
//     运行方式：`node tests/collab-skill-real.mjs`（需先 npm run build）。
//
// 为什么单独存在：tests/collab-skill.mjs 的 57 条断言全部基于**假** settings 服务，
// 只验证本插件自己的契约；真实 `installSection` 的 setSource/onChange 接线与真实
// skill 目录如果被改坏，那些断言仍会全绿。本文件用真实的
// FileSettingsProvider + SkillRegistry 覆盖这条缝：偏好默认开 → 真实目录里能看到 skill；
// 走真实持久化路径 update(false) → skill 从真实目录消失、上下文撤销（证明**活读**，非
// apply 时缓存）；update(true) → 回来；卸载插件 → 命名空间释放、可重新挂载。
//
// 运行：node tests/collab-skill-real.mjs

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const DEFAULT_DEPLOY = '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules'
const DEPLOY = process.env.DSH_DEPLOY_NODE_MODULES || DEFAULT_DEPLOY
const PLUGIN_ENTRY = process.env.DSH_COLLAB_PLUGIN_ENTRY || path.join(ROOT, '../lib/index.js')

// 先做可解析性判断，再 import：缺部署时必须是"跳过"，不是"失败"。
const REQUIRED = [
  path.join(DEPLOY, '@deepseek-ai/cordis/lib/index.js'),
  path.join(DEPLOY, '@deepseek-ai/dsh-skill/lib/index.js'),
  path.join(DEPLOY, '@deepseek-ai/dsh-settings-file/lib/index.js')
]
const missing = REQUIRED.filter((p) => !fs.existsSync(p))
if (missing.length) {
  // ⑷ 跳过默认是**失败**：只有 COLLAB_ALLOW_SKIP=1 显式放行才以 0 退出（并打"未验证"横幅）。
  if (skippedOrRejected('no dsh deployment at ' + DEPLOY)) {
    // skippedOrRejected 已打过"未验证"横幅 + 一行 `SKIPPED: …`，这里只补上下文。
    console.log('  set DSH_DEPLOY_NODE_MODULES to a dsh deployment node_modules directory to run this test')
    for (const p of missing) console.log('  missing: ' + p)
    process.exit(0)
  }
  console.log('FAILED: no dsh deployment at ' + DEPLOY + '（未验证即失败；设 COLLAB_ALLOW_SKIP=1 才放行）')
  for (const p of missing) console.log('  missing: ' + p)
  process.exit(1)
}
if (!fs.existsSync(PLUGIN_ENTRY)) {
  const why = 'plugin build output missing at ' + PLUGIN_ENTRY + ' (run npm run build first)'
  if (skippedOrRejected(why)) {
    process.exit(0)
  }
  console.log('FAILED: ' + why + '（未验证即失败；设 COLLAB_ALLOW_SKIP=1 才放行）')
  process.exit(1)
}

const { Context } = await import(path.join(DEPLOY, '@deepseek-ai/cordis/lib/index.js'))
const { default: SkillRegistry } = await import(path.join(DEPLOY, '@deepseek-ai/dsh-skill/lib/index.js'))
const { default: FileSettingsProvider } = await import(path.join(DEPLOY, '@deepseek-ai/dsh-settings-file/lib/index.js'))
const plugin = (await import(PLUGIN_ENTRY)).default

const SKILL_PATH = path.join(ROOT, '../skills/subagent-delegation/SKILL.md')

const h = createHarness()
const { ok } = h
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

// 临时设置文档：本测试自己建、自己删，不依赖任何外部路径。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-skill-real-'))
const settingsPath = path.join(tmpDir, 'settings.yaml')

const contexts = new Map()
const contextDisposals = []

try {
  const root = new Context()
  await root.plugin(SkillRegistry)
  await root.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
  await settle(250)
  root.provide('tools'); root.provide('timer'); root.provide('fs'); root.provide('systemPrompt')
  root.set('tools', { register: () => () => {} })
  root.set('timer', { timeout: () => Promise.resolve(), interval: () => () => {} })
  root.set('fs', {
    resolve: async (p) => ({ displayPath: p, path: p }),
    stat: async () => null,
    readText: async () => '',
    writeText: async () => {},
    processPath: (t) => t.path
  })
  root.set('systemPrompt', {
    context: (c) => {
      contexts.set(c.name, c)
      return () => {
        contextDisposals.push(c.name)
        if (contexts.get(c.name) === c) contexts.delete(c.name)
      }
    }
  })

  ok(!!root.get('settings') && typeof root.get('settings').update === 'function', 'real settings service is live')
  ok(!!root.get('skills') && typeof root.get('skills').register === 'function', 'real skills service is live')

  const fiber = await root.plugin(plugin)
  await settle()

  const names = async () => (await root.get('skills').list()).map((s) => s.name)
  ok((await names()).includes('subagent-delegation'), 'default (ON) -> skill is in the real skill catalog', JSON.stringify(await names()))
  ok(contexts.has('dsh-collab/delegation'), 'default (ON) -> discipline PromptContext registered')
  ok(root.get('settings').describe().some((d) => d.ns === 'dsh-collab'), 'settings namespace dsh-collab is registered', JSON.stringify(root.get('settings').describe().map((d) => d.ns)))

  // —— 用户在设置面板里关掉它：走真实持久化路径 settings.update ——
  await root.get('settings').update('dsh-collab', { exposeDelegationDiscipline: false })
  await settle(250)
  ok(!(await names()).includes('subagent-delegation'), 'update(false) -> skill withdrawn from the real catalog (live read)', JSON.stringify(await names()))
  ok(!contexts.has('dsh-collab/delegation'), 'update(false) -> discipline PromptContext withdrawn')
  ok(contextDisposals.includes('dsh-collab/delegation'), 'update(false) went through the real onChange hook', contextDisposals.join(','))

  await root.get('settings').update('dsh-collab', { exposeDelegationDiscipline: true })
  await settle(250)
  ok((await names()).includes('subagent-delegation'), 'update(true) -> skill back in the catalog', JSON.stringify(await names()))
  ok(contexts.has('dsh-collab/delegation'), 'update(true) -> discipline PromptContext back')

  const def = await root.get('skills').get('subagent-delegation')
  const diskBody = fs.readFileSync(SKILL_PATH, 'utf8')
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(diskBody)
  ok(!!def && def.content === diskBody.slice(m[0].length), 'real catalog body matches the shipped file byte-for-byte')
  ok(!!def && def.source === 'bundled' && def.provider === 'dsh-collab', 'real catalog reports bundled/dsh-collab', def && (def.source + '/' + def.provider))
  ok(!!def && def.resourceBase && def.resourceBase.kind === 'directory' && fs.existsSync(def.resourceBase.path), 'real catalog resourceBase directory exists', def && JSON.stringify(def.resourceBase))

  await fiber.dispose()
  await settle(250)
  ok(!(await names()).includes('subagent-delegation'), 'plugin unload -> skill removed from the real catalog')
  ok(!contexts.has('dsh-collab/delegation'), 'plugin unload -> discipline PromptContext removed')
  ok(!root.get('settings').describe().some((d) => d.ns === 'dsh-collab'), 'plugin unload -> settings namespace released (re-registerable)', JSON.stringify(root.get('settings').describe().map((d) => d.ns)))

  // 命名空间确实被释放：重新装载能再装一次（否则 installSection 会抛 already registered）
  const again = await root.plugin(plugin)
  await settle(250)
  ok(root.get('settings').describe().some((d) => d.ns === 'dsh-collab'), 're-mount re-installs the settings namespace cleanly')
  await again.dispose()
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

h.finish()
