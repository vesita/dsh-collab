# 多会话协作插件使用指南

> 供任意会话（AI / 人类）在协作前查阅。目标：**让同一项目上的多个 DSH 会话彼此可见、互相避让**。

---

## 1. 这是什么

一个注册到当前 DSH 部署的协作插件，提供两个模型工具：

| 工具 | 作用 |
| --- | --- |
| `collab_lock` | **中央注册锁**：开工前声明"我占用哪些文件夹/文件"，并查询 / 等待 / 续租 |
| `collab_board` | **协作留言板**：发消息 / 增量读消息，用于协商、交接、同步进展 |

它只管**跨会话、跨进程**这一层：单会话内部的成员派生、任务依赖与 CAS 归官方 `Agent Teams`
（实验性、默认关闭），本插件不重复提供。分工的判据、边界与三条已知接缝见
[`README.md`](../README.md) 的「与官方 Agent Teams 的分工（定位）」一节。

### 1.1 你的每步都会看到同项目的占用态势

插件在运行时上下文里注入一行实时态势。同项目有其他会话持有声明时，你会看到类似：

```
[dsh-collab] 同项目其他会话当前占用：S1 调研（独占）占用 crates/transport/，租约 30 分（09-13 06:35Z–09-13 07:05Z）。改动这些路径前请先执行 collab_lock op=wait 或用 collab_board 协商。
```

租约用**绝对 UTC 起止时刻**表示，不用「还剩几分钟」的倒计时：DSH 只有在运行时上下文文本逐字节变化时才提交新快照，时间无关的摘要因此不会每隔几分钟被重新注入一次。

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

### 1.4 委托纪律，以及在哪里关掉它

除态势摘要外，插件还注入一段常驻的**委托与验收纪律**，并随包注册 `subagent-delegation` 技能，默认开启。它是插件的一行配置：侧边栏 **Plugins** → `dsh-collab` 卡片里的开关（旁边标着当前状态词「集群协作」/「关闭」），对应 Config 字段 `exposeDelegationDiscipline`（布尔，默认 `true`，改动不需要重载插件）。

不选「关闭」时，纪律文本与随包技能都不再注册，**中央注册锁与协作留言板照常可用**。设置是活读的，改完立即生效，无需重启 dsh。完整说明见 README 的「委托纪律偏好与设置卡片」。

同一个标签页上还有「原生写保护」开关（拦截 / 不拦截，字段 `enforceWriteLock`，默认 `true`，同样活读）：开启时，写 / 改目标路径被**他人未过期的 `exclusive` 声明覆盖**会走原生审批路径拦截（本类部署通常没有审批提示，`ask` 等价于硬拒绝）；`shared` / `read` 声明不产生任何门控。`bash` / `pwsh` 没有目标路径参数，不受该门控保护。详见 README「功能 C」。

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
- `readable`：可读性，默认 `true`。**写入对非持有者永远要协商；读取默认放行，只有持有者显式 `readable: false` 才要协商。** 该维度只对他人的 `exclusive` 声明生效 —— `shared` / `read` 声明上的 `readable: false` 既不拦写也不拦读。合并声明时不带 `readable` 不会重置已有取值（缺省≠改写）。

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

### 2.5 循环终止自动释放（0.9.10；0.9.11 起宽限期 120 秒 + 有子代理在跑不放）

会话的循环停下（`agent/status` 从 `running` 翻到 `idle`）并空闲超过**宽限期**（0.9.11 起默认
**120 秒**，此前 15 秒）后，它持有的声明**自动释放** —— 这是"父会话派完子代理就停下、锁还占着"
那个死锁的出口（停下的循环收不到任何通知：`agent.inject` 不唤醒 driver，留言板协商它读不到）。
0.9.11 起家族豁免（见 README「会话家族（血缘）」）已是正解，自动释放退为兜底。

- 宽限期内被唤醒 ⇒ **取消**释放；到点还必须解析到该会话且它仍是 `idle`（判据不可用、或它已
  退场，一律不放）；0.9.11 起再加一条：**有自家子代理在 running 就不放**（重新武装，下一轮再看）。
- 只释放该会话**未过期**的声明；别人的、已过期的都不动。
- 释放后：等待者收到「锁已自动释放」，被释放的会话收到「你的声明已被自动释放，恢复工作前重新
  `claim`」；状态文件里另留一条审计留言（`channel` = `agent:<sessionId>`），`collab_board op=read` 可回读。
  0.9.11 起**发给本人的注入通知**按 `holderId` 在 60 秒窗口内合并（审计留言不合并）。

| 配置（命名空间 `collab`，活读） | 默认 | 说明 |
| --- | --- | --- |
| `releaseOnLoopEnd` | `true` | 关掉则回到旧行为：只由 `release` / 租约到期回收 |
| `loopEndGraceSec` | `120` | 宽限秒数，夹在 `[1, 3600]`（0.9.11 从 15 调长） |

> 宽限期排不掉"等真人回复"这种停顿：超过宽限期同样会放锁。希望锁握到手动 `release` 就关掉
> `releaseOnLoopEnd`（或调大 `loopEndGraceSec`）。

### 2.6 维护

| op | 用途 |
| --- | --- |
| `release claimId=...` | 释放指定声明（仅 holder 本人） |
| `release paths=[...]` | 释放与给定路径重叠的本人声明 |
| `heartbeat claimId=...` | 续租（延长至 `now + ttlSec`） |
| `reap` | **僵尸声明显式回收**（默认 dry-run，只列候选、不改状态） |
| `reap confirm=true` | 真正回收命中判据的僵尸声明（回收后通知其读者） |
| —（无 op） | **循环终止自动释放**：循环停下且空闲超过宽限期后自动执行，不是手动 op，见 §2.5 |

### 2.7 僵尸声明显式回收（`reap`）

被**强杀**的会话（dsh 重启等）不会 `release`，它未到期的声明会一直占用到租约到期；租约最长
`86400` 秒 ⇒ 最长 24 小时内他人对这些路径的**写入都会被门控硬拒绝**，而声明只有持有者本人能
`release`（他人拿到 `forbidden`）。`reap` 就是给这种情况的一条**显式**出口：

```
collab_lock op=reap                                  # 第一步：只看候选（dry-run，绝不改状态）
collab_lock op=reap confirm=true                      # 第二步：确认后真正删除
collab_lock op=reap paths=["src/"] olderThanSec=60    # 可限定路径 / 放宽 age 门槛
```

候选必须**同时**满足：声明未过期（已过期的归 `sweep()`）；holder 不在 `ctx.get('agents').list()`
里；不是调用者自己（清自己的锁用 `release`）；`now - createdAt` 严格大于 `olderThanSec`
（默认 **600 秒**）。`human:console` 这类没有活体信号的 holder 一律不收。响应里
`candidates[]`（dry-run）或 `reaped[]`（confirm）逐条带 `holderId` / `paths` / `ageSec` /
`remainingSec` 与 `reasons`（每条判据一个标签）。

> **为什么必须显式**：`agents.list()` 只含本进程**此刻加载着**的 agent，休眠但**可唤回**的会话
> 同样不在里面 —— 运行时注册表无法区分"休眠可唤回"与"真死"。所以 reap **绝不自动触发**：
> 没有定时器、不在 `sweep()`/读路径里、`agent/disposed` 也不会调用它。误杀的代价是持有者恢复后
> 仍以为自己有锁，而另一边看到路径空闲（W7 的锁安全缺陷）。

### 2.8 本地工具链辅助

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
- 租约 `expiresAt` 是声明生命周期的**唯一权威**回收机制：agent 正常下线（`agent/disposed`）**不会**提前释放它未到期的声明，只会回收**已过期**的声明、并把它从各 claim 的读者名单里摘掉；未到期的声明原样保留到租约到期后由惰性清理回收。`op=heartbeat` 是**唯一**的续租方式。

---

## 5. 使用提示

- **谁先 `claim` 谁先得**；冲突时 `wait` + `board` 协商是首选路径。
- **`read` 模式**用于测绘 / 审计类只读调研；**`shared` 模式**用于"我也要写这块，愿意共用"。
- 状态文件是跨会话共享的唯一事实来源。直接编辑它会触发乐观并发版本冲突，工具会自动重试并写入最新版本。

---

## 6. 部署

插件以包形态经 `dsh.profile.bundles` 装载。源码改动后重新构建、打包并重启 DSH 进程即生效。动态形态（`cordis_define` + `hostCode`）适合开发与临时排查，其 Package 在 DSH 进程存活期间有效，并与包形态共享同一个状态目录。
