(window as any).__ModuleLoader__.load({
  id: 'dsh-collab',
  factory: (require: (id: string) => any) => {
    /**
     * dsh-collab 的浏览器半边：侧边栏「插件」页里 dsh-collab 那张 bundle 卡上的配置区。
     *
     * 卡里是两个开关：「委托与验收纪律」（关闭 / 集群协作）与「原生写保护」（拦截 / 不拦截）。
     *
     * 偏好不在这里自存：表单是 `configForms` 上这张配置的控制器，写进去的字段就是本插件
     * 在 profile 里的 Config（0.1.7 起设置由当前 Profile 的插件配置保存）。
     *
     * 手写 `__ModuleLoader__.load` 包装是浏览器半边的加载协议：客户端插件以「一个
     * 自带 id 的工厂」注册，`require` 由加载器注入。全文件不使用 JSX ——
     * `React.createElement` 的第三个参数起是 children，而自动 jsx runtime 从
     * `props.children` 读取，混用会静默渲染出空元素。
     */
    var module = { exports: {} as any }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /**
     * 官方表单原语：本页的**保存 / 放弃 / 暂存**语义全部由它们承担，不自己发明。
     * `SettingsFormModel` 把一个命名空间的暂存编辑投影成组件读的 store；
     * `SettingsForm` 画保存栏；`SettingsValueField` 画一个带覆盖标记与重置按钮的字段；
     * `Switch` 是官方给两态字段的控件（原语里没有布尔字段 helper，`SettingsValueField`
     * 画的是文本框，所以开关由卡片自己挂）。
     */
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const SettingsForm = primitives.SettingsForm
    const SettingsValueField = primitives.SettingsValueField
    const SettingsFormModel = primitives.SettingsFormModel
    const Switch = primitives.Switch
    const settingsNumberField = primitives.settingsNumberField
    const settingsTextField = primitives.settingsTextField

    /**
     * 本插件在 profile 里的**条目 id**，也就是配置表单的命名空间。
     * 与 Host 半边 `DELEGATION_SETTINGS_NAMESPACE` 逐字一致（`cordis.patch.yml` 的 id）。
     */
    const NS = 'collab'
    /** 本卡片编辑的唯一字段（布尔，默认 true；已持久化的值不能改名/改型）。 */
    const FIELD = 'exposeDelegationDiscipline'
    /** 功能 C 的写保护开关（布尔，默认 **true**；字段名必须与 Host 半边 schema 逐字一致）。 */
    const WRITE_LOCK_FIELD = 'enforceWriteLock'
    /** 侧边栏「插件」页里本插件那张配置卡的键：必须是 bundle 的包名（= package.json 的 name）。 */
    const BUNDLE_KEY = 'dsh-collab'
    /** 「委托与验收纪律」开关的两档状态词。 */
    const OFF_LABEL = '关闭'
    const ON_LABEL = '集群协作'
    /** 「原生写保护」开关的两档状态词。 */
    const LOCK_ON_LABEL = '拦截'
    const LOCK_OFF_LABEL = '不拦截'

    /** 配置表单快照中本卡片真正用到的字段（对应 `configForms` 的 ConfigFormController 快照）。 */
    interface ScopeSnapshot {
      status: 'loading' | 'ready' | 'unavailable'
      value: {
        exposeDelegationDiscipline?: boolean
        enforceWriteLock?: boolean
      } | undefined
      writable: boolean
      revision: number | undefined
    }

    /**
     * 内联样式：本包不发布 CSS。用到的主题变量都能在已安装的客户端样式里确认
     * （settings-plugins 的卡片 / ValueField 样式），不猜变量名。
     */
    const styles: Record<string, any> = {
      summary: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '13px',
        lineHeight: 1.5
      },
      page: { display: 'flex', flexDirection: 'column', gap: '8px' },
      item: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 0' },
      itemHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      itemLabel: {
        minWidth: 0,
        flex: 1,
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        fontWeight: 500,
        lineHeight: 1.5
      },
      itemType: {
        flex: 'none',
        color: 'var(--dsw-alias-label-tertiary)',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px',
        padding: '1px 6px',
        fontSize: '11px',
        lineHeight: 1.5
      },
      controls: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      select: {
        font: 'inherit',
        height: '34px',
        minWidth: '140px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '0 10px',
        fontSize: '13px'
      },
      /** 秒数输入框：与 select 同一套边框/底色 token，宽度收窄到够放四位数。 */
      number: {
        font: 'inherit',
        height: '34px',
        width: '84px',
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px',
        padding: '0 10px',
        fontSize: '13px'
      },
      /** 数字后面的单位（"秒"）：只做说明，不可点。 */
      unit: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' },
      /** 覆盖标记：与 ValueField 里的 Tag 同位，只用文字不上色，免得抢注意力。 */
      badge: {
        flex: 'none',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: 1.5
      },
      /** 「恢复默认」：官方字段里的 reset 是同款无边框文字按钮。 */
      reset: {
        appearance: 'none',
        cursor: 'pointer',
        border: 'none',
        background: 'none',
        padding: 0,
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-secondary)'
      },
      /** 开关旁的两档状态词：一个滑块本身说不出「开」是什么意思。 */
      state: {
        flex: 'none',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: 1.5
      },
      /** 字段之间的发丝线（官方 fields.module.css 的 `.field + .field` 同款）。 */
      hr: { borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
      hint: {
        color: 'var(--dsw-alias-label-tertiary)',
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5
      },
      placeholder: {
        color: 'var(--dsw-alias-label-tertiary)',
        margin: 0,
        padding: '14px 16px',
        fontSize: '13px',
        lineHeight: 1.5
      }
    }

    /**
     * 依赖的客户端服务：槽位注册表 + 配置表单（`configForms`，由 dsh-client-ui-settings 提供）。
     *
     * 0.1.7 起客户端不再有 `settingsScope`：设置页读写的统一入口是 `configForms`，
     * 它是「当前 Profile 的插件配置」在浏览器里的那张表单（`ConfigFormController`）。
     */
    const inject = ['slots', 'configForms']

    /**
     * 挂载设置卡片。
     * @param ctx - 浏览器端插件上下文。
     */
    function apply(ctx: any) {
      // 只绑定一次：卡片组件闭包持有它，因此不必经 props 传递。
      // `configForms.get(entryId)` 用的 entryId 是**本插件在 profile 里的条目 id**，
      // 与 Host 半边 Config 的命名空间同一个值。
      const scope = ctx.configForms.get(NS)

      /**
       * 官方暂存表单：三个布尔开关 + 一个数字字段。
       *
       * 布尔字段用 `settingsTextField`（存 "on"/"off" 文本再在 parse 时翻译）——
       * 官方原语没有布尔字段 helper（见 `dsh-client-ui-primitives` 的 `settingsNumberField` /
       * `settingsTextField`），而 `SettingsValueField` 画的就是一个文本输入，所以布尔在这里
       * 表示成两档文本。这不是自造语义：写回 Host 的值仍是真正的 boolean。
       */
      const booleanField = (field: string) => ({
        field,
        format: (value: any) => (value === false ? 'off' : 'on'),
        parse: (text: string) => ({ kind: 'set', value: text.trim() !== 'off' })
      })

      /**
       * 一个布尔字段的开关行。
       *
       * 表单协议不变：`booleanField` 仍以 "on"/"off" 文本暂存，写回 Host 的仍是真 boolean；
       * 换掉的只有控件 —— 官方原语没有布尔字段 helper，`SettingsValueField` 画的是文本框，
       * 所以这里挂官方 `Switch`，并把两态的可读名字放在它旁边（一个滑块本身说不出「开」
       * 代表什么）。标签用纯文本而不是 `<label for>`：`Switch` 自己带 `label` 无障碍名，
       * 官方设置页也是这么挂的。
       *
       * @param props - 槽位注入的官方表单动作（edit / resetField / save / discard）。
       * @param state - `useCollabForm` 交给组件的投影：四个字段读数 + `shell`。
       * @param name - Host Config 里的字段名（与 schema 逐字一致）。
       * @param label - 字段标题。
       * @param hint - 字段说明。
       * @param onText - 打开时的状态词。
       * @param offText - 关闭时的状态词。
       */
      function booleanSwitch(
        props: any,
        state: any,
        name: string,
        label: string,
        hint: string,
        onText: string,
        offText: string
      ) {
        const node = state[name]
        const locked = !state.shell.writable || state.shell.saving
        // 与 `booleanField` 的 parse 同一条判据：只有 "off" 是假，其余（含未设置）都是真。
        const on = node.text !== 'off'
        return h(
          'div',
          { key: name, style: styles.item },
          h(
            'div',
            { style: styles.itemHead },
            h('span', { style: styles.itemLabel }, label),
            node.overridden
              ? h(
                  'span',
                  { style: styles.controls },
                  h('span', { style: styles.badge }, '已覆盖'),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: styles.reset,
                      disabled: locked,
                      onClick: () => { props.resetField(name) }
                    },
                    '恢复默认'
                  )
                )
              : null,
            h('span', { style: styles.state }, on ? onText : offText),
            h(Switch, {
              checked: on,
              label: label,
              disabled: locked,
              onChange: (next: boolean) => { props.edit(name, next ? 'on' : 'off') }
            })
          ),
          h('p', { style: styles.hint }, hint)
        )
      }
      const formModel = new SettingsFormModel(scope, [
        booleanField(FIELD),
        booleanField(WRITE_LOCK_FIELD)
      ])
      ctx.effect(() => () => { formModel.dispose() })

      /** 保存栏文案。官方 `SettingsForm` 的 `labels` 契约，逐字对齐 `ui-settings-agent-loop`。 */
      const formLabels = {
        unavailable: '本部署没有提供这项配置。',
        readOnly: '本部署的配置为只读，无法在此修改。',
        save: '保存',
        saving: '保存中…',
        saveFailed: '保存失败，改动未生效。'
      }

      /**
       * 把表单投影成组件读的 store：`shell` 是保存栏状态，四个字段各是一份读数。
       * 官方页面用同样的形状把 `SettingsFormModel` 交给 slot（见 `ui-settings-agent-loop`
       * 的 `AgentLoopCardController.inject()`）。
       */
      const formStore = formModel.bind(() => ({
        shell: formModel.shell(),
        [FIELD]: formModel.field(FIELD),
        [WRITE_LOCK_FIELD]: formModel.field(WRITE_LOCK_FIELD)
      }))
      ctx.effect(() => () => { formStore.dispose() })

      /**
       * 侧边栏「插件」页里 dsh-collab 那张组合包卡上的配置区。
       *
       * 保存语义由官方表单原语承担（`SettingsForm` 的保存栏 + `SettingsFormModel` 的暂存）：
       * 离开页面即丢弃未保存的草稿，只有点保存才写 Host。这里只负责画两个字段。
       */
      function CollabConfigEntry(props: any) {
        const state = props.useCollabForm((s: any) => s)
        // 表单未就绪（Host 还没服务这个命名空间）时整块不渲染 —— 官方页面同款：
        // `SettingsForm` 自己在 `available` 为假时画一句「不可用」，所以这里交给它。
        const field = (name: string) => state[name]
        /**
         * 字段之间的发丝线。
         *
         * 每个字段都是「标题 + 一行说明」的同一种节奏，挨着排会读成一段散文；
         * 一条分隔线让每一行自成一件事（官方 `fields.module.css` 就是 `.field + .field`
         * 加同款 0.5px 边框）。
         */
        const hr = (key: string) => h('div', { key: key, style: styles.hr })

        return h(
          SettingsForm,
          {
            labels: formLabels,
            state: state.shell,
            onSave: props.save,
            onDiscard: props.discard
          },
          h(
            'div',
            { style: styles.page },
            booleanSwitch(props, state, FIELD, '委托与验收纪律',
              '集群协作：把委托与验收纪律文本注入会话上下文，并注册随包技能；关闭则两者都撤回。',
              ON_LABEL, OFF_LABEL),
            hr('hr-discipline'),
            booleanSwitch(props, state, WRITE_LOCK_FIELD, '原生写保护',
              '拦截：写入/修改他人已声明占用的路径前先走原生审批（本部署没有审批提示时，ask 会变成硬拒绝）；关闭则完全不拦。',
              LOCK_ON_LABEL, LOCK_OFF_LABEL),
            hr('hr-lock')
          )
        )
      }

      // 配置挂到侧边栏「插件」页里 dsh-collab 那张组合包卡上：`key` 必须是组合包的**包名**
      // （插件页用 `ledger.bundles.has(openPkg.name)` 决定要不要渲染这个配置区）。
      // 标题、图标、面包屑由插件页自绘，所以这里只出 `view: 'page'` 的表单正文。
      //
      // `hooks: { collabForm: store }` 是官方的 store→React 通道：渲染器把每个 hook 源绑成
      // `props.use<Name>`（`dsh-client-ui-renderer/lib/client.js:1662` 的 `copyUnique` +
      // `standardHookPropName`），组件里就是 `props.useCollabForm(selector)`。官方
      // `ui-settings-agent-loop` 用同一形状（`hooks: { agentLoopCard: this.store }`）。
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: BUNDLE_KEY,
            inject: () => ({
              hooks: { collabForm: formStore },
              ...formModel.actions()
            })
          },
          CollabConfigEntry
        )
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
