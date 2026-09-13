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
│   ├── index.ts                  # 包入口：注册工具 + 注入协作态势
│   ├── client.ts                 # 浏览器半边：Settings → Plugins 下的 dsh-collab 设置卡片
│   ├── collab-core.ts            # 纯逻辑唯一事实源（可 import / 可测 / 供多语言对照）
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

打开 **设置 → 插件**（Settings → Plugins）即可看到 `dsh-collab` 的卡片：一个复选框加一行说明。复选框直接写 Host，勾选即保存；三种状态都如实呈现——命名空间尚未就绪时给一行加载占位，本部署没有 Host 半边时整张卡片不渲染，只读部署把控件置灰并说明原因。

### 随包发布的委托技能

`skills/subagent-delegation/SKILL.md` 随包发布。偏好开启时，插件把它注册进宿主技能注册表（`ctx.skills.register`），标注 `source: 'bundled'`、`provider: 'dsh-collab'`，技能目录里因此能看到它、来源也可辨。注册随 effect disposer 撤回，**可逆**：插件卸载或偏好关闭，该技能随之消失。

插件的**动态宿主形态**（`hostCode` 字符串）刻意不注册该技能：受限动态环境没有包目录、也没有 `import`，无法定位 `<pkg>/skills/subagent-delegation/SKILL.md`。这是环境限制，不是遗漏。

包形态的 `DSH_COLLAB_NO_PROMPT_HINT=1` 关掉**所有**运行时上下文注入，纪律文本一并关闭（它不影响技能注册）。

---

## 运行测试

```bash
pnpm run build          # 测试与发布均针对 lib/ 产物
npm test                # 依次运行下列全部测试

node tests/collab-pure-logic.mjs       # 纯逻辑 + hostCode 漂移守护
node tests/collab-integration.mjs      # Cordis 插件端到端（fake ctx）
node tests/collab-hostcode-parity.mjs  # 动态宿主形态行为对拍
node tests/collab-awareness.mjs        # 多会话态势注入
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
