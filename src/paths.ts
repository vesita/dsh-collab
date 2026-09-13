// src/paths.ts
// 协作状态文件的**唯一路径事实源**：任何形态（包形态 index.ts / 动态宿主形态
// collab-plugin.host.ts / CLI）都必须从这里（或其纯 JS 复刻）取绝对路径。
//
// 背景（实测，勿重新怀疑）：
//   1. ctx.fs.resolve(p) 对**相对路径**的基址是**进程 cwd**，不是 HOME。
//   2. `~` 完全不展开：fs.resolve('~/.dsh/...') 会在 HOME 下造一个名为 `~` 的目录。
//   3. 绝对路径原样通过；fs.resolve(p, { cwd }) 的 cwd 选项有效。
// 历史两处错误落点因此产生：
//   - src/collab-plugin.host.ts 用字面量 '~/.dsh/collab/projects'
//     ⇒ 真实数据被写进 <HOME>/~/.dsh/collab/projects/。
//   - src/index.ts 用相对路径 '.dsh/collab/projects'（依赖进程 cwd）
//     ⇒ dsh 从不同目录启动时，同一项目会写到互不相干的文件，跨会话可见性静默失效。
//
// 本模块统一产出**绝对路径**：状态目录 = ${DSH_HOME:-$HOME/.dsh}/collab/projects。

import { homedir } from 'node:os'
import path from 'node:path'
import { projectStorageFileName } from './collab-core.js'

/** 项目内遗留的单文件状态（第一代落点，只读、用于一次性迁移）。 */
export const LEGACY_PROJECT_FILE: string = '.dsh-collab.json'

/** 可注入的环境变量视图：便于测试 DSH_HOME 而不污染全局 process.env。 */
export type EnvLike = Record<string, string | undefined>

/**
 * 展开开头的 `~` / `~/`（对齐 DSH 自身 expandHomePath 的语义）。
 * 不做展开的话，`DSH_HOME='~/.dsh'` 会造出一个名字就叫 `~` 的目录 —— 正是本插件修掉的那个 bug。
 */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2))
  return p
}

/**
 * DSH 用户目录（绝对路径）：DSH_HOME 优先（先展开 `~`），其次 <home>/.dsh。
 * DSH_HOME 为空/纯空白视为未设置。无法确定绝对家目录时抛错，
 * 而不是退回相对路径 —— 相对路径意味着状态会随进程 cwd 漂移。
 */
export function dshHomeDir(env: EnvLike = process.env): string {
  const home = homedir()
  if (typeof home !== 'string' || !home.trim()) {
    throw new Error('dsh-collab: 无法确定用户的绝对主目录（os.homedir() 为空）；请把 DSH_HOME 设为绝对路径')
  }
  const raw = env ? env.DSH_HOME : undefined
  const configured = typeof raw === 'string' ? raw.trim() : ''
  if (configured) return path.resolve(expandHome(configured, home))
  return path.join(home, '.dsh')
}

/**
 * 协作状态目录（绝对路径）：<dshHomeDir>/collab/projects。
 * 这是**唯一**的正确落点，与 DSH 进程 cwd 无关。
 */
export function collabDir(env: EnvLike = process.env): string {
  return path.join(dshHomeDir(env), 'collab', 'projects')
}

/**
 * 某个项目工作区的状态文件（绝对路径）。
 * 文件名沿用 collab-core 的 projectStorageFileName(cwd || 'default')，
 * 与历史产物（含错误落点里的文件）保持同名，迁移才能一一对上。
 */
export function projectStateFile(cwd: string | null, env: EnvLike = process.env): string {
  const key = typeof cwd === 'string' && cwd ? cwd : 'default'
  return path.join(collabDir(env), projectStorageFileName(key))
}

/**
 * 历史错误落点（**只读**，仅供一次性迁移扫描）。顺序即优先级：
 *   [0] path.resolve('.dsh','collab','projects')                旧版相对进程 cwd
 *   [1] path.join(os.homedir(),'~','.dsh','collab','projects')  旧版 `~` 未展开
 *
 * 说明：这两个位置由「历史 bug 运行时的进程 cwd」与「真实 home」决定，
 * 与当前 env（DSH_HOME）无关，故 env 参数仅为契约对称性保留、不参与计算。
 * 另外 [0] 依赖**当前**进程 cwd —— 只有当 dsh 进程的启动 cwd 与历史一致时才有效。
 */
export function legacyCollabDirs(env: EnvLike = process.env): string[] {
  void env
  return [
    path.resolve('.dsh', 'collab', 'projects'),
    path.join(homedir(), '~', '.dsh', 'collab', 'projects')
  ]
}

/** 诊断用：一次性给出正确落点与全部历史落点（供工具返回 / 日志展示）。 */
export function describeCollabPaths(env: EnvLike = process.env): { stateDir: string; legacyDirs: string[] } {
  return { stateDir: collabDir(env), legacyDirs: legacyCollabDirs(env) }
}
