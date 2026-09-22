import { createHarness } from './_harness.mjs'

// collab-skill.mjs
// 随包发布的 subagent-delegation skill + 委托纪律常驻上下文 + 偏好设置的回归测试。
//
// 机制：
//   - 包形态在 apply 里按 import.meta.url 定位 ../skills/subagent-delegation/SKILL.md 读一次（结果缓存）；
//   - skill 与常驻 PromptContext 都**只**在偏好 exposeDelegationDiscipline（默认 true）为真时注册；
//   - 0.1.7 起偏好就是插件**自己的 Config**：`.volatile()` 字段是稳定引用，Loader 就地更新引用
//     内容并发 `loader/volatile-update`（插件不重载），所以设置里一改就重新结算；
//   - Config 的 volatile 字段缺省 / Config 整个缺席（没有 Loader 的迷你宿主）/ 文件缺失 /
//     解析失败，一律静默降级到 schema 默认值；
//   - 注册与上下文都走 ctx.effect，卸载插件即撤销。
//
// 本测试用假 ctx 捕获 register 入参、PromptContext，断言：
//   (a) 随包文件存在且 frontmatter 可解析（name/description/whenToUse 正确）；
//   (b) 偏好开：skill 恰好注册一次、内容与磁盘逐字一致、resourceBase 指向真实目录；
//   (c) 偏好开：第二个 PromptContext（dsh-collab/delegation, order 131）注册，文本**常量**且无数字；
//   (d) 偏好关：skill 与上下文都不注册，collab_lock 照旧注册；
//   (e) 没有 Config：插件照常装载、按 schema 默认值（开）注册、不抛；
//   (f) 偏好在运行时由 true 翻到 false（不重启）：skill 与上下文都被撤回；
//   (g) 卸载插件：skill 注册与上下文注册的 disposer 都被调用（可逆）。
//
// 运行：node tests/collab-skill.mjs

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const cordis = await import('@deepseek-ai/cordis').catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
const { Context } = cordis

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const SKILL_PATH = path.join(ROOT, '../skills/subagent-delegation/SKILL.md')
const SKILL_DIR = path.dirname(SKILL_PATH)
const collabPlugin = (await import(path.join(ROOT, '../lib/index.js'))).default
const { Config, DELEGATION_SETTINGS_ENTRY } = await import(path.join(ROOT, '../lib/index.js'))

const h = createHarness()
const { ok } = h

// 不要把状态写到真实的 ~/.dsh；也确保包形态的总开关处于默认（开）。
process.env.DSH_HOME = path.join(os.tmpdir(), 'collab-skill-' + process.pid)
delete process.env.DSH_COLLAB_NO_PROMPT_HINT
const settle = () => new Promise((r) => setTimeout(r, 30))

/**
 * 把一份普通配置包装成 Loader 交给插件的形态：`.volatile()` 字段是**稳定引用**
 * （`{ get() }`），与 `cordis-plugin-loader` 的 `_commitVolatile` 同形。
 */
function makeConfig(initial) {
  const refs = {}
  for (const [key, value] of Object.entries(initial)) {
    const box = { current: value }
    refs[key] = { get: () => box.current, set: (next) => { box.current = next } }
  }
  return refs
}

/** 按 Loader 的 volatile 通道改字段：更新引用内容 + 把路径发给插件（模拟用户在设置里改）。 */
function writeConfig(fiber, ctx, patch) {
  const paths = []
  for (const key of Object.keys(patch)) {
    fiber.config[key].set(patch[key])
    paths.push([key])
  }
  ctx.emit('loader/volatile-update', paths)
}

/** 把一份解析后的 Config 摊平成普通值：volatile 字段取 `.get()`（官方 `plainOptions()` 同款）。 */
function plainConfig(config) {
  const out = {}
  for (const [key, value] of Object.entries(config || {})) {
    out[key] = value && typeof value.get === 'function' ? value.get() : value
  }
  return out
}

/** 统一的假 ctx：记录工具、PromptContext、skills 注册。 */
function makeCtx(opts = {}) {
  // contexts 是"当前活着的上下文"（dispose 时删除该 name），contextDisposals 记录每次撤销。
  const captured = { tools: [], contexts: new Map(), contextDisposals: [], regs: [], liveRegs: 0, skillDisposed: 0 }
  const ctx = new Context()
  const names = ['tools', 'timer', 'fs']
  if (opts.skills) names.push('skills')
  if (opts.systemPrompt) names.push('systemPrompt')
  for (const n of names) ctx.provide(n)
  ctx.set('tools', { register: (t) => { captured.tools.push(t); return () => {} } })
  ctx.set('timer', { timeout: () => Promise.resolve(), interval: () => () => {} })
  ctx.set('fs', {
    resolve: async (p) => ({ displayPath: p, path: p }),
    stat: async () => null,
    readText: async () => '',
    writeText: async () => {},
    processPath: (t) => t.path
  })
  if (opts.skills) {
    ctx.set('skills', {
      register: (s) => {
        captured.regs.push(s)
        captured.liveRegs++
        return () => { captured.liveRegs--; captured.skillDisposed++ }
      }
    })
  }
  if (opts.systemPrompt) {
    ctx.set('systemPrompt', {
      context: (c) => {
        captured.contexts.set(c.name, c)
        return () => {
          captured.contextDisposals.push(c.name)
          if (captured.contexts.get(c.name) === c) captured.contexts.delete(c.name)
        }
      }
    })
  }
  if (opts.settings) ctx.set('settings', opts.settings.service)
  return { ctx, captured }
}

console.log('# (a) the shipped skill file exists and its frontmatter parses')
ok(fs.existsSync(SKILL_PATH), 'skills/subagent-delegation/SKILL.md exists', SKILL_PATH)
const raw = fs.readFileSync(SKILL_PATH, 'utf8')
// 测试自己独立解析一遍（刻意不复用 lib 里的解析器），避免"用被测代码验证被测代码"。
const fm = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
ok(!!fm, 'file opens with a --- frontmatter block')
const fmLines = fm ? fm[1].split(/\r?\n/) : []
const field = (k) => {
  const line = fmLines.find((l) => l.startsWith(k + ':'))
  return line ? line.slice(k.length + 1).trim() : ''
}
const diskName = field('name')
const diskDescription = field('description')
const diskWhenToUse = field('whenToUse')
const diskBody = fm ? raw.slice(fm[0].length) : ''
ok(diskName === 'subagent-delegation', "frontmatter name === 'subagent-delegation'", diskName)
ok(diskDescription.length > 0, 'frontmatter description is non-empty', diskDescription)
ok(diskWhenToUse.length > 0, 'frontmatter whenToUse is non-empty', diskWhenToUse)
ok(diskBody.length > 1000, 'body after frontmatter is non-trivial', String(diskBody.length))

// ---------------------------------------------------------------------------
console.log('# (b)(c)(g) preference ON (explicit true): skill + constant discipline context, both reversible')
{
  const config = makeConfig({ exposeDelegationDiscipline: true, enforceWriteLock: true, releaseOnLoopEnd: true, loopEndGraceSec: 120 })
  const { ctx, captured } = makeCtx({ skills: true, systemPrompt: true })
  const fiber = await ctx.plugin(collabPlugin, config)
  await settle()

  const reg = captured.regs[0]
  ok(captured.regs.length === 1, 'plugin calls skills.register exactly once', 'calls=' + captured.regs.length)
  ok(!!reg && reg.name === diskName, 'registered name matches the frontmatter on disk', String(reg && reg.name))
  ok(!!reg && reg.description === diskDescription, 'registered description matches the frontmatter on disk')
  ok(!!reg && reg.whenToUse === diskWhenToUse, 'registered whenToUse matches the frontmatter on disk')
  ok(!!reg && typeof reg.content === 'string', 'registered content is a real string')
  ok(!!reg && reg.content === diskBody, 'registered content is byte-for-byte the body on disk', 'len=' + String(reg && reg.content.length))
  ok(!!reg && reg.content.length > 1000, 'registered content has a non-trivial body length', String(reg && reg.content.length))
  ok(!!reg && reg.source === 'bundled', "source is 'bundled'", String(reg && reg.source))
  ok(!!reg && reg.provider === 'dsh-collab', "provider is 'dsh-collab'", String(reg && reg.provider))
  ok(!!reg && reg.path === SKILL_PATH, 'registered path is the shipped SKILL.md', String(reg && reg.path))
  ok(!!reg && !!reg.invocation && reg.invocation.modelInvocable === true && reg.invocation.userInvocable === true,
    'invocation allows both model and user surfaces', JSON.stringify(reg && reg.invocation))
  const rb = reg && reg.resourceBase
  ok(!!rb && rb.kind === 'directory', "resourceBase kind is 'directory'", JSON.stringify(rb))
  ok(!!rb && rb.path === SKILL_DIR, 'resourceBase points at the shipped skill directory', String(rb && rb.path))
  ok(!!rb && fs.existsSync(rb.path) && fs.statSync(rb.path).isDirectory(), 'resourceBase directory exists on disk', String(rb && rb.path))
  ok(fs.existsSync(path.join(SKILL_DIR, 'SKILL.md')), 'resourceBase directory really holds SKILL.md')

  const discipline = captured.contexts.get('dsh-collab/delegation')
  ok(!!discipline, 'a second PromptContext is registered when the preference is on', [...captured.contexts.keys()].join(','))
  ok(!!discipline && discipline.name === 'dsh-collab/delegation', 'discipline context name is dsh-collab/delegation')
  ok(!!discipline && discipline.order === 131, 'discipline context order is 131 (distinct from awareness 130)', String(discipline && discipline.order))
  ok(!!discipline && typeof discipline.text === 'function', 'discipline context text is a provider function')
  if (discipline && typeof discipline.text === 'function') {
    const t1 = discipline.text()
    const t2 = discipline.text()
    ok(typeof t1 === 'string' && t1.length > 0, 'discipline text is a non-empty string')
    ok(t1 === t2, 'discipline text is CONSTANT across calls (byte-identical)', JSON.stringify([t1, t2]))
    ok(!/[0-9]/.test(t1), 'discipline text contains no digits that could drift', t1)
    ok(t1.includes('[dsh-collab]'), 'discipline text carries the [dsh-collab] marker', t1)
    ok(/子代理/.test(t1) && /验收/.test(t1) && /原始输出/.test(t1), 'discipline text states the delegation + acceptance + raw-evidence rules', t1)
    ok(!/租约|剩 \d|expires/.test(t1), 'discipline text does not duplicate the awareness digest job', t1)
  }

  // 0.1.7 起偏好不再是插件自建的 settings section，而是**插件自己的 Config**：
  // 断言因此落在 Config 解析出的默认值上（判据没有放松 —— 字段集合仍被钉死成恰好四个，
  // 任何一个默认值没落对都会 FAIL），以及 Config 缺席时插件仍在、仍注册。
  //
  // 注意：`.volatile()` 字段是**引用**（`{ get() }`），所以默认值要经 `plainConfig()` 取出；
  // 直接 JSON 比对会看到 `{}` 这种被剥掉方法的空壳（那正是"schemastery 把引用序列化没了"）。
  const parsedDefaults = plainConfig(Config['~standard'].validate({}).value)
  ok(parsedDefaults.exposeDelegationDiscipline === true,
    'Config schema defaults exposeDelegationDiscipline to true', JSON.stringify(parsedDefaults))
  ok(parsedDefaults.enforceWriteLock === true,
    'Config schema defaults enforceWriteLock to true (write protection defaults ON)', JSON.stringify(parsedDefaults))
  ok(parsedDefaults.releaseOnLoopEnd === true,
    'Config schema defaults releaseOnLoopEnd to true (循环终止自动释放默认开)', JSON.stringify(parsedDefaults))
  ok(parsedDefaults.loopEndGraceSec === 120,
    'Config schema defaults loopEndGraceSec to 120 (宽限期 120 秒，0.9.11 从 15 调长)', JSON.stringify(parsedDefaults))
  ok(Object.keys(parsedDefaults).sort().join(',') === 'enforceWriteLock,exposeDelegationDiscipline,loopEndGraceSec,releaseOnLoopEnd',
    'Config schema exposes exactly the four known fields', Object.keys(parsedDefaults).join(','))
  ok(DELEGATION_SETTINGS_ENTRY.exposeDelegationDiscipline === true,
    'composition entry (fallback when Config detach) is true')
  ok(DELEGATION_SETTINGS_ENTRY.enforceWriteLock === true,
    'composition entry defaults enforceWriteLock to true as well')
  ok(DELEGATION_SETTINGS_ENTRY.releaseOnLoopEnd === true && DELEGATION_SETTINGS_ENTRY.loopEndGraceSec === 120,
    'composition entry defaults 循环终止自动释放 to ON / 120s', JSON.stringify(DELEGATION_SETTINGS_ENTRY))

  ok(captured.liveRegs === 1, 'exactly one live skill registration before unload', 'live=' + captured.liveRegs)
  ok(captured.contexts.has('dsh-collab/delegation'), 'the discipline context is live before unload')
  await fiber.dispose()
  await settle()
  ok(captured.skillDisposed === 1 && captured.liveRegs === 0, 'unloading the plugin calls the skill registration disposer', 'disposed=' + captured.skillDisposed + ' live=' + captured.liveRegs)
  ok(captured.contextDisposals.filter((n) => n === 'dsh-collab/delegation').length === 1,
    'unloading the plugin calls the discipline PromptContext disposer', captured.contextDisposals.join(','))
  ok(!captured.contexts.has('dsh-collab/delegation'), 'the discipline context is gone after unload')
}

// ---------------------------------------------------------------------------
console.log('# (d) preference OFF: neither skill nor discipline context is registered; collab_lock remains')
{
  const config = makeConfig({ exposeDelegationDiscipline: false, enforceWriteLock: true, releaseOnLoopEnd: true, loopEndGraceSec: 120 })
  const { ctx, captured } = makeCtx({ skills: true, systemPrompt: true })
  let threw = null
  try { await ctx.plugin(collabPlugin, config) } catch (e) { threw = e }
  await settle()

  ok(threw === null, 'plugin loads with the preference off (no throw)', threw && String(threw.message))
  ok(captured.regs.length === 0, 'no skill is registered when the preference is off', 'calls=' + captured.regs.length)
  ok(!captured.contexts.has('dsh-collab/delegation'), 'no discipline PromptContext when the preference is off', [...captured.contexts.keys()].join(','))
  ok(captured.tools.map((t) => t.name).includes('collab_lock'), 'collab_lock is still registered when the preference is off')
  ok(captured.tools.map((t) => t.name).includes('collab_board'), 'collab_board is still registered when the preference is off')
}

// ---------------------------------------------------------------------------
console.log('# (e) Config ABSENT: plugin loads, defaults to ON, nothing throws')
{
  const { ctx, captured } = makeCtx({ skills: true, systemPrompt: true })
  let threw = null
  try { await ctx.plugin(collabPlugin) } catch (e) { threw = e }
  await settle()

  ok(threw === null, 'plugin loads without a Config (no throw)', threw && String(threw.message))
  ok(captured.regs.length === 1, 'no Config -> schema default true -> skill registered', 'calls=' + captured.regs.length)
  ok(captured.contexts.has('dsh-collab/delegation'), 'no Config -> schema default true -> discipline context registered')
  ok(captured.tools.map((t) => t.name).includes('collab_lock'), 'collab_lock is still registered without a Config')
}

// ---------------------------------------------------------------------------
console.log('# (f) the flag is read LIVE: flipping true -> false at runtime withdraws both, with no restart')
{
  const config = makeConfig({ exposeDelegationDiscipline: true, enforceWriteLock: true, releaseOnLoopEnd: true, loopEndGraceSec: 120 })
  const { ctx, captured } = makeCtx({ skills: true, systemPrompt: true })
  const fiber = await ctx.plugin(collabPlugin, config)
  await settle()
  ok(captured.liveRegs === 1 && captured.contexts.has('dsh-collab/delegation'), 'both exposed while the preference is on')

  writeConfig(fiber, ctx, { exposeDelegationDiscipline: false }) // 模拟用户在设置里改
  await settle()
  ok(captured.skillDisposed === 1 && captured.liveRegs === 0, 'flipping off calls the skill disposer', 'disposed=' + captured.skillDisposed + ' live=' + captured.liveRegs)
  ok(!captured.contexts.has('dsh-collab/delegation'), 'flipping off withdraws the context')

  writeConfig(fiber, ctx, { exposeDelegationDiscipline: true }) // 再翻回来
  await settle()
  ok(captured.regs.length === 2 && captured.liveRegs === 1, 'flipping back on re-registers the skill', 'calls=' + captured.regs.length + ' live=' + captured.liveRegs)
  ok(captured.contexts.has('dsh-collab/delegation'), 'flipping back on re-registers the context')
}

// ---------------------------------------------------------------------------
console.log('# degradation: missing skill file / broken services cannot break plugin load')
{
  let threw = null
  const { ctx, captured } = makeCtx({ systemPrompt: true })
  ctx.provide('skills')
  // skills 在、但 register 抛错：附加能力失败不得影响产品工具。
  ctx.set('skills', { register: () => { throw new Error('skill registry exploded') } })
  const config = makeConfig({ exposeDelegationDiscipline: true, enforceWriteLock: true, releaseOnLoopEnd: true, loopEndGraceSec: 120 })
  try { await ctx.plugin(collabPlugin, config) } catch (e) { threw = e }
  await settle()
  ok(threw === null, 'a throwing skills.register does not break plugin load', threw && String(threw.message))
  ok(captured.tools.map((t) => t.name).includes('collab_lock'), 'collab_lock survives a throwing skills.register')
}

h.finish()
