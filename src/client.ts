(window as any).__ModuleLoader__.load({
  id: 'dsh-collab',
  factory: (require: (id: string) => any) => {
    /**
     * dsh-collab 的浏览器半边：侧边栏「插件」页里 dsh-collab 那张 bundle 卡上的配置区。
     *
     * 卡里的「委托与验收纪律」带一个下拉（关闭 / 集群协作）与一个「预览」按钮：
     * 预览用 DSH 自己的右侧文档面板打开随包技能正文，**不离开插件页** ——
     * `plugins.bundle.config` 只给 `view` 一个 prop，也拿不到关闭句柄（详见 README）。
     *
     * 偏好不在这里自存：表单是 `configForms` 上这张配置的控制器，写进去的字段就是本插件
     * 在 profile 里的 Config（0.1.7 起设置由当前 Profile 的插件配置保存）。
     *
     * 两处只能由 Host 交出的事实，走 host 半边注册的只读 loopback 路由
     * `GET /dsh-collab/skill-index`：随包 skill 的**绝对路径**（浏览器拿不到包的安装
     * 位置）与名称/描述。正文不过网 —— 右侧文档面板自己读文件。
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
     * `SettingsForm` 画保存栏；`SettingsValueField` 画一个带覆盖标记与重置按钮的字段。
     */
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const SettingsForm = primitives.SettingsForm
    const SettingsValueField = primitives.SettingsValueField
    const SettingsFormModel = primitives.SettingsFormModel
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
    /** 循环终止自动释放的开关（布尔，默认 **true**；字段名与 Host 半边 schema 逐字一致）。 */
    const AUTO_RELEASE_FIELD = 'releaseOnLoopEnd'
    /** 上面那条的宽限期秒数（数字，默认 15；Host 半边把它夹在 [1, 3600]）。 */
    const AUTO_RELEASE_GRACE_FIELD = 'loopEndGraceSec'
    /** Host 半边 spec.ts 的三个常量，逐字对齐（这里只做前端夹取与回退，权威仍在 Host）。 */
    const GRACE_MIN = 1
    const GRACE_MAX = 3600
    const GRACE_DEFAULT = 15
    /** Host 半边注册的只读技能索引路由。 */
    const SKILL_ROUTE = '/dsh-collab/skill-index'
    /** 侧边栏「插件」页里本插件那张配置卡的键：必须是 bundle 的包名（= package.json 的 name）。 */
    const BUNDLE_KEY = 'dsh-collab'
    /** 下拉的两档文案。 */
    const OFF_LABEL = '关闭'
    const ON_LABEL = '集群协作'
    /** 写保护开关的两档文案。 */
    const LOCK_ON_LABEL = '拦截'
    const LOCK_OFF_LABEL = '不拦截'
    /** 循环终止自动释放的两档文案。 */
    const AUTO_ON_LABEL = '自动释放'
    const AUTO_OFF_LABEL = '不自动释放'
    /**
     * `dsh-resource://file/session/<sessionId>/<path>` 前缀。
     * 只读**会话作用域**：`absolute` 作用域在本部署读不了 —— 文档预览类型的
     * `canOpen` 要求 `parseFileAddress(address)?.scope === 'session'`，
     * 且 `sidebarRight.claim` 对无人认领的地址直接抛错。
     */
    const RESOURCE_PREFIX = 'dsh-resource://file/session/'

    /**
     * 把绝对路径编成资源地址的路径段：逐段 `encodeURIComponent`，分隔符不编码。
     * Windows 盘符路径先归一成 `/` 分隔（部署的资源语法只认一种分隔符）。
     */
    function encodeSegments(path: string): string {
      const normalized = /^[A-Za-z]:/.test(path) ? path.replace(/\\/g, '/') : path
      return normalized.split('/').map(encodeURIComponent).join('/')
    }

    /** 用当前会话把绝对路径编成 session 作用域地址（相对路径不适用：技能在包目录里）。 */
    function sessionFileAddress(sessionId: string, absolutePath: string): string {
      return RESOURCE_PREFIX + encodeURIComponent(sessionId) + '/' + encodeSegments(absolutePath)
    }

    /** 配置表单快照中本卡片真正用到的字段（对应 `configForms` 的 ConfigFormController 快照）。 */
    interface ScopeSnapshot {
      status: 'loading' | 'ready' | 'unavailable'
      value: {
        exposeDelegationDiscipline?: boolean
        enforceWriteLock?: boolean
        releaseOnLoopEnd?: boolean
        loopEndGraceSec?: number
      } | undefined
      writable: boolean
      revision: number | undefined
    }

    /** 随包技能：路由只交出路径与名称/描述，正文由右侧面板读文件。 */
    interface SkillInfo {
      name: string
      description: string
      whenToUse?: string
      path: string
    }

    interface SkillState {
      status: 'loading' | 'ready' | 'error'
      skill: SkillInfo | null
      error: string | null
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
      button: {
        appearance: 'none',
        font: 'inherit',
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '8px',
        padding: '5px 14px',
        fontSize: '13px',
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-secondary)',
        background: '0 0'
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
      hint: {
        color: 'var(--dsw-alias-label-tertiary)',
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.5
      },
      failed: {
        color: 'var(--dsw-alias-label-error)',
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
      const formModel = new SettingsFormModel(scope, [
        booleanField(FIELD),
        booleanField(WRITE_LOCK_FIELD),
        booleanField(AUTO_RELEASE_FIELD),
        settingsNumberField(AUTO_RELEASE_GRACE_FIELD)
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
        [WRITE_LOCK_FIELD]: formModel.field(WRITE_LOCK_FIELD),
        [AUTO_RELEASE_FIELD]: formModel.field(AUTO_RELEASE_FIELD),
        [AUTO_RELEASE_GRACE_FIELD]: formModel.field(AUTO_RELEASE_GRACE_FIELD)
      }))
      ctx.effect(() => () => { formStore.dispose() })

      /** 取一个可选服务；拿不到就返回 undefined（绝不抛）。 */
      function service(name: string): any {
        try {
          return ctx.get(name)
        } catch (e) {
          return undefined
        }
      }

      /** 当前选中的会话 id；设置页是全局面板，右侧栏却挂在会话上。 */
      function currentSessionId(): string | null {
        try {
          const sessions = service('sessions')
          const snapshot = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
            ? sessions.list.getSnapshot()
            : null
          const id = snapshot ? snapshot.current : null
          return typeof id === 'string' && id.length > 0 ? id : null
        } catch (e) {
          return null
        }
      }

      /**
       * 侧边栏「插件」页里 dsh-collab 那张组合包卡上的配置区。
       *
       * 保存语义由官方表单原语承担（`SettingsForm` 的保存栏 + `SettingsFormModel` 的暂存）：
       * 离开页面即丢弃未保存的草稿，只有点保存才写 Host。这里只负责画四个字段与技能预览。
       */
      function CollabConfigEntry(props: any) {
        const [skill, setSkill] = React.useState({ status: 'loading', skill: null, error: null } as SkillState)
        const [notice, setNotice] = React.useState(null as string | null)

        // 技能索引只取一次：它回答的是「随包技能文件在哪」，与偏好无关。
        React.useEffect(() => {
          let live = true
          const load = async () => {
            try {
              const response = await fetch(SKILL_ROUTE, { headers: { accept: 'application/json' } })
              // 解析失败**不吞**：让 response.json() 的异常直接冒到下面的 catch。
              // 曾经的写法是内层再包一个 try、失败就 payload={} —— 于是"远端返回了非 JSON"
              // 会被降级成 items=[]、status='ready'、skill=null，UI 显示"技能路径不可用"，
              // 把一次真实的响应格式故障说成了"这个技能没随包发布"。**能读懂的错误 > 好看的错误。**
              const payload: any = await response.json()
              if (!response.ok) throw new Error((payload && payload.error) || 'HTTP ' + response.status)
              if (!live) return
              const items = payload && Array.isArray(payload.items) ? payload.items : []
              const match = items.find((entry: any) => entry && entry.field === FIELD) || null
              const found = match && match.skill ? match.skill : null
              setSkill({
                status: 'ready',
                skill: found && typeof found.path === 'string' && found.path.length > 0 ? found : null,
                error: null
              })
            } catch (error) {
              if (!live) return
              setSkill({
                status: 'error',
                skill: null,
                error: (error && error.message) || '无法读取技能索引'
              })
            }
          }
          void load()
          return () => {
            live = false
          }
        }, [])

        React.useEffect(() => {
          if (notice === null) return undefined
          const timer = setTimeout(() => setNotice(null), 6000)
          return () => clearTimeout(timer)
        }, [notice])

        /**
         * 预览：让右侧栏的文档面板打开随包技能正文。
         *
         * 每一处都先确认服务在不在、调用会不会抛 —— 这是浏览器里唯一会失败的路径，
         * 失败只落一句提示，绝不把异常丢进 React。
         *
         * 这里**刻意不调用** `layout.selectPanel(null)`：设置页不是 `layout` 的主面板，
         * 它是 settings-general 里 `SettingsRoot` 的组件内部状态，`selectPanel(null)`
         * 对它无效，反而会把中间主面板的选中项清空（把会话从中间列弄掉）。
         * 本槽位也没有关闭设置页的句柄，见 README。
         */
        const preview = () => {
          const path = skill.skill ? skill.skill.path : null
          if (path === null) {
            setNotice('技能路径不可用，无法预览。')
            return
          }
          const sessionId = currentSessionId()
          if (sessionId === null) {
            setNotice('当前没有已打开的会话，无法在右侧预览。')
            return
          }
          const sidebarRight = service('sidebarRight')
          if (!sidebarRight || typeof sidebarRight.openResource !== 'function') {
            setNotice('右侧栏不可用，无法预览。')
            return
          }
          try {
            sidebarRight.openResource(sessionFileAddress(sessionId, path))
            setNotice('已在右侧打开技能预览。')
          } catch (error) {
            setNotice('打开预览失败：' + ((error && error.message) || '未知错误'))
          }
        }

        const state = props.useCollabForm((s: any) => s)
        // 表单未就绪（Host 还没服务这个命名空间）时整块不渲染 —— 官方页面同款：
        // `SettingsForm` 自己在 `available` 为假时画一句「不可用」，所以这里交给它。
        const field = (name: string) => state[name]

        return h(
          SettingsForm,
          {
            labels: formLabels,
            state: state.shell,
            onSave: props.save,
            onDiscard: props.discard
          },
          h(SettingsValueField, {
            id: 'plugin-config-collab-discipline',
            label: '委托与验收纪律',
            hint: '集群协作：把委托与验收纪律文本注入会话上下文，并注册随包技能；关闭则两者都撤回。',
            overriddenLabel: '已覆盖',
            resetLabel: '恢复默认',
            invalidLabel: '只能是 on 或 off',
            disabled: !state.shell.writable || state.shell.saving,
            ...field(FIELD),
            onEdit: (text: string) => { props.edit(FIELD, text) },
            onReset: () => { props.resetField(FIELD) }
          }),
          skill.status === 'error'
            ? h('p', { style: styles.failed, role: 'status' }, '无法读取技能信息：' + skill.error)
            : null,
          skill.status === 'ready' && skill.skill !== null
            ? h(
                'div',
                { style: styles.previewRow },
                h('button', {
                  type: 'button',
                  style: styles.button,
                  onClick: () => {
                    setNotice(null)
                    preview()
                  }
                }, '预览技能正文'),
                h('span', { style: styles.hint }, skill.skill.description)
              )
            : null,
          h(SettingsValueField, {
            id: 'plugin-config-collab-write-lock',
            label: '原生写保护',
            hint: '拦截：写入/修改他人已声明占用的路径前先走原生审批（本部署没有审批提示时，ask 会变成硬拒绝）；关闭则完全不拦。',
            overriddenLabel: '已覆盖',
            resetLabel: '恢复默认',
            invalidLabel: '只能是 on 或 off',
            disabled: !state.shell.writable || state.shell.saving,
            ...field(WRITE_LOCK_FIELD),
            onEdit: (text: string) => { props.edit(WRITE_LOCK_FIELD, text) },
            onReset: () => { props.resetField(WRITE_LOCK_FIELD) }
          }),
          h(SettingsValueField, {
            id: 'plugin-config-collab-auto-release',
            label: '循环终止自动释放',
            hint: '会话循环停下（空闲超过下面的秒数）后，它持有的声明会被自动释放，让等在后面的会话能接着干；宽限期内被唤醒则取消释放。',
            overriddenLabel: '已覆盖',
            resetLabel: '恢复默认',
            invalidLabel: '只能是 on 或 off',
            disabled: !state.shell.writable || state.shell.saving,
            ...field(AUTO_RELEASE_FIELD),
            onEdit: (text: string) => { props.edit(AUTO_RELEASE_FIELD, text) },
            onReset: () => { props.resetField(AUTO_RELEASE_FIELD) }
          }),
          h(SettingsValueField, {
            id: 'plugin-config-collab-grace',
            label: '空闲宽限期（秒）',
            hint: '夹在 [1, 3600]。0 会把「每个回合之间的停顿」也算成循环终止。',
            overriddenLabel: '已覆盖',
            resetLabel: '恢复默认',
            invalidLabel: '请填一个数字',
            numeric: true,
            disabled: !state.shell.writable || state.shell.saving,
            ...field(AUTO_RELEASE_GRACE_FIELD),
            onEdit: (text: string) => { props.edit(AUTO_RELEASE_GRACE_FIELD, text) },
            onReset: () => { props.resetField(AUTO_RELEASE_GRACE_FIELD) }
          }),
          notice !== null ? h('p', { style: styles.hint, role: 'status' }, notice) : null
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
    exports.sessionFileAddress = sessionFileAddress
    return module.exports
  }
})
