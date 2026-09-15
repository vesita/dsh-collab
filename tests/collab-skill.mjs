import { createHarness } from './_harness.mjs'

// collab-skill.mjs
// 随包发布的 subagent-delegation skill + 委托纪律常驻上下文 + dsh-collab 偏好设置的回归测试。
//
// 机制：
//   - 包形态在 apply 里按 import.meta.url 定位 ../skills/subagent-delegation/SKILL.md 读一次（结果缓存）；
//   - skill 与常驻 PromptContext 都**只**在偏好 exposeDelegationDiscipline（settings 命名空间 dsh-collab，
//     默认 true）为真时注册；
//   - 偏好的值通过 settings.installSection 的 setSource 回调**活读**（缓存的是读取器，不是值），
//     所以设置面板里一改，onChange 触发重新结算，无需重启；
//   - settings 是可选服务：缺失 / installSection 不可用 / 文件缺失 / 解析失败都静默降级；
//   - 注册与上下文都走 ctx.effect，卸载插件即撤销。
//
// 本测试用假 ctx 捕获 register 入参、PromptContext 与 settings hooks，断言：
//   (a) 随包文件存在且 frontmatter 可解析（name/description/whenToUse 正确）；
//   (b) 偏好开：skill 恰好注册一次、内容与磁盘逐字一致、resourceBase 指向真实目录；
//   (c) 偏好开：第二个 PromptContext（dsh-collab/delegation, order 131）注册，文本**常量**且无数字；
//   (d) 偏好关：skill 与上下文都不注册，collab_lock 照旧注册；
//   (e) settings 服务缺失：插件照常装载、按默认值（开）注册、不抛；
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

const h = createHarness()
const { ok } = h

// 不要把状态写到真实的 ~/.dsh；也确保包形态的总开关处于默认（开）。
process.env.DSH_HOME = path.join(os.tmpdir(), 'collab-skill-' + process.pid)
delete process.env.DSH_COLLAB_NO_PROMPT_HINT
const settle = () => new Promise((r) => setTimeout(r, 30))

/**
 * 假 settings 服务：只实现 installSection 的对外契约——
 * 交出**实时**读取器 setSource(() => 当前值)，值变化时回调 onChange。
 * 测试用 set() 模拟"用户在设置面板里改动"。
 */
function makeSettings(initial) {
  let value = Object.assign({}, initial)
  let hooks = null
  const installed = []
  const service = {
    installSection: (owner, ns, schema, entry, h) => {
      installed.push({ owner, ns, schema, entry })
      hooks = h
      h.setSource(() => value)
      h.onChange()
    }
  }
  return {
    service,
    installed,
    set(patch) {
      value = Object.assign({}, value, patch)
      if (hooks) hooks.onChange() // 真实 installSection 在 scope.watch 里就是这么回调的
    },
    current: () => value
  }
}

/** 统一的假 ctx：记录工具、PromptContext、skills 注册。 */
function makeCtx(opts = {}) {
  // contexts 是"当前活着的上下文"（dispose 时删除该 name），contextDisposals 记录每次撤销。
  const captured = { tools: [], contexts: new Map(), contextDisposals: [], regs: [], liveRegs: 0, skillDisposed: 0 }
  const ctx = new Context()
  const names = ['tools', 'timer', 'fs']
  if (opts.skills) names.push('skills')
  if (opts.systemPrompt) names.push('systemPrompt')
  if (opts.settings) names.push('settings')
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
  const settings = makeSettings({ exposeDelegationDiscipline: true })
  const { ctx, captured } = makeCtx({ skills: true, systemPrompt: true, settings })
  const fiber = await ctx.plugin(collabPlugin)
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

  const settingsInstall = settings.installed[0]
  ok(settings.installed.length === 1, 'plugin installs exactly one settings section', 'installs=' + settings.installed.length)
  ok(!!settingsInstall && settingsInstall.ns === 'dsh-collab', 'settings namespace is dsh-collab', String(settingsInstall && settingsInstall.ns))
  // 0.8.0 起 schema 有**两个**布尔字段（enforceWriteLock 是功能 C 的门控，默认同样为 true）；
  // 0.9.10 起追加两个字段描述「循环终止自动释放」（releaseOnLoopEnd 布尔 + loopEndGraceSec 秒数）。
  // 这里从"逐字比一个 JSON 串"改成"逐字段判 + 字段集合判"，判据没有放松：
  // 字段集合被钉死成恰好这四个，任何一个默认值没落对都会 FAIL。
  const schemaDefaults = settingsInstall && settingsInstall.schema ? settingsInstall.schema({}) : null
  ok(!!schemaDefaults && schemaDefaults.exposeDelegationDiscipline === true,
    'settings schema defaults exposeDelegationDiscipline to true', JSON.stringify(schemaDefaults))
  ok(!!schemaDefaults && schemaDefaults.enforceWriteLock === true,
    'settings schema defaults enforceWriteLock to true (write protection defaults ON)', JSON.stringify(schemaDefaults))
  ok(!!schemaDefaults && schemaDefaults.releaseOnLoopEnd === true,
    'settings schema defaults releaseOnLoopEnd to true (循环终止自动释放默认开)', JSON.stringify(schemaDefaults))
  ok(!!schemaDefaults && schemaDefaults.loopEndGraceSec === 15,
    'settings schema defaults loopEndGraceSec to 15 (宽限期 15 秒)', JSON.stringify(schemaDefaults))
  ok(!!schemaDefaults && Object.keys(schemaDefaults).sort().join(',') === 'enforceWriteLock,exposeDelegationDiscipline,loopEndGraceSec,releaseOnLoopEnd',
    'settings schema exposes exactly the four known fields', Object.keys(schemaDefaults || {}).join(','))
  ok(!!settingsInstall && !!settingsInstall.entry && settingsInstall.entry.exposeDelegationDiscipline === true,
    'composition entry (fallback when settings detach) is true')
  ok(!!settingsInstall && !!settingsInstall.entry && settingsInstall.entry.enforceWriteLock === true,
    'composition entry defaults enforceWriteLock to true as well')
  ok(!!settingsInstall && !!settingsInstall.entry && settingsInstall.entry.releaseOnLoopEnd === true &&
    settingsInstall.entry.loopEndGraceSec === 15,
    'composition entry defaults 循环终止自动释放 to ON / 15s', JSON.stringify(settingsInstall && settingsInstall.entry))

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
  const settings = makeSettings({ exposeDelegationDiscipline: false })
  const { ctx, captured } = makeCtx({ skills: true, systemPrompt: true, settings })
  let threw = null
  try { await ctx.plugin(collabPlugin) } catch (e) { threw = e }
  await settle()

  ok(threw === null, 'plugin loads with the preference off (no throw)', threw && String(threw.message))
  ok(captured.regs.length === 0, 'no skill is registered when the preference is off', 'calls=' + captured.regs.length)
  ok(!captured.contexts.has('dsh-collab/delegation'), 'no discipline PromptContext when the preference is off', [...captured.contexts.keys()].join(','))
  ok(captured.tools.map((t) => t.name).includes('collab_lock'), 'collab_lock is still registered when the preference is off')
  ok(captured.tools.map((t) => t.name).includes('collab_board'), 'collab_board is still registered when the preference is off')
}

// ---------------------------------------------------------------------------
console.log('# (e) settings service ABSENT: plugin loads, defaults to ON, nothing throws')
{
  const { ctx, captured } = makeCtx({ skills: true, systemPrompt: true })
  let threw = null
  try { await ctx.plugin(collabPlugin) } catch (e) { threw = e }
  await settle()

  ok(ctx.get('settings') === undefined, 'fake ctx really exposes no settings service', String(ctx.get('settings')))
  ok(threw === null, 'plugin loads with settings absent (no throw)', threw && String(threw.message))
  ok(captured.regs.length === 1, 'settings absent -> default true -> skill registered', 'calls=' + captured.regs.length)
  ok(captured.contexts.has('dsh-collab/delegation'), 'settings absent -> default true -> discipline context registered')
  ok(captured.tools.map((t) => t.name).includes('collab_lock'), 'collab_lock is still registered with settings absent')
}

// ---------------------------------------------------------------------------
console.log('# (f) the flag is read LIVE: flipping true -> false at runtime withdraws both, with no restart')
{
  const settings = makeSettings({ exposeDelegationDiscipline: true })
  const { ctx, captured } = makeCtx({ skills: true, systemPrompt: true, settings })
  await ctx.plugin(collabPlugin)
  await settle()
  ok(captured.liveRegs === 1 && captured.contexts.has('dsh-collab/delegation'), 'both exposed while the preference is on')

  settings.set({ exposeDelegationDiscipline: false }) // 模拟用户在设置面板里改
  await settle()
  ok(captured.skillDisposed === 1 && captured.liveRegs === 0, 'flipping off calls the skill disposer', 'disposed=' + captured.skillDisposed + ' live=' + captured.liveRegs)
  ok(!captured.contexts.has('dsh-collab/delegation'), 'flipping off withdraws the context')

  settings.set({ exposeDelegationDiscipline: true }) // 再翻回来
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
  const settings = makeSettings({ exposeDelegationDiscipline: true })
  ctx.provide('settings')
  ctx.set('settings', settings.service)
  try { await ctx.plugin(collabPlugin) } catch (e) { threw = e }
  await settle()
  ok(threw === null, 'a throwing skills.register does not break plugin load', threw && String(threw.message))
  ok(captured.tools.map((t) => t.name).includes('collab_lock'), 'collab_lock survives a throwing skills.register')
}

h.finish()
