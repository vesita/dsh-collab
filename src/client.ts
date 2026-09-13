(window as any).__ModuleLoader__.load({
  id: 'dsh-collab',
  factory: (require: (id: string) => any) => {
    /**
     * dsh-collab 的浏览器半边：Settings → Plugins 下 `dsh-collab` 命名空间的配置卡片。
     *
     * Host 半边用 `ctx.settings.installSection(...)` 注册了 `dsh-collab` 命名空间，
     * 但设置页只**枚举**命名空间、从不解释它：一张卡片是通过 `settings.plugin.item`
     * 按「它编辑的命名空间」为 key 注册进来的，所以**谁拥有设置谁自带卡片**。
     * 这里就是 dsh-collab 自己的那张卡。
     *
     * 手写 `__ModuleLoader__.load` 包装是浏览器半边的加载协议：浏览器端没有打包器，
     * 客户端插件以「一个自带 id 的工厂」形式注册，`require` 由加载器注入，只保证
     * react 与共享的客户端包可用。全文件不使用 JSX —— `React.createElement` 的
     * 第三个参数起是 children，而自动 jsx runtime 从 `props.children` 读取，混用会
     * 静默渲染出空元素。
     */
    var module = { exports: {} as any }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 设置命名空间，必须与 Host 半边 installSection 的 ns 逐字一致。 */
    const NS = 'dsh-collab'
    /** 本卡片编辑的唯一字段。 */
    const FIELD = 'exposeDelegationDiscipline'

    /** scope 快照中本卡片真正用到的字段。 */
    interface ScopeSnapshot {
      status: 'loading' | 'ready' | 'unavailable'
      value: { exposeDelegationDiscipline?: boolean } | undefined
      writable: boolean
      revision: number | undefined
    }

    /**
     * 内联样式：本包不发布 CSS。主题变量只写**被真正定义过**的别名令牌
     * （`--dsw-alias-*`，定义在 `dsh-client-ui-theme`）——写一个不存在变量名不会报错，
     * 只会让那条 CSS 属性被静默丢弃。
     */
    const styles: Record<string, any> = {
      card: {
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-3)',
        borderRadius: '16px',
        listStyle: 'none',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px'
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
      label: {
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '15px',
        fontWeight: 600,
        lineHeight: 1.4
      },
      hint: {
        color: 'var(--dsw-alias-label-tertiary)',
        margin: 0,
        fontSize: '13px',
        lineHeight: 1.5
      },
      placeholder: {
        listStyle: 'none',
        color: 'var(--dsw-alias-label-tertiary)',
        margin: 0,
        padding: '14px 16px',
        fontSize: '13px',
        lineHeight: 1.5
      },
      failed: {
        color: 'var(--dsw-alias-state-error-primary)',
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5
      }
    }

    /** 依赖的客户端服务：槽位注册表 + 设置命名空间 scope。 */
    const inject = ['slots', 'settingsScope']

    /**
     * 挂载设置卡片。
     * @param ctx - 浏览器端插件上下文。
     */
    function apply(ctx: any) {
      // 只绑定一次：卡片组件闭包持有它，因此不必经 props 传递。
      const scope = ctx.settingsScope.bind({ namespace: NS })

      /**
       * `dsh-collab` 命名空间的配置卡片。
       *
       * 受控复选框直接写 Host：勾选即 `scope.set`，快照回推后自然反映结果。
       * 三种快照状态都如实处理：加载中给一行安静占位；命名空间不可用（本部署
       * 没装 Host 半边）就完全不渲染；只读部署把控件禁用而不是假装可写。
       */
      function CollabSettingsCard() {
        const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot() as ScopeSnapshot)
        const [saving, setSaving] = React.useState(false)
        const [failed, setFailed] = React.useState(false)

        React.useEffect(() => {
          setSnapshot(scope.getSnapshot())
          return scope.subscribe(() => setSnapshot(scope.getSnapshot()))
        }, [])

        React.useEffect(() => {
          if (!failed) return undefined
          const timer = setTimeout(() => setFailed(false), 4000)
          return () => clearTimeout(timer)
        }, [failed])

        // hooks 必须无条件调用，早退只能发生在它们之后。
        if (snapshot.status === 'loading') {
          return h('li', { style: styles.placeholder, role: 'status' }, '正在加载设置…')
        }
        if (snapshot.status === 'unavailable') return null

        // schema 默认开启：只有显式关掉才是关。
        const checked = snapshot.value?.exposeDelegationDiscipline !== false
        const disabled = snapshot.writable !== true || saving

        const toggle = () => {
          if (disabled) return
          const next = !checked
          setSaving(true)
          setFailed(false)
          Promise.resolve(scope.set(FIELD, next)).then(
            () => setSaving(false),
            () => {
              setSaving(false)
              setFailed(true)
            }
          )
        }

        return h(
          'li',
          { style: styles.card },
          h(
            'label',
            { style: styles.row },
            h('input', { type: 'checkbox', checked, disabled, onChange: toggle }),
            h('span', { style: styles.label }, '委托与验收纪律')
          ),
          h(
            'p',
            { style: styles.hint },
            '开启后，新会话的运行时上下文会注入委托与验收纪律文本（默认开启）。'
          ),
          !snapshot.writable
            ? h('p', { style: styles.hint, role: 'status' }, '本部署的设置为只读，无法在此修改。')
            : null,
          failed ? h('p', { style: styles.failed, role: 'status' }, '写入失败，设置未改变。') : null
        )
      }

      ctx.slots.inject('settings.plugin.item', () =>
        ctx.slots.register({ name: 'settings.plugin.item', key: NS }, CollabSettingsCard)
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
