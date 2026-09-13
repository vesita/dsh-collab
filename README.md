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

---

## 目录结构

```
.
├── crates/
│   └── collab-cli/               # Rust 高性能 CLI 与 Git-aware 冲突预警工具
├── docs/
│   ├── collab-plugin-design.md   # 完整设计文档（13 章 + 决策记录 + M1-M3 实现纪要）
│   └── collab-usage.md           # 面向任意会话的使用指南
├── scripts/
│   ├── collab_models.py          # Python dataclass 模型定义（Schema 派生）
│   └── simulate_collab.py        # Python (uv) 多 Agent 高并发冲突仿真与压测脚本
├── src/                          # TypeScript 源码（NodeNext 风格，import 写 ./x.js）
│   ├── index.ts                  # 包入口：注册工具 + 注入协作态势 + 访问通知/写保护/读者推送
│   ├── client.ts                 # 浏览器半边：Settings → Plugins 下的 dsh-collab 设置卡片
│   ├── collab-core.ts            # 纯逻辑唯一事实源（可 import / 可测 / 供多语言对照）
│   ├── plugin-message.ts         # 插件通知消息（逐字复刻 dsh-llm 的 createUserMessage 语义）
│   ├── collab-plugin.host.ts     # 自包含 Cordis Host 插件源码（导出 hostCode 字符串，可直接作为 code.host）
│   ├── paths.ts                  # 状态目录的唯一路径事实源（绝对路径推导 + 历史落点）
│   ├── schema/
│   │   └── collab.schema.json    # JSON Schema v1：状态文档 + 工具参数（单一契约）
│   └── types/
│       └── collab.d.ts           # TypeScript 类型定义（构建时复制到 lib/types/）
├── lib/                          # tsc 构建产物（git 忽略，随 npm 包发布）
├── skills/
│   └── subagent-delegation/
│       └── SKILL.md              # 随包发布的委托与验收纪律技能
└── tests/
    ├── collab-pure-logic.mjs        # 纯逻辑回归 + hostCode 内联副本漂移守护
    ├── collab-integration.mjs       # Cordis 插件端到端（fake ctx）
    ├── collab-hostcode-parity.mjs   # 动态宿主形态行为对拍（路径 + 三态语义 + holder 回收）
    ├── collab-awareness.mjs         # 多会话态势注入回归
    ├── collab-access-gate.mjs       # 访问通知（post-execute）与原生写保护（pre-execute）回归
    ├── collab-readers-push.mjs      # 读者反向注册 + 释放推送（含与真实 dsh-llm 的对拍）
    └── collab-e2e.mjs               # 真实 fs + 临时 DSH_HOME 的端到端回归
```

---

## 状态目录

状态目录 = `${DSH_HOME:-$HOME/.dsh}/collab/projects/`，由 `src/paths.ts` 统一产出：

```ts
collabDir(env?)              // <dshHome>/collab/projects（绝对路径）
projectStateFile(cwd, env?)  // 上面目录 + <项目名>-<哈希>.json
legacyCollabDirs(env?)       // 历史落点，用于一次性迁移
```

该路径是**绝对路径**，因此与 DSH 进程的启动目录无关：从任何目录启动的 dsh 实例，同一项目都落到同一个文件。`<哈希>` 由会话 cwd（项目根绝对路径）确定性派生。

`list` / `overview` / `status` 三个 op 都返回 `stateDir` 与 `statePath`，落点随时可核实。

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
[dsh-collab] 同项目其他会话当前占用：Other Session（exclusive）占用 src/backend/，租约 30 分（09-13 06:35Z–09-13 07:05Z）。改动这些路径前请先执行 collab_lock op=wait 或用 collab_board 协商。
```

租约刻意用**绝对 UTC 起止时刻**表示，而不是「还剩几分钟」的倒计时：DSH 只在运行时上下文的文本逐字节变化时才提交新快照，时间无关的摘要因此不会因为过了几分钟而被重复注入。

同项目暂无他人声明时，该上下文退化为一句通用协作规范。读盘走 15 秒 TTL 的后台缓存（`DSH_COLLAB_DIGEST_TTL_MS` 可调），provider 同步返回缓存，刷新失败时沿用上一份。

关闭方式：包形态设置环境变量 `DSH_COLLAB_NO_PROMPT_HINT=1`。受限的动态宿主形态读不到 `process.env`，因此它**始终注入**；需要彻底关闭时请使用包形态。

---

## 委托纪律偏好与设置卡片

运行时上下文除态势摘要外，还带一段常驻的**委托与验收纪律**；它同时决定随包的 `subagent-delegation` 技能是否注册。两者由包形态的一项设置控制，默认开启：

| 项 | 值 |
| --- | --- |
| 设置命名空间 | `dsh-collab` |
| 字段 | `exposeDelegationDiscipline` |
| 类型 / 默认 | `boolean` / `true` |

该命名空间经 `ctx.settings.installSection(...)` 注册（schema 由 `@deepseek-ai/schemastery` 描述），因此它出现在设置文档 `${DSH_HOME:-$HOME/.dsh}/settings.yaml` 与设置界面里。值是**活读**的：改完立即生效，无需重启 dsh。命名空间是可选服务，部署里没有 settings 服务时插件按 `true` 行事。

开启（默认）时，插件多做两件事：

1. 把随包发布的 `subagent-delegation` 技能注册进宿主技能注册表；
2. 通过 `systemPrompt.context()` 注入段名 `dsh-collab/delegation`、`order=131` 的纪律文本。

关闭时这两项都不注册。**中央注册锁与协作留言板不受影响**——它们是插件本体，始终在场。

纪律文本是**纯常量**：没有时间戳、计数或任何会漂移的字符。DSH 的运行时上下文快照按整串相等去重，常量块因此每个会话只提交一次；一旦掺入随步变化的文本，整块快照就会被反复重发。

### 设置界面里的那张卡片

偏好能出现在 UI 里，靠的是插件带的浏览器半边 `lib/client.js`（`package.json` 声明 `dsh.client` 与 `exports["./client"]`）。原因很直接：设置页只**枚举**命名空间、从不解释它，一张卡片是由拥有该命名空间的插件按 `settings.plugin.item` 槽位、以命名空间为 key 注册进来的——**谁拥有设置，谁自带卡片**。

打开 **设置 → 插件**（Settings → Plugins）即可看到 `dsh-collab` 的卡片：默认折叠的一行摘要（标题 + 当前两项状态），点开是两行设置项 —— 「委托与验收纪律」（下拉：关闭 / 集群协作，带一个打开随包技能正文的预览按钮）与「原生写保护」（下拉：拦截 / 不拦截）。控件直接写 Host，改完即保存；三种状态都如实呈现——命名空间尚未就绪时给一行加载占位，本部署没有 Host 半边时整张卡片不渲染，只读部署把控件置灰并说明原因。

**预览按钮的行为（0.8.2 起）**：点一下**直接**在右侧栏的文档面板打开随包技能正文，没有二次确认，**也不会关闭设置页**——设置页照常开着，右侧栏多出一份技能文档。按钮就只是「在右侧栏打开技能文档」，文案与行为一致。

> **本落点无法关闭设置页**：卡片注册在 `settings.plugin.item`，该槽位的 `standardProps` 只有 `useResource` / `useWorkspaces` / `usePanelInfo` / `useSessions` / `useSessionPendingInteraction`，**没有 `close` 回调**（`settings-plugins` 里就是 `renderSlot("settings.plugin.item", {}, { entryKey: ns })`，业务 props 是空对象）。设置页本身也不是 `layout` 的主面板——它是 `settings-general` 里 `SettingsRoot` 的组件内部 `useState`，因此 `layout.selectPanel(null)` 关不掉它，反而会清空中间主面板的选中项（把会话从中间列弄掉）；0.8.2 已把这个调用**整个删除**。**若将来确需自动关闭设置页，必须改用 `settings.section` 落点**——那里是 `renderSlot("settings.section", { close: onClose }, …)`，是唯一能拿到 `close` 回调的地方。

### 随包发布的委托技能

`skills/subagent-delegation/SKILL.md` 随包发布。偏好开启时，插件把它注册进宿主技能注册表（`ctx.skills.register`），标注 `source: 'bundled'`、`provider: 'dsh-collab'`，技能目录里因此能看到它、来源也可辨。注册随 effect disposer 撤回，**可逆**：插件卸载或偏好关闭，该技能随之消失。

插件的**动态宿主形态**（`hostCode` 字符串）刻意不注册该技能：受限动态环境没有包目录、也没有 `import`，无法定位 `<pkg>/skills/subagent-delegation/SKILL.md`。这是环境限制，不是遗漏。

包形态的 `DSH_COLLAB_NO_PROMPT_HINT=1` 关掉**所有**运行时上下文注入，纪律文本一并关闭（它不影响技能注册）。

---

## 0.8.0：访问通知、原生写保护与读者推送

> **0.8.4 修复（功能 D 的投递通道）**：读者若是**由 subagent 路由托管的会话**，
> `sessionController.prompt` 会被 DSH 结构化拒绝（`session/agent-busy`，message
> `session "…" is owned by subagent routing`，details 里明写
> `use subagent delivery for this child session`）。0.8.3 之前这条拒绝只留下一条
> `prompt-failed`，通知实际发不出去。0.8.4 在这种情况改用 **`ctx.subagents.sendMessage`**
> 再投一次，并在 `notify` 里把"走的哪个通道"与失败原因分开记。**安全闸门一条都没放宽**：
> 仍然只对 `isLiveSession()` 为真的读者投递 —— 回退通道会对"缺席的直接子会话"
> cold-resume，所以那道闸门对两个通道统一生效；拿不到释放者的活 Agent、或 `subagents`
> 不可用时不回退。详见下文「功能 D」。

> **0.8.3 修复（bug + 可观测性）**：0.8.2 的 `sweep()` 会按「会话是否加载」判据清理 `readers`，
> 而该判据对**休眠但可唤回**的会话返回 `undefined` —— 只是空闲的读者会在下一次任意写路径上
> 被删掉，claim 释放时已无人可推（静默丢通知）。0.8.3 让 `sweep()` 不再触碰 readers，
> 并在 `op=release` 的返回上新增 `notify` 汇总，把"没有人需要通知"与"通道坏了"分开。
> 详见下文「功能 D」。

> **0.8.2 修复（交互）**：设置卡片「预览」原先是「两步内联确认 → `layout.selectPanel(null)` 关设置页 → 右侧打开」。
> 前两步都错：`selectPanel(null)` 对设置页无效（它不是 `layout` 的主面板），却会清空中间主面板的选中项，
> 把会话从中间列弄掉；本槽位也根本没有关闭句柄。0.8.2 删掉二次确认与整个 `selectPanel(null)` 调用，
> 点「预览」直接打开右侧技能文档，设置页保持打开。详见上文「设置界面里的那张卡片」。

> **0.8.1 修复（bug）**：0.8.0 的写保护门控在收集阻塞声明时漏了 `mode` 过滤，把**他人的
> `shared` / `read` 声明也当成写阻塞** —— 后果是另一个会话按提示用 `mode=read` 声明 `src/`
> 之后，所有人的写入都会被硬拒绝（本部署 `ask` = deny），`shared` 的两个共享方也会互相挡死。
> 0.8.1 让门控与 `claim()` 用同一判据：**只有他人的 `exclusive` 声明阻塞他人**。

### 功能 A — 访问时的路径相关通知（旁路投递）

插件监听 `tools/post-execute`：从本次调用的参数里递归提取候选路径（非空字符串 / 字符串数组），
与共享状态里**他人的未过期声明**按「同父目录的旁支及其后代，或目标路径的祖先」匹配。
命中且与上一次投递给同一个 agent 的内容不同时，把一条 `source.form = 'notice'` 的插件消息
**前插**进该工具结果的 `additionalContexts`（不改 `content` / `value`，`block` 决策单独分支）。
一次调用最多合并一条；内容逐字相同时原样放行；任何异常都等价于"这次没有通知"，绝不进入 waterfall。

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

每条 claim 增加 `readers`（holderId 列表，默认 `[]`）。**被通知这个动作本身就完成登记**：
功能 A 投递通知时把被通知者写入该 claim 的 `readers`（去重）。移除读者的路径**只有两条**：
持有者释放，以及 `agent/disposed`（真正的会话结束，同时释放该 holder 的声明）。

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

在**显式 `op=release`** 成功之后、以及 `agent/disposed` 自动释放之后，插件向受影响 claim 的
读者推送一条通知，走可选的 `ctx.sessionController.prompt({requestId, sessionId, mode, content})`；
被"子代理路由托管"拒绝时改走 `ctx.subagents.sendMessage`（0.8.4 的回退通道，见下文）：

* **只推给此刻活着的会话**（`ctx.agents.get(sessionId)` 判定）。冷会话**直接丢弃**——
  `prompt` 的文档写明它会 resume 会话，而 `subagents.sendMessage` 的文档写明它对"缺席的直接
  子会话"会 cold-resume，两者都不允许因为推送唤醒冷会话（这道闸门对两个通道统一生效）；
* 通道缺失（`sessionController` 不可用）不再静默：候选读者会以 `prompt-failed` 出现在 `notify` 里；
* `mode`：`SessionSummary.running === true` 用 `'steer'`，其余（含判定不了）用 `'queue'`；
* 排除释放者自己；同一 `(claimId, reader)` 只推一次；全部 best-effort，绝不影响 release 的返回值。

**推送结果可观测（0.8.3）**：`op=release` 的返回在原有 `ok` / `released` / `serverTime` **之外**
追加一个 `notify` 字段，让"没有人需要通知"与"通知通道坏了"不再长得一样：

```jsonc
{
  "ok": true,
  "released": [ /* 原样，未改动 */ ],
  "serverTime": 1789293294682,
  "notify": {
    "readers": 2,                       // 该次涉及的去重读者数（pushed + skipped 的候选）
    "pushed": ["ses_me"],               // 真正投递成功的 sessionId
    "skipped": [
      { "sessionId": "ses_idle", "reason": "not-live" },              // 刻意不唤醒
      { "sessionId": "ses_x",    "reason": "already-pushed" },        // 同 (claimId, reader) 已推过
      { "sessionId": "ses_y",    "reason": "prompt-failed", "error": "timeout" } // 真实错误，超时即 'timeout'
    ]
  }
}
```

`reason` 只有 `not-live` / `already-pushed` / `prompt-failed` 三种取值；`error` 只在
`prompt-failed` 时出现，携带真实错误文本（`'timeout'`、`'no-session-controller'` 或 `prompt`
抛出的原始 message）。凡是失败都仍是 best-effort：`release` 一定仍是 `ok:true`，绝不抛出。

**子代理投递回退通道（0.8.4）**：读者如果是一个**由 subagent 路由托管的会话**，原生
`prompt` 会被 DSH 结构化拒绝，错误与 DSH 自己给的指示（实测 + 源码 `dsh-api-session-controller/lib/index.js:137`）是：

```jsonc
// RemoteError：code = 'session/agent-busy'
// message = 'session "ses_child" is owned by subagent routing'
// details = { reason: 'use subagent delivery for this child session' }
```

这时插件改用 `ctx.get('subagents')` 的
`sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], { signal })`
（Inspect 实查的服务契约）把同一条通知再投一次：

* **sender 必须是释放者的那个活 Agent 对象本身**（工具处理器里的 `exec.agent`）。DSH 用
  `ctx.agents.get(sender.id) !== sender` 做对象同一性判定（`dsh-subagent/lib/index.js:1735`），
  所以插件只做类型收窄、**绝不重建**该对象；拿不到它（例如 `agent/disposed` 那条路径上
  正在销毁的 agent）就**不回退**，如实记 `skipped`。
* **邻接是硬约束**：`sendMessage` 只能投给 sender 的**直接父会话**或**直接可续子会话**。
  跨父会话的子代理读者会被 DSH 拒绝（`SubagentError` code `UNAUTHORIZED` / `PARENT_UNAVAILABLE`
  / `NOT_RESUMABLE`），插件把这次失败记成 `reason: 'not-adjacent'`（**如实记录，不静默**）。
* `signal` 用自建 `AbortController`，并沿用与 `prompt` 通道同一套 3s 超时护栏。
* **不 cold-resume 的保证**：`sendMessage` 的文档写明 "an absent direct child cold-resumes
  from persistence"。插件因此把 `isLiveSession(sessionId)`（`ctx.agents.get(sessionId) !== undefined`）
  这道闸门放在**两个通道之前**统一判定 —— 不活的读者一律 `reason: 'not-live'` 直接丢弃，
  一次 `prompt`、一次 `sendMessage` 都不会发出去。回退**没有**放宽任何既有安全闸门。

`notify` 相应地**只做追加**（既有字段名与既有 `reason` 取值一字未改）：

```jsonc
{
  "ok": true,
  "released": [ /* 原样，未改动 */ ],
  "serverTime": 1789293294682,
  "notify": {
    "readers": 3,
    "pushed": ["ses_parent", "ses_child"],        // 语义不变：投递成功的 sessionId（不分通道）
    "pushedVia": [                                 // 0.8.4 追加：与 pushed 等长同序
      { "sessionId": "ses_parent", "channel": "session-controller" },
      { "sessionId": "ses_child",  "channel": "subagents" }
    ],
    "skipped": [
      { "sessionId": "ses_idle",  "reason": "not-live" },                        // 既有
      { "sessionId": "ses_x",     "reason": "already-pushed" },                  // 既有
      { "sessionId": "ses_y",     "reason": "prompt-failed", "error": "timeout" },// 既有（非路由的 prompt 失败）
      { "sessionId": "ses_sib",   "reason": "not-adjacent",  "error": "subagent \"ses_sib\" belongs to another parent session" }, // 0.8.4 追加
      { "sessionId": "ses_z",     "reason": "subagent-failed", "error": "no-subagents-service" }                                 // 0.8.4 追加
    ]
  }
}
```

新增取值：`not-adjacent`（原生 prompt 被"路由托管"拒绝、回退又因邻接不成立被拒）与
`subagent-failed`（回退通道本身失败/超时/不可用，`error` 为真实文案或
`'timeout'` / `'no-subagents-service'` / `'no-live-sender-agent'`）。哪些失败**不**触发回退是刻意的：
只有 `code === 'session/agent-busy'` **且** `details.reason === 'use subagent delivery for this
child session'`（`details` 丢失时退化为比对 message 里 DSH 自己写死的 `owned by subagent routing` /
`durable parent address`）才回退。同一个 code 在 DSH 里**不止一处**抛出 ——
`dsh-api-session-controller/lib/index.js:785` 用 `session/agent-busy` + message `prompt rejected`
表示普通投递失败，那种情况**不回退**；认不出的 `agent-busy` 一律不触发，宁可少一次回退。

> **已知限制**：claim **自然过期（TTL 到期）不推送** —— 没有对应的事件源，过期只在下一次
> 读/写时被 `sweep()` 惰性清理。需要对方知晓时请显式 `op=release`。

---

## 运行测试

```bash
pnpm run build          # 测试与发布均针对 lib/ 产物
npm test                # 依次运行下列全部测试

node tests/collab-pure-logic.mjs       # 纯逻辑 + hostCode 漂移守护
node tests/collab-integration.mjs      # Cordis 插件端到端（fake ctx）
node tests/collab-hostcode-parity.mjs  # 动态宿主形态行为对拍
node tests/collab-awareness.mjs        # 多会话态势注入
node tests/collab-access-gate.mjs      # 访问通知 + 原生写保护（真实 cordis waterfall）
node tests/collab-readers-push.mjs     # readers 反向注册 + 释放推送 + 子代理回退通道 + 消息形状对拍
node tests/collab-e2e.mjs              # 真实 fs 路径/语义端到端（临时 DSH_HOME）

pnpm run test:types                    # TypeScript 契约静态检查
uv run python scripts/simulate_collab.py
cargo test --manifest-path crates/collab-cli/Cargo.toml
```

---

## 状态维护

`src/collab-core.ts` 的 `sweep()` 在每次读/写前惰性执行：

| 行为 | 阈值 | 说明 |
| --- | --- | --- |
| 过期声明回收 | 租约到期 | 过期声明随每次读取失效，不再阻塞他人 |
| 留言保留 | 最近 `MAX_MESSAGES = 2000` 条 | 超出部分从最旧的开始丢弃，写入时回报 `swept.droppedMessages` |
| 陈旧 holder 回收 | 无活跃声明且 `HOLDER_TTL_MS = 24h` 未出现 | 回收由 `sweep()` 执行；`list` 另用 `holderView()` 给出 `ageSec` / `active` / `stale` 与 `staleHolders` |
| holder 废弃预警 | 无活跃声明且静默 `HOLDER_STALE_WARN_MS = 1h` | `stale` 走这条更短的阈值，因此它是"看起来已废弃"的先行信号，在 `list` 上始终可达 |
| 损坏状态自愈 | JSON 解析失败 | 备份为 `<state>.corrupt-<ts>` 后重置为空状态，并以 `warning` 上报 |

工具返回统一信封：失败时 `error` / `message` 在顶层（`bad-request`、`not-found`、`conflict`、`forbidden`、`timeout`）。

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
