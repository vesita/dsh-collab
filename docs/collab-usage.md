# 多会话协作插件使用指南

> 供任意会话（AI / 人类）在协作前查阅。目标：**让同一项目上的多个 DSH 会话彼此可见、互相避让**。

---

## 1. 这是什么

一个注册到当前 DSH 部署的协作插件，提供两个模型工具：

| 工具 | 作用 |
| --- | --- |
| `collab_lock` | **中央注册锁**：开工前声明"我占用哪些文件夹/文件"，并查询 / 等待 / 续租 |
| `collab_board` | **协作留言板**：发消息 / 增量读消息，用于协商、交接、同步进展 |

### 1.1 你的每步都会看到同项目的占用态势

插件在运行时上下文里注入一行实时态势。同项目有其他会话持有声明时，你会看到类似：

```
[dsh-collab] 同项目其他会话当前占用：S1 调研（exclusive）占用 crates/transport/，剩 25 分。改动这些路径前请先执行 collab_lock op=wait 或用 collab_board 协商。
```

同项目暂无他人声明时，这一行是通用协作规范。这些信息来自共享状态文件，因此对**互相独立的会话**同样成立——你不需要知道对方是谁，也不需要记得去查。

### 1.2 建议流程

1. **动手改代码前先 `claim`** 你要碰的目录 / 文件；
2. **开工前和定期 `list` / `overview`**，看别人占用了什么，有没有和你重叠的；
3. **遇到他人独占**：先 `wait` 等待，或用 `board` 留言协商；
4. **只读调研**（测绘、审计、读代码）用 `mode=read`，它不排他也不被排；纯粹看看的话也可以不 claim；
5. **完成后 `release`** 释放占用；
6. **长任务 `heartbeat`** 续租，让租约覆盖你的实际工作时长。

### 1.3 状态落在哪

状态文件统一存放于 DSH 用户数据目录：

```
${DSH_HOME:-$HOME/.dsh}/collab/projects/<项目名>-<哈希>.json
```

- `<哈希>` 由**会话 cwd（项目根绝对路径）**确定性派生，因此同一项目的所有会话、子代理、乃至不同 dsh 进程共享同一份状态；
- 该目录是**绝对路径**，与 DSH 进程的启动目录无关；
- 状态脱离项目源码树，进程重启后仍保留。

工具返回的 `stateDir` / `statePath` 可随时核实真实落点。

早期版本使用过的落点（`<项目>/.dsh-collab.json`、相对 cwd 的 `.dsh/collab/projects/`、`<HOME>/~/.dsh/collab/projects/`）在目标文件不存在时会被只读扫描并一次性搬入正确位置（由包形态执行；动态形态直接读写正确落点，两者共享同一份状态）。

---

## 2. `collab_lock`

### 2.1 声明占用

```
collab_lock op=claim paths=["src/backend/models/"] mode=exclusive ttlSec=1800 note="调整字段校验"
```

- `paths`：项目相对路径，**目录以 `/` 结尾**（如 `src/backend/`）；文件不带斜杠。多个可同时传。
- `mode`：三态，见下表。
- `ttlSec`：租约秒数 `5–86400`，默认 `1800`（30 分钟）。`< 60` 时返回 **short-lease 警告**，提示按时心跳。
- `note`：占用说明（最多 500 字）。

| mode | 用途 | 阻塞他人 | 被他人阻塞 |
| --- | --- | --- | --- |
| `exclusive`（默认） | 我要改这块，别来 | 是（阻塞他人的 `exclusive`） | 是（被他人未过期 `exclusive` 阻塞） |
| `shared` | 我也要写，愿意共用 | 否 | 是（被他人未过期 `exclusive` 阻塞） |
| `read` | 只读观测（测绘 / 审计） | 否 | 否 |

`mode` 只接受这三个值；其余取值返回 `bad-request`，插件不会替调用方猜一个。

同一 holder 重复声明会并入**同 mode** 的现有声明（路径取并集）。不同 mode 各成一条，因此"对 `src/` 声明 `read`、对 `src/sub/` 声明 `exclusive`"不会把独占扩到 `src/` 的其他子目录上。

**返回**：`claimId`（后续 release / heartbeat 用）、`merged`（同 holder 是否并入现有声明）、`warning`（短租约提示）。

### 2.2 冲突处理与 AI 决策优化

与他人**独占**声明重叠时（前缀匹配：`src/backend/` 与 `src/backend/models/` 重叠；`src/foo` 与 `src/foobar` 不重叠），返回 `conflict` 及冲突详情：

- `overlapsWith`：具体重叠的声明路径；
- `remainingSec`：该占用剩余存续秒数；
- `suggestedAction`：
  - `remainingSec <= 30` → `wait`（短暂等待对方释放）；
  - `remainingSec > 30` → `negotiate`（用 `collab_board` 沟通）；
  - 或 `switch_path` 切换到无冲突的模块继续推进。

### 2.3 查询

| op | 用途 |
| --- | --- |
| `list` | 全部声明 + holder 存活视图 + `expiredCount` + `staleHolders` |
| `overview` | **按 holder 分组**的占用全景（`totalClaims` + 每个 holder 的 claimCount / mode / paths / claims）；同一 holder 持有多种 mode 时为 `mixed` |
| `status paths=[...]` | 给定路径的 related + exclusive 声明 |

`list` 的 `holders` 是**存活视图**，按 `lastSeenAt` 降序，每项含：

| 字段 | 含义 |
| --- | --- |
| `ageSec` | 距上次出现的秒数 |
| `active` | 该 holder 当前是否持有未过期声明 |
| `stale` | 无活跃声明且静默 ≥ 1h（预警阈值；回收仍按 24h 执行） |

顶层 `staleHolders` 给出计数，便于区分"正在干活的会话"与"上一会话的残留"。

### 2.4 等待释放

```
collab_lock op=wait paths=["src/backend/models/"] timeoutMs=15000
```

等待给定路径被他人**独占**声明释放。`blockers` 是当前阻塞者（空数组表示可以进入）；`timeoutMs` 到点仍被占则返回 timeout + blockers + waitedMs。`read` / `shared` 声明会直接放行。

### 2.5 维护

| op | 用途 |
| --- | --- |
| `release claimId=...` | 释放指定声明（仅 holder 本人） |
| `release paths=[...]` | 释放与给定路径重叠的本人声明 |
| `heartbeat claimId=...` | 续租（延长至 `now + ttlSec`） |

### 2.6 本地工具链辅助

开工或提交前，可用 Rust CLI 做协作自检：

```bash
./crates/collab-cli/target/debug/collab-cli git-check
```

---

## 3. `collab_board`

### 3.1 发消息

```
collab_board op=post channel=general body="我占用 src/backend/models/ 调整字段校验，预计 30 分钟内完成" mentions=["agent:xxx"]
```

- `channel`：默认 `general`。约定 `general` 通用 / `path:<路径>` 按目录 / `agent:<holderId>` 定向。
- `body`：正文（必填，去空白）。
- `mentions`：被 @ 的 holderId（最多 20 个）。
- `replyTo`：回复的 msgId（可选，构成线程）。

### 3.2 读消息

```
collab_board op=read channel=general since=0 limit=50
```

返回 `seq > since` 的消息（增量拉取），`limit` 最多 200（默认 50）。

留言板是**跨会话交接**的主要通道：把自己的计划、阻塞点、完成状态写进 `general` 或 `path:<路径>`，下一个接手该目录的会话即可在 `read` 时看到。

---

## 4. 身份与安全

- 身份取自调用方会话（`exec.agent.id`），工具参数里传不了 holder，因此无法冒充他人。
- 每条声明 / 消息都记录 holderId、holderName（会话标题截断 24 字）、时间戳。
- 租约过期是权威回收机制；agent 正常下线时插件也会立即释放其声明。

---

## 5. 使用提示

- **谁先 `claim` 谁先得**；冲突时 `wait` + `board` 协商是首选路径。
- **`read` 模式**用于测绘 / 审计类只读调研；**`shared` 模式**用于"我也要写这块，愿意共用"。
- 状态文件是跨会话共享的唯一事实来源。直接编辑它会触发乐观并发版本冲突，工具会自动重试并写入最新版本。

---

## 6. 部署

插件以包形态经 `dsh.profile.bundles` 装载。源码改动后重新构建、打包并重启 DSH 进程即生效。动态形态（`cordis_define` + `hostCode`）适合开发与临时排查，其 Package 在 DSH 进程存活期间有效，并与包形态共享同一个状态目录。
