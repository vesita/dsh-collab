// src/delegation.ts
// **委托纪律：偏好在 settings（可选服务），默认开**。技能正文随包走，常驻纪律块是常量。
// 服务缺失、文件缺失、解析失败一律静默跳过，绝不抛、也绝不阻断工具注册。
//
// 依赖：运行时上下文注册面（surface，来自 awareness）。
// 对外暴露偏好读取面：gate 用它做写保护总开关（活读，不是快照）。

import { dirname } from 'node:path'
import {
  DELEGATION_SETTINGS_NAMESPACE, DELEGATION_SETTINGS_SCHEMA, DELEGATION_SETTINGS_ENTRY, DELEGATION_DISCIPLINE_TEXT,
  LOOP_END_GRACE_SEC_DEFAULT, LOOP_END_GRACE_SEC_MIN, LOOP_END_GRACE_SEC_MAX
} from './spec.js'
import { loadBundledSkill } from './skill.js'
import type { CollabContext, DelegationSettings, SettingsService, SkillsService } from './contract.js'
import type { AwarenessSurface } from './awareness.js'

/** 偏好读取面：installDelegation() 对外暴露的东西（gate 与 auto-release 消费）。 */
export interface DelegationPrefs {
  /** 功能 C 的写保护总开关，**活读**；默认 true。 */
  enforceWriteLockEnabled(): boolean
  /** 循环终止自动释放总开关，**活读**；默认 true（见 src/auto-release.ts）。 */
  releaseOnLoopEndEnabled(): boolean
  /** 循环终止自动释放的宽限毫秒数，**活读**；默认 15 秒，夹在 spec 的上下界内。 */
  loopEndGraceMs(): number
}

export function installDelegation(ctx: CollabContext, surface: AwarenessSurface): DelegationPrefs {
  // ---- 委托纪律：偏好在 settings（**可选服务**），默认开 ----
  // 技能正文随包走（<pkg>/skills/subagent-delegation/SKILL.md），所以按构建产物的位置解析，
  // 而不是猜用户 ~/.dsh/skills/ 的落点。锁与留言板是产品本体，纪律只是附加项：
  // 服务缺失、文件缺失、解析失败一律**静默跳过**，绝不抛、也绝不阻断上面的工具注册。
  //
  // 关键约束：偏好的值必须**活读**。installSection 会把 setSource 换成返回注册表实时
  // resolved 值的读取器，用户一改设置 onChange 就触发重新结算 —— 不需要重启进程。
  // 这里缓存的只是"读取器"，不是值本身。
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

  /**
   * 循环终止自动释放的开关，**活读**（同一份读取器）。默认 true：
   * 读设置失败、服务缺失、字段缺省都按"**开**"处理 —— 这条功能的默认值就是用户的诉求
   * （删掉那个"会话循环停了、锁还在"的死锁），只有显式 false 才关。
   */
  const releaseOnLoopEndEnabled = (): boolean => {
    try {
      const value = readSettings ? readSettings() : DELEGATION_SETTINGS_ENTRY
      return !value || value.releaseOnLoopEnd !== false
    } catch (e) {
      return true
    }
  }

  /**
   * 宽限毫秒数，**活读**。非有限数 / 越界一律回落到默认 15 秒：
   * 这条值决定"多久之后自动放锁"，绝不接受 NaN（会让计时器立即触发）或 0 之类的坏输入。
   */
  const loopEndGraceMs = (): number => {
    let sec = LOOP_END_GRACE_SEC_DEFAULT
    try {
      const value = readSettings ? readSettings() : DELEGATION_SETTINGS_ENTRY
      const raw = Number(value && value.loopEndGraceSec)
      if (Number.isFinite(raw)) sec = Math.min(LOOP_END_GRACE_SEC_MAX, Math.max(LOOP_END_GRACE_SEC_MIN, raw))
    } catch (e) {
      sec = LOOP_END_GRACE_SEC_DEFAULT
    }
    return Math.round(sec * 1000)
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

  // settings 的接线：可选服务，缺失时保持默认值（开）。
  // 若此刻 settings 已经可用，则**不**先按默认值落地，等 installSection 把实时读取器交上来
  // 再由 onChange 结算 —— 否则"偏好为关"时会先注册再撤回，留下一次无谓的瞬时注册。
  const settingsNow = ctx.get('settings') as SettingsService | undefined
  const settingsUsable = !!(settingsNow && typeof settingsNow.installSection === 'function')
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      const settings = settingsCtx.settings
      if (settings && typeof settings.installSection === 'function') {
        settings.installSection(ctx, DELEGATION_SETTINGS_NAMESPACE, DELEGATION_SETTINGS_SCHEMA, DELEGATION_SETTINGS_ENTRY, {
          setSource: (source) => { readSettings = () => source() },
          onChange: () => { reconcileDelegation() }
        })
      }
    } catch (e) {}
    // 兜底：installSection 缺席或失败（例如命名空间被占用）时，仍按当时的可读值结算。
    reconcileDelegation()
  })
  if (!settingsUsable) reconcileDelegation()

  return { enforceWriteLockEnabled, releaseOnLoopEndEnabled, loopEndGraceMs }
}
