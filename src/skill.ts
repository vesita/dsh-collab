// src/skill.ts
// **随包 skill 的读盘与只读载荷**：正文与目录来自 <pkg>/skills/subagent-delegation/。
// 两个消费者共用本模块：delegation.ts（注册给 skills 服务）与 client-route.ts（只交出路径）。
// 读盘结果（含失败）只算一次；任何失败都返回 null，绝不抛。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DELEGATION_SETTINGS_NAMESPACE } from './spec.js'
import type { BundledSkill, CollabSkillIndex } from './contract.js'

/** 随包发布的 skill：正文与目录都来自 <pkg>/skills/subagent-delegation/。 */
const BUNDLED_SKILL_FILE = '../skills/subagent-delegation/SKILL.md'

/**
 * 极简 frontmatter 解析：只认文件开头的 `---` 块，只取 name/description/whenToUse 三个标量，
 * 其余行（含 YAML 注释）忽略；正文是闭合 `---` 之后的全部原文，不做任何改写。
 * 缺 frontmatter、缺 name、或整段不可解析时返回 null，由调用方静默降级。
 */
function parseSkillFrontmatter(text: string): { name: string; description?: string; whenToUse?: string; content: string } | null {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!kv) continue
    let v = kv[2].trim()
    // 值两侧成对的引号剥掉即可，不追求完整 YAML（本文件只用裸标量）。
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1)
    meta[kv[1]] = v
  }
  const name = (meta.name || '').trim()
  if (!name) return null
  const content = text.slice(m[0].length)
  return {
    name,
    description: (meta.description || '').trim() || undefined,
    whenToUse: (meta.whenToUse || '').trim() || undefined,
    content
  }
}

// 读盘结果（含失败）只算一次：prompt 装配路径绝不碰盘，apply 也只同步读一次。
let bundledSkillCache: BundledSkill | null | undefined

/** 读取并解析随包 skill；文件缺失/不可读/解析失败都返回 null（绝不抛）。 */
export function loadBundledSkill(): BundledSkill | null {
  if (bundledSkillCache !== undefined) return bundledSkillCache
  bundledSkillCache = null
  try {
    // 相对**构建产物**定位：lib/index.js -> <pkg>/skills/...，因此与安装位置无关。
    const file = fileURLToPath(new URL(BUNDLED_SKILL_FILE, import.meta.url))
    const parsed = parseSkillFrontmatter(readFileSync(file, 'utf8'))
    if (parsed) {
      bundledSkillCache = {
        name: parsed.name,
        description: parsed.description || '',
        whenToUse: parsed.whenToUse,
        content: parsed.content,
        path: file
      }
    }
  } catch (e) {}
  return bundledSkillCache
}

/**
 * 纯函数：把「已加载或缺失的随包 skill」组装成只读路由的载荷。
 * 与读盘解耦，所以 node 里能直接断言「文件缺失 ⇒ skill 为 null」这条降级路径。
 * **绝不**带上 skill 正文：浏览器半边只拿路径与名称/描述，正文由右侧预览自己读文件。
 */
export function buildSkillIndex(skill: BundledSkill | null): CollabSkillIndex {
  return {
    namespace: DELEGATION_SETTINGS_NAMESPACE,
    items: [
      {
        field: 'exposeDelegationDiscipline',
        skill: skill === null
          ? null
          : {
              name: skill.name,
              description: skill.description,
              ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
              path: skill.path
            }
      }
    ]
  }
}
