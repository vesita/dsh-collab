// plugin-message.ts
// 插件通知消息（UserMessage）的构造：**逐字复刻** @deepseek-ai/dsh-llm 的
// freezeMessage / createMessage / createUserMessage 三个函数的语义。
//
// 为什么复刻而不是 import：
//   `@deepseek-ai/dsh-llm` 确实导出 createUserMessage（lib/index.js:48），但它是
//   **运行时依赖**，本包安装后要从自己的 node_modules 链上解析到它才行。实测：
//     - 本仓库裸 `import('@deepseek-ai/dsh-llm')` → ERR_MODULE_NOT_FOUND
//       （只有 `node_modules/.pnpm/node_modules/@deepseek-ai/dsh-llm` 这条 pnpm 虚拟
//        store 路径存在，它不在标准解析链上）；
//     - 部署 profile（~/.dsh/profiles/web/node_modules/@deepseek-ai/）里只有
//       cosmokit 与 schemastery，同样没有 dsh-llm。
//   为一个"附加的提示消息"新增运行时依赖，会让整个插件在依赖缺席时**装载失败** ——
//   代价远高于这十几行有明确文档语义的代码。因此这里复刻，形状与真身逐字段一致：
//     { id: <uuid v4>, role: 'user', content: [{ type: 'text', text }],
//       source: { kind: 'plugin', plugin: 'dsh-collab', form: 'notice', summary } }
//   并由 tests/collab-readers-push.mjs 与真实 dsh-llm 做**现场对拍**
//   （能解析到真身时逐字段比对 id 形状/role/content/source 与深冻结；解析不到就显式 SKIP）。

import { randomUUID } from 'node:crypto'

/** 文本内容块（PromptContentPart / ContentBlock 的文本分支）。 */
export interface TextBlockLike {
  type: 'text'
  text: string
}

/** plugin 来源：kind + 插件名 + ContextFormed 的 notice 形态。 */
export interface PluginNoticeSourceLike {
  kind: 'plugin'
  plugin: string
  form: 'notice'
  summary: string
}

/** 与 dsh-llm 的 UserMessage 同形的结构（id 是 MessageId，运行时就是 uuid 字符串）。 */
export interface UserMessageLike {
  id: string
  role: 'user'
  content: TextBlockLike[]
  source: PluginNoticeSourceLike
}

/**
 * 深冻结（复刻 @deepseek-ai/dsh-util-values 的 deepFreeze 语义）：
 * 冻结对象图上每个可达的**可枚举**子节点。真身额外跳过 AbortSignal 实例；
 * 本模块只构造纯 JSON（文本 + 字符串字段），不存在 AbortSignal，故该分支无对应物。
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  const seen = new Set<unknown>()
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || typeof node !== 'object') continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    for (const key of Object.keys(node as Record<string, unknown>)) {
      stack.push((node as Record<string, unknown>)[key])
    }
  }
  return value
}

/** 分离并深冻结一条已带身份的 message（等价 dsh-llm freezeMessage: deepFreeze(structuredClone(m))）。 */
export function freezeMessage<T>(message: T): T {
  return deepFreeze(structuredClone(message))
}

/**
 * 通知摘要的长度上限（等价 dsh-llm 的 CONTEXT_SUMMARY_MAX_CHARS = 120：
 * 摘要是折叠行上的说明文字，长度为调用方文本，必须有界）。
 */
export const CONTEXT_SUMMARY_MAX_CHARS: number = 120

/** 把摘要截到上限（等价 dsh-llm 的 boundContextSummary）。 */
export function boundContextSummary(summary: string): string {
  return summary.length <= CONTEXT_SUMMARY_MAX_CHARS ? summary : summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1) + '…'
}

/**
 * 构造一条插件 notice 形态的 user 消息（等价 dsh-llm createUserMessage + freezeMessage）。
 * 身份用 node:crypto 的 randomUUID（v4，与 dsh-util-crypto 的 globalThis.crypto 版本同形）。
 */
export function createUserMessage(input: { content: TextBlockLike[]; source: PluginNoticeSourceLike }): UserMessageLike {
  return freezeMessage({ ...input, role: 'user' as const, id: randomUUID() })
}
