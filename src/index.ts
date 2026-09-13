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
//   tools.ts       collab_lock / collab_board 注册（消费 push 的 notifyReaders）
//   client-route.ts 浏览器半边只读 loopback 路由

import { installStore } from './store.js'
import { installPush } from './push.js'
import { installAccess } from './access.js'
import { installAwareness } from './awareness.js'
import { installDelegation } from './delegation.js'
import { installGate } from './gate.js'
import { installTools } from './tools.js'
import { installClientRoute } from './client-route.js'
import type { CollabContext } from './contract.js'

// ---- 对外导出面：与拆分前**逐名一致**（只是搬了家，这里重新导出） ----
export type {
  FileRef, CollabFs, PushOutcome, PushChannel, NotifyOutcome,
  SkillInvocationPolicy, SkillResourceBase, SkillRegistration, SkillsService,
  DelegationSettings, SettingsSectionHooks, SettingsService,
  ConnectionService, WebServerService, CollabSkillItem, CollabSkillIndex,
  BundledSkill, ToolExecContext, CollabArgs, ToolResult, ToolDefinition, CollabContext
} from './contract.js'
export {
  CLIENT_SKILL_ROUTE, DELEGATION_SETTINGS_NAMESPACE, DELEGATION_SETTINGS_SCHEMA,
  DELEGATION_SETTINGS_ENTRY, DELEGATION_DISCIPLINE_TEXT,
  TOOL_PATH_SPECS, COMMAND_AWARE_TOOL, pathArgsFor,
  collectPathCandidates, accessSignature, sessionIdOf
} from './spec.js'
export { buildSkillIndex } from './skill.js'

export const name = 'dsh-collab'
export const inject = ['fs', 'timer', 'tools']

export function apply(ctx: CollabContext): void {
  // 顺序即依赖顺序：
  //   store 是唯一的状态入口；push 只依赖 store；
  //   access 只依赖 store（逐事件 agent.inject，不再用上下文面）；
  //   awareness 交出运行时上下文注册面，delegation 需要它；
  //   delegation 交出写保护开关，gate 需要它；
  //   tools 需要 store + push 的 notifyReaders；clientRoute 独立。
  const store = installStore(ctx)
  const push = installPush(ctx, store)
  installAccess(ctx, store)
  const surface = installAwareness(ctx, store)
  const prefs = installDelegation(ctx, surface)
  installGate(ctx, store, prefs)
  installTools(ctx, store, push)
  installClientRoute(ctx)
}

export default { name, inject, apply }
