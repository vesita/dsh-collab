import { createHarness, skippedOrRejected, loadCosmokit } from './_harness.mjs'

// collab-skill-real.mjs
// 委托纪律（随包 skill + 常驻 PromptContext + dsh-collab 偏好设置）的**真实服务**端到端测试。
//
// 前置条件（本文件不是 `npm test` 的一部分，因为不是每台机器都装了 dsh）：
//   - 本机存在一份 dsh 部署，且以下三个包可从其 node_modules 解析：
//       <deploy>/@deepseek-ai/cordis
//       <deploy>/@deepseek-ai/dsh-skill
//   - 部署 node_modules 的根用 `DSH_DEPLOY_NODE_MODULES` 指定；
//     未设置时退回到本机默认路径（/usr/lib/node_modules/@deepseek-ai/dsh/node_modules）。
//   - 插件从**本仓库自己的构建产物**加载（默认 ../lib/index.js，可用
//     `DSH_COLLAB_PLUGIN_ENTRY` 覆盖，便于对打包产物做同样一遍验证）。
//   - 找不到部署或构建产物时**默认按失败退出（exit 1）**——"没跑"不伪装成"通过"。
//     只有显式 `COLLAB_ALLOW_SKIP=1` 才放行（exit 0），并打印含"未验证"字样的横幅。
//     运行方式：`node tests/collab-skill-real.mjs`（需先 npm run build）。
//
// 为什么单独存在：tests/collab-skill.mjs 的断言全部基于**假**服务，只验证本插件自己的契约；
// 真实的 SkillRegistry 目录与**真实 cordis 的 Config 校验/volatile 引用**如果被改坏，
// 那些断言仍会全绿。本文件用真实部署的 SkillRegistry + 真实 cordis 覆盖这条缝：
//   - 偏好默认开 → 真实 skill 目录里能看到随包 skill，正文与磁盘逐字节一致；
//   - 改偏好走 **Loader 的 volatile 通道**（cosmokit 的 updateVolatile）→ skill 从真实目录
//     消失、上下文撤销（证明**活读**，不是 apply 时缓存）→ 改回来又出现；
//   - 卸载插件 → skill 与上下文都撤销，重新装载能再装一次。
//
// 0.11.0 说明：0.1.7 起偏好不再是"插件注册一个 settings 命名空间"，而是**插件自己的 Config**
// （见 README「偏好设置」与 backlog §2.22）。所以本文件不再依赖 `@deepseek-ai/dsh-settings-file`
// （该包在 0.1.7 已被 dsh-settings 取代、且不再提供 installSection）——旧版的 settings 断言
// 随那次迁移失效，这里改为直接验证"真实 cordis 按 Config schema 生成 volatile 引用 + 活读"。
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
const { updateVolatile } = await loadCosmokit()
const plugin = (await import(PLUGIN_ENTRY)).default

const SKILL_PATH = path.join(ROOT, '../skills/subagent-delegation/SKILL.md')

// 本测试自己建、自己删的临时目录（不放任何外部路径）。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-skill-real-'))

const h = createHarness()
const { ok } = h
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

const contexts = new Map()
const contextDisposals = []

try {
  const root = new Context()
  await root.plugin(SkillRegistry)
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

  ok(!!root.get('skills') && typeof root.get('skills').register === 'function', 'real skills service is live')

  // 普通值交给真实 cordis：它按插件默认导出的 Config schema 校验并生成 volatile 引用
  // （与线上 Loader 同一条路；测试**不**手工造 {get,set}）。
  const CONFIG = { exposeDelegationDiscipline: true, enforceWriteLock: true, releaseOnLoopEnd: true, loopEndGraceSec: 120 }
  const fiber = await root.plugin(plugin, Object.assign({}, CONFIG))
  await settle()
  const setPref = (value) => {
    updateVolatile(fiber.config.exposeDelegationDiscipline, { get: () => value })
    root.emit('loader/volatile-update', [['exposeDelegationDiscipline']])
  }

  const names = async () => (await root.get('skills').list()).map((s) => s.name)
  ok((await names()).includes('subagent-delegation'), 'default (ON) -> skill is in the real skill catalog', JSON.stringify(await names()))
  ok(contexts.has('dsh-collab/delegation'), 'default (ON) -> discipline PromptContext registered')
  ok(!!fiber.config && !!fiber.config.exposeDelegationDiscipline && typeof fiber.config.exposeDelegationDiscipline.get === 'function',
    '真实 cordis 按 Config schema 把普通值换成了 volatile 引用（插件页配置卡片的前置条件）',
    JSON.stringify(fiber.config && Object.keys(fiber.config)))
  ok(fiber.config.exposeDelegationDiscipline.get() === true, '引用读出来就是 profile 里那个普通值')

  // —— 用户在插件页里关掉它：走 Loader 的 volatile 通道（与线上同一条）——
  setPref(false)
  await settle(250)
  ok(!(await names()).includes('subagent-delegation'), 'update(false) -> skill withdrawn from the real catalog (live read)', JSON.stringify(await names()))
  ok(!contexts.has('dsh-collab/delegation'), 'update(false) -> discipline PromptContext withdrawn')
  ok(contextDisposals.includes('dsh-collab/delegation'), 'update(false) went through the real onChange hook', contextDisposals.join(','))

  setPref(true)
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
  // 重新装载能再装一次（skill 名与上下文名都必须已释放，否则第二次会撞名/报重复注册）
  const again = await root.plugin(plugin, Object.assign({}, CONFIG))
  await settle(250)
  ok((await names()).includes('subagent-delegation'), 're-mount re-registers the skill cleanly')
  ok(contexts.has('dsh-collab/delegation'), 're-mount re-registers the discipline PromptContext')
  await again.dispose()
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

h.finish()
