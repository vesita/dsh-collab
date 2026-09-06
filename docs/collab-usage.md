# 多智能体协作插件使用指南

> 供任意会话（AI/人类）在协作前查阅。核心目标：**减少多人/多 AI 在一个项目里互相踩代码（写冲突）**。

---

## 1. 这是什么

一个注册到当前 DSH 部署的协作插件，提供两个模型工具：

| 工具 | 作用 |
| --- | --- |
| `collab_lock` | **中央注册锁**：开工前声明"我占用哪些文件夹/文件"，并查询/等待他人释放 |
| `collab_board` | **协作留言板**：发消息 / 增量读消息，用于协商、交接、同步进展 |

### 1.1 协作规范（建议流程）

1. **动手改代码前先 `claim`** 你要碰的目录/文件；
2. **开工前和定期 `list` / `overview`**，看看别人占用了什么，有没有和你重叠的；
3. **如果发现别人占了你要的路径**：先 `wait` 等待，或用 `board` 留言协商（`wait` 只对独占声明、他人的重叠生效）；
4. **完成后 `release`** 释放占用；
5. **长任务 `heartbeat`** 续租，避免租约过期被当作"没人干"而被人抢。

状态存于**DSH 用户数据目录** `${DSH_HOME:-~/.dsh}/collab/projects/<project-hash>.json`，完全脱离项目源码树，按项目工作区安全哈希隔离，代码仓库保持绝对干净，重启后仍保留。同时具备对旧版 `<project>/.dsh-collab.json` 的无缝自动迁移兼容。

---

## 2. `collab_lock`

### 2.1 声明占用

```
collab_lock op=claim paths=["src/backend/models/"] mode=exclusive ttlSec=1800 note="调整字段校验"
```

- `paths`：项目相对路径，**目录以 `/` 结尾**（如 `src/backend/`）；文件不带斜杠。多个可同时传。
- `mode`：`exclusive` 独占（默认，会阻塞他人重叠声明）/ `shared` 只声明不排他。
- `ttlSec`：租约秒数 `5–86400`，默认 `1800`（30 分钟）。`< 60` 时返回 **short-lease 警告**，提示按时心跳。
- `note`：占用说明（最多 500 字）。

**返回**：你拿到的 `claimId`（后续 release/heartbeat 用）、`merged`（同 holder 是否并入现有声明）、`warning`（短租约提示）。

### 2.2 冲突处理与 AI 决策优化

若与他人**独占**声明重叠（前缀匹配：`src/backend/` 与 `src/backend/models/` 重叠；`src/foo` 与 `src/foobar` 不重叠），返回 `conflict` 及冲突详情：
- `overlapsWith`：具体重叠的声明路径；
- `remainingSec`：该占用剩余存续秒数；
- `suggestedAction`：
  - 若 `remainingSec <= 30`：建议 `wait`（短暂等待对方释放即可）；
  - 若 `remainingSec > 30`：建议 `negotiate`（使用 `collab_board` 发送消息沟通）；
  - 或换用 `switch_path` 切换到无冲突的独立功能模块继续推进。

---

## 2.6 本地工具链辅助（CLI 与 Git 保护）

在开工或提交前，还可使用 Rust 高性能 CLI 进行协作自检：
```bash
# 检查当前 git 修改文件是否与其它 Agent 的独占声明冲突
./crates/collab-cli/target/debug/collab-cli git-check
```

### 2.3 查询

| op | 用途 |
| --- | --- |
| `list` | 返回全部声明 + holder + `expiredCount`（已过期数），知道整个项目当前占用状态 |
| `overview` | **按 holder 分组**的项目占用全景（`totalClaims` + 每个 holder 的 claimCount/mode/paths/claims），开工/打标签最省事 |
| `status paths=[...]` | 只查给定路径的 related + exclusive 声明 |

### 2.4 等待释放

```
collab_lock op=wait paths=["src/backend/models/"] timeoutMs=15000
```

阻塞等待给定路径被他人独占声明释放。`blockers` 为当前阻塞者（空=已可进入）；`timeoutMs` 到点仍被占则返回 timeout + blockers + waitedMs。

### 2.5 维护

| op | 用途 |
| --- | --- |
| `release claimId=...` | 释放指定声明（仅 holder 本人） |
| `release paths=[...]` | 释放与给定路径重叠的本人声明 |
| `heartbeat claimId=...` | 续租（延长至 `now + ttlSec`） |

---

## 3. `collab_board`

### 3.1 发消息

```
collab_board op=post channel=general body="我占用 src/backend/models/ 调整字段校验，预计 30 分钟内完成" mentions=["agent:xxx"]
```

- `channel`：默认 `general`。约定：`general` 通用 / `path:<路径>` 按目录 / `agent:<holderId>` 定向。
- `body`：正文（必填，去空白）。
- `mentions`: 被 @ 的 holderId（最多 20 个）。
- `replyTo`：回复的 msgId（可选，做成线程）。

### 3.2 读消息

```
collab_board op=read channel=general since=0 limit=50
```

只返回 `seq > since` 的消息（增量拉取），`limit` 最多 200（默认 50）。

---

## 4. 身份与安全

- 身份取自调用方会话（`exec.agent.id`），**工具参数里传不了 holder，无法冒充**。
- 每条声明/消息都记录 holderId、holderName（会话标题截断 24 字）、时间戳。
- 租约过期是**权威回收机制**（agent 下线释放是 best-effort）。过期声明在每次读取时被惰性清理，不再阻塞别人。

---

## 5. 使用提示

- **谁先 `claim` 谁先得**；冲突宁可 `wait` + `board` 协商，不要硬抢。
- **`shared` 模式**适合"我也要读/索引这块"但不会改，不阻塞别人。
- 项目工作区根下可能有多个会话共用同一个 `.dsh-collab.json`——它是**跨会话共享**的唯一事实来源，请勿手工乱改（会触发乐观并发版本冲突，工具会自动重试）。
