import { createHarness } from './_harness.mjs'

// collab-client-route.mjs
// 浏览器半边唯一的 Host 依赖面：只读技能索引路由 GET /dsh-collab/skill-index 的回归测试。
//
// 为什么这条能测：路由是纯 Host 面（cordis 服务 + node:http 的 req/res），
// 在 node 里用假 webServer/connection 就能完整跑通「注册 → 方法判定 → 围栏 → 载荷」。
// 为什么卡片本身不测：它是浏览器 React/Slot 面，node 里没有真实 React 渲染与槽位、
// 也没有 dsh-resource 资源栈，造假测试只会制造假信心。
//
// 断言：
//   (a) 恰好注册一条 exact 路由，路径为 /dsh-collab/skill-index；
//   (b) GET 200 + JSON：命名空间、条目字段、随包 SKILL.md 的绝对路径与名称/描述；
//   (c) 载荷**不含 skill 正文**（正文由右侧预览自己读文件）；
//   (d) 非 GET → 405 + Allow: GET，且不泄漏载荷；
//   (e) connection 拒绝 → 直接回拒绝码、空 body，且**先于**方法判定（围栏在最前）；
//   (f) 文件缺失（buildSkillIndex(null)）→ skill 为 null，不抛；
//   (g) webServer 缺失 → 插件照常装载、不注册路由、不抛；connection 缺失 → 仍可服务；
//   (h) 卸载插件 → 路由 disposer 被调用（可逆）。
//
// 运行：node tests/collab-client-route.mjs

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const cordis = await import('@deepseek-ai/cordis').catch(() => import('../node_modules/.pnpm/node_modules/@deepseek-ai/cordis/lib/index.js'))
const { Context } = cordis

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const SKILL_PATH = path.join(ROOT, '../skills/subagent-delegation/SKILL.md')
const mod = await import(path.join(ROOT, '../lib/index.js'))
const collabPlugin = mod.default
const { buildSkillIndex, CLIENT_SKILL_ROUTE, DELEGATION_SETTINGS_NAMESPACE } = mod

const h = createHarness()
const { ok } = h

// 不要写真实的 ~/.dsh；并确保包形态总开关处于默认（开）。
process.env.DSH_HOME = path.join(os.tmpdir(), 'collab-route-' + process.pid)
delete process.env.DSH_COLLAB_NO_PROMPT_HINT
const settle = () => new Promise((r) => setTimeout(r, 30))

/** 极简 node:http 请求替身（路由只读 method）。 */
function makeReq(method) {
  return { method, headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', cookie: 'session=x' } }
}

/**
 * 极简 node:http 响应替身。刻意模拟 Node 的两条真实语义：
 * writeHead(status, headers) 会与先前 setHeader 的头部**合并**（Allow 不会被吞掉），
 * 而 end() 只记录一次 body。
 */
function makeRes() {
  return {
    statusCode: 0,
    headersSent: false,
    headers: {},
    body: null,
    ended: 0,
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value },
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headersSent = true
      for (const [key, value] of Object.entries(headers || {})) this.headers[String(key).toLowerCase()] = value
      return this
    },
    end(body) {
      this.ended++
      if (body !== undefined && body !== null) this.body = String(body)
    }
  }
}

/** 统一的假 ctx：记录路由注册与 disposer，可按需装/不装 webServer 与 connection。 */
function makeCtx(opts = {}) {
  const captured = { routes: [], routeDisposed: 0 }
  const ctx = new Context()
  for (const name of ['tools', 'timer', 'fs']) ctx.provide(name)
  ctx.set('tools', { register: () => () => {} })
  ctx.set('timer', { timeout: () => Promise.resolve(), interval: () => () => {} })
  ctx.set('fs', {
    resolve: async (p) => ({ displayPath: p, path: p }),
    stat: async () => null,
    readText: async () => '',
    writeText: async () => {},
    processPath: (t) => t.path
  })
  if (opts.webServer !== false) {
    ctx.provide('webServer')
    ctx.set('webServer', {
      register: (route) => {
        captured.routes.push(route)
        return () => { captured.routeDisposed++ }
      }
    })
  }
  if (opts.connection !== undefined) {
    ctx.provide('connection')
    ctx.set('connection', opts.connection)
  }
  return { ctx, captured }
}

// 测试自己独立解析一遍 frontmatter（刻意不复用 lib 里的解析器）。
const raw = fs.readFileSync(SKILL_PATH, 'utf8')
const fm = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
const fmLines = fm ? fm[1].split(/\r?\n/) : []
const field = (k) => {
  const line = fmLines.find((l) => l.startsWith(k + ':'))
  return line ? line.slice(k.length + 1).trim() : ''
}
const diskName = field('name')
const diskDescription = field('description')
const diskWhenToUse = field('whenToUse')
const diskBody = fm ? raw.slice(fm[0].length) : ''

console.log('# (a)(b)(c)(d)(e)(g)(h) route registration, payload, method fence, trust fence, degradations')
{
  const allow = { requestRejection: () => undefined }
  const { ctx, captured } = makeCtx({ connection: allow })
  const fiber = await ctx.plugin(collabPlugin)
  await settle()

  ok(captured.routes.length === 1, 'exactly one web route is registered', 'routes=' + captured.routes.length)
  const route = captured.routes[0]
  ok(!!route && route.kind === 'exact', "route kind is 'exact'", String(route && route.kind))
  ok(!!route && route.path === CLIENT_SKILL_ROUTE, 'route path is ' + CLIENT_SKILL_ROUTE, String(route && route.path))
  ok(!!route && route.path === '/dsh-collab/skill-index', 'route path literal is /dsh-collab/skill-index', String(route && route.path))
  ok(!!route && typeof route.handler === 'function', 'route handler is a function')

  // (b) GET 200 + 载荷形状
  const getRes = makeRes()
  await route.handler(makeReq('GET'), getRes)
  ok(getRes.statusCode === 200, 'GET answers 200', String(getRes.statusCode))
  ok(/application\/json/.test(String(getRes.headers['content-type'] || '')), 'GET sets a JSON content-type', String(getRes.headers['content-type']))
  ok(String(getRes.headers['cache-control'] || '') === 'no-store', 'GET forbids caching', String(getRes.headers['cache-control']))
  let payload = null
  try { payload = JSON.parse(getRes.body) } catch (e) { payload = null }
  ok(payload !== null, 'GET body is valid JSON', String(getRes.body).slice(0, 120))
  ok(!!payload && payload.namespace === DELEGATION_SETTINGS_NAMESPACE, 'payload namespace is the profile entry id', String(payload && payload.namespace))
  ok(!!payload && payload.namespace === DELEGATION_SETTINGS_NAMESPACE, 'payload namespace matches the exported constant')
  ok(!!payload && Array.isArray(payload.items) && payload.items.length === 1, 'payload carries exactly one item', JSON.stringify(payload && payload.items))
  const item = payload && payload.items ? payload.items[0] : null
  ok(!!item && item.field === 'exposeDelegationDiscipline', 'item field is exposeDelegationDiscipline', String(item && item.field))
  ok(!!item && !!item.skill, 'item carries a skill (the shipped SKILL.md was found)')
  const skill = item && item.skill ? item.skill : null
  ok(!!skill && skill.path === SKILL_PATH, 'skill.path is the shipped SKILL.md absolute path', String(skill && skill.path))
  ok(!!skill && path.isAbsolute(skill.path), 'skill.path is absolute', String(skill && skill.path))
  ok(!!skill && fs.existsSync(skill.path), 'skill.path exists on disk', String(skill && skill.path))
  ok(!!skill && skill.name === diskName, 'skill.name matches the frontmatter on disk', String(skill && skill.name))
  ok(!!skill && skill.description === diskDescription, 'skill.description matches the frontmatter on disk')
  ok(!!skill && skill.whenToUse === diskWhenToUse, 'skill.whenToUse matches the frontmatter on disk')

  // (c) 正文绝不过网
  ok(!!skill && !('content' in skill), 'skill payload has no content field', Object.keys(skill || {}).join(','))
  ok(!!skill && !('path' in skill && 'content' in skill), 'skill payload keys are exactly name/description/whenToUse/path', Object.keys(skill || {}).join(','))
  const bodyProbe = diskBody.replace(/\s+/g, ' ').slice(0, 40)
  ok(bodyProbe.length > 0 && !getRes.body.includes(bodyProbe), 'the skill BODY never rides the response', bodyProbe)
  ok(getRes.body.length < 2000, 'response stays tiny (path + metadata only)', String(getRes.body.length))

  // (d) 非 GET
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = makeRes()
    await route.handler(makeReq(method), res)
    ok(res.statusCode === 405, method + ' answers 405', String(res.statusCode))
    ok(String(res.headers['allow'] || '') === 'GET', method + ' advertises Allow: GET', String(res.headers['allow']))
    ok(!/SKILL\.md/.test(String(res.body || '')), method + ' refuses without leaking the path', String(res.body))
  }

  // (e) 围栏优先：拒绝时既不判方法、也不给载荷
  const denied = { calls: 0, requestRejection: () => { denied.calls++; return 403 } }
  const { ctx: ctx2, captured: captured2 } = makeCtx({ connection: denied })
  const fiber2 = await ctx2.plugin(collabPlugin)
  await settle()
  const route2 = captured2.routes[0]
  ok(!!route2, 'the route is also registered with a rejecting connection')
  const deniedRes = makeRes()
  await route2.handler(makeReq('GET'), deniedRes)
  ok(denied.calls === 1, 'the connection fence is consulted for every request', 'calls=' + denied.calls)
  ok(deniedRes.statusCode === 403, 'a rejected request answers the rejection status', String(deniedRes.statusCode))
  ok(deniedRes.body === null, 'a rejected request carries no body', String(deniedRes.body))
  const deniedPost = makeRes()
  await route2.handler(makeReq('POST'), deniedPost)
  ok(deniedPost.statusCode === 403, 'the fence runs BEFORE the method check (POST is rejected, not 405)', String(deniedPost.statusCode))
  await fiber2.dispose()
  await settle()

  // (h) 可逆
  await fiber.dispose()
  await settle()
  ok(captured.routeDisposed === 1, 'unloading the plugin disposes the route', 'disposed=' + captured.routeDisposed)
}

console.log('# (f) missing skill file degrades to skill:null (no throw, no invented path)')
{
  const index = buildSkillIndex(null)
  ok(index.namespace === DELEGATION_SETTINGS_NAMESPACE, 'degraded payload keeps the namespace', String(index.namespace))
  ok(Array.isArray(index.items) && index.items.length === 1, 'degraded payload keeps the item', JSON.stringify(index.items))
  ok(index.items[0].field === 'exposeDelegationDiscipline', 'degraded item keeps the field name', String(index.items[0].field))
  ok(index.items[0].skill === null, 'degraded item reports skill:null instead of a guessed path', JSON.stringify(index.items[0].skill))
  const live = buildSkillIndex({ name: 'n', description: 'd', content: 'BODY', path: '/abs/SKILL.md' })
  ok(live.items[0].skill !== null && live.items[0].skill.path === '/abs/SKILL.md', 'a loaded skill is projected with its path')
  ok(!('content' in live.items[0].skill), 'buildSkillIndex never projects the body', Object.keys(live.items[0].skill).join(','))
  ok(!('whenToUse' in live.items[0].skill), 'an absent whenToUse is omitted rather than emitted as undefined', Object.keys(live.items[0].skill).join(','))
}

console.log('# (g) optional services: no webServer -> no route and no throw; no connection -> still served')
{
  const { ctx, captured } = makeCtx({ webServer: false })
  let threw = null
  try { await ctx.plugin(collabPlugin) } catch (e) { threw = e }
  await settle()
  ok(threw === null, 'the plugin loads without a webServer service', threw && String(threw.message))
  ok(captured.routes.length === 0, 'no route is registered without a webServer', 'routes=' + captured.routes.length)

  const bare = makeCtx({})
  const fiber = await bare.ctx.plugin(collabPlugin)
  await settle()
  const res = makeRes()
  await bare.captured.routes[0].handler(makeReq('GET'), res)
  ok(res.statusCode === 200, 'without a connection service the route still answers 200 (fence skipped, path is not a secret)', String(res.statusCode))
  await fiber.dispose()
}

h.finish()
