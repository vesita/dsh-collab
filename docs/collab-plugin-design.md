# DSH 多智能体协作插件设计方案
## 中央注册锁（文件夹占用声明）+ 协作留言板

- 版本：v0.2（评审中）
- 状态：设计规划阶段，未开始实现
- 关联：调研参考见第 2 节；所有接口均基于本环境 `cordis_inspect_*` 实测结果（见第 5 节）

---

## 1. 需求与场景

### 1.1 目标

多个 AI 会话（agent/session）同时开发**同一个项目工作区**时：

1. **中央注册锁**：AI 动手前先声明自己占据哪些文件夹/文件，其余 AI 查询后自觉避开，从源头减少写冲突；
2. **协作留言板**：多方之间互相留言（广播、定向 @、按频道），用于协商、交接、同步进展；
3. 配套的**可见性**：人类用户能一眼看到"谁占着哪里、有什么留言"。

### 1.2 非目标

- ❌ 不做强制互斥的文件锁（参考 agentlocks 的"建议性锁"哲学——AI 是协作者不是被强制者）；
- ❌ 不做代码合并/差异解决（那是 git 的职责）；
- ❌ 不做任务编排/团队工作流（DSH 已有 `agentTeams`，本插件与其互补，见第 13 节）。

### 1.3 用户故事

- 作为 AI 会话 A，我在 `src/backend/` 开工前 `collab_lock claim`，占用到期前 B 查询会看到"A 占据 src/backend/"，从而避开；
- 作为 AI 会话 B，我 `collab_lock list` 发现 `src/shared/` 与 A 的声明冲突，于是 `collab_board post` 留言协商或 `wait` 等待释放；
- 作为人类，我在面板上看到完整占用地图和留言流，可强制释放某个"僵尸占用"；
- 某个 AI 会话崩溃/结束，其占用被自动释放（租约过期 + 下线事件联动），不留死锁。

---

## 2. 参考项目与借鉴点

| 项目/模式 | 借鉴点 | 本设计落点 |
| --- | --- | --- |
| [agentlocks](https://github.com/simke9445/agentlocks) | 建议性文件锁：多个 AI 代理共享 git worktree，声明式占用而非强制 | 中央注册锁整体哲学：claim/release/list |
| [session-collab-mcp](https://github.com/leaf76/session-collab-mcp) | 认领文件 + 持久化工作记忆 + 防多代理冲突 | claim 粒度 + "持久化"要求（我们的数据落盘） |
| [agent-claim-mcp](https://www.npmjs.com/package/@vk0/agent-claim-mcp) | 代理认领文件的 MCP 工具面 | 工具化暴露给 AI（collab_lock） |
| [MetaGPT MessageHub](https://github.com/hardness1020/awesome-agent-architecture/pull/44/files) | 全局消息池：所有智能体往一个池发消息，带角色路由 | 留言板：append-only 消息流 + 频道 + @ |
| etcd / ZooKeeper 租约（lease） | 锁带 TTL，持有者崩溃后自动过期 | 每次 claim 必带 ttlSec + 续租 heartbeat |
| GitHub CODEOWNERS | 声明式所有权（不锁，只声明谁负责哪里） | shared 模式：只声明归属不排他 |
| DSH `agentTeams` | 进程内团队：sendMessage / createTask / waitForChange | 消息通道可选桥接（v2），不重复造轮子 |
| 本环境 dsi-omni-craft-git-flow | 分支/worktree 隔离约定 | 文档建议：注册锁与 git 隔离配合使用 |

---

## 3. 核心概念与术语

| 术语 | 含义 |
| --- | --- |
| 协作域（CollabDomain） | 一个项目工作区 = 一个协作域；状态文件/存储域以工作区根目录为 key |
| 占用声明（Claim） | holder 对一组路径的声明：`{claimId, holderId, paths[], mode, ttlSec, expiresAt, note}` |
| 租约（Lease） | claim 的存活期限，过期自动释放（防崩溃死锁） |
| 持有者（Holder） | 身份：`{holderId, name, kind: 'agent'\|'human', sessionId?, preset?}` |
| 留言（Message） | 协作域内的 append-only 消息：`{msgId, channel, author, ts, body, mentions[]}` |
| 路径模式（PathPattern） | 规范化的相对路径（目录或文件），如 `src/backend/`、`README.md` |

---

## 4. 总体架构

### 4.1 部署拓扑假设（重要）

**默认假设：多个协作 AI 会话运行在同一个 DSH host 进程内**（DSH 动态插件均挂在同一 Node 进程）。

这带来两个关键性质：

1. **进程内事件广播即实时同步**：一个会话 claim，其他会话的插件实例立刻收到事件（`ctx.emit` / `ctx.on`），无需轮询；
2. **持久化只需一份**：`storageDomain`（部署级 KV 域）或工作区文件，作为跨重启的权威副本。

> 跨进程部署（多个 dsh 进程协作同一工作区）作为扩展点：v1 不支持，设计上预留"文件轮询/版本号乐观并发"的接口位置（见第 10 节）。

### 4.2 组件

```
┌────────────────────────── DSH Host 进程 ──────────────────────────┐
│                                                                    │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐              │
│  │ Agent 会话 A │   │ Agent 会话 B │   │  人类 (UI)   │              │
│  │  collab_lock │   │  collab_lock │   │  面板按钮    │              │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘              │
│         │ 工具调用          │ 工具调用         │ harness.handle RPC   │
│         ▼                  ▼                  ▼                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              collab 插件实例（每会话一个，共享状态）              │   │
│  │  ┌───────────────────────────────────────────────────────┐  │   │
│  │  │  CollabCore（单例状态机）                               │  │   │
│  │  │  · claims 表 / messages 表 / holders 表               │  │   │
│  │  │  · 冲突检测 · 租约扫描 · 路径规范化                     │  │   │
│  │  └───────────────┬───────────────────────────────────────┘  │   │
│  │                  │ 读写                                      │   │
│  │          ┌───────▼────────┐   ctx.emit/collab/* 事件 ──► 各实例 │   │
│  │          │ storageDomain  │◄──── 持久化（schema 校验 + 原子写） │   │
│  │          │ (回退: JSON)   │                                   │   │
│  │          └────────────────┘                                   │   │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

### 4.3 数据流（claim 为例）

1. 会话 A 调用 `collab_lock claim {paths:['src/backend/'], ttlSec:1800}`；
2. 插件校验路径、检查与现有 claims 的冲突（见第 9 节）；
3. 无冲突 → 写入 claims 表（原子 put），更新全局 seq；
4. 广播 `collab/claim-changed` 事件（payload 只含标量/JSON 字段）；
5. 会话 B 的插件实例收到事件 → 更新自己的内存视图 → 若 B 开着面板则 UI 刷新；
6. B 调用 `collab_lock list` 得到最新注册表（也支持直接读持久化，双保险）。

---

## 5. 环境能力盘点与技术选型（基于本次实测）

以下结论来自 `cordis_inspect_list` / `cordis_inspect_query` 实测：

### 5.1 可用的关键能力

| 能力 | 实测签名/形态 | 用途 |
| --- | --- | --- |
| `storageDomain.open(spec)` | `Domain`：`table(name): KvTable`（get/put/update/delete/entries）+ `global`，带 zod schema 校验，单开约束 | **持久化后端选项**：表 `claims`/`messages`/`holders` + global(seq)，部署级统一管理时用 |
| `storage` 枢纽 | `backend` 注册表 + `mount(form, facility)` | 实现时先探测是否有 kv backend 挂载；无则回退文件方案 |
| `harness.registerTool(ctx, tool)` / `defineTool` | 动态注册模型工具，随 Fiber 自动清理 | 注册 `collab_lock` / `collab_board` |
| `harness.handle(method, handler)` | Client→Host JSON RPC（Package 私有） | 面板数据接口 |
| 事件 `agent/disposed`、`agent/status` | emit，`this: Scoped<Agent>` | **生命周期联动**：agent 下线 → 自动释放其 claims + 广播 |
| `timer` 服务（`ctx.timer`，需 `inject`） | timeout / interval | 租约到期扫描 + 惰性过期兜底 |
| `tools` 服务 / `Tool.listTools` | 现有工具名已确认：`collab_*` 无冲突 | 工具命名 |
| `systemPrompt` 服务 | `section()` / `context()` / `tools()` | v2 可选：向模型上下文注入实时占用摘要 |
| Client 插槽 | `sidebar.footer.action`（list, additive）、`shell.overlay`（list）、`tool.call.toolview`（keyed）、`settings.plugins.tab` | 面板落点 |
| `agentTeams` | sendMessage / createTask / waitForChange（lead session log 支撑） | v2 可选桥接 |

### 5.2 选型决策

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 持久化 | **storageDomain 为主**（schema 校验 + 原子 put），工作区 JSON 为回退 | 已确认选部署级统一管理；回退保证无 kv 后端的环境仍可跑 |
| 状态权威 | **进程内单例 CollabCore 为读权威**，持久化为写权威 | 单进程部署下事件即时同步，持久化保证重启不丢 |
| 广播 | `ctx.emit('collab/...')` + 每实例 `ctx.on` | 进程内实时、零轮询 |
| 锁模型 | 建议性锁 + 租约（lease） | 参照 agentlocks + etcd，防僵尸占用 |
| 工具命名 | `collab_lock`、`collab_board` | 已确认与现有工具无冲突 |

### 5.3 配套工具链策略（TS / Python(uv) / Rust）

既定工具链：通用逻辑 TS、脚本/数据 Python(uv)、性能敏感 Rust。映射到本插件：

| 层 | 语言 | 说明 |
| --- | --- | --- |
| Cordis 插件本体（Host/Client） | **纯 JS（硬约束）** | 动态插件不接受 TS/import/打包；Client 面板即 Web TS/React 生态，无冲突 |
| 数据契约 | **JSON Schema v1（单一事实源）** | TS 类型 / Python dataclass / Rust struct 均由 Schema 派生，保证多语言互通 |
| 配套 CLI（可选） | **Rust**（性能敏感：大仓库遍历、批量冲突检测、watcher）或 **Python + uv**（迁移/导入导出/测试脚本） | 以 `state.json` 或 socket 为接口，与插件解耦 |
| 运维与测试脚本 | **Python + uv** | 造数、回放、迁移、E2E |

**为 Rust 化预留的接口契约**：
- 注册表文件 `.dsh-collab/state.json`：稳定 JSON Schema v1（claims/messages/holders/seq），版本号字段预留；
- CLI 形态：`collab-cli list|claim|release|post|read --json`，stdout 输出 JSON，插件可经 `subprocess` 直接调用；
- 高性能形态（M4 评估）：Rust daemon 持有引擎，插件经 stdin-JSON 或本机 HTTP 调用；替换不影响服务与工具 API。

**v1 决策**：引擎先纯 JS 实现——路径级冲突检测在数百条声明规模下是毫秒级，Node 绰绰有余；Rust 化仅在出现真实瓶颈（如监控巨仓、留言全文检索）时按上述契约进行，插件其余部分不动。

---

## 6. 数据模型（Domain 定义草案）

```ts
// defineDomain 风格的 spec（实现时按 zod 声明）
const collabDomain = {
  name: 'dsh-collab',
  version: 1,
  tables: {
    claims:   { valueSchema: ClaimSchema },   // key: claimId
    messages: { valueSchema: MessageSchema }, // key: msgId
    holders:  { valueSchema: HolderSchema },  // key: holderId
  },
  global: { schema: SeqSchema, initial: { seq: 0 } }, // 全局单调序号
}

// 记录形状（均为 JSON 安全标量，无 live data）
Claim = {
  claimId: string,          // 'c_' + seq
  holderId: string,         // 指向 holders
  paths: string[],          // 规范化相对路径，如 ['src/backend/']
  mode: 'exclusive' | 'shared',   // shared = 只声明归属不排他（CODEOWNERS 式）
  ttlSec: number,           // 租约秒数
  expiresAt: number,        // epoch ms，续租时更新
  note: string,             // 人类/AI 可读说明（如"正在实现用户模块"）
  createdAt: number,
}

Message = {
  msgId: string,            // 'm_' + seq
  channel: string,          // 'general' | 'path:src/backend/' | 'agent:<holderId>'
  author: string,           // holderId 或 'human:<name>'
  ts: number,
  body: string,
  mentions: string[],       // 被 @ 的 holderId
  replyTo?: string,         // 可选，msgId
}

Holder = {
  holderId: string,         // agent: <sessionId> / human: <name>
  name: string,             // 显示名（会话标题/预设名/用户名）
  kind: 'agent' | 'human',
  sessionId?: string,       // agent 会话标识（agent/disposed 联动用）
  preset?: string,          // agent 预设名（若有）
  lastSeenAt: number,       // 最近活跃，用于面板显示
}
```

**持久化实现**：v1 主实现为 storageDomain——Domain 表 `claims`/`messages`/`holders` + global `seq`（zod schema 校验、原子 put）；**JSON 文件为回退后端**——同一 Schema 序列化为工作区 `.dsh-collab/state.json` 单文档（`{schemaVersion, seq, claims[], messages[], holders[]}`），整文档原子写（临时文件 + rename，复用 `fs` 服务的 write-intent/version 机制做乐观并发，实现前 inspect `fs` 契约确认 `FsWriteIntent` 形状）。

> 路径规范化：相对协作域根（工作区根），`resolve` 掉 `.`/`..`，目录统一 `xxx/` 尾斜杠，文件不带。`fs.contains` 语义可复用（`ctx.fs`）。

---

## 7. Host Service 接口设计（`ctx.collab`，跨会话可调）

> 动态插件每会话实例独立 apply，但共享 CollabCore 单例与持久化。Service 通过 `ctx.provide('collab', ...)` 暴露；工具直接调内部实现。

### 7.1 锁（中央注册）

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| claim | `claim(req: {paths: string[], mode?, ttlSec?, note?}) → {ok, claim?, conflicts?}` | 原子声明；冲突则返回冲突者详情，不写入 |
| release | `release(req: {claimId?, paths?}) → {ok, reason?}` | 仅持有者/人类可释放自己的声明 |
| forceRelease | `forceRelease({claimId, reason})` | 仅人类（UI）或持特殊权限调用 |
| heartbeat | `heartbeat({claimId}) → {ok, expiresAt}` | 续租，重置 expiresAt |
| list | `list() → {claims, holders, serverTime}` | 全量注册表（工具与面板共用） |
| status | `status({path}) → {claims[], conflicts?}` | 单路径查询 |
| wait | `wait({paths, timeoutMs?}) → {ok, releasedBy?}` | 轮询/事件等待释放（v1.1） |
| claimByPath | `claimByPath({path}) → claim?` | 工具常用便捷查询 |

### 7.2 留言板

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| post | `post({channel, body, mentions?, replyTo?}) → {msgId}` | append-only；channel 约定见数据模型 |
| read | `read({channel?, since?, limit?}) → {messages[]}` | 增量拉取（since = 上次 seq） |
| subscribe | 由事件 `collab/message` 承担 | 不单独提供订阅 API |

### 7.3 生命周期与租约

- **租约扫描**：每实例 `ctx.timer.interval`（如 30s）惰性检查；claim 读取时也做惰性过期（双重机制）；
- **下线联动**：`ctx.on('agent/disposed')` → 找到该 agent 的所有 claims → 释放 → 广播 `collab/claim-released` + 留言"xx 已下线，占用已释放"；
- **启动恢复**：插件 apply 时从持久化加载全量状态（含未过期的 claims），跨重启不丢。

### 7.4 广播事件（`ctx.emit('collab/<event>', payload)`）

| 事件 | payload（仅 JSON 标量） | 触发 |
| --- | --- | --- |
| `collab/claim-added` | `{claim}` | claim 成功 |
| `collab/claim-released` | `{claimId, holderId, reason}` | release / 过期 / 下线联动 |
| `collab/message` | `{message}` | post 成功 |
| `collab/seq` | `{seq}` | 任何变更（UI 刷新信号） |

---

## 8. 模型工具设计（AI 调用面）

两个工具经 `harness.registerTool` 注册，随插件 Fiber 自动清理。

### 8.1 `collab_lock`

```
参数: { op: 'claim'|'release'|'list'|'status'|'wait'|'heartbeat',
        paths?: string[],        // claim/status/wait 用
        claimId?: string,        // release/heartbeat 用
        mode?: 'exclusive'|'shared',
        ttlSec?: number,         // 默认 1800
        note?: string,           // claim 用，说明占用目的
        timeoutMs?: number }     // wait 用
返回: 结构化 JSON（claim 冲突时含 conflicts 详情）
```

**工具描述中内置协作规范**（提示词约束）：

> 动手修改文件前，先对目标目录 `collab_lock claim`；开工前和定期 `collab_lock list` 检查他人占用；发现冲突先留言协商或等待；完成后立即 `release`；占用时长不超过 ttlSec，长任务记得 `heartbeat`。

### 8.2 `collab_board`

```
参数: { op: 'post'|'read',
        channel?: string,        // 默认 'general'
        body?: string,           // post 用
        mentions?: string[],     // 定向 @
        replyTo?: string,
        since?: number,          // read 增量
        limit?: number }
返回: {msgId} 或 {messages[]}
```

### 8.3 可选增强（v2，开关控制）

- 用 `systemPrompt.context()` 在每个模型 step 前注入当前占用摘要（如"⚠️ src/backend/ 被会话 B 占用中"），让 AI 每次决策都自带上下文；需注意这是全局影响面，默认关闭。

---

## 9. 冲突检测算法

```
规范化每个 path（相对根、resolve、目录尾斜杠）
冲突判定（对每条新 path P）：
  对每个现存 claim C（未过期）：
    if C.mode == 'shared' → 不排他，跳过
    if P 与 C.paths 中任一 Q 满足：P 是 Q 的祖先 或 Q 是 P 的祖先（前缀匹配，按段分割避免 'src/a' 误伤 'src/ab'）
      → 冲突，记录 {claim, overlapPath, holder}
结果：
  任一冲突 → claim 拒绝，返回 conflicts 详情（含 holder 名，便于 AI 留言协商）
  无冲突 → 写入；同 holder 重复声明相同路径 = 更新/续租语义（幂等）
```

> 按路径段（split('/')）做前缀比较，而不是字符串 startsWith，避免 `src/foobar` 与 `src/foo` 误判。

---

## 10. 并发与一致性

- **单进程**：CollabCore 内所有写操作经一个微队列（promise 链）串行化；`KvTable.update` 提供原子读改写（写前再校验一次冲突，防竞态）。
- **多实例一致性**：内存视图只做展示/事件消费；一切决策以持久化最新值为准（每次 claim 都基于最新快照判定）。
- **跨进程扩展点**：预留"文件锁 + 版本号乐观重试"位置——写前读 seq，写时带 expectedSeq，冲突则重读重试。v1 不实现。
- **原子性**：storageDomain 的 put/update 本身原子；JSON 回退后端用"写临时文件 + rename"（复用 `fs` write-intent/version 乐观并发）。

---

## 11. Client UI（v1.1）

### 11.1 落点（基于实测插槽）

| 用途 | 插槽 | 说明 |
| --- | --- | --- |
| 入口按钮 | `sidebar.footer.action`（list, additive, replaceRisk=none） | 侧栏底部"协作"按钮，最稳妥的加法式入口 |
| 主面板 | `shell.overlay`（list, 根级浮层） | 占用地图 + 留言板，可开关 |
| 工具卡片 | `tool.call.toolview` keyed by `collab_lock`/`collab_board` | 每次调用在对话流中展示结构化结果 |

### 11.2 面板内容

- **占用地图**：路径树 + holder + 剩余租约（进度条）+ 模式徽标（独占/共享）；人类可"强制释放"（经 approval 确认）；
- **留言板**：频道切换（general / path:* / agent:*）+ 消息流 + @提及高亮 + 快速回复；
- **身份栏**：当前会话的 holder 标识，可改显示名。

### 11.3 通信

- Client → Host：`harness.handle('collab/list'|'collab/post'|'collab/release'|...)`；
- Host → Client：Client 订阅 `collab/seq` 事件驱动刷新（事件只带 seq，数据经 RPC 拉取，避免 live data 跨边界）。

---

## 12. 权限与安全

| 操作 | 允许者 |
| --- | --- |
| claim / heartbeat / post / read | 任何 agent（工具自带 holder 身份=发起会话） |
| release（自己的 claim） | 该 holder |
| release（他人的） | 仅人类（UI 触发，可走 `approval.request` 二次确认） |
| forceRelease | 仅人类 |

- 工具内部**不允许传 holderId 参数**（防冒充），holder 一律从调用上下文（当前 agent/session）推导；
- 留言 @ 不强制送达（建议性），但会在面板和（v2）agentTeams 桥接中提示。

---

## 13. 与 DSH `agentTeams` 的关系

- `agentTeams` 已提供进程内团队的消息/任务能力（lead session 支撑），**面向"一个 lead 管多个 teammate"的层级协作**；
- 本插件面向**平级多会话共享工作区的文件级协调**，两者互补；
- v2 可选桥接：留言板消息可经 `agentTeams.sendMessage` 转发到团队流（开关控制），避免重复实现消息投递；v1 保持独立、零依赖。

---

## 14. 落地形态（三种路径）

| 形态 | 适用 | 说明 |
| --- | --- | --- |
| **动态插件**（本次 cordis_define） | 快速原型验证 | 单会话可见；多会话验证需每个会话各自挂载；进程重启后需重挂（数据因持久化不丢） |
| **host 组合 plugin 行**（cordis.yml） | 正式多会话常驻 | 所有会话自动获得服务与工具；需 `editing-cordis-compositions` 技能指导，属部署级修改 |
| **agent preset 内置工具** | 按预设分发 | 团队 preset 里带上 collab 工具定义，随会话自动装载 |

> 建议路线：**动态插件原型 → 验证多会话协作 → 转 host 组合常驻**。

---

## 15. 里程碑与验收

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| M1 MVP（Host 核心） | 插件骨架 + CollabCore + storageDomain 持久化（无 kv 后端则 JSON 回退）+ `collab_lock`/`collab_board` 工具 | 单会话可 claim/list/release/post/read，数据重启后仍在 |
| M2 协同与生命周期 | 跨会话事件广播 + 租约过期 + agent/disposed 自动释放 + 冲突检测完整化 | 双会话 A/B：A 占 src/ 后 B 的 list 立即可见；A 下线后占用自动释放 |
| M3 面板 | 入口 + overlay 面板 + 工具卡片 | 人类可查看占用地图/留言，可强制释放 |
| M4 增强（可选） | wait、systemPrompt 注入、agentTeams 桥接、跨进程乐观并发；出现真实瓶颈时按契约将引擎 **Rust 化**（CLI/daemon） | 按需开启，JSON Schema 契约不变 |

---

## 16. 风险与边界

1. **建议性锁的自觉性**：AI 可能不查不声明。缓解：工具描述强约束 + list 结果显眼 + （v2）systemPrompt 注入占用摘要 + 面板可见性形成社会压力；
2. **动态插件进程生命周期**：进程重启后插件需重挂（host 组合化可根治）；持久化保证数据不丢；
3. **storageDomain 后端可用性**：v1 主实现依赖部署挂载 kv 后端——实现 M1 时先探测 `storage.backend.names()`；若无 kv 后端，需在 host 组合挂载一个，或回退工作区 JSON；
4. **同 holder 多实例**：同一会话的多个插件实例（理论上不会）由单例 CollabCore 规避；
5. **时钟**：租约依赖本机时钟，单机部署无问题。

---

## 17. 决策记录（评审确认）

| # | 决策点 | 结论 | 状态 |
| --- | --- | --- | --- |
| D1 | 持久化介质 | **storageDomain（部署级）为主**，工作区 JSON 为回退 | ✅ 用户确认 |
| D2 | 首版范围 | **仅 Host 工具+服务**（M1+M2），Client 面板后置 | ✅ 用户确认 |
| D3 | 协作形态假设 | **单 host 进程多会话**，进程内事件实时同步；跨进程为扩展点 | ✅ 用户确认 |
| D4 | 与 agentTeams 关系 | 独立实现，v2 再评估桥接 sendMessage | 📌 按推荐 |
| D5 | claim 粒度 | 目录 + 文件混合（工具层自动判断） | 📌 按推荐 |
| D6 | 引擎实现 | **v1 纯 JS**，JSON Schema 契约预留，出现真实瓶颈后 M4 再评估 Rust 化 | ✅ 用户确认 |

> M1 已完成（见第 18 节实现纪要）；正式化（host 组合）时再评估 storageDomain 后端。

---

## 18. M1 实现纪要（2025-09，动态插件原型）

**产物**：动态插件 `coll-1`（当前 pkg-9 运行中），Host 单端，两个模型工具 `collab_lock` / `collab_board`。

### 18.0 代码落库结构（2025-09，随 M3 后提交）

设计文档与运行插件已落到本仓库 `/home/vesita/coding/my/dsh-collab`，按职责分三层：

| 路径 | 职责 |
| --- | --- |
| `src/collab-core.mjs` | **纯逻辑唯一事实源**。不碰 fs/ctx/sessions，只操作 state，时间可注入。可 import / 可测 / 供未来 CLI、Python、Rust 对照复用 |
| `src/collab-plugin.host.js` | 自包含 Cordis Host 插件源码，导出 `hostCode` 字符串（直接作为 cordis 的 `code.host`）。因 Cordis 动态插件**不接受 import/打包**，内联与核心一致的纯逻辑 |
| `src/schema/collab.schema.json` | **JSON Schema v1（单一契约）**：`StateDocument`（注册表状态结构）+ `colabLockParams` / `colabBoardParams`（两工具参数）。§5.3 定义 TS/Python/Rust 类型均由此派生 |
| `docs/collab-usage.md` | 面向任意会话的使用指南 |
| `tests/collab-pure-logic.mjs` | 纯逻辑 + 宿主一致性的回归测试 |
| `README.md` | 仓库说明与目录结构 |

> 一致性保障：`collab-plugin.host.js` 内联的 `norm`/`cleanName` 与核心库由对拍测试（`tests/collab-pure-logic.mjs` §9）保证不漂移；正式化进 host 组合后插件改为直接 import 核心模块消除重复。

> **转义注意**：`collab-plugin.host.js` 是 `.js` 模板字符串，内部正则层级与运行中的 `pkg-9` 实际生效正则一致（如 `norm` 中 `/\\/g` 匹配单个反斜杠 → 替换为 `/`）。已用行为级 + 对拍测试双重确认，避免"模板字符串比运行版多一层转义"这类隐蔽漂移。

### 18.1 与设计的实测偏差（均已验证）

| 设计点 | 实现结论 | 原因 |
| --- | --- | --- |
| 状态文件位置 | 会话**工作区根** `.dsh-collab.json`（经 `fs.resolve(FILE, {cwd: session.header.cwd})`） | fs 服务无 mkdir；`.dsh-collab/` 子目录留待有 mkdir 手段后迁移 |
| 持久化后端 | **文件后端**（fs `writeText` + `replaceIfVersion` 版本守卫做乐观并发，陈旧写自动重试 ≤5 次） | storageDomain 有单开约束、动态插件按会话隔离、且本部署未挂 kv 后端——storageDomain 推迟到 host 组合化形态 |
| 跨会话同步 | **pull 式**：每次操作读最新文件即见他人变更 | 会话级动态插件 ctx 互不可达，`ctx.emit` 无法跨会话广播；事件/推送留给 M3 面板与正式化 |
| 身份 | `exec.agent.id` → `sessions.get(id).header.cwd`（状态路径）与 `sessionTitle.get(session)`（显示名） | 工具内部不可传 holder 参数，防冒充 |

### 18.2 已验证项（全部通过）

- `claim` / `list` / `release` / `post` / `read` / `status` / `heartbeat` 全流程；
- **冲突检测**：他人独占声明重叠 → 拒绝并返回冲突详情（holder、重叠路径）；无冲突路径正常通过；同 holder 子路径自动合并续租；
- **租约过期**：过期声明被过滤（`expiredCount`），且不再阻塞新声明；
- **权限**：release / heartbeat 他人声明被拒（forbidden）；
- **跨会话可见性**：手写注入的"另一会话"声明可被本会话 list/status 读取（模拟双会话）；
- **重启持久化**：`cordis_stop` + `cordis_run` 后状态从文件完整恢复。

### 18.3 已知问题与 M2 处理

| # | 问题 | 状态 |
| --- | --- | --- |
| 1 | 同 holder 合并声明时 `ttlSec` 未随新 ttl 更新 | ✅ 已修（pkg-7 置 `own.ttlSec = ttl`） |
| 2 | holder 显示名直接取会话标题（可能超长） | ✅ 已修（pkg-7 加 `cleanName` 截断 24 字） |
| 3 | `wait`（轮询等待释放）未实现 | ✅ 已实现（pkg-7，`timer.timeout` 400ms 轮询 + deadline） |
| 4 | **项目隔离被破坏（pkg-7 发现）**：全局 `rootCache` 缓存会话 cwd，进程内共享的插件实例导致所有会话复用首个会话的 cwd，跨项目写同文件 | ✅ 已修（pkg-8 去掉缓存，按每次 `exec.agent.id` 现算 cwd） |
| 5 | agent 下线自动释放为 best-effort（dispose 时文件写可能失败） | 📌 保留，权威机制仍是租约过期 |

> 第 4 项是重要修复：实测发现另一真实会话（omni_craft/stem-control 项目）的声明因共享缓存误写入了本项目文件；pkg-8 改为按调用方会话现算 cwd 后，各项目各写各的 `.dsh-collab.json`。已把滞留声明迁回其正确项目文件。

### 18.4 M2 迭代（pkg-7 / pkg-8）

- `wait` 操作（阻塞等待释放，含 timeout/blocker 上报）；合并声明 ttl 修正；显示名清洗；
- **按会话 cwd 解析状态路径**（修复跨项目污染）；
- 已验证：wait 阻塞/成功、合并 ttl 同步、隔离（本项目 list 干净，他人项目文件独立）。

### 18.5 待办（下一迭代）

- 状态文件迁移到 `.dsh-collab/state.json` 目录形态（需 `shell` mkdir / 确认 fs 行为）；
- 进程内事件广播（供同会话 UI / 其他 host 插件消费）；
- 真实双会话自动化测试（两个会话各挂插件、操作同一工作区，验证注册表/留言共享）；
- storageDomain 后端接入（host 组合化形态）；
- **正式化接入 host 组合**（`~/.dsh/profiles/web/cordis.patch.yml`，把动态插件固化为部署级插件，进程重启不丢，多会话自动获得工具）。

### 18.5 M3 迭代（pkg-9，协作健壮性 + 可操作性）

面向"真实协作"而非"单进程演示"的增量，核心是让新加入的 AI 一眼看清占用全景、避免短租约静默过期、并防"状态文件落错项目"被无声吞掉。

| 变更 | 说明 |
| --- | --- |
| `overview` 操作 | 按 holder 分组返回项目占用全景（totalClaims + 各 holder 的 claimCount/mode/paths/claims），替代逐条翻 list，供"开工前扫一眼" |
| 短租约警告 | `claim` 在 `ttlSec < 60` 时返回 `warning`（含剩余秒数与"请 heartbeat 续租"），默认 1800 不告警 |
| 越界软诊断 | `load` 检测到**无会话 cwd**（状态落到默认 HOME 位置）时在 list/status/overview 数据里挂 `warning`，提示隔离已失效——正是隔离 bug 那类问题不再被无声吞掉 |
| 描述更新 | `collab_lock` 描述纳入 `overview`，`claim` 结果返回 `merged` 标记（同 holder 并入是否发生） |

> **验证方式**：本会话（checkpoint 恢复后）的函数目录为基础集，动态注册的 `collab_lock`/`collab_board` 不在可直接调用的 schema 内，故不用"重复调用"验证，而用 **纯逻辑单元测试 + 真实磁盘工件**：
> `node tests/collab-pure-logic.mjs`（**25/25 通过**）。该脚本从 pkg-9 复制不变的核心函数（`norm`/`ov`/`claim` 冲突检测/短租约警告/`overview` 分组/到期清理），并以**真实 omni_craft `/home/vesita/coding/hub/omni_craft/.dsh-collab.json` 工件**断言——确认迁移的声明可被 overview 正确分组、路径扁平化、holderId 保留，且既有冲突/合并/过期语义不回归。运行时健康：`coll-1/pkg-9 running`，无 `waitingFor`、无 diagnostics，`overview` 已入工具 enum 并经 `Tool.listTools` 确认注册。

### 18.6 测试资产

- `tests/collab-pure-logic.mjs`：纯逻辑回归（`node tests/collab-pure-logic.mjs`，42/42 通过）。**import 自 `src/collab-core.mjs` 而非复制**，并含主机源码对拍（§9）——从 `collab-plugin.host.js` 提取 `norm`/`cleanName` 与核心库做行为对比，防止内联版与核心库漂移。

---

*本文档基于 DSH 实测能力编写；实现前对所用 Service/Event/Slot 需再次 inspect 确认（能力目录可能随版本变化）。*
