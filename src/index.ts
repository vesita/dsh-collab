// src/index.ts
// dsh-collab 的**组合根**。本文件只做接线：读 ctx、按依赖顺序调用各 installer、
// 把上一个 installer 的返回值显式传给下一个。任何一段功能都不在这里实现。
//
// 分段与模块（每个 installer 的返回值就是它对外暴露的东西）：
//   store.ts       状态文件存取 + 只读查询 op
//   push.ts        功能 D：释放推送、子代理回退通道、agent/disposed 生命周期
//   access.ts      功能 A：访问旁路通知 + 读者反向注册
//   awareness.ts   态势上下文（order 130）；暴露 systemPrompt 面与总开关
//   delegation.ts  委托纪律：settings 偏好 + 随包 skill + 常驻纪律块（order 131）
//   gate.ts        功能 C：写/读的原生审批门控（消费 delegation 的偏好读取面）
//   auto-release.ts 循环终止自动释放（消费 store + push + delegation 的偏好读取面）
//   tools.ts       collab_lock / collab_board 注册（消费 push 的 notifyReaders）
//   client-route.ts 浏览器半边只读 loopback 路由

import { installStore } from './store.js'
import { DELEGATION_SETTINGS_SCHEMA } from './spec.js'
import { installPush } from './push.js'
import { installAccess } from './access.js'
import { installAwareness } from './awareness.js'
import { installDelegation } from './delegation.js'
import { installGate } from './gate.js'
import { installAutoRelease } from './auto-release.js'
import { installTools } from './tools.js'
import { installClientRoute } from './client-route.js'
import type { CollabContext } from './contract.js'

// ---- 对外导出面：与拆分前**逐名一致**（只是搬了家，这里重新导出） ----
export type {
  FileRef, CollabFs, PushOutcome, PushChannel, NotifyOutcome,
  SkillInvocationPolicy, SkillResourceBase, SkillRegistration, SkillsService,
  DelegationSettings,
  ConnectionService, WebServerService, CollabSkillItem, CollabSkillIndex,
  BundledSkill, ToolExecContext, CollabArgs, ToolResult, ToolDefinition, CollabContext
} from './contract.js'
export {
  CLIENT_SKILL_ROUTE, DELEGATION_SETTINGS_NAMESPACE, DELEGATION_SETTINGS_SCHEMA,
  DELEGATION_SETTINGS_ENTRY, DELEGATION_DISCIPLINE_TEXT, TEAM_DISCIPLINE_ADDENDUM,
  TOOL_PATH_SPECS, COMMAND_AWARE_TOOL, pathArgsFor,
  collectPathCandidates, accessSignature, sessionIdOf
} from './spec.js'
export { buildSkillIndex } from './skill.js'

export const name = 'dsh-collab'
export const inject = ['fs', 'timer', 'tools']
/**
 * 本插件的 Config schema：偏好的唯一保存处（0.1.7 起设置就是 profile 条目上的 Config）。
 * 字段全部 `.volatile()` —— 改一个字段不需要重载插件（见 src/spec.ts）。
 */
export const Config = DELEGATION_SETTINGS_SCHEMA

export function apply(ctx: CollabContext, config?: Record<string, unknown> | null): void {
  // 顺序即依赖顺序：
  //   store 是唯一的状态入口；push 只依赖 store；
  //   access 只依赖 store（逐事件 agent.inject，不再用上下文面）；
  //   awareness 交出运行时上下文注册面，delegation 需要它；
  //   delegation 交出写保护开关，gate 需要它；
  //   auto-release 需要 store + push + delegation 的偏好读取面；
  //   tools 需要 store + push 的 notifyReaders；clientRoute 独立。
  const store = installStore(ctx)
  const push = installPush(ctx, store)
  installAccess(ctx, store)
  const surface = installAwareness(ctx, store)
  const prefs = installDelegation(ctx, surface, config)
  // gate 额外的第 4 个面是 push（0.11.0 反向交叉预警的 advisory 投递）。
  // 它**只用于投递提示**：门控判定本身仍只用 store + prefs。
  installGate(ctx, store, prefs, push)
  installAutoRelease(ctx, store, push, prefs)
  installTools(ctx, store, push)
  installClientRoute(ctx)
}

// **默认导出必须带上 `Config`**：Loader 是从插件对象的 `Config` 投影出条目配置的
// （`cordis/lib/index.js:1347` 的 `resolveConfig(this.runtime, config)`，`runtime` 就是这里的
// 默认导出对象），插件页的配置表单同样由它驱动。0.10.0 把偏好迁到 profile Config 时漏了这一项，
// 于是 `Config` 只有具名导出、`fiber.runtime.Config` 是 undefined —— 浏览器半边的卡片注册得好好的，
// 却整张没有内容可渲染（`dsh-tool-cordis` 的 Config 检视会如实报 `status: 'absent'`）。
// tests/collab-client-config-page.mjs 的 ⑦ 就是这条的机械守卫。
export default { name, inject, apply, Config }
