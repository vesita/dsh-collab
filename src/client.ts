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

    /** 设置命名空间，必须与 Host 半边 installSection 的 ns 逐字一致。 */
    const NS = 'dsh-collab'
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

    /** 设置 scope 快照中本卡片真正用到的字段。 */
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

    /** 依赖的客户端服务：槽位注册表 + 设置命名空间 scope。 */
    const inject = ['slots', 'settingsScope']

    /**
     * 挂载设置卡片。
     * @param ctx - 浏览器端插件上下文。
     */
    function apply(ctx: any) {
      // 只绑定一次：卡片组件闭包持有它，因此不必经 props 传递。
      const scope = ctx.settingsScope.bind({ namespace: NS })

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
       * 侧边栏「插件」页里 dsh-collab 那张配置卡的内容：三行设置项。
       *
       * 三种快照状态都如实处理：加载中给一行安静占位；命名空间不可用（本部署没装
       * Host 半边）就完全不渲染；只读部署把控件禁用而不是假装可写。技能索引读不到
       * 时只收起预览按钮并说明原因 —— 页面本身照常可用来改偏好。
       */
      function CollabConfigEntry(props: any) {
        const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot() as ScopeSnapshot)
        const [saving, setSaving] = React.useState(false)
        const [failed, setFailed] = React.useState(false)
        const [skill, setSkill] = React.useState({ status: 'loading', skill: null, error: null } as SkillState)
        const [notice, setNotice] = React.useState(null as string | null)
        /**
         * 宽限期输入框的**本地草稿**（null = 跟随 Host 快照）。
         * 为什么要草稿：受控 input 直接写 Host 会在每次按键上触发一次保存，
         * 而保存期间的 `disabled` 会让 input 立刻失焦 —— 用户输入两位数会被打断。
         * 所以输入只改草稿，**失焦或回车**才写回（写回时夹到 [1, 3600]）。
         */
        const [graceDraft, setGraceDraft] = React.useState(null as string | null)

        React.useEffect(() => {
          setSnapshot(scope.getSnapshot())
          return scope.subscribe(() => setSnapshot(scope.getSnapshot()))
        }, [])

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

        const write = (field: string, next: boolean | number) => {
          setSaving(true)
          setFailed(false)
          Promise.resolve(scope.set(field, next)).then(
            () => setSaving(false),
            () => {
              setSaving(false)
              setFailed(true)
            }
          )
        }

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

        // 插件页按 `view` 要两种视图：`summary` 出标题下的一句话，`page` 出表单正文。
        // 本槽位（plugins.bundle.config）实际只被要 `page`，`summary` 是为契约完整保留的。
        const summaryView = props !== null && typeof props === 'object' && props.view === 'summary'

        // hooks 必须无条件调用，早退只能发生在它们之后。
        if (snapshot.status === 'loading') {
          const loading = '正在加载设置…'
          return summaryView
            ? h('span', null, loading)
            : h('div', { style: styles.placeholder, role: 'status' }, loading)
        }
        if (snapshot.status === 'unavailable') return null

        // schema 默认开启：只有显式关掉才是关。
        const enabled = snapshot.value?.exposeDelegationDiscipline !== false
        const writeLock = snapshot.value?.enforceWriteLock !== false
        const autoRelease = snapshot.value?.releaseOnLoopEnd !== false
        // 宽限期：Host 是权威（夹在 [1, 3600]），这里只做同口径的前端回退，避免显示 NaN。
        const rawGrace = Number(snapshot.value?.loopEndGraceSec)
        const graceSec = Number.isFinite(rawGrace)
          ? Math.min(GRACE_MAX, Math.max(GRACE_MIN, Math.round(rawGrace)))
          : GRACE_DEFAULT
        const disabled = snapshot.writable !== true || saving
        const stateLabel = enabled ? ON_LABEL : OFF_LABEL
        const summaryText =
          '委托与验收纪律 · ' +
          stateLabel +
          ' · 写保护 ' +
          (writeLock ? LOCK_ON_LABEL : LOCK_OFF_LABEL) +
          ' · ' +
          (autoRelease ? AUTO_ON_LABEL + ' ' + graceSec + ' 秒' : AUTO_OFF_LABEL)

        /**
         * 把宽限期草稿写回 Host；非法值直接丢弃（回到 Host 的值）。
         * 与 Host 同口径夹到 [1, 3600]，值没变就不发请求。
         */
        const commitGrace = (draft: string | null) => {
          setGraceDraft(null)
          if (draft === null) return
          const next = Number(draft)
          if (!Number.isFinite(next)) return
          const clamped = Math.min(GRACE_MAX, Math.max(GRACE_MIN, Math.round(next)))
          if (clamped === graceSec) return
          write(AUTO_RELEASE_GRACE_FIELD, clamped)
        }

        const controls = [
          h(
            'select',
            {
              key: 'select',
              style: styles.select,
              value: enabled ? 'on' : 'off',
              disabled,
              'aria-label': '委托与验收纪律',
              onChange: (event: any) => {
                write(FIELD, event.target.value === 'on')
              }
            },
            h('option', { key: 'on', value: 'on' }, ON_LABEL),
            h('option', { key: 'off', value: 'off' }, OFF_LABEL)
          ),
          skill.status === 'ready' && skill.skill !== null
            ? h(
                'button',
                {
                  key: 'preview',
                  type: 'button',
                  style: styles.button,
                  onClick: () => {
                    setNotice(null)
                    preview()
                  }
                },
                '预览'
              )
            : null
        ]

        if (summaryView) {
          return h('span', null, summaryText)
        }

        return h(
          'div',
          { style: styles.page },
          h('p', { style: styles.summary }, summaryText),
          h(
            'div',
            { style: styles.item },
            h(
              'div',
              { style: styles.itemHead },
              h('span', { style: styles.itemLabel }, '委托与验收纪律'),
              h('span', { style: styles.itemType }, '技能')
            ),
            h('div', { style: styles.controls }, ...controls),
            h(
              'p',
              { style: styles.hint },
              '集群协作：把委托与验收纪律文本注入会话上下文，并注册随包技能；关闭则两者都撤回。'
            ),
            skill.status === 'error'
              ? h('p', { style: styles.failed, role: 'status' }, '无法读取技能信息：' + skill.error)
              : null,
            skill.status === 'ready' && skill.skill === null
              ? h('p', { style: styles.hint }, '该设置当前没有关联的技能文件。')
              : null,
            skill.status === 'ready' && skill.skill !== null
              ? h('p', { style: styles.hint }, skill.skill.description)
              : null
          ),
          h(
            'div',
            { style: styles.item },
            h(
              'div',
              { style: styles.itemHead },
              h('span', { style: styles.itemLabel }, '原生写保护'),
              h('span', { style: styles.itemType }, '门控')
            ),
            h(
              'div',
              { style: styles.controls },
              h(
                'select',
                {
                  key: 'lock',
                  style: styles.select,
                  value: writeLock ? 'on' : 'off',
                  disabled,
                  'aria-label': '原生写保护',
                  onChange: (event: any) => {
                    write(WRITE_LOCK_FIELD, event.target.value === 'on')
                  }
                },
                h('option', { key: 'on', value: 'on' }, LOCK_ON_LABEL),
                h('option', { key: 'off', value: 'off' }, LOCK_OFF_LABEL)
              )
            ),
            h(
              'p',
              { style: styles.hint },
              '拦截：写入/修改他人已声明占用的路径前先走原生审批（本部署没有审批提示时，ask 会变成硬拒绝）；关闭则完全不拦。'
            )
          ),
          h(
            'div',
            { style: styles.item },
            h(
              'div',
              { style: styles.itemHead },
              h('span', { style: styles.itemLabel }, '循环终止自动释放'),
              h('span', { style: styles.itemType }, '锁生命周期')
            ),
            h(
              'div',
              { style: styles.controls },
              h(
                'select',
                {
                  key: 'auto',
                  style: styles.select,
                  value: autoRelease ? 'on' : 'off',
                  disabled,
                  'aria-label': '循环终止自动释放',
                  onChange: (event: any) => {
                    write(AUTO_RELEASE_FIELD, event.target.value === 'on')
                  }
                },
                h('option', { key: 'on', value: 'on' }, AUTO_ON_LABEL),
                h('option', { key: 'off', value: 'off' }, AUTO_OFF_LABEL)
              ),
              h('input', {
                key: 'grace',
                type: 'number',
                style: styles.number,
                min: GRACE_MIN,
                max: GRACE_MAX,
                step: 1,
                // 草稿优先；跟随 Host 时用归一后的值。
                value: graceDraft !== null ? graceDraft : String(graceSec),
                // **不**因 saving 而 disable：输入框一 disabled 就会失焦，多位数会输不完。
                disabled: snapshot.writable !== true || !autoRelease,
                'aria-label': '空闲宽限期（秒）',
                onChange: (event: any) => {
                  setGraceDraft(String(event.target.value))
                },
                onBlur: () => {
                  commitGrace(graceDraft)
                },
                onKeyDown: (event: any) => {
                  if (event && event.key === 'Enter') commitGrace(graceDraft)
                }
              }),
              h('span', { style: styles.unit }, '秒')
            ),
            h(
              'p',
              { style: styles.hint },
              '会话循环停下（空闲超过上面的秒数）后，它持有的声明会被自动释放，让等在后面的会话能接着干；' +
              '宽限期内被唤醒则取消释放。释放后会通知等待者，并给该会话留一条「你的锁已被自动释放」的告知。'
            )
          ),
          h(
            'div',
            null,
            snapshot.writable !== true
              ? h('p', { style: styles.hint, role: 'status' }, '本部署的设置为只读，无法在此修改。')
              : null,
            failed ? h('p', { style: styles.failed, role: 'status' }, '写入失败，设置未改变。') : null,
            notice !== null ? h('p', { style: styles.hint, role: 'status' }, notice) : null
          )
        )
      }

      // 配置挂到侧边栏「插件」页里 dsh-collab 那张 bundle 卡上：键是包名。标题、图标、
      // 面包屑由插件页自绘，所以这里只出 `view: 'page'` 的表单正文。
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE_KEY }, CollabConfigEntry)
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.sessionFileAddress = sessionFileAddress
    return module.exports
  }
})
