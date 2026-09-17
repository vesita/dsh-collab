# dsh-collab — 多 DSH 会话协同插件（Collab）

让**同一项目上的多个 DSH 会话**彼此可见、互相避让的部署级协作能力。典型场景是两三个独立会话（不同对话、不同浏览器标签、甚至不同 dsh 进程）并行改同一个仓库：每个会话都能自动看到别人占着什么，并在动手前完成声明。

它提供两个模型工具：

| 工具 | 作用 |
| --- | --- |
| `collab_lock` | **中央注册锁**：开工前声明"我占用哪些文件夹/文件"，并查询/等待/协商 |
| `collab_board` | **协作留言板**：发消息 / 增量读消息，用于协商、交接、同步进展 |

## 多会话协同靠三个机制

1. **共享状态**：所有会话（含子代理、跨进程）读写同一份状态文件，路径由项目工作区绝对路径确定性派生。
2. **自动态势注入**：每次模型步，插件把"同项目其他会话当前占着什么"写进运行时上下文。会话无需记得去查，也无需知道对方存在。
3. **声明占用**：改动前 `claim` 目标路径；冲突时 `wait` 等待或用 `collab_board` 协商。

> 面向使用者的完整规范见 [`docs/collab-usage.md`](docs/collab-usage.md)。
>
> 子代理路由（默认继承父会话 vs 用原生 preset 固定成配置路由）的机制与实测证据见
> [`docs/dsh-subagent-routing.md`](docs/dsh-subagent-routing.md) —— **那是文档，不是提示词**，
> 不进 `skills/`、不进运行时纪律文本。

---

## 目录结构

```
.
├── crates/
│   └── collab-cli/               # Rust 高性能 CLI 与 Git-aware 冲突预警工具
├── docs/
│   ├── collab-plugin-design.md   # 完整设计文档（18 节 + 决策记录 + M1-M3 实现纪要）
│   ├── collab-usage.md           # 面向任意会话的使用指南
│   ├── dsh-subagent-routing.md   # DSH 子代理路由：默认继承 vs 原生 preset 固定（机制 + 实测索引；非提示词）
│   └── collab-ux-backlog.md      # 使用不便清单与优化方向（含实测使用统计）
├── scripts/
│   ├── collab_models.py          # Python dataclass 模型定义（Schema 派生）
│   └── simulate_collab.py        # Python (uv) 多 Agent 高并发冲突仿真与压测脚本
├── src/                          # TypeScript 源码（NodeNext 风格，import 写 ./x.js）
│   ├── index.ts                  # **组合根**（60 行）：只做接线，按依赖顺序调用各 installer
│   ├── contract.ts               # 对外契约类型（工具/服务/返回结构的类型面）
│   ├── spec.ts                   # 纯常量与纯函数（工具路径规格、状态目录文案、sessionIdOf…）
│   ├── collab-core.ts            # 纯逻辑唯一事实源（可 import / 可测 / 供多语言对照）
│   ├── paths.ts                  # 状态目录的唯一路径事实源（绝对路径推导 + 历史落点）
│   ├── store.ts                  # 状态文件存取 + 只读 op（list/overview/status/msgs/wait）
│   ├── tools.ts                  # collab_lock / collab_board 注册（消费 store + push）
│   ├── access.ts                 # 功能 A：访问通知（逐事件经 agent.inject 投递 form:'notice' 的显式来源消息）+ 读者反向注册（tools/post-execute）
│   ├── gate.ts                   # 功能 C：写/读的原生审批门控（tools/pre-execute）
│   ├── auto-release.ts           # 循环终止自动释放（agent/status → idle，宽限 120 秒 + 有子代理在跑不放；tools.ts 之外的第二条回收路径）
│   ├── push.ts                   # 功能 D：释放推送（唯一通道 agent.inject + 显式来源 form:'notice'）+ agent/disposed 生命周期
│   ├── awareness.ts              # 协作态势注入（运行时上下文 order 130）
│   ├── delegation.ts             # 委托纪律：settings 偏好 + 随包 skill + 常驻纪律块（order 131）
│   ├── skill.ts                  # 随包 skill 读盘与 buildSkillIndex（delegation 与路由共用）
│   ├── client-route.ts           # 浏览器半边只读 loopback 路由（技能索引）
│   ├── client.ts                 # 浏览器半边：设置 → 插件 里 dsh-collab 标签页
│   ├── collab-plugin.host.ts     # 自包含 Cordis Host 插件源码（导出 hostCode 字符串，可直接作为 code.host）
│   ├── schema/
│   │   └── collab.schema.json    # JSON Schema v1：状态文档 + 工具参数（单一契约）
│   └── types/
│       └── collab.d.ts           # TypeScript 类型定义（构建时复制到 lib/types/）
├── lib/                          # tsc 构建产物（git 忽略，随 npm 包发布）
├── skills/
│   └── subagent-delegation/
│       └── SKILL.md              # 随包发布的委托与验收纪律技能
└── tests/
    ├── _harness.mjs                 # 共用断言脚手架（ok / skip / 汇总 / 退出码）
    ├── collab-pure-logic.mjs        # 纯逻辑回归 + hostCode 内联副本漂移守护
    ├── collab-integration.mjs       # Cordis 插件端到端（fake ctx）
    ├── collab-hostcode-parity.mjs   # 动态宿主形态**行为**对拍（路径 + 三态语义 + holder 回收）
    ├── collab-inline-parity.mjs     # 两形态**同名函数**逐输出对拍（19 个，含集合回归守护）
    ├── collab-contract-derivation.mjs # 契约派生守卫（schema ⇄ d.ts ⇄ Python ⇄ Rust ⇄ 真实工具 schema）
    ├── collab-message-provenance.mjs # 规范守卫：严禁冒充用户（AGENTS.md §1）
    ├── collab-digest-stability.mjs  # 态势摘要文本时间稳定性回归（运行时快照去重）
    ├── collab-awareness.mjs         # 多会话态势注入回归
    ├── collab-access-gate.mjs       # 访问通知（agent.inject 的 notice 载体）与原生写保护（pre-execute）回归
    ├── collab-readers-push.mjs      # 读者反向注册 + 释放推送 + 子代理回退 + 通知载体回归
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

插件通过 `systemPrompt.context()` 注册一条 `order=130`（紧随 sandbox / approval / subagent-delegation）的运行时上下文。它的 provider 在装配时执行：

```
agents.currentInitiator()            → 正在装配的那个会话
  .session.header.cwd                → 项目根
  → 读共享状态文件 → 过滤出他人的未过期声明 → 渲染成一行
```

渲染结果形如：

```
[dsh-collab] 同项目其他会话当前占用：Other Session（独占）占用 src/backend/，租约 30 分（09-13 06:35Z–09-13 07:05Z）。改动这些路径前请先执行 collab_lock op=wait 或用 collab_board 协商。
```

租约刻意用**绝对 UTC 起止时刻**表示，而不是「还剩几分钟」的倒计时：DSH 只在运行时上下文的文本逐字节变化时才提交新快照，时间无关的摘要因此不会因为过了几分钟而被重复注入。

同项目暂无他人声明时，该上下文退化为一句通用协作规范。读盘走 15 秒 TTL 的后台缓存（`DSH_COLLAB_DIGEST_TTL_MS` 可调），provider 同步返回缓存，刷新失败时沿用上一份。缓存里存的是**该 cwd 的原始活跃占用列表**，「排除谁」按**读取时的发起者**现场做——同一份缓存对所有会话都成立，只有「排除谁」因人而异；0.9.11 起排的是**整个会话家族**（自己 + 祖先 + 后代），见「会话家族（血缘）」一节。

关闭方式：包形态设置环境变量 `DSH_COLLAB_NO_PROMPT_HINT=1`。受限的动态宿主形态读不到 `process.env`，因此它**始终注入**；需要彻底关闭时请使用包形态。

同一个开关也管住**功能 A 的访问通知**（`plugin: 'dsh-collab'`、`form: 'notice'` 的消息）：它是运行时状态派生出来、再注入进会话的内容，所以 `DSH_COLLAB_NO_PROMPT_HINT=1` 下**不投递**。只关投递 —— 读者反向登记（功能 D）照常发生。这一条由 `tests/collab-access-gate.mjs` 钉住，并配了负向对照（摘掉开关判定 -> 该断言精确变红）。

（受限的**动态宿主形态**不接线 `tools/pre-execute` / `tools/post-execute`，因此它本来就没有访问通知与原生写保护 —— 那是既定环境限制，与这个开关无关。见 `src/collab-plugin.host.ts`。）

---

## 委托纪律偏好与设置卡片

运行时上下文除态势摘要外，还带一段常驻的**委托与验收纪律**；它同时决定随包的 `subagent-delegation` 技能是否注册。两者由包形态的一项设置控制，默认开启：

| 项 | 值 |
| --- | --- |
| 设置命名空间 | `dsh-collab` |
| 字段 | `exposeDelegationDiscipline` |
| 类型 / 默认 | `boolean` / `true` |
| 字段 | `enforceWriteLock` |
| 类型 / 默认 | `boolean` / `true` |
| 字段 | `releaseOnLoopEnd` |
| 类型 / 默认 | `boolean` / `true` |
| 字段 | `loopEndGraceSec` |
| 类型 / 默认 | `number` / `120`（夹在 `[1, 3600]`；0.9.11 起，此前 15） |

四个字段同属一个命名空间：前两项控制委托纪律与写保护（见上），后两项控制**循环终止自动释放**（见下文「循环终止自动释放」一节）。

该命名空间经 `ctx.settings.installSection(...)` 注册（schema 由 `@deepseek-ai/schemastery` 描述），因此它出现在设置文档 `${DSH_HOME:-$HOME/.dsh}/settings.yaml` 与设置界面里。值是**活读**的：改完立即生效，无需重启 dsh。命名空间是可选服务，部署里没有 settings 服务时插件按 `true` 行事。

开启（默认）时，插件多做两件事：

1. 把随包发布的 `subagent-delegation` 技能注册进宿主技能注册表；
2. 通过 `systemPrompt.context()` 注入段名 `dsh-collab/delegation`、`order=131` 的纪律文本。

关闭时这两项都不注册。**中央注册锁与协作留言板不受影响**——它们是插件本体，始终在场。

纪律文本是**纯常量**：没有时间戳、计数或任何会漂移的字符。DSH 的运行时上下文快照按整串相等去重，常量块因此每个会话只提交一次；一旦掺入随步变化的文本，整块快照就会被反复重发。

### 设置界面里的那个标签页

偏好能出现在 UI 里，靠的是插件带的浏览器半边 `lib/client.js`（`package.json` 声明 `dsh.client` 与 `exports["./client"]`）。原因很直接：设置 → 插件 分区只**枚举**标签页、从不解释它，一个配置页是由插件自己按 `settings.plugins.tab` 槽位、以 id 注册进来的——**谁拥有配置，谁自带页面**。

打开 **设置 → 插件** 并切到 `dsh-collab` 标签页，即可看到三行设置项 —— 「委托与验收纪律」（下拉：关闭 / 集群协作，带一个打开随包技能正文的预览按钮）、「原生写保护」（下拉：拦截 / 不拦截）与「循环终止自动释放」（下拉：自动释放 / 不自动释放 + 宽限期秒数输入框）。控件直接写 Host，改完即保存；三种状态都如实呈现——命名空间尚未就绪时给一行加载占位，本部署没有 Host 半边时整页不渲染，只读部署把控件置灰并说明原因。

**预览按钮的行为**：点一下**直接**在右侧栏的文档面板打开随包技能正文，没有二次确认，**也不会关闭设置页**——设置页照常开着，右侧栏多出一份技能文档。按钮就只是「在右侧栏打开技能文档」，文案与行为一致。

> **本落点拿不到关闭句柄**：`settings.plugins.tab` 不传任何 props，所以页面无法自行关闭设置页。需要关闭能力时改用 `settings.section` 落点——那里是 `renderSlot("settings.section", { close: onClose }, …)`。

### 随包发布的委托技能

`skills/subagent-delegation/SKILL.md` 随包发布。偏好开启时，插件把它注册进宿主技能注册表（`ctx.skills.register`），标注 `source: 'bundled'`、`provider: 'dsh-collab'`，技能目录里因此能看到它、来源也可辨。注册随 effect disposer 撤回，**可逆**：插件卸载或偏好关闭，该技能随之消失。

技能正文的 §10.4 与常驻纪律文本（`DELEGATION_DISCIPLINE_TEXT`）同时写明一条恢复路径：**子代理意外终止（回合以 `error` / 空收尾结束、久等之后不再是 `running`）时先唤醒它、别急着重派**。唤醒靠 `send_message`（对 `idle` / `ready` 的子代理会**开启一个回合**，且是**同一个会话**，所以它保留着上下文与已完成的工作，比重派便宜），而 `collab_board` 那条通道**唤不醒任何人** —— `agent.inject` 的契约是 `send(msg, 'next-step', wakeup=false)`，只挂进收件箱、不起 driver。两处都提醒：被唤醒的子代理**不知道自己已经丢锁**（循环一停，声明就被自动释放），要让它先 `collab_lock op=claim` 再动手；同一处最多试一两次，之后自己写。

插件的**动态宿主形态**（`hostCode` 字符串）刻意不注册该技能：受限动态环境没有包目录、也没有 `import`，无法定位 `<pkg>/skills/subagent-delegation/SKILL.md`。这是环境限制，不是遗漏。

包形态的 `DSH_COLLAB_NO_PROMPT_HINT=1` 关掉**所有**运行时注入 —— 态势上下文、委托纪律文本、以及功能 A 的访问通知（后者也是运行时派生再注入进会话的内容）。它不影响技能注册。

---

## 会话家族（血缘）

**问题**（backlog §2.1，Top 5 第 3 条）：holder 身份是 `agent:<会话 id>`，而**子代理跑在自己的
会话里** ⇒ 主会话 `claim src/`（exclusive）之后派子代理去改 `src/` 下的文件，子代理会被这把锁
**硬拒绝**（本部署审批关闭，`ask` 即 `deny`），而且它无权释放（`release` 只允许持有者本人）——
只能到留言板求父会话放锁，而父会话的循环可能已经停了。核心工作流（派子代理写代码）就此卡死。

**血缘从哪来**：子代理创建时会把 `parentSession: parentHeader.id`、`origin: 'subagent'`、
`delegationDepth` 写进会话头（`dsh-subagent/lib/types/child-agent.js:117-123`；类型见部署内
`dsh-agent/lib/types/index.d.ts:66`）。祖先链可上溯，`store.familyIds()` 因此能现算出
**自己 + 祖先链 + 后代**这一组 holderId（后代会话从 `agents.list()` 里按祖先链反查）。

**判据**：`collab-core.inFamily(h, holderId)` —— 家族成员之间的独占声明**不构成冲突**。
它取代了原先散在 6 处的裸判据 `c.holderId === h.holderId`：

| 位置 | 作用 |
| --- | --- |
| `collab-core.claim()` | 冲突扫描（子代理 claim 父占的路径） |
| `collab-core.blockers()` | `op=wait` 的阻塞判据（不 wait 自家人） |
| `gate.ts` | 原生写门控（子代理写父占的路径） |
| `awareness.ts` | 常驻态势摘要（不把自家子代理报成"其他会话占用"，backlog §2.2） |
| `access.ts` | 访问通知（不为自家人发通知） |
| `collab-plugin.host.ts` | 动态形态的内联副本（同上五处，由 parity 测试对拍） |

**三条纪律**：

1. **只缩不放**——拿不到 `agents` 服务、读不到血缘字段、或 `h.family` 缺省时，判据退化为
   "只看 holderId 是否相等"，也就是 0.9.10 的语义。**不会**因为判据缺失就放行陌生人。
2. **不落盘**——`family` 只活在 `HolderInput` 上（`holder()` 只挑已知字段写状态文件），
   每次从运行时现算。血缘因此**不进契约**（`src/schema/collab.schema.json` 的 4 份派生物
   一份都不用改）。
3. **带环保护与深度上限**（16 层）——血缘字段来自会话头，不能假设它良构。

**与自动释放的次序**：家族豁免必须**先**落地。它是"父独占、子代理写不了"的正解，而自动释放
只是那个死锁的临时出口；先放宽宽限期（或加第四道闸门）会把死锁还回来。理由记在
「循环终止自动释放」一节。

**测试**：`tests/collab-pure-logic.mjs`（正负对照：自家人放行 / 无血缘第三方仍 conflict /
血缘缺省仍 conflict / 父写子占的路径放行 / holders 表不出现 `family`）、
`tests/collab-inline-parity.mjs`（`inFamily` 进同名集合，7 条语料逐输出对拍两形态）、
`tests/collab-access-gate.mjs`（门控侧）。

---

## 循环终止自动释放

**问题**：父会话 `claim` 后把写入交给子代理，**自己循环停了**。子代理被门控硬拒绝，到留言板
`@` 它也没用 —— `agent.inject` 是 `send(msg, 'next-step', wakeup=false)`，**不唤醒 driver**
（`dsh-agent/lib/types/runtime-types.d.ts:202-209`），停下的循环读不到留言。结果只能干等租约
（默认 1800 秒）或让别人 `op=reap`。根子是**锁的生命周期比会话的循环长**。

**判据**：`agent/status` 从 `running` 翻到 `idle`（循环停了）。**不是** `agent/disposed` ——
idle 的 agent 仍在 `agents.list()` 里、仍可唤醒，所以 W7「dispose 不释放」没有被推翻。

**四道闸门**（前三道方向都是"少放"）：宽限期 `loopEndGraceSec`（0.9.11 起默认 **120 秒**，
此前 15）排除回合之间的正常停顿；宽限期内任何状态变化都让本次武装作废（代次）；到点**必须**
解析到那个 agent 且它此刻仍是 `idle` —— 服务缺失 / `get()` 抛错 / 已 dispose / 非 idle，
**一律不放**；第四道是 0.9.11 新增的**「有自家子代理在 running 就不放」**（见
「会话家族（血缘）」一节）：子代理在跑说明锁还在被用，它只是不在我的循环里。放的时候
只释放该 holder **未过期**的声明。

**释放后两条告知**（都经 `agent.inject` 的显式来源 notice）：等待者收到「锁已自动释放」（不是
"X 已释放"，释放者不是持有者）；被释放的会话本人收到「你的声明已被自动释放，恢复工作前重新
`claim`」—— 后者是安全阀，否则它恢复后仍以为自己持锁。同时在状态文件里留一条审计留言
（`channel` = `agent:<sessionId>`，作者 `system:dsh-collab`），`collab_board op=read` 可回读。

0.9.11 降噪：**发给本人的那条注入通知**按 `holderId` 在 60 秒窗口内合并（第二次起记
`error: 'deduped'`），专治"claim→release→claim"抖动；**审计留言一条都不合并**——那是取证账目，
合并它等于篡改证据。等待者的通知仍按 `(claimId, reader)` 去重，语义不变。

| 回收路径 | 触发 | 说明 |
| --- | --- | --- |
| 租约到期 | 时间 | `sweep()` 回收，仍是最后兜底 |
| `op=release` | 持有者显式 | — |
| **循环终止自动释放** | `idle` + 宽限到点 | 本版新增；**仅限仍加载着的会话** |
| `agent/disposed` | agent 离开注册表 | **不释放**未过期声明（W7） |
| `op=reap` | 显式 `confirm:true` | 只收确认的僵尸，默认 dry-run |

**边界**：只覆盖"循环停了、agent 还加载着"的持有者。**已 dispose** 的持有者不在此列 ——
它收不到告知（注入面对未加载会话不可达），恢复后必然会以为自己还持锁，所以交给租约到期与
`op=reap`。

**设置**：`releaseOnLoopEnd`（默认 `true`）、`loopEndGraceSec`（0.9.11 起默认 `120`，夹在 `[1, 3600]`），
**活读**——武装后到点前关掉也照样拦住。**取舍**：宽限期排不掉"等真人回复"这种停顿，超过宽限期
同样会放锁；想让锁活得比循环长就关掉 `releaseOnLoopEnd` 或调大 `loopEndGraceSec`。

**为什么 0.9.11 才敢把 15 秒调长**：15 秒对"派完子代理、等它跑几分钟"这种长流程几乎必然误放。
但自动释放本身是「会话家族」落地前"父独占、子代理写不了"的**唯一**出口，先调长就等于把死锁
还回去 —— 所以次序是：**先做家族豁免（子代理不再需要父会话放锁），再调宽限期、再加第四道闸门**。

**两形态**：包形态 `src/auto-release.ts`（释放 + 两条通知）；动态形态 `hostCode` 内联等价释放
逻辑但**不投递通知**（受限环境没有 `@deepseek-ai/dsh-llm`，造不出显式来源消息，不许退回会冒充
用户的通道）。一致性由 `tests/collab-inline-parity.mjs`（纯函数逐输出）与
`tests/collab-hostcode-parity.mjs`（真实触发 `agent/status`）守护；完整生命周期见
`tests/collab-auto-release.mjs`。`collab_lock` 描述与常驻纪律文本各加一句"循环一停就自动放锁：
恢复工作前先重新 claim"（常驻文本仍是纯常量、无阿拉伯数字）。

## 僵尸声明的显式回收（`op=reap`）

**要解决的问题（实测，不是推演）**：2026-09-13 深夜，一个子代理会话（W10）被强杀（dsh 重启），
它持有的 `src/` + `tests/` exclusive 声明**留在了状态文件里**。声明只有持有者本人能 `release`
（对其他会话返回 `{"ok":false,"error":"forbidden","message":"only holder can release"}`），
而租约 `ttlSec` 最长可到 `86400` 秒 ⇒ **最长 24 小时内，任何其他会话对这些路径的写入都会被门控
硬拒绝**（本部署审批被禁用，`ask` 即 `deny`）。当时主 AI 只能手工改状态文件
（`~/.dsh/collab/projects/*.json`）才解开。

**判据为什么必须极其小心**：`agents.get(holderId) === undefined` **不能**单独作为"僵尸"依据 ——
休眠但**可唤回**的会话同样返回 undefined（实测活进程 `agents.list()` 只有 2 个 agent，
而 `sessionController.list()` 有 224 个会话）。这正是 0.8.2 的真缺陷（按 liveness 清 readers，
静默丢通知）与 W7 的决策（`agent/disposed` 不得提前释放未到期声明）的来源。
**运行时注册表无法区分"休眠可唤回"与"真死"**，而误杀的代价不对称：被回收的会话恢复后仍按对话历史
以为自己持有锁，另一边却看到路径空闲 ⇒ 两边同时以为可以写。

**因此 `op=reap` 是纯显式的**：默认 dry-run，`confirm: true` 才动手，且**绝不**接进 `sweep()`
或任何读路径、定时器、`agent/disposed`。判据（每条都写进返回值的 `reasons`）：

| 判据 | 说明 |
| --- | --- |
| 未过期 | `expiresAt > now`；已过期的归 `sweep()`，不是僵尸 |
| holder 不在 `agents.list()` | `ctx.get('agents').list()` 的 `'agent:' + id` 列表里没有它 |
| 不是调用者自己 | 清自己的锁用 `op=release` |
| age 超门槛 | `now - createdAt` **严格大于** `olderThanSec`，默认 **600 秒**（保守；可显式放大/缩小） |
| `paths` 限定（可选） | 只考虑与给定路径相交的声明 |
| **只对 `agent:<id>` holder** | `human:console` 从不在 `agents.list()` 里，"不在名单"对它零信息量；按它回收等于纯按 age 回收 |

**活体检查跑不成时一个也不收**：拿不到 `agents.list()`（服务/方法缺失或抛错）⇒ `liveHolderIds = null`
⇒ 候选为空并如实标 `livenessCheck: 'unavailable'`（"拿不到名单"与"名单为空"是两件事）。

**返回**（沿用现有信封，不改任何既有 op 的形状）：

- dry-run：`{ ok:true, data:{ dryRun:true, olderThanSec, serverTime, livenessCheck, candidates:[…] } }`
- `confirm:true`：`{ ok:true, data:{ dryRun:false, olderThanSec, serverTime, livenessCheck, reaped:[…] } }`

每个条目 = 该声明的公开视图（`claimId` / `holderId` / `holderName` / `paths` / `mode` …）
加上 `ageSec`、`remainingSec`（剩余租约）与 `reasons`（逐条判据标签）。

**回收后的读者通知**复用功能 D 的同一条投递面（`notifyReaders` → `agent.inject` + `form:'notice'`
的显式来源消息），**不另造通道**，也绝不触碰任何会冒充用户（`kind:'user'`）的接口；文案说"回收"
而不是"释放"（回收者不是原持有者）。只有**真的回收到了**才通知，dry-run 与空结果都不发。

**回归守卫**：`tests/collab-reap.mjs`（dry-run 状态逐字节不变 / confirm 正负成对 / age 门槛 /
自己的不回收 / 过期不归它 / paths 限定 / 通知 source 形状 / 活体检查不可用 / 静态断言"reap 只由
工具 handler 调用"）；两形态同步由 `tests/collab-inline-parity.mjs`（`reap` 进同名函数逐输出对拍）
与 `tests/collab-hostcode-parity.mjs`（宿主内联形态的 dry-run/confirm 行为）守护。

> **负向对照**（可复核）：临时删掉 `src/collab-core.ts` 里的 `if (live.has(c.holderId)) continue`
> 一行，`tests/collab-reap.mjs` 立即红在「2.4 活着的 holder 的声明**一条都没动**」（只剩 `c_mine`，
> `c_live` 被误删）；还原后逐字节一致、全绿。

---

## 释放通知与声明生命周期

**修的是两个真问题（都实测过）**：

- **释放通知在 GUI 里是「用户气泡」**。旧实现经 `sessionController.prompt`（主通道）与
  `subagents.sendMessage`（0.8.4 的回退通道）投递，而这两个 API **只收 `content`、不收 message**：
  消息由宿主代造并写死 `source: { kind: 'user', rpcId: 'dsh-collab-…' }` ⇒ 客户端按 `source.kind`
  分流后渲染成**用户气泡**（落进 next-step 收件箱还会升级成 steering 气泡，与真人输入共用同一个
  渲染器）。插件既改不了也看不见来源 ⇒ 只能换载体。
- **会话被 dispose 会提前丢掉未到期的声明**。`dropHolder` 原先只按 `holderId` 过滤、完全不看
  `expiresAt`：会话一结束就释放。但同一个 session 常常随后恢复并继续干活（对话历史里仍"记得"
  自己持锁），而别的会话在 `overview` 里看到路径**空闲** ⇒ 两边同时以为可以写。

**现在的行为**：

1. 释放通知的唯一投递面是 `ctx.get('agents').get(sessionId)` 解析到读者**自己的活 agent** 后
   `agent.inject(createUserMessage({ source: { kind: 'plugin', plugin: 'dsh-collab', form: 'notice',
   summary: boundContextSummary(…) } }))` —— 来源显式，GUI 里是独立可折叠的 notice 行而非气泡。
   解析不到就**如实跳过**（`skipped.reason = 'agent-not-resolvable'`），**没有任何回退通道**；
   `inject` 是同步契约 ⇒ 不再有 `timeout` 这一态；`prompt-failed` / `not-adjacent` /
   `subagent-failed` 三个 reason 随通道一起删除。
2. **租约 `expiresAt` 是声明生命周期的唯一权威**：`agent/disposed` 只回收该 holder **已过期**的声明、
   并把它从各 claim 的 `readers` 里摘掉；未到期声明原样保留，到期由惰性清理回收，`op=heartbeat`
   是唯一续租方式。安全侧后果如实记：会话死亡后其声明会占用到租约到期。
3. 常驻纪律新增一条：**主会话上下文最贵**（主 AI 跑最强也最贵的模型 ⇒ 目标是低上下文运行），
   配套 `skills/subagent-delegation/SKILL.md` §6 把「成本」一节改写为「让主 AI 用得起最强的模型」。

**回归守卫**：

- `tests/collab-readers-push.mjs` 全场景断言旧通道**零调用**，且每条投递的 source 形状为
  `plugin/notice` + 非空且 ≤120 字符的 summary（负向对照：把 `kind` 改回 `'user'` 即红）；
- `tests/collab-message-provenance.mjs` 新增机械规则：剥注释后扫 `src/` 与 `lib/`，
  `src/push.ts` 必须经 `agent.inject` + 真身 `createUserMessage`，且**代码里不得再出现**
  `subagents.sendMessage` / `sessionController`（负向对照：分别污染 `src/push.ts` 与 `lib/push.js` 各得一次 RED）；
- 两形态同步由 `tests/collab-inline-parity.mjs`（`dropHolder` 已进同名函数逐输出对拍）与
  `tests/collab-hostcode-parity.mjs`（触发真实注册的 `agent/disposed` 处理器）守护。

---

## 子代理禁止 client 平台检视 + 探索阶段默认先派

**修的是真故障（实测定位）**：
- **症状**：子代理执行 `cordis_inspect_query` 查询 `platform: 'client'`（如 `Slots` / `Theme`）会**永久挂起**。故障实测中子代理会话 `769c2e33` 调 `listSubTree` 空挂 344.8 秒直到被主 AI 中断；主会话做相同调用则瞬时返回。
- **根因**：`@deepseek-ai/dsh-cordis-host-runner/lib/types/inspect-registry.js` 的 `queryClient` 只被拥有该 `agentId` 的浏览器页面应答 settle，子代理没有浏览器页面，因此永不 settle。
- **现在的分工与硬化**：
  1. **纪律文本注入**：`src/spec.ts` 的 `DELEGATION_DISCIPLINE_TEXT` 追加纪律，明文禁止子代理调用客户端检视；界面信息必须由主 AI 在主会话预查并写入委派背景。
  2. **随包技能硬禁令**：`skills/subagent-delegation/SKILL.md` 新增 §10 硬禁令（含机制解释、反例、正例、以及 Slots/Theme/listSubTree 等危险信号清单），并在 §7 工具表格和 §9 踩坑速查中关联该禁令。
  3. **探索阶段默认先派**：强化探索期先派子代理拿取事实的纪律，防止主会话上下文浪费。

---

## 态势摘要按 cwd 缓存原始占用

**修的是真 bug（已实测复现）**：`dsh-collab/awareness` 的运行时候选摘要原先**只按 cwd 缓存「某个人视角
渲染好的文本」**，而「排除自己」的过滤做在**刷新侧**。同 cwd 的多个会话（父会话与其子代理）各自刷新，
后写覆盖先写；只要有一次刷新发生在 `id` 为空的 agent 上（`mine` 退化成 `human:console`，谁都不排除），
之后同 cwd 的所有会话都会读到这份「含自己锁」的缓存——**持有者会在自己的态势里看到自己的占用**，
误以为自己被挡着（正是这种误导会让人去 `wait`／`board` 协商一个不存在的竞争者）。

**修法**：缓存改存**该 cwd 的原始活跃 claim 列表**（渲染与时间无关，按 cwd 缓存原始数据是安全的），
「排除自己」挪到**读取侧**、按当次 `currentInitiator()` 现场过滤。**两形态同改**：
`src/awareness.ts` 与 `src/collab-plugin.host.ts` 里的内联副本。

**回归守卫**：新增 `tests/collab-awareness-cross-session.mjs`（已进 `npm test`）——两个会话同一 cwd、
由 `id` 为空的会话先刷新缓存，然后断言三条：**持有者看不到自己的锁**（负向对照）、**他人占用照常显示**、
claim 删除并强制刷新后双方都回落通用规范。修复前实测 `6 passed, 2 failed`（失败源唯一），修复后全绿。
既有的 `collab-awareness.mjs` 抓不到这条：它的假 `agents.list()` 永远只有 1 个 agent、`timer.interval`
被桩成 no-op，「同 cwd 两个会话互相覆盖缓存」这条路径从未被执行。

**顺带（提示词）**：常驻委托纪律文本（`src/spec.ts` 的 `DELEGATION_DISCIPLINE_TEXT`）新增一条
「探索阶段默认先派」，随包技能 `skills/subagent-delegation/SKILL.md` 新增 §1.1（探索期该派哪五类单元、
哪三种探索才允许自己做）——目标是让「先摸清情况」默认发生在子代理里，而不是主会话里。

---

## 架构拆分、契约守卫与「跳过即失败」

这一版**没有新增用户可见功能**，全是在夯地基——目标是让「两形态漂移」「契约漂移」「静默失败」
这三类问题在**下一次改动时当场变红**，而不是靠事后排查。

**架构**：1640 行的单体 `src/index.ts` 拆成 **11 个模块**，入口变成 60 行的**组合根**：只按依赖顺序
调用各 installer，并把上一个 installer 的返回值显式传给下一个（**没有跨模块可变全局**）。
对外导出面逐名不变。

**三道新的守卫**（都进了 `npm test`）：

- `tests/collab-inline-parity.mjs`：从动态形态的 `hostCode` 字符串里用**括号配对扫描**抽出
  **全部 19 个两形态同名函数**逐输出对拍。此前只有 `clockUtc` / `renderDigest` 两个被比对；
  并用「实测同名集合必须**恰好等于**期望集合」做回归守护——任何一侧新增同名函数却忘记接进对拍都会红。
- `tests/collab-contract-derivation.mjs`：把「schema 是单一事实源」从**声称**变成**可执行**——
  逐字段核对 `$defs` ⇄ `src/types/collab.d.ts` ⇄ `scripts/collab_models.py` ⇄
  `crates/collab-cli/src/main.rs` ⇄ **真实注册**的工具 schema。
- `.github/workflows/ci.yml`：Node 与 Rust 两个 job。

**「跳过即失败」**：测试里任何「环境不满足所以跳过」的路径**默认判失败**；只有显式设
`COLLAB_ALLOW_SKIP=1` 才放行，且会打印含「未验证」字样的横幅。绿的不等于验证过的。

**不再谎报**：状态文件损坏自愈时，备份/重置的失败原先被静默吞掉、warning 却宣称
「已备份 / 已重新初始化」；现在**如实**说明失败原因与**原始损坏内容此刻的下落**
（已备份 / 被重置覆盖 / 仍原样留在磁盘上）。包形态与动态宿主形态**同步**修好，避免两形态在
「损坏自愈是否谎报」上分叉。

**契约修复**：Rust CLI 的 `Mode` 缺 `Read` —— 只要项目里有**一个**会话用过 `mode=read`
（而插件自己就推荐只读调研用它），整个状态文件就会被 `Failed to parse JSON` 拒绝。已修，
并补齐 `ConflictInfo` / `SuggestedAction` 与往返测试。

**使用上已知的别扭之处与优化方向**：见 `docs/collab-ux-backlog.md`。

## 访问通知、原生写保护与读者推送

### 功能 A — 访问时的路径相关通知（逐事件经 `agent.inject` 投递 notice）

插件监听 `tools/post-execute`：从本次调用的参数里递归提取候选路径（非空字符串 / 字符串数组），
与共享状态里**他人的未过期声明**按「同父目录的旁支及其后代，或目标路径的祖先」匹配。
命中且与上一次投递给同一个 agent 的占用集合（`accessSignature`）不同时，经 `agent.inject` **逐事件**
投递一条**显式标注来源**的 notice 消息：
`createUserMessage({ content, source })`，其中
`source = { kind: 'plugin', plugin: 'dsh-collab', form: 'notice', summary: boundContextSummary(...) }`。
客户端按 `source.kind !== 'user'` 把它渲染成 **notice 行、不是用户气泡** —— 来源是明示的，
冒充不了真人；`summary` 缺失时才会退化成 **opaque** 行，所以它必须非空（≤ 120 字符）。
工具结果**原样返回**（`post-execute` 返回 `downstream` 本身，不产生 `content` / `value` /
`additionalContexts` 任何改动）；一次调用最多投递一条；同一 agent 对同一组占用重复命中**不再投递**；
`agent` 不存在或没有 `inject` 函数时**不投递**，且绝不退回"自己造一条消息"；
任何异常都等价于"这次没有通知"，绝不进入 waterfall。

> **规范**：**严禁冒充用户**（见 `AGENTS.md` §1）—— 消息可以投，来源必须诚实。
> 构造一律走**真实的** `@deepseek-ai/dsh-llm`：`id` / `role` / 深冻结全部由构造函数补，
> `source` 显式 `plugin/notice` 且 `form:'notice'` 必须带非空 `summary`。

通知文案与态势摘要同源：只用**绝对 UTC 租约窗口**，不含倒计时。

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

设置里新增开关 `enforceWriteLock`（`dsh-collab` 命名空间，默认 **`true`**，活读，无需重启）。

### 功能 D — 读者反向注册 + 释放推送

每条 claim 增加 `readers`（holderId 列表；**由 `publish()` / `readersOf()` 归一输出** `[]` —— 新 claim 初始为空，缺字段的老状态文件按空处理；schema 里的 `default: []` 只是文档性声明，运行时不回填它）。**被通知这个动作本身就完成登记**：
功能 A 投递通知时把被通知者写入该 claim 的 `readers`（去重）。移除读者的路径**只有两条**：
持有者释放，以及 `agent/disposed`（会话结束）时把已消失的 holder 从**所有** claim 的
`readers` 里摘掉（会话结束时**不再**同时释放它未到期的声明，见下文「claim 生命周期」）。

> **0.8.3 修复（清理语义）**：0.8.2 曾在 `mutate()` 里把「会话是否加载」判据
> （`agents.get(sessionId) !== undefined`）注入 `sweep()`，并用它**同时**清理 holders 与 readers。
> 但该判据对**已休眠、仍可唤回**的会话返回 `undefined`（实测活进程 `agents.list()` 只有 2 个
> agent，而 `sessionController.list()` 有 224 个会话），于是一个**只是空闲、并未结束**的读者
> 会在**下一次任意写路径**上被悄悄删掉；等那条 claim 释放时 `released[].readers` 已经是空的，
> 通知谁也发不出去 —— 静默丢消息。0.8.3 起 `sweep()` **不再触碰 readers**，
> `SweepOptions.liveHolders` / `SweepResult.prunedReaders` 一并删除；该判据只保留在
> 「此刻要不要推」这一处（拿不到 `agents` 服务时按**不推**处理，宁可少推也不唤醒冷会话）。
> 有界性不需要新增 TTL 或上限：readers 挂在 claim 上，claim 在 release 或到期时被移除，
> readers 随 claim 一起消亡。

**0.9.6：投递面只剩一个 —— `agent.inject` + 显式来源的 notice。**
在**显式 `op=release`** 成功之后、以及 `agent/disposed` 回收了该 holder **已过期**的声明之后，
插件向受影响 claim 的读者推送一条通知，投递路径**只有这一条**：

```
ctx.get('agents')          // 进程内的 agents 注册表
  → agents.get(sessionId)  // 解析读者**自己的活 agent**
  → agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-collab', form: 'notice', summary: boundContextSummary(…) }
    }))
```

* **来源显式、不冒充用户**：消息由**真实的** `@deepseek-ai/dsh-llm` 的 `createUserMessage`
  构造，`source` 显式写成 `plugin/notice`（`summary` 非空，经 `boundContextSummary` 截到
  120 字符）。客户端的分流只看 `source.kind`，且发生在收件箱分类**之前**
  （`dsh-client-ui-chat/lib/client.js:6058`）：`kind !== 'user'` ⇒ 渲染成**独立可折叠的 notice
  行**，**无论投进哪个收件箱都不是气泡**。
* **排除释放者自己**；同一 `(claimId, reader)` 只推一次（幂等键不变，仍**先记账再投递**，
  成功/失败都不再重投）；全部 **best-effort**，绝不抛、绝不影响 release 的返回值。
* **只推给此刻活着的会话**：投递前先过 `store.livenessOf(sessionId)` 这道安全闸门。
  `not-live` 直接跳过（**刻意不唤醒冷会话**；注入面对未加载的会话在结构上也不可能投递 ——
  注册表里根本没有它，解析即失败）。`liveness-check-failed`（存活判据**自己坏了**）与
  `not-live` **严格区分**，绝不折叠成后者。
* **同步契约 ⇒ 不再有 `timeout` 这一态**：`agent.inject(message): void` 是**同步**的
  （`dsh-agent/lib/types/runtime-types.d.ts:209`；实现 `dsh-agent-loop/lib/index.js:795` 只是把
  消息 splice 进收件箱并返回，`wakeup=false`），同步调用要么正常返回、要么当场抛，
  不存在"永不 resolve"的窗口。旧实现给 `prompt` 通道套的 3s 超时护栏随旧通道一起删除。
* **解析不到就如实跳过，没有任何回退**：`agents.get(sessionId)` 解析不到目标 agent（存活判据
  与这次查询之间的 TOCTOU 竞态）⇒ `skipped.reason = 'agent-not-resolvable'`；`agents` 服务本身
  缺失 ⇒ `inject-failed` + `error: 'no-agents-service'`；解析到的对象没有 `inject` 面（受限宿主）
  ⇒ `inject-failed` + `'agent-has-no-inject'`。**绝不再掉头去找任何"能把消息投出去"的通道** ——
  那正是旧实现冒充用户的来源。
* `pushedVia[].channel` **只有一个取值**：`'inject'`。
* `notifyReaders` 的第 4 个形参 `releaserAgent` **保留但不再使用**：0.8.4 曾拿它当子代理回退
  通道的 sender；通道删除后它不参与任何判定，保留只为**不动 `src/tools.ts:51` 的调用点签名**。

**为什么换掉旧通道**：0.8.4 的两条通道（`ctx.sessionController.prompt({requestId, sessionId,
mode, content})` 与 `ctx.subagents.sendMessage(sender, targetId, content, {signal})`）都**只收
`content`**，消息由宿主代造，宿主写死 `source: { kind: 'user', rpcId: 'dsh-collab-…' }`
—— 实测转录里就是 `user/message` + `kind:'user'`，在 GUI 里渲染成**用户气泡**（落进 next-step
收件箱还会升级成 steering 气泡，与真人输入共用同一个渲染器）。这违反 `AGENTS.md` §1
「严禁冒充用户」，故整体删除。自己构造消息（来源显式非 user）再 `agent.inject` 就能既投出去
又不冒充 —— 旧注释里"插件无法改变来源"的结论是错的。

**推送结果可观测（0.8.3）**：`op=release` 的返回在原有 `ok` / `released` / `serverTime` **之外**
追加一个 `notify` 字段，让"没有人需要通知"与"通知通道坏了"不再长得一样：

```jsonc
{
  "ok": true,
  "released": [ /* 原样，未改动 */ ],
  "serverTime": 1789293294682,
  "notify": {
    "readers": 6,                       // 该次涉及的读者数：按 sessionId 去重、非 agent holder 不计入（与下面 pushed/skipped 的逐 (claim, reader) 口径不同）
    "pushed": ["ses_me"],               // 真正投递成功的 sessionId
    "pushedVia": [                      // 与 pushed 等长同序；0.9.6 起 channel 只有一个取值
      { "sessionId": "ses_me", "channel": "inject" }
    ],
    "skipped": [
      { "sessionId": "ses_idle", "reason": "not-live" },                                   // 刻意不唤醒
      { "sessionId": "ses_x",    "reason": "already-pushed" },                             // 同 (claimId, reader) 已推过
      { "sessionId": "ses_y",    "reason": "liveness-check-failed", "error": "…" },        // 存活判据自己坏了
      { "sessionId": "ses_z",    "reason": "agent-not-resolvable", "error": "agent-not-resolvable" }, // 判据说活着，投递时已解析不到
      { "sessionId": "ses_w",    "reason": "inject-failed", "error": "no-agents-service" },// 通道不可用/投递抛错
      { "sessionId": "ses_v",    "reason": "internal", "error": "…" }                      // 链路兜底（逐条补记）
    ]
  }
}
```

0.9.6 起 `reason` 共 **6** 种取值（与 `src/contract.ts:147-148` 的联合类型逐字一致）：

| reason | 含义 | `error` |
| --- | --- | --- |
| `not-live` | 会话此刻未加载，**刻意不唤醒**（注入面对未加载的会话结构上不可能投递） | 无 |
| `already-pushed` | 同一 `(claimId, reader)` 已推过 | 无 |
| `liveness-check-failed` | 存活判据**本身坏了**（基础设施故障）—— 与 `not-live` 严格区分，绝不折叠 | 真实错误文本 |
| `agent-not-resolvable` | 0.9.6 追加：判据说活着、投递时却已解析不到目标 agent（TOCTOU 竞态）—— **如实跳过，无回退** | `'agent-not-resolvable'` |
| `inject-failed` | 0.9.6 追加：投递面本身不可用/失败 | `'no-agents-service'` / `'agent-has-no-inject'` / inject 抛出的真实文本 |
| `internal` | 0.9.0 追加：推送链路的整体兜底，逐条补记尚未记账的候选，使 `pushed + skipped` 永远能对上候选条数 | 真实错误文本 |

**已删除（0.9.6）**：`prompt-failed` / `not-adjacent` / `subagent-failed` —— 它们描述的
`sessionController.prompt` 与 `subagents.sendMessage` 两条通道会让宿主把消息来源写成
`kind:'user'`（GUI 里是用户气泡），已整体移除，**取值不再可产生**。凡是失败都仍是 best-effort：
`release` 一定仍是 `ok:true`，绝不抛出。

**claim 生命周期（0.9.6 语义）：租约 `expiresAt` 是声明生命周期的唯一权威。**

`agent/disposed`（会话结束）**不再提前释放未到期的声明**，它只做两件事：

1. 回收该 holder **已过期**的声明（若确实回收到了，走同一条 `notifyReaders` 通知其读者）；
2. 把已消失的 holder 从**各 claim 的 `readers`** 里摘掉（否则会向一个已经死掉的会话推送）。

**未到期的声明原样保留**（含它自己的 `readers`），到期由 `sweep()` 回收。

> **为什么**：会话 dispose 之后常常会被恢复，并继续按对话历史认为自己持有锁；如果声明在
> dispose 时就消失，另一个会话会看到"路径空闲"，于是两边同时以为可以写。

**安全侧后果（如实写）**：会话死亡后，它**未到期**的声明会一直占用到租约到期，期间他人只能
`op=wait` 等待或用 `collab_board` 协商；`op=heartbeat` 是**唯一**的续租方式。

> **历史（0.8.4 的 `subagents.sendMessage` 回退通道，0.9.6 已整体删除）**：它要求 sender 是
> 释放者的活 Agent（工具处理器里的 `exec.agent`，DSH 用对象同一性判定）、且只能投给 sender 的
> **直接父会话 / 直接可续子会话**（邻接硬约束，跨父会话记 `not-adjacent`），并复用 prompt 通道
> 同一套 3s 超时护栏（超时/不可用记 `subagent-failed`）。这些约束与 reason 随通道一起消失 ——
> 现在的 `inject` 面**既不需要 sender、也不要求邻接**，只要求读者自己的 agent 在本进程内可解析。

> **已知限制**：claim **自然过期（TTL 到期）不推送** —— 没有对应的事件源，过期只在下一次
> 读/写时被 `sweep()` 惰性清理。需要对方知晓时请显式 `op=release`。

---

## 运行测试

```bash
pnpm run build          # 测试与发布均针对 lib/ 产物
npm test                # 依次运行下列全部测试

node tests/collab-pure-logic.mjs       # 纯逻辑 + hostCode 漂移守护
node tests/collab-integration.mjs      # Cordis 插件端到端（fake ctx）
node tests/collab-hostcode-parity.mjs  # 动态宿主形态**行为**对拍
node tests/collab-inline-parity.mjs    # 两形态**同名函数**逐输出对拍（20 个 + 集合回归守护）
node tests/collab-contract-derivation.mjs # 契约派生守卫（schema ⇄ d.ts ⇄ Python ⇄ Rust ⇄ 真实工具 schema）
node tests/collab-message-provenance.mjs # 规范守卫：严禁冒充用户（AGENTS.md §1）
node tests/collab-digest-stability.mjs # 态势摘要文本时间稳定性
node tests/collab-awareness.mjs        # 多会话态势注入
node tests/collab-access-gate.mjs      # 访问通知（agent.inject 的 notice 载体）+ 原生写保护（真实 cordis waterfall）
node tests/collab-readers-push.mjs     # readers 反向注册 + 释放推送（唯一通道 agent.inject / form:'notice'）+ 通知载体
node tests/collab-reap.mjs             # op=reap 僵尸声明显式回收（dry-run / confirm / age 门槛 / 无自动触发路径）
node tests/collab-e2e.mjs              # 真实 fs 路径/语义端到端（临时 DSH_HOME）
node tests/collab-skill.mjs            # 随包 skill + 委托纪律 + 偏好设置
node tests/collab-client-route.mjs     # Host 端技能索引路由（GET /dsh-collab/skill-index）

pnpm run test:types                    # TypeScript 契约静态检查
pnpm run test:real                     # 真实 DSH 部署上的委托纪律端到端（不在 npm test 内）
uv run python scripts/simulate_collab.py
cargo test --manifest-path crates/collab-cli/Cargo.toml
```

**跳过即失败**：测试里任何"环境不满足所以跳过"的路径**默认判失败**。只有显式设
`COLLAB_ALLOW_SKIP=1` 才放行，且会打印含「未验证」字样的横幅——绿的不等于验证过的。

---

## 状态维护

`src/collab-core.ts` 的 `sweep()` 在每次读/写前惰性执行：

| 行为 | 阈值 | 说明 |
| --- | --- | --- |
| 过期声明回收 | 租约到期 | 过期声明随每次读取失效，不再阻塞他人 |
| **僵尸声明显式回收** | **仅 `op=reap` + `confirm:true`** | **绝不自动**：dry-run 默认、判据见「僵尸声明的显式回收」一节；被强杀的会话留下的未到期声明由调用方显式确认后回收 |
| 留言保留 | 最近 `MAX_MESSAGES = 2000` 条 | 超出部分从最旧的开始丢弃，写入时回报 `swept.droppedMessages`（`swept` 是**条件字段**：仅当本次 `droppedMessages > 0` 或 `prunedHolders > 0` 时才出现在返回里，且不含 readers 相关字段） |
| 陈旧 holder 回收 | 无活跃声明且 `HOLDER_TTL_MS = 24h` 未出现 | 回收由 `sweep()` 执行；`list` 另用 `holderView()` 给出 `ageSec` / `active` / `stale` 与 `staleHolders` |
| holder 废弃预警 | 无活跃声明且静默 `HOLDER_STALE_WARN_MS = 1h` | `stale` 走这条更短的阈值，因此它是"看起来已废弃"的先行信号，在 `list` 上始终可达 |
| 损坏状态自愈 | JSON 解析失败 | 备份为 `<state>.corrupt-<ts>` 后重置为空状态，并以 `warning` 上报 |

工具返回统一信封：失败时 `error` / `message` 在顶层（`bad-request`、`not-found`、`conflict`、`forbidden`、`timeout`、`concurrent-modification`、`internal`）。

---

## 作为动态插件运行

把 `collab-plugin.host.ts` 导出的 `hostCode` 作为 `code.host` 传给 `cordis_define` 即可：

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
