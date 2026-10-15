# dsh-collab — 多 DSH 会话协同插件（Collab）

让**同一项目上的多个 DSH 会话**彼此可见、互相避让的部署级协作能力。典型场景是两三个独立会话（不同对话、不同浏览器标签、甚至不同 dsh 进程）并行改同一个仓库：每个会话都能自动看到别人占着什么，并在动手前完成声明。

它提供两个模型工具：

| 工具 | 作用 |
| --- | --- |
| `collab_lock` | **中央注册锁**：开工前声明"我占用哪些文件夹/文件"，并查询/等待/协商 |
| `collab_board` | **跨会话留痕本**：发消息 / 增量读消息。**没有投递面**：post 只写共享状态文件，不投递、不唤醒任何会话（@ 谁 ≠ 通知谁）；要通知或唤醒某个会话，用 DSH 原生的会话消息工具 |

## 多会话协同靠三个机制

1. **共享状态**：所有会话（含子智能体、跨进程）读写同一份状态文件，路径由项目工作区绝对路径确定性派生。
2. **自动态势注入**：每次模型步，插件把"同项目其他会话当前占着什么"写进运行时上下文。会话无需记得去查，也无需知道对方存在。
3. **声明占用**：改动前 `claim` 目标路径；冲突时 `wait` 等待或用 `collab_board` 协商。

> 面向使用者的完整规范见 [`docs/collab-usage.md`](docs/collab-usage.md)。
>
> 子智能体路由（默认继承父会话 vs 调用时显式点名）的机制与实测证据见
> [`docs/dsh-subagent-routing.md`](docs/dsh-subagent-routing.md) —— **那是文档，不是提示词**，
> 不进 `skills/`、不进运行时纪律文本。

## 与官方 Agent Teams 的分工（定位）

DSH 自带一套实验性的 `Agent Teams`（`dsh-experimental-agent-team*`）：安装后是**关**的，
安装层把它登记在 `OPTIONAL_BUNDLES` 里，没有任何内置 profile 模板启用它
（`dsh-app-boot/lib/index.js:557`、`dsh-experimental-agent-team-profile/README.md:104`）。
两者**同域不同层**：

| | 官方 Agent Teams | 本插件（Collab） |
| --- | --- | --- |
| 解决的问题 | **一个会话干不完**：隐式 Lead 派生具名 teammate | **互不相识的会话看不见彼此**：同一 checkout 上的路径占用 |
| 拓扑 | 树内：Lead → 直属 teammate（`TeamId` = Lead 的 `SessionId`，`dsh-experimental-agent-team/lib/types/types.d.ts:5`） | 树间：平级会话 / 子智能体 / 不同 dsh 进程 |
| 伙伴怎么来 | `spawn_teammate` 现造，`fresh` 或 `fork` | 本来就在那儿：先声明路径，再动手 |
| 共享什么 | 持久信箱 + 共享任务 DAG（`team_task_*`，revision CAS） | 路径声明（`collab_lock`）+ 留言板（`collab_board`） |
| 文件冲突 | `write_scopes` 明确是 advisory：*"advisory, not a lock"*（`dsh-experimental-tool-agent-team/lib/index.js:23`） | 路径占用 + 原生写门控，唯一带"这块归谁"语义的一层 |
| 跨进程 | 不支持：一个进程一个 Team、共享同一个 checkout（`dsh-experimental-agent-team/README.md:205,209`） | 状态按项目 cwd 派生落盘，跨进程共享 |
| 默认 | 关（experimental，*"carries no stability promise"*） | 常驻（profile 插件条目 `collab`） |

**判据一句话**：官方管**树内**（谁干什么活、活之间的依赖），本插件管**树间**（同一个仓库里
谁在动哪块路径）。官方把文件系统锁与跨进程一致划在能力之外，那一层归本插件；派生成员、任务
依赖与 CAS 归官方，在本插件里重做就是重复建设。

**0.11.0 起两者是互补而不是互不知道**：本插件会读官方**在跑任务**的 `write_scopes` 做交叉预警
（只报不锁），官方不需要知道本插件存在。这是唯一可行的形态 —— 官方没给第三方插件注册钩子的接口，
所以预警只落在**本插件这一侧**：一次读（进态势摘要与 `overview`/`claim` 返回）、一次写侧提示
（团队建/改任务时提示与外部 `collab_lock` 声明的重叠）。服务缺席时本插件的一切输出**一字不变**。

三条**接缝**（已知边界；每条都有 0.11.0 的实测证据，原始命令与输出见
[`docs/agent-teams-interop-evidence.md`](docs/agent-teams-interop-evidence.md)）：

1. **家族豁免在团队内不生效**：teammate 是 Lead 的直属子会话，落在下面「会话家族（血缘）」的
   豁免范围里 —— **自动态势注入与写门控**都不把对方当"别人"（实测 teammate 覆盖写了 Lead 持独占
   声明的文件，而另一个无血缘会话的同样写入被拒绝）。注意一处更精确的说法：显式
   `collab_lock op=overview` / `op=status` **看得见**对方的声明，只有自动注入与门控豁免；
   同一层级的两个 teammate 互不为祖先/后代，故彼此可见。团队内部的占用由官方任务 DAG 的
   `write_scopes` 表达 —— 而实测那只是 advisory，不挡任何写入。
2. **同名工具会被遮蔽**：`tool-agent-team` 在成员作用域内遮蔽全局的 `send_message` /
   `list_agents` / `interrupt_agent`（`dsh-experimental-tool-agent-team/README.md:99`）；agent-team
   profile 补丁里那四行 `disabled` 管的是组合层的 legacy 条目，**preset 自带的同名行不受它管辖** ——
   本部署实测工具目录里 `subagent` 仍在。团队成员的派生 / 转向 / 等待语义由官方 `team:policy` 段
   自己写明（`dsh-experimental-tool-agent-team/lib/index.js:21-27`：`inactive` 只表示没有回合在
   执行、`wait_agent` 不唤醒、先 `list_agents` 再 `send_message`），本插件不再复述。
3. **交叉预警是单向、只报不锁的**：`ctx.agentTeams` 在场时，本插件把官方在跑任务的 `write_scopes`
   当 advisory 占用读进态势摘要与 `overview` / `claim` 返回，并在团队建/改任务的 `tools/pre-execute`
   上提示与外部 `collab_lock` 声明的重叠。官方那侧仍然读不到本插件；预警**不改变任何门控语义**
   （写入该拒的照拒、该放的照放）。

### 官方覆盖的，本插件不做（0.12.0 逐条核对）

判据是官方 packages 的实现与 README 自述，不是印象：

| 能力 | 官方 Agent Teams | 本插件的取舍 |
| --- | --- | --- |
| 成员派生 / 名册 / 转向 / 等待 / 打断 | `spawn_teammate`、`list_agents`、`send_message`、`wait_agent`、`interrupt_agent` | 不重做，也不重讲怎么用 —— 官方 `team:policy` 段已逐条写明（0.12.0 删掉了重复的那段追加文本） |
| 任务依赖 / 认领 / CAS | `team_task_*`（`revision` CAS、`blocked_by`、owner） | 不重做；只读在跑任务的 `write_scopes` 做交叉预警 |
| 写协调纪律 | `team:policy`：写域互斥但 advisory、"not a lock"、Lead 复核最终 diff | 不复述；只补官方明说不做的那一层 |
| 文件系统级锁 / 跨进程 | 明说没有（`dsh-experimental-agent-team/README.md:205,209`） | **互补面**：路径声明 + 原生写门控，状态按项目 cwd 派生、跨进程共享 |
| 锁的自动回收 | 明说没有（同文件 `:208`） | **互补面**：**句柄结束（`agent/disposed`）即删** + `op=reap` 回收确证死亡的声明 |
| 对非团队成员会话的可见性 | 不给非成员注入任何 prompt，只有浏览器投影 | **互补面**：态势注入进**每一个**同项目会话的运行时上下文 |

---

## 目录结构

```
.
├── crates/
├── docs/
│   ├── collab-usage.md           # 面向任意会话的使用指南
│   ├── dsh-subagent-routing.md   # DSH 子智能体路由：继承、点名与验证（机制 + 实测索引；非提示词）
│   ├── agent-teams-interop-evidence.md  # 与官方 Agent Teams 的接缝：一次性取证记录
│   └── collab-ux-backlog.md      # 仍未解决的使用摩擦（每条都能一次检查判定）
├── scripts/
│   ├── collab_models.py          # Python dataclass 模型定义（Schema 派生）
├── src/                          # TypeScript 源码（NodeNext 风格，import 写 ./x.js）
│   ├── index.ts                  # **组合根**（60 行）：只做接线，按依赖顺序调用各 installer
│   ├── contract.ts               # 对外契约类型（工具/服务/返回结构的类型面）
│   ├── spec.ts                   # 纯常量与纯函数（工具路径规格、状态目录文案、sessionIdOf…）
│   ├── collab-core.ts            # 纯逻辑·辅助面（类型/id/规范化/收敛/清理）
│   ├── collab-ops.ts             # 纯逻辑·操作面（claim/release/reap/post/overview/… 与渲染）
│   ├── state-core.ts             # 状态机唯一事实源（读改写 / 磁盘布局 / 损坏自愈 / 只读 op）；构建期原样内联进动态外壳
│   ├── paths.ts                  # 状态目录的唯一路径事实源（绝对路径推导 + 历史落点）
│   ├── store.ts                  # 包形态的**状态存取适配器**：环境面（targetFor / 血缘 / 显示名 / 存活判据）注入 state-core
│   ├── tools.ts                  # collab_lock / collab_board 注册（消费 store + push）
│   ├── access.ts                 # 功能 A：访问通知（逐事件经 agent.inject 投递 form:'notice' 的显式来源消息）
│   ├── gate.ts                   # 功能 C：写/读的原生审批门控（tools/pre-execute）
│   ├── push.ts                   # 功能 D：释放推送（唯一通道 agent.inject + 显式来源 form:'notice'）+ agent/disposed 生命周期
│   ├── awareness.ts              # 协作态势注入（运行时上下文 order 130）
│   ├── delegation.ts             # 委托纪律：settings 偏好 + 随包 skill + 常驻纪律块（order 131）
│   ├── skill.ts                  # 随包 skill 读盘与 buildSkillIndex（delegation 与路由共用）
│   ├── client-route.ts           # 浏览器半边只读 loopback 路由（技能索引）
│   ├── client.ts                 # 浏览器半边：侧边栏 Plugins 页里 dsh-collab 卡上的配置区
│   ├── host-shell.js             # 动态宿主形态的外壳模板（只留环境适配）；hostCode 由 scripts/build-host.mjs 构建期内联核心与状态层生成
│   ├── schema/
│   │   └── collab.schema.json    # JSON Schema v1：状态文档 + 工具参数（单一契约）
│   └── types/
│       └── collab.d.ts           # TypeScript 类型定义（构建时复制到 lib/types/）
├── lib/                          # tsc 构建产物（git 忽略，随 npm 包发布）
├── skills/
│   └── agent-delegation/
│       └── SKILL.md              # 随包发布的委托与验收纪律技能
└── tests/
    ├── _harness.mjs                 # 共用断言脚手架（ok / skip / 汇总 / 退出码）
    ├── collab-pure-logic.mjs        # 纯逻辑回归 + hostCode 内联副本漂移守护
    ├── collab-convergence.mjs       # 单元 C：merge 的代数律（交换/结合/幂等）+ id 唯一 + 游标无损 + 终态化
    ├── gen-merge-golden.mjs         # 单元 D：黄金语料生成器（从 lib/collab-core.js 的 mergeDocs 现算）
    ├── fixtures/merge-golden.json   # 合并语义的期望输出（勿手改，重跑生成器）
    ├── collab-merge-golden.mjs      # 单元 D：TS 侧断言自己的 mergeDocs 与黄金语料逐字节相同
    ├── collab-write-merge.mjs       # 单元 C/D：写者并发写盘不丢更新 + CLI/插件两个方向（含负向对照）
    ├── collab-integration.mjs       # Cordis 插件端到端（fake ctx）
    ├── collab-hostcode-parity.mjs   # 动态宿主形态**行为**对拍（路径 + 三态语义 + holder 回收）
    ├── collab-inline-parity.mjs     # 两形态**源码同源**守护（核心 + 状态层两段内联区逐字节一致，外壳不复刻）
    ├── collab-state-split.mjs       # 磁盘布局（主文件 + 留言旁挂）/ 并集合并 / 备份保留 / 两形态等价
    ├── collab-contract-derivation.mjs # 契约派生守卫（schema ⇄ d.ts ⇄ Python ⇄ 真实工具 schema）
    ├── collab-message-provenance.mjs # 规范守卫：严禁冒充用户（AGENTS.md §1）
    ├── collab-digest-stability.mjs  # 态势摘要文本时间稳定性回归（运行时快照去重）
    ├── collab-awareness.mjs         # 多会话态势注入回归
    ├── collab-awareness-cross-session.mjs # 跨会话家人/陌生人视角回归
    ├── collab-agent-teams.mjs       # 官方 Agent Teams 交叉预警（服务缺席 ⇒ 输出一字不变）
    ├── collab-access-gate.mjs       # 访问通知（agent.inject 的 notice 载体）与原生写保护（pre-execute）回归
    ├── collab-e2e.mjs               # 真实 fs + 临时 DSH_HOME 的端到端回归
    ├── collab-skill.mjs             # 随包 skill + 委托纪律 + 偏好设置回归
    ├── collab-client-route.mjs      # Host 端技能索引路由（GET /dsh-collab/skill-index）回归
    └── collab-skill-real.mjs        # 真实 DSH 部署上的委托纪律端到端（`npm run test:real`，不在 npm test 内）
```

---

## 状态目录

状态目录 = `${DSH_HOME:-$HOME/.dsh}/collab/projects/`，由 `src/paths.ts` 统一产出：

```ts
collabDir(env?)              // <dshHome>/collab/projects（绝对路径）
projectStateFile(cwd, env?)  // 上面目录 + <项目名>-<哈希>.json
legacyCollabDirs(env?)       // 历史落点，用于一次性迁移（env 仅为契约对称保留，实现显式忽略它）
```

该路径是**绝对路径**，因此与 DSH 进程的启动目录无关：从任何目录启动的 dsh 实例，同一项目都落到同一个文件。`<哈希>` 由会话 cwd（项目根绝对路径）确定性派生。

`list` / `overview` / `status` 三个 op 都返回 `stateDir` 与 `statePath`，落点随时可核实。

0.9.11 起 `overview` 还会**顺带报出别的项目**：返回里多一个 `otherProjects`（每条给出文件名、
`statePath`、活跃声明数与占用明细，按声明数降序、最多 10 条；没有活跃声明的项目不列入）。
它走**输出侧附加**而不是给工具加 `project`/`all` 入参 —— 加参数要同步 4 份契约派生物，而排障
真正缺的是"我能看见别人占着什么"。宿主 fs 不提供 `listDir`、目录不存在或某个状态文件损坏时，
只返回 `otherProjects: []` 加一句 `otherProjectsNote`，**本项目的数字一字不动**。

历史落点（`<项目>/.dsh-collab.json`、旧版相对 cwd 的 `.dsh/collab/projects/`、以及早期版本写入的 `<HOME>/~/.dsh/collab/projects/`）在目标文件不存在时被只读扫描并一次性搬入正确位置，文件名一一对应。该迁移由包形态执行；动态形态直接读写正确落点，因此与包形态共享同一份状态。

---

## 锁模式

| mode | 用途 | 阻塞他人 | 被他人阻塞 |
| --- | --- | --- | --- |
| `exclusive`（默认） | 我要改这块 | 是 | 是 |
| `shared` | 我也要写，愿意共用 | 否 | 是（被他人独占挡住） |
| `read` | 只读观测（测绘 / 审计） | 否 | 否 |

`wait` 把**他人的独占声明**当作阻塞条件；`read` 与 `shared` 声明永远放行。

同一套判据贯穿三处：`claim()` 的冲突扫描、`wait`（内部 `blockers()`）、以及功能 C 的原生写保护门控
（`writeGate`）。**只有他人的 `exclusive` 声明阻塞他人**：`shared` 声明不挡任何人（两个共享方互不阻塞），
`read` 声明既不排他也不被挡。因此 `readable` 只对 `exclusive` 声明有意义 —— `shared` / `read` 声明
上的 `readable: false` 不产生任何门控效果（既不拦写也不拦读）。

---

## 多会话态势注入

插件通过 `systemPrompt.context()` 注册一条 `order=130`（紧随 sandbox / approval / agent-delegation）的运行时上下文。它的 provider 在装配时执行：

```
agents.currentInitiator()            → 正在装配的那个会话
  .session.header.cwd                → 项目根
  → 读共享状态文件 → 过滤出他人的未过期声明 → 渲染成一行
```

渲染结果形如：

```
[dsh-collab] 同项目其他会话当前占用：Other Session#a1b2c3d4（独占）占用 src/backend/。改动这些路径前请先执行 collab_lock op=wait 或用 collab_board 协商。
```

名字后的 `#a1b2c3d4` 是 `holderId` 的稳定短句柄（会话 id 去掉 `session-` 前缀后的前 8 字符）：显示名来自会话标题，子智能体会话的标题就是父 AI 那条 prompt 的开头，实测会重名（一个名字占 10 份），句柄不会。

这段摘要**完全时间无关**：DSH 只在运行时上下文的文本逐字节变化时才提交新快照，不含时刻的摘要因此不会因为过了几分钟就被重复注入。

同项目暂无他人声明时，该上下文退化为一句通用协作规范。读盘走 15 秒 TTL 的后台缓存（`DSH_COLLAB_DIGEST_TTL_MS` 可调），provider 同步返回缓存，刷新失败时沿用上一份。缓存里存的是**该 cwd 的原始活跃占用列表**，「排除谁」按**读取时的发起者**现场做——同一份缓存对所有会话都成立，只有「排除谁」因人而异；0.9.11 起排的是**整个会话家族**（自己 + 祖先 + 后代），见「会话家族（血缘）」一节。

关闭方式：包形态设置环境变量 `DSH_COLLAB_NO_PROMPT_HINT=1`。受限的动态宿主形态读不到 `process.env`，因此它**始终注入**；需要彻底关闭时请使用包形态。

同一个开关也管住**功能 A 的访问通知**（`kind: 'dsh-collab'`、`form: 'notice'` 的消息）：它是运行时状态派生出来、再注入进会话的内容，所以 `DSH_COLLAB_NO_PROMPT_HINT=1` 下**不投递**。只关投递。这一条由 `tests/collab-access-gate.mjs` 钉住，并配了负向对照（摘掉开关判定 -> 该断言精确变红）。

（受限的**动态宿主形态**：0.14.0 起**已接线** `tools/pre-execute` 写门控（`src/host-shell.js`，判据直接调内联核心，与包形态同源；两形态的 ask 文案逐字节对拍）。但它的开关读不到 —— 受限宿主拿不到 env 与插件 Config ⇒ `enforceWriteLock` **恒为开**、`DSH_COLLAB_NO_PROMPT_HINT` 无效。**访问通知**（`tools/post-execute`）与官方 Agent Teams 的反向交叉预警**仍未接**：它们要 `agent.inject` / `dsh-llm`，受限宿主里没有。）

---

## 委托纪律偏好与配置卡

运行时上下文除态势摘要外，还带一段常驻的**委托与验收纪律**；它同时决定随包的 `agent-delegation` 技能是否注册。两者由包形态的一项设置控制，默认开启：

| 项 | 值 |
| --- | --- |
| 配置命名空间（= profile 条目 id） | `collab` |
| 字段 | `exposeDelegationDiscipline` |
| 类型 / 默认 | `boolean` / `true` |
| 字段 | `enforceWriteLock` |
| 类型 / 默认 | `boolean` / `true` |

两个字段同属一份配置，分别控制委托纪律与写保护。

这份配置就是本插件在 profile 里的 **Config**（0.1.7 起设置由当前 Profile 的插件配置保存，见 `@deepseek-ai/dsh-settings`）：两个字段都声明 `.volatile()`，因此改一个字段**不需要重载插件**——Loader 把新值提交进正在运行的引用，再发 `loader/volatile-update`，插件据此重新结算。值是**活读**的：改完立即生效，无需重启 dsh。迷你宿主没有 Loader 解析配置时，插件按 schema 默认值行事。

开启（默认）时，插件多做两件事：

1. 把随包发布的 `agent-delegation` 技能注册进宿主技能注册表；
2. 通过 `systemPrompt.context()` 注入段名 `dsh-collab/delegation`、`order=131` 的纪律文本。

关闭时这两项都不注册。**中央注册锁与协作留言板不受影响**——它们是插件本体，始终在场。

纪律文本是**纯常量**：没有时间戳、计数或任何会漂移的字符。DSH 的运行时上下文快照按整串相等去重，常量块因此每个会话只提交一次；一旦掺入随步变化的文本，整块快照就会被反复重发。

### 侧边栏「插件」页里的那张配置卡

偏好能出现在 UI 里，靠的是插件带的浏览器半边 `lib/client.js`（`package.json` 声明 `dsh.client` 与 `exports["./client"]`）。原因很直接：插件页只**枚举**配置、从不解释它 —— 侧边栏 **Plugins** 页声明了 `plugins.bundle.config` 槽位（keyed，键是 bundle 的包名），由插件自己注册进来：**谁拥有配置，谁自带页面**。

打开侧边栏的 **Plugins**，进 `dsh-collab` 那张组合包卡，即可看到两个字段 —— 「委托与验收纪律」（含一个打开随包技能正文的预览按钮）与「原生写保护」。页面用官方表单原语画（`SettingsForm` 的保存栏 + `SettingsFormValue` 字段 + `SettingsFormModel` 的暂存）：**改动先暂存，点保存才写 Host**，离开页面即丢弃草稿；被覆盖过的字段带「已覆盖」标记与「恢复默认」按钮。三种状态都如实呈现——Host 还没服务这个命名空间时 `SettingsForm` 自己画一句「不可用」，只读部署把控件置灰并说明原因。

**预览按钮的行为**：点一下**直接**在右侧栏的文档面板打开随包技能正文，没有二次确认，**也不会离开插件页**——插件页照常开着，右侧栏多出一份技能文档。按钮就只是「在右侧栏打开技能文档」，文案与行为一致。

> **本落点拿不到关闭句柄**：`plugins.bundle.config` 只给 `view` 一个 prop（`'summary'` 出标题下的一句话、`'page'` 出表单正文；本槽位实际只被要 `page`），所以页面无法自行关闭或离开。需要关闭能力时改用 `settings.section` 落点——那里是 `renderSlot("settings.section", { close: onClose }, …)`。
>
> **配置区出现的条件是条目上有 `config`**：插件页用 `ledger.bundles.has(openPkg.name)` 决定要不要渲染它，而那份账本只收「声明了 volatile 字段的 profile 条目」。所以 profile 的 `cordis.patch.yml` 里必须为 `collab` 写一段 `config`（四个字段的默认值），否则这张卡上没有配置区。

### 随包发布的委托技能

`skills/agent-delegation/SKILL.md` 随包发布。偏好开启时，插件把它注册进宿主技能注册表（`ctx.skills.register`），标注 `source: 'bundled'`、`provider: 'dsh-collab'`，技能目录里因此能看到它、来源也可辨。注册随 effect disposer 撤回，**可逆**：插件卸载或偏好关闭，该技能随之消失。

技能正文的 §10.4 与常驻纪律文本（`DELEGATION_DISCIPLINE_TEXT`）同时写明一条恢复路径：**子智能体意外终止（回合以 `error` / 空收尾结束）时先看它还在不在，别急着重派** —— 唤醒走那个能给已停下的它发消息的工具，而 `collab_board` 那条通道**唤不醒任何人**（`agent.inject` 的契约是 `send(msg, 'next-step', wakeup=false)`，只挂进收件箱、不起 driver）。派生 / 转向 / 等待的语义以**你当时的工具目录**为准：启用官方 Agent Teams 时由官方 `team:policy` 段给出（`dsh-experimental-tool-agent-team/lib/index.js:21-27`），本插件不再复述。两处都提醒：被唤醒的子智能体**不知道自己已经丢锁**（会话句柄结束即释放），要让它先 `collab_lock op=claim` 再动手；同一处最多试一两次，之后自己写。

插件的**动态宿主形态**（`hostCode` 字符串）刻意不注册该技能：受限动态环境没有包目录、也没有 `import`，无法定位 `<pkg>/skills/agent-delegation/SKILL.md`。这是环境限制，不是遗漏。

包形态的 `DSH_COLLAB_NO_PROMPT_HINT=1` 关掉**所有**运行时注入 —— 态势上下文、委托纪律文本、以及功能 A 的访问通知（后者也是运行时派生再注入进会话的内容）。它不影响技能注册。

---

## 会话家族（血缘）

**问题**（backlog §2.1，Top 5 第 3 条）：holder 身份是 `agent:<会话 id>`，而**子智能体跑在自己的
会话里** ⇒ 主会话 `claim src/`（exclusive）之后派子智能体去改 `src/` 下的文件，子智能体会被这把锁
**硬拒绝**（本部署审批关闭，`ask` 即 `deny`），而且它无权释放（`release` 只允许持有者本人）——
只能到留言板求父会话放锁，而父会话的循环可能已经停了。核心工作流（派子智能体写代码）就此卡死。

**血缘从哪来**：子智能体创建时会把 `parentSession: parentHeader.id`、`origin: 'subagent'`、
`delegationDepth` 写进会话头（`dsh-subagent/lib/types/child-agent.js:117-123`；类型见部署内
`dsh-agent/lib/types/index.d.ts:66`）。祖先链可上溯，`store.familyIds()` 因此能现算出
**自己 + 祖先链 + 后代**这一组 holderId（后代会话从 `agents.list()` 里按祖先链反查）。

**判据**：`collab-core.inFamily(h, holderId)` —— 家族成员之间的独占声明**不构成冲突**。
它取代了原先散在 6 处的裸判据 `c.holderId === h.holderId`：

| 位置 | 作用 |
| --- | --- |
| `collab-core.claim()` | 冲突扫描（子智能体 claim 父占的路径） |
| `collab-core.blockers()` | `op=wait` 的阻塞判据（不 wait 自家人） |
| `gate.ts` | 原生写门控（子智能体写父占的路径） |
| `awareness.ts` | 常驻态势摘要（不把自家子智能体报成"其他会话占用"，backlog §2.2） |
| `access.ts` | 访问通知（不为自家人发通知） |
| `src/host-shell.js` + `scripts/build-host.mjs` | 动态形态：外壳模板 + 构建期把 `lib/collab-core.js` 与 `lib/state-core.js` 原样内联 ⇒ 两形态的纯逻辑与状态层**逐字节同源**（由 parity 测试断言） |

**边界**：这条豁免的前提是"同一棵树里的子智能体与我共享同一写域"。当树里跑的是官方 `Agent Teams`
的 teammate（长期并行、各有独立任务）时，树内占用归团队任务 DAG 的 `write_scopes` —— 见
「与官方 Agent Teams 的分工（定位）」。

**三条纪律**：

1. **只缩不放**——拿不到 `agents` 服务、读不到血缘字段、或 `h.family` 缺省时，判据退化为
   "只看 holderId 是否相等"，也就是 0.9.10 的语义。**不会**因为判据缺失就放行陌生人。
2. **不落盘**——`family` 只活在 `HolderInput` 上（`holder()` 只挑已知字段写状态文件），
   每次从运行时现算。血缘因此**不进契约**（`src/schema/collab.schema.json` 的 4 份派生物
   一份都不用改）。
3. **带环保护与深度上限**（16 层）——血缘字段来自会话头，不能假设它良构。

**测试**：`tests/collab-pure-logic.mjs`（正负对照：自家人放行 / 无血缘第三方仍 conflict /
血缘缺省仍 conflict / 父写子占的路径放行 / holders 表不出现 `family`）、
`tests/collab-inline-parity.mjs`（`inFamily` 进同名集合，7 条语料逐输出对拍两形态）、
`tests/collab-access-gate.mjs`（门控侧）。

---

## 声明的生命周期

一条声明的回收**只有三条路径**，都不看时间：

1. **持有者自己 `op=release`** —— 正常收工；
2. **会话句柄结束**（`agent/disposed`）—— 立即释放它的全部声明，并在留言板留一条审计留言（频道 `agent:<holderId>`），恢复工作前重新 claim；
3. **持有者已确证死亡**（不在会话注册表里）时显式 `op=reap` —— 默认只列候选，`confirm:true` 才真删。

没有租约、没有到期时间、没有按空闲时长推算的自动释放：死没死只由**会话注册表**回答。
代价如实写在这里：一个活着但忘记 `release` 的会话会一直占着，别人必须 `op=wait` 或协商，
或者由持有者自己释放。

## 确证死亡的显式回收（`op=reap`）

**要解决的问题（实测，不是推演）**：2026-09-13 深夜，一个子智能体会话被强杀（dsh 重启），
它持有的 `src/` + `tests/` exclusive 声明留在了状态文件里。声明只有持有者本人能 `release`
（对其他会话返回 `forbidden`），当时主 AI 只能手工改状态文件才解开。

**判据只有一条**：harness 的**会话注册表**说它不在了（`not-live`）。**不看 age、不看 TTL** ——
同一条状态不许有两个相反的存活答案。本地进程注册表无法区分"休眠可唤回"与"真死"，
而误杀的代价不对称（被回收的会话恢复后仍按对话历史以为自己持锁），所以 `op=reap` 是纯显式的：
默认 dry-run，`confirm: true` 才动手，且**绝不**接进 `sweep()` 或任何读路径、定时器。
判据不可用（拿不到 oracle、或 oracle 自己抛错）⇒ 一个也不收（fail-closed），并如实标
`livenessCheck: 'unavailable'`。

**返回**：

- dry-run：`{ ok:true, data:{ dryRun:true, serverTime, livenessCheck, candidates:[…], candidateHolders:[…] } }`
- `confirm:true`：`{ ok:true, data:{ dryRun:false, serverTime, livenessCheck, reaped:[…], reapedHolders:[…] } }`

每个候选 = 该声明的公开视图 + `reasons`（逐条判据标签，如 `holder-not-live` / `not-self` /
`paths-intersect`）。自己的声调用 `op=release`，`reap` 绝不替调用者清自己的锁。

**回归守卫**：`tests/collab-reap.mjs`。两形态行为一致（`tests/collab-hostcode-parity.mjs` 的对应段）。

## 子智能体禁止 client 平台检视 + 探索阶段默认先派

**修的是真故障（实测定位）**：
- **症状**：子智能体执行 `cordis_inspect_query` 查询 `platform: 'client'`（如 `Slots` / `Theme`）会**永久挂起**。故障实测中子智能体会话 `769c2e33` 调 `listSubTree` 空挂 344.8 秒直到被主 AI 中断；主会话做相同调用则瞬时返回。
- **根因**：`@deepseek-ai/dsh-cordis-host-runner/lib/types/inspect-registry.js` 的 `queryClient` 只被拥有该 `agentId` 的浏览器页面应答 settle，子智能体没有浏览器页面，因此永不 settle。
- **现在的分工与硬化**：
  1. **纪律文本注入**：`src/spec.ts` 的 `DELEGATION_DISCIPLINE_TEXT` 追加纪律，明文禁止子智能体调用客户端检视；界面信息必须由主 AI 在主会话预查并写入委派背景。
  2. **随包技能硬禁令**：`skills/agent-delegation/SKILL.md` 新增 §10 硬禁令（含机制解释、反例、正例、以及 Slots/Theme/listSubTree 等危险信号清单），并在 §7 工具表格和 §9 踩坑速查中关联该禁令。
  3. **探索阶段默认先派**：强化探索期先派子智能体拿取事实的纪律，防止主会话上下文浪费。

---

## 态势摘要按 cwd 缓存原始占用

**修的是真 bug（已实测复现）**：`dsh-collab/awareness` 的运行时候选摘要原先**只按 cwd 缓存「某个人视角
渲染好的文本」**，而「排除自己」的过滤做在**刷新侧**。同 cwd 的多个会话（父会话与其子智能体）各自刷新，
后写覆盖先写；只要有一次刷新发生在 `id` 为空的 agent 上（`mine` 退化成 `human:console`，谁都不排除），
之后同 cwd 的所有会话都会读到这份「含自己锁」的缓存——**持有者会在自己的态势里看到自己的占用**，
误以为自己被挡着（正是这种误导会让人去 `wait`／`board` 协商一个不存在的竞争者）。

**修法**：缓存改存**该 cwd 的原始活跃 claim 列表**（渲染与时间无关，按 cwd 缓存原始数据是安全的），
「排除自己」挪到**读取侧**、按当次 `currentInitiator()` 现场过滤。**两形态同改**：
`src/awareness.ts` 与宿主外壳 `src/host-shell.js` 里的对应实现。

**回归守卫**：新增 `tests/collab-awareness-cross-session.mjs`（已进 `npm test`）——两个会话同一 cwd、
由 `id` 为空的会话先刷新缓存，然后断言三条：**持有者看不到自己的锁**（负向对照）、**他人占用照常显示**、
claim 删除并强制刷新后双方都回落通用规范。修复前实测 `6 passed, 2 failed`（失败源唯一），修复后全绿。
既有的 `collab-awareness.mjs` 抓不到这条：它的假 `agents.list()` 永远只有 1 个 agent、`timer.interval`
被桩成 no-op，「同 cwd 两个会话互相覆盖缓存」这条路径从未被执行。

**顺带（提示词）**：常驻委托纪律文本（`src/spec.ts` 的 `DELEGATION_DISCIPLINE_TEXT`）新增一条
「探索阶段默认先派」，随包技能 `skills/agent-delegation/SKILL.md` 新增 §1.1（探索期该派哪五类单元、
哪三种探索才允许自己做）——目标是让「先摸清情况」默认发生在子智能体里，而不是主会话里。

---

## 架构拆分、契约守卫与「跳过即失败」

这一版**没有新增用户可见功能**，全是在夯地基——目标是让「两形态漂移」「契约漂移」「静默失败」
这三类问题在**下一次改动时当场变红**，而不是靠事后排查。

**架构**：1640 行的单体 `src/index.ts` 拆成 **11 个模块**，入口变成 60 行的**组合根**：只按依赖顺序
调用各 installer，并把上一个 installer 的返回值显式传给下一个（**没有跨模块可变全局**）。
对外导出面逐名不变。

**三道新的守卫**（都进了 `npm test`）：

- `tests/collab-inline-parity.mjs`：从动态形态的 `hostCode` 字符串里用**括号配对扫描**抽出
  **全部 30 个两形态同名函数**逐输出对拍。此前只有 `clockUtc` / `renderDigest` 两个被比对；
  并用「实测同名集合必须**恰好等于**期望集合」做回归守护——任何一侧新增同名函数却忘记接进对拍都会红。
- `tests/collab-contract-derivation.mjs`：把「schema 是单一事实源」从**声称**变成**可执行**——
  逐字段核对 `$defs` ⇄ `src/types/collab.d.ts` ⇄ `scripts/collab_models.py` ⇄
  `src/types/collab.d.ts` / `scripts/collab_models.py` ⇄ **真实注册**的工具 schema。
- `.github/workflows/ci.yml`：Node job（build + 全量测试）。

**「跳过即失败」**：测试里任何「环境不满足所以跳过」的路径**默认判失败**；只有显式设
`COLLAB_ALLOW_SKIP=1` 才放行，且会打印含「未验证」字样的横幅。绿的不等于验证过的。

**不再谎报**：状态文件损坏自愈时，备份/重置的失败原先被静默吞掉、warning 却宣称
「已备份 / 已重新初始化」；现在**如实**说明失败原因与**原始损坏内容此刻的下落**
（已备份 / 被重置覆盖 / 仍原样留在磁盘上）。包形态与动态宿主形态**同步**修好，避免两形态在
「损坏自愈是否谎报」上分叉。


**仍未解决的使用摩擦**：见 `docs/collab-ux-backlog.md`。

## 访问通知与原生写保护

### 功能 A — 访问时的路径相关通知（逐事件经 `agent.inject` 投递 notice）

插件监听 `tools/post-execute`：从本次调用的参数里递归提取候选路径（非空字符串 / 字符串数组），
与共享状态里**他人的未过期声明**按「同父目录的旁支及其后代，或目标路径的祖先」匹配。
命中且与上一次投递给同一个 agent 的占用集合（`accessSignature`）不同时，经 `agent.inject` **逐事件**
投递一条**显式标注来源**的 notice 消息：
`createUserMessage({ content, source })`，其中
`source = { kind: 'dsh-collab', form: 'notice', summary: boundContextSummary(...) }`。
客户端按 `source.kind !== 'user'` 把它渲染成 **notice 行、不是用户气泡** —— 来源是明示的，
冒充不了真人；`summary` 缺失时才会退化成 **opaque** 行，所以它必须非空（≤ 120 字符）。
工具结果**原样返回**（`post-execute` 返回 `downstream` 本身，不产生 `content` / `value` /
`additionalContexts` 任何改动）；一次调用最多投递一条；同一 agent 对同一组占用重复命中**不再投递**；
`agent` 不存在或没有 `inject` 函数时**不投递**，且绝不退回"自己造一条消息"；
任何异常都等价于"这次没有通知"，绝不进入 waterfall。

> **规范**：**严禁冒充用户**（见 `AGENTS.md` §1）—— 消息可以投，来源必须诚实。
> 构造一律走**真实的** `@deepseek-ai/dsh-llm`：`id` / `role` / 深冻结全部由构造函数补，
> `source` 显式 `dsh-collab/notice`（`kind` 在 `src/contract.ts` 里 augment `MessageSourceMap`
> 声明，0.1.7 起没有通用的 `plugin` 兜底种类）且 `form:'notice'` 必须带非空 `summary`。

通知文案与态势摘要同源：**完全时间无关**，不含任何时刻或倒计时。

### 功能 C — 可读性 + 原生写保护

claim 增加可读性维度（`readable`，默认 `true`；缺字段的老状态文件按可读处理）：
**写入对非持有者永远要协商；读取默认放行，只有持有者显式 `readable: false` 才要协商。**

可读性与 `mode` 的关系（0.8.1 起自洽）：**只有他人的 `exclusive` 声明才对他人生效**，
因此门控先按 `mode` 过滤，再判 `readable` —— `shared` / `read` 声明**既不拦写也不拦读**，
它们上面的 `readable: false` 不产生效果。这与 `claim()` 的冲突判据同源（同一份
`c.mode === 'shared' || c.mode === 'read'`），不会出现"声明一条 `read` 就把所有人的写入挡死"。

写保护走**原生审批路径**：`tools/pre-execute` 在调用是写/改（或命中 `readable: false` 的读）、
且目标路径被他人活跃的 **`exclusive`** 声明**覆盖**时返回 `{kind:'ask', reason}`，否则 `return next()` 原样放行。
被识别的工具是按实测 schema 逐个列出的：`write` / `edit`（`file_path`）、
`str_replace_editor`（`path`，`command=view` 算读，其余算写）、`read`（`file_path`）、
`glob` / `grep`（`path`）。

> **已知后果**：本类部署通常没有审批提示，而 `tools/pre-execute` 的文档写明
> 「missing approval support turns `ask` into denial」——此时 `ask` 等价于**硬拒绝**。
> 这是原生路径的行为，插件不另造 override 机制。
>
> **已知旁路**：shell 类工具（`bash` / `pwsh`）没有"目标路径"参数，无法在不制造假阳性
> 的前提下解析其 `command`，因此**不在**写工具表里 —— 通过 shell 写入不受本门控保护。

设置里新增开关 `enforceWriteLock`（`collab` 命名空间，默认 **`true`**，活读，无需重启）。

## 运行测试

```bash
pnpm run build          # 测试与发布均针对 lib/ 产物
npm test                # 依次运行下列全部测试

node tests/collab-pure-logic.mjs       # 纯逻辑 + hostCode 漂移守护
node tests/collab-convergence.mjs      # merge 的代数律（交换/结合/幂等）+ id 唯一 + 游标无损 + 终态化
node tests/collab-write-merge.mjs      # 两个写者并发写盘不丢更新（含负向对照）+ release 终态化
node tests/collab-integration.mjs      # Cordis 插件端到端（fake ctx）
node tests/collab-hostcode-parity.mjs  # 动态宿主形态**行为**对拍
node tests/collab-inline-parity.mjs    # 两形态**同名函数**逐输出对拍（30 个 + 集合回归守护）
node tests/collab-contract-derivation.mjs # 契约派生守卫（schema ⇄ d.ts ⇄ Python ⇄ 真实工具 schema）
node tests/collab-message-provenance.mjs # 规范守卫：严禁冒充用户（AGENTS.md §1）
node tests/collab-digest-stability.mjs # 态势摘要文本时间稳定性
node tests/collab-awareness.mjs        # 多会话态势注入
node tests/collab-access-gate.mjs      # 访问通知（agent.inject 的 notice 载体）+ 原生写保护（真实 cordis waterfall）
node tests/collab-reap.mjs             # op=reap 确证死亡的显式回收（dry-run / confirm / 无自动触发路径）
node tests/collab-e2e.mjs              # 真实 fs 路径/语义端到端（临时 DSH_HOME）
node tests/collab-skill.mjs            # 随包 skill + 委托纪律 + 偏好设置
node tests/collab-client-route.mjs     # Host 端技能索引路由（GET /dsh-collab/skill-index）

pnpm run test:types                    # TypeScript 契约静态检查
pnpm run test:real                     # 真实 DSH 部署上的委托纪律端到端（不在 npm test 内）
```

**跳过即失败**：测试里任何"环境不满足所以跳过"的路径**默认判失败**。只有显式设
`COLLAB_ALLOW_SKIP=1` 才放行，且会打印含「未验证」字样的横幅——绿的不等于验证过的。

---

## 状态维护

`src/collab-core.ts` 的 `sweep()` 在每次读/写前惰性执行（读路径只清内存；写路径把清理结果一并落盘，**即使该 op 自己 `changed:false`**）：

| 行为 | 阈值 | 说明 |
| --- | --- | --- |
| 终态墓碑（`released`）回收 | 表上限 `MAX_RELEASED = 4096` 条 | 墓碑值 = 该声明的 Lamport `seq`（只用于确定性排序）；规则**只看数据**，任何副本 GC 出同一结果；超限丢最旧的（值最小） |
| **确证死亡的显式回收** | **仅 `op=reap` + `confirm:true`** | **绝不自动**：dry-run 默认；判据只有一条 —— 会话注册表说持有者不在了 |
| 留言保留 | 最近 `MAX_MESSAGES = 2000` 条 **且** 总量 ≤ `MAX_MESSAGES_BYTES = 256 KiB` | 两个上限**取先到者**，超出都从最旧的开始丢弃；写入时回报 `swept.droppedMessages`（`swept` 是**条件字段**：仅当本次确有清理时才出现在返回里）。字节口径 = 每条留言 JSON 序列化的 UTF-8 字节之和（不含数组分隔符与外层键名） |
| 单条留言正文上限 | `MESSAGE_BODY_MAX_CHARS = 8000` 字符 | 只封条数会让状态"任意大"（一条 5MB 实测原样落盘）；超限由 `post()` 以 `bad-request` **显式挡回**，不静默截断 |
| 陈旧 holder 回收 | 无活跃声明且 `HOLDER_TTL_MS = 24h` 未出现 | 回收由 `sweep()` 执行；`list` 另用 `holderView()` 给出 `ageSec` / `active` / `stale` 与 `staleHolders`，并在有 stale 条目时附 `holdersNote` 说明「`holders` 是名册不是锁」 |
| holder 废弃预警 | 无活跃声明且静默 `HOLDER_STALE_WARN_MS = 1h` | `stale` 走这条更短的阈值，因此它是"看起来已废弃"的先行信号，在 `list` 上始终可达 |
| 损坏状态自愈 | JSON 解析失败 | 备份为 `<state>.corrupt-<ts>` 后重置为空状态，并以 `warning` 上报；旧备份只保留最近 3 份（`fs.listDir` 拿不到时静默跳过清理，绝不让自愈失败） |
| 旁挂损坏自愈 | 留言旁挂 JSON 解析失败 | 同样先备份为 `<name>.messages.json.corrupt-<ts>` 再按无留言继续（**不删不覆盖**），旧备份与主文件**共用同一份保留份数**（最近 3 份） |

> 「旧备份只保留最近 3 份」需要一个**删除原语**：包形态用 `node:fs` 的 rm；受限动态宿主没有删除能力，因此那一形态不清理备份（备份只增不减）—— 这是宿主能力限制，不是漏做。`state-core` 的注入面里 `removeFile` 缺失即整段跳过。

工具返回统一信封：失败时 `error` / `message` 在顶层（`bad-request`、`not-found`、`conflict`、`forbidden`、`timeout`、`concurrent-modification`、`internal`）。

### 状态文件的磁盘布局（0.15.0）

状态文档是 `{schemaVersion, seq, writer, claims, messages, holders, released}`（SSOT 见 `src/schema/collab.schema.json`）；它摊到磁盘上时拆成两半，让锁操作不必重写留言那条大尾巴（实测一份 82 KB 的状态里 97% 是留言）：

| 文件 | 内容 |
| --- | --- |
| `<name>.json` | `{schemaVersion, seq, writer, claims, holders, released}` —— 锁状态（KB 级） |
| `<name>.messages.json` | `{schemaVersion, seq, writer, messages}` —— 留言旁挂 |

- **加载期合并**：主文件 + 旁挂合并成一个逻辑文档；`seq` 取两边的较大值（Lamport 逻辑时钟，`claimId` 与 `msgId` 都从它分配）。
- **写盘**：`claim` / `release` 只写主文件；旁挂**只在留言真的变了**时才写（判据是"条数 + 首条 msgId + 末条 msgId"指纹，留言只有尾部追加与头部截断两种变化）。迁移那一次**先写旁挂再写主文件**，保证任何一步失败时留言都还在磁盘上。
- **迁移**：主文件里仍有 `messages`（旧布局）时与旁挂按 `msgId` 求**并集**（同 `msgId` 取 `(seq, writer)` 较大者，按 `(seq, writer)` 升序），**首次写盘**把并集搬进旁挂并从主文件里去掉这个键；**只搬不删**，`collab_board op=read` 迁移前后返回一致。求并集而不是"以主文件为准"的理由：滚动升级期间同一份状态会被新旧两个版本交替写（旧版写主文件、新版写旁挂），任何"以某一边为准"都会在下次写盘时把另一边整批覆盖掉。
- **跨进程收敛（单元 C）**：状态文件用 `replaceIfVersion` 写，而它是 probe → rename —— 两个进程可以同时 probe 到同一个 version、各自 rename 都成功，后写者静默覆盖先写者。所以写入不靠"版本守卫一定拦住"，靠状态本身**可合并**：每个写者有稳定唯一的写者戳（记录 id 是 `c_<seq>@<writer>` / `m_<seq>@<writer>`），写路径是 读 → `mergeDocs(盘上, 我的副本)` → 应用本次 op → 写 → **写后验证**（重读主文件、确认写者戳还是自己；不是就重读重合并重试）。`mergeDocs` 是半格 join（交换/结合/幂等）；`release` 不删记录而是留终态墓碑（`released`）：墓碑值 = 该声明的 Lamport `seq`，`sweep` 按 `(墓碑值, claimId)` 保留最大的 `MAX_RELEASED = 4096` 条（丢最旧，规则只看数据、不看时钟）。
- **合并语义的回归语料**：`tests/fixtures/merge-golden.json` 由 `tests/gen-merge-golden.mjs` 从 TS 的 `mergeDocs` 现算，`tests/collab-merge-golden.mjs` 断言产出与语料**逐字节相同** —— 改了合并语义而没重跑语料就会红。
- **读路径不合并任何"本地未落盘的改动"**（单元 D 澄清，不是缺陷）：`list` / `status` / `overview` / `collab_board op=read` / `wait` / 写保护门控都直接以**盘上内容**为准，因为它们根本没有可合并的东西——写是 **write-through**（每个 op 都在自己的事务里落盘，成功才返回）。唯一的 in-memory 副本是写事务内部的"合并基"，它在每次写盘成功后都等于盘上内容，且只服务于下一次写。所以"读到的比写过的旧"只可能来自读盘时的**跨进程时序**，不可能来自本进程未落盘的改动。
- `overview` 的 `otherProjects` 扫状态目录时排除 `*.messages.json`，不会把旁挂当成一个项目。

---

## 作为动态插件运行

把构建产物 `lib/collab-plugin.host.js` 导出的 `hostCode` 作为 `code.host` 传给 `cordis_define` 即可：

```js
import { hostCode } from './lib/collab-plugin.host.js'
// cordis_define({ plugin: { kind: 'new', idPrefix: 'coll' }, code: { host: hostCode } })
```

受限的动态宿主形态通过 `settings.prepareDocument()` 返回的绝对文档路径推导 DSH 用户目录，因此与包形态共享同一个状态目录；该服务不可用时落到会话项目内的 `.dsh-collab/`，并在 `warning` 中说明。动态 Package 在 DSH 进程存活期间有效，生产环境使用包形态。

---

## 部署

包形态经 `dsh.profile.bundles` 装载。源码改动后重新构建、打包并重启 DSH 进程即生效：

```bash
pnpm run build
pnpm pack --pack-destination <dist-dir>      # 生成 dsh-collab-<version>.tgz
# 更新 ~/.dsh/profiles/<profile>/package.json 的依赖后
pnpm install --dir ~/.dsh/profiles/<profile>
# 重启 dsh
```

**坑（实测，pnpm 12.4.1）**：**版本号不变**、只是用同一个文件名重新打包时，`pnpm install`
（含 `--force`）会**从 store 拿回缓存里的旧包**：lockfile 里那条 `file:` 依赖的 integrity 没变，
pnpm 就认为已解析、直接复用 —— 连 `rm -rf node_modules/dsh-collab` 再装也一样（"reused 7,
downloaded 0"，装回去的还是旧内容）。**唯一可靠的做法是让它重新解析**：

```bash
pnpm update dsh-collab --dir ~/.dsh/profiles/<profile>   # 重新哈希那个 tgz（会 "downloaded 1"）
```

改 `package.json` 里的版本号（新文件名）时，普通 `pnpm install` 就够了。

装完用 `diff -r lib ~/.dsh/profiles/<profile>/node_modules/dsh-collab/lib` 确认逐字节一致 ——
「装了」和「装对了」是两件事。
