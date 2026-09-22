#!/usr/bin/env node
/**
 * tests/collab-client-config-page.mjs — 浏览器半边**配置页注册面**的机械检查。
 *
 * 为什么要有它：0.10.1 之前这一半的落点与表单语义只靠人肉看页面验证，于是
 * "插件页里没有配置项" 这类故障要等用户发现。这里把它钉成一次命令可判定的规则：
 *
 *   ① 声明了 `slots` 与 `configForms` 两个客户端服务（0.1.7 起没有 settingsScope）；
 *   ② 注册到 `plugins.bundle.config`，`key` 必须是**组合包的包名**（插件页用
 *      `ledger.bundles.has(openPkg.name)` 决定渲染与否）；
 *   ③ 命名空间与 Host 半边的条目 id 逐字一致（`collab`）；
 *   ④ 走官方的 store→React 通道：`inject()` 交出 `hooks: { <name>: store }`，
 *      组件里用 `props.use<Name>(selector)` 读——不许自己造订阅；
 *   ⑤ 用官方表单原语（`SettingsForm` / `SettingsValueField` / `SettingsFormModel`），
 *      保存语义由它们承担，不许手搓"每按键即写盘"或自造保存按钮；
 *   ⑥ 四个字段名与 Host 半边 Config schema 逐字一致（编译产物里也要能看见）。
 *
 * 在 vm 里真实执行 `lib/client.js`（不是读源码猜）：用假槽位注册表接住注册，
 * 用假的 primitives 接住 require，然后逐条断言。
 *
 * 运行：node tests/collab-client-config-page.mjs
 * 退出码非 0 表示失败。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0
let failed = 0
const failures = []

function ok(name, cond, detail) {
  if (cond) {
    passed++
    console.log('  ok  ' + name)
  } else {
    failed++
    failures.push(detail ? `${name} — ${detail}` : name)
    console.log('  FAIL ' + name + (detail ? '  <-- ' + detail : ''))
  }
}

// ── 在 vm 里加载浏览器半边，用假注册表接住一切 ──────────────────────────────
const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

const activated = []
let registration = null
let formModelSpecs = null
let requiredIds = []

const fakeStore = () => ({
  getSnapshot: () => ({}),
  subscribe: () => () => {},
  dispose() {}
})

function requireShim(id) {
  requiredIds.push(id)
  if (id === 'react') {
    return {
      createElement: (...args) => ({ type: args[0], props: args[1], children: args.slice(2) }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {},
      useRef: (initial) => ({ current: initial })
    }
  }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      SettingsForm: function SettingsForm() {},
      SettingsValueField: function SettingsValueField() {},
      SettingsFormModel: class SettingsFormModel {
        constructor(scope, specs, secrets) {
          formModelSpecs = { scope, specs, secrets }
        }
        bind() { return fakeStore() }
        actions() { return { edit() {}, resetField() {}, save() {}, discard() {} } }
        dispose() {}
      },
      settingsNumberField: (field) => ({ field, kind: 'number' }),
      settingsTextField: (field) => ({ field, kind: 'text' })
    }
  }
  throw new Error('client half required an unexpected module: ' + id)
}

const ctx = {
  slots: {
    inject(name, callback) {
      activated.push(name)
      return callback()
    },
    register(options, component) {
      registration = { options, component }
      return () => {}
    }
  },
  configForms: {
    get(namespace) {
      return {
        namespace,
        getSnapshot: () => ({ status: 'ready', writable: true, value: {}, revision: 1 }),
        subscribe: () => () => {},
        mutate: async () => true
      }
    }
  },
  effect: () => {},
  get: () => undefined
}

const sandbox = { console }
sandbox.window = { __ModuleLoader__: { load: () => {} } }
vm.createContext(sandbox)

let exported = null
sandbox.window.__ModuleLoader__ = {
  load: ({ factory }) => { exported = factory(requireShim) }
}
vm.runInContext(source, sandbox)

ok('客户端半边经 __ModuleLoader__ 传出 exports', !!exported, String(exported))
if (!exported) {
  console.log('\nFAILURES: ' + (passed + failed) + ' passed, ' + failed + ' failed')
  process.exit(1)
}

exported.apply(ctx)

// ── ① 依赖声明的客户端服务 ────────────────────────────────────────────────
const inject = Array.isArray(exported.inject) ? exported.inject : []
ok('声明依赖 slots', inject.includes('slots'), JSON.stringify(inject))
ok('声明依赖 configForms（0.1.7 起设置读写的唯一入口）', inject.includes('configForms'), JSON.stringify(inject))
ok('没有残留 settingsScope（0.1.7 已移除）', !inject.includes('settingsScope'), JSON.stringify(inject))

// ── ② 落点与 key ─────────────────────────────────────────────────────────
ok('只激活插件页的配置槽位', activated.length === 1 && activated[0] === 'plugins.bundle.config', JSON.stringify(activated))
ok('注册进 plugins.bundle.config', !!registration && registration.options.name === 'plugins.bundle.config',
  String(registration && registration.options.name))
ok('key 是组合包包名 dsh-collab（插件页据此决定渲染与否）',
  !!registration && registration.options.key === 'dsh-collab', String(registration && registration.options.key))
ok('注册了组件', !!registration && typeof registration.component === 'function',
  typeof (registration && registration.component))

// ── ④ 官方 store→React 通道 ───────────────────────────────────────────────
const injected = registration && typeof registration.options.inject === 'function' ? registration.options.inject() : null
ok('inject() 交出 hooks（渲染器据此绑 props.use<Name>）',
  !!injected && !!injected.hooks && typeof injected.hooks === 'object',
  JSON.stringify(injected && Object.keys(injected)))
const hookNames = injected && injected.hooks ? Object.keys(injected.hooks) : []
ok('hooks 里恰好一个源 collabForm', hookNames.length === 1 && hookNames[0] === 'collabForm', JSON.stringify(hookNames))
ok('hook 源是可订阅快照（getSnapshot + subscribe）',
  hookNames.length === 1 && typeof injected.hooks[hookNames[0]].getSnapshot === 'function'
  && typeof injected.hooks[hookNames[0]].subscribe === 'function',
  JSON.stringify(injected && injected.hooks))
for (const action of ['edit', 'resetField', 'save', 'discard']) {
  ok('inject() 交出官方表单动作 ' + action, !!injected && typeof injected[action] === 'function', String(injected && typeof injected[action]))
}

// ── ⑤ 官方表单原语 ───────────────────────────────────────────────────────
ok('经 require 取到官方 primitives', requiredIds.includes('@deepseek-ai/dsh-client-ui-primitives'), JSON.stringify(requiredIds))
ok('用 SettingsFormModel 建表单（暂存 + 保存语义不由本插件自造）', !!formModelSpecs, String(formModelSpecs))
const specs = formModelSpecs && Array.isArray(formModelSpecs.specs) ? formModelSpecs.specs : []

// ── ③ 命名空间 ───────────────────────────────────────────────────────────
ok('configForms.get 用的是 profile 条目 id collab',
  !!formModelSpecs && !!formModelSpecs.scope && formModelSpecs.scope.namespace === 'collab',
  String(formModelSpecs && formModelSpecs.scope && formModelSpecs.scope.namespace))
const hostSource = readFileSync(join(ROOT, 'src/spec.ts'), 'utf8')
ok('Host 半边 DELEGATION_SETTINGS_NAMESPACE 也是 collab',
  /DELEGATION_SETTINGS_NAMESPACE\s*=\s*'collab'/.test(hostSource), '与浏览器半边不一致')

// ── ⑥ 字段与 Host Config schema 一致 ─────────────────────────────────────
const fields = specs.map((spec) => spec && spec.field)
const expected = ['exposeDelegationDiscipline', 'enforceWriteLock', 'releaseOnLoopEnd', 'loopEndGraceSec']
ok('表单恰好编辑四个字段：' + expected.join(', '),
  fields.length === expected.length && expected.every((f) => fields.includes(f)), JSON.stringify(fields))
for (const field of expected) {
  ok(`Host 的 Config schema 里有 ${field}`, new RegExp(`\\b${field}\\s*:`).test(hostSource), '字段名与浏览器半边不一致')
}
const numberSpec = specs.find((spec) => spec && spec.field === 'loopEndGraceSec')
ok('宽限期用 settingsNumberField（数字字段）',
  !!numberSpec && numberSpec.kind === 'number', JSON.stringify(numberSpec))

console.log('\n' + (failed === 0 ? 'ALL PASS: ' : 'FAILURES: ') + passed + ' passed, ' + failed + ' failed')
process.exit(failed === 0 ? 0 : 1)
