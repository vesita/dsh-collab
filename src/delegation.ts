// src/delegation.ts
// **委托纪律：偏好是本插件的 Config volatile 字段，默认开**。技能正文随包走，常驻纪律块是常量。
// 字段缺失、文件缺失、解析失败一律静默跳过，绝不抛、也绝不阻断工具注册。
//
// 依赖：运行时上下文注册面（surface，来自 awareness）。
// 对外暴露偏好读取面：gate 用它做写保护总开关（活读，不是快照）。

import { dirname } from 'node:path'
import { DELEGATION_SETTINGS_ENTRY, DELEGATION_DISCIPLINE_TEXT } from './spec.js'
import { loadBundledSkill } from './skill.js'
import type { CollabContext, DelegationSettings, SkillsService } from './contract.js'
import type { AwarenessSurface } from './awareness.js'

/** 偏好读取面：installDelegation() 对外暴露的东西（gate 消费）。 */
export interface DelegationPrefs {
  /** 功能 C 的写保护总开关，**活读**；默认 true。 */
  enforceWriteLockEnabled(): boolean
}

export function installDelegation(
  ctx: CollabContext,
  surface: AwarenessSurface,
  config?: Record<string, unknown> | null
): DelegationPrefs {
  // ---- 委托纪律：偏好是 Config 的 volatile 字段，默认开 ----
  // 技能正文随包走（<pkg>/skills/agent-delegation/SKILL.md），所以按构建产物的位置解析，
  // 而不是猜用户 ~/.dsh/skills/ 的落点。锁与留言板是产品本体，纪律只是附加项：
  // 字段缺失、文件缺失、解析失败一律**静默跳过**，绝不抛、也绝不阻断上面的工具注册。
  //
  // 关键约束：偏好的值必须**活读**。Loader 改 volatile 字段时是就地更新同一个 config 引用
  // （不是重建插件），所以从 `apply(ctx, config)` 收到的那个对象上现读 `config[field]` 就能拿到
  // 当前值；`loader/volatile-update` 到达时重新结算交付物 —— 不需要重启进程。
  // 这里缓存的只是"读取器"，不是值本身。
  //
  // **别写 `ctx.config`**：Cordis 的 ctx 是代理，未 inject `config` 服务时读它会**抛错**，
  // 而且在参数求值处就炸、try/catch 接不住。要可选地拿宿主配置用 `ctx.get('config')`，
  // 拿到对象之后再读字段。
  let readSettings: (() => DelegationSettings) | null = null
  let skillStop: (() => void) | null = null
  let disciplineStop: (() => void) | null = null

  const delegationEnabled = (): boolean => {
    try {
      const value = readSettings ? readSettings() : DELEGATION_SETTINGS_ENTRY
      return !value || value.exposeDelegationDiscipline !== false
    } catch (e) {
      return true // 读设置失败按默认开处理：附加能力不该因为读取异常而消失
    }
  }

  /**
   * 功能 C 的门控开关，**活读**（与 delegationEnabled 同源的那份读取器）。
   * 默认 true：读设置失败、服务缺失、字段缺省都按"**必须拦**"处理 ——
   * 写保护失效比多拦一次危险得多。只有显式 false 才关闭。
   */
  const enforceWriteLockEnabled = (): boolean => {
    try {
      const value = readSettings ? readSettings() : DELEGATION_SETTINGS_ENTRY
      return !value || value.enforceWriteLock !== false
    } catch (e) {
      return true
    }
  }

  // 按当前偏好结算两项交付物；开则注册，关则撤回。注册与撤回都走 effect disposer，可逆。
  function reconcileDelegation(): void {
    try {
      const on = delegationEnabled()

      // a) 随包 skill
      if (on && !skillStop) {
        const skills = ctx.get('skills') as SkillsService | undefined
        const skill = skills && typeof skills.register === 'function' ? loadBundledSkill() : null
        if (skills && skill) {
          ctx.effect(() => {
            const off = skills.register({
              name: skill.name,
              description: skill.description,
              whenToUse: skill.whenToUse,
              content: skill.content,
              source: 'bundled',
              provider: 'dsh-collab',
              path: skill.path,
              resourceBase: { kind: 'directory', path: dirname(skill.path) },
              invocation: { modelInvocable: true, userInvocable: true }
            })
            let live = true
            skillStop = () => { if (!live) return; live = false; skillStop = null; off() }
            return () => { if (!live) return; live = false; skillStop = null; off() }
          })
        }
      } else if (!on && skillStop) {
        const stop = skillStop
        skillStop = null
        stop()
      }

      // b) 常驻纪律上下文：skill 是按需拉取的，而这段文本要的是"默认就发生"。
      // DSH_COLLAB_NO_PROMPT_HINT=1 是包形态的总开关：它关掉**所有**运行时注入的内容 ——
      // 上下文段（本段与态势段），以及功能 A 逐事件投递的访问通知（见 access.ts 的 NOTICE_ENABLED）。
      // 所以这里一并遵守（该开关不管 skill 注册）。
      if (on && surface.promptHintEnabled && !disciplineStop) {
        if (surface.systemPrompt && typeof surface.systemPrompt.context === 'function') {
          ctx.effect(() => {
            const off = surface.systemPrompt.context({
              name: 'dsh-collab/delegation',
              order: 131,
              // 常量：每次装配返回同一个串，快照去重才能生效。
              // 官方 Agent Teams 是否在场**都不追加任何文本** —— teammate 工具语义由官方
              // `team:policy` 段自己给出（`dsh-experimental-tool-agent-team/lib/index.js:21-27`），
              // 本插件重讲一遍就是重复建设。纪律块里只留官方不覆盖的：委托判据、验收、
              // 并发约束，以及"被唤醒的子智能体不知道自己已经丢锁"这条 collab 事实。
              text: () => DELEGATION_DISCIPLINE_TEXT
            })
            let live = true
            disciplineStop = () => { if (!live) return; live = false; disciplineStop = null; off() }
            return () => { if (!live) return; live = false; disciplineStop = null; off() }
          })
        }
      } else if ((!on || !surface.promptHintEnabled) && disciplineStop) {
        const stop = disciplineStop
        disciplineStop = null
        stop()
      }
    } catch (e) {}
  }

  // 设置的接线（0.1.7）：偏好就是这个插件 Config 上的 volatile 字段，`apply(ctx, config)`
  // 拿到的是 Loader 解析后的那份 Config。
  //
  // 关键：`.volatile()` 字段不是普通值，而是一个**稳定引用**（`{ get() }`，见
  // `@deepseek-ai/cosmokit` 的 `Volatile` 与 `isVolatile`）。Loader 改一个 volatile 字段时
  // 并不重载插件 —— 它把新快照提交进同一个引用的内部，再发 `loader/volatile-update`
  // （`cordis-plugin-loader/lib/index.js` 的 `_commitVolatile`）。所以每次 `get()` 都拿到当前值，
  // 这里保存的只是"读取器"，不是值本身。官方适配器同款读法：
  // `dsh-llm-deepseek/lib/index.js:2014` 的 `plainOptions()`。
  //
  // 非 volatile 字段是普通值，两种形态都要认；Config 缺席（没有 Loader 的迷你宿主）
  // 则按 schema 默认值结算，见 DELEGATION_SETTINGS_ENTRY。
  const readField = (field: keyof DelegationSettings): unknown => {
    try {
      const raw = config ? config[field] : undefined
      return raw && typeof (raw as { get?: unknown }).get === 'function'
        ? (raw as { get(): unknown }).get()
        : raw
    } catch (e) {
      return undefined
    }
  }

  /** 布尔开关的读法：缺省、读取异常都按 schema 默认（开）处理。 */
  const readFlag = (field: keyof DelegationSettings): boolean => readField(field) !== false

  readSettings = () => ({
    exposeDelegationDiscipline: readFlag('exposeDelegationDiscipline'),
    enforceWriteLock: readFlag('enforceWriteLock'),
  })

  // volatile 字段被改：Loader 已把新快照提交进引用，这里只负责按新值结算交付物。
  ctx.on('loader/volatile-update', () => { reconcileDelegation() })

  reconcileDelegation()

  return { enforceWriteLockEnabled }
}
