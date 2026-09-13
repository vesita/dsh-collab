# dsh-collab 项目规范

> 本文件是**本仓库**的纪律，会被 harness 在每个会话的第一次请求时注入。
> 跨项目的通用偏好见 `~/.dsh/AGENTS.md`；本文件只写**这个仓库独有的硬规则**。

---

## 1. 严禁冒充用户（消息来源规范）

**规则**：插件可以投递消息，但**不许让消息看起来是真人发的**。

- ✗ **禁止**
  - `source.kind === 'user'`，或手写 `role: 'user'` —— 那会让消息在界面上与真人输入同形；
  - 投递**没有 `source`** 的消息 —— 来源无法追溯；
  - **手抄构造函数副本**（自己实现 `createUserMessage` / `createMessage` / `freezeMessage` /
    `boundContextSummary`）—— 那是一份会腐烂的副本（见下）。
- ✓ **允许**
  - 经**真实的** `@deepseek-ai/dsh-llm`（peer + dev 依赖）构造，且 `source` **显式非 user**：
    ```js
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-collab', form: 'notice', summary: boundContextSummary(...) }
    })
    ```
  - 逐事件投递用 `agent.inject(msg)` —— 契约是 `send(msg, "next-step", wakeup=false)`
    （`dsh-agent/lib/types/runtime-types.d.ts:209`、实现 `dsh-agent-loop/lib/index.js:795`）：
    进入下一步但**不唤醒** driver。
  - 跨会话投递用 `sessionController.prompt({ content })` / `subagents.sendMessage(sender, id, content, …)`
    —— 这两个收 **content**，由宿主构造消息；
  - 常驻文本用 `systemPrompt.context` / `systemPrompt.section`（收 text）。

**判据一句话**：**消息可以投，来源必须诚实。**

### 为什么

1. **冒充会污染一切按来源判断的东西**。客户端的分流判据只有一条 —— `source.kind !== 'user'`
   ⇒ 渲染成 context 节点（`dsh-client-ui-chat/lib/client.js:6058`）；`kind === 'user'` 才会成为
   用户气泡（或在 next-step 收件箱里成为 `steering`）。压缩、去重、审计、"这句到底是谁说的"
   全都按消息来源判断。
   —— 注意恰恰是**显式标注**的 `plugin/notice` 不冒充用户：它渲染成 **notice 行**。
2. **手抄副本会静默腐烂**。2025-09 之前本仓库有一份 `src/plugin-message.ts` 逐字复刻 dsh-llm；
   DSH 一改消息形状，插件就会**静默**产出宿主不认的结构而看起来"能跑"。该副本已删除，**不许复活**。
   它当年存在的理由（"插件解析不到 `dsh-llm`"）本就不成立：从安装位置 import 是成功的，
   生态里 50 个包都这么用（另有三份副本散落在 `dsh-repeat-tool-reminder`、`dsh-tmux-context`、
   `dsh-client-connection` —— 那是反面教材，不是先例）。
3. **`form` 必须配齐**：`form: 'notice'` **必须带非空 `summary`**，否则客户端会把它退化成
   **opaque** 行（`client.js:795-800`）。`summary` 用 `boundContextSummary`（120 字符上限，
   dsh-llm 导出，生态里 5 个包在用）。DSH 自家也有翻车的：`dsh-tool-cordis` 与 `dsh-tool-skill`
   声明了 `form:'instructions'` 却没给 `changes`，实际渲染成 opaque。

### 载体怎么选（照 `dsh-tool-jobs` 的分法）

同一个包把两种面**分开**，这是本项目的参照：

| 内容性质 | 载体 | 例子 |
|---|---|---|
| **常驻**说明（不变、每轮要可见） | `systemPrompt.section` / `systemPrompt.context` | `dsh-tool-jobs:200-206` 的工具纪律 |
| **逐事件**通知（一次性、要独立一行） | `agent.inject` + `form:'notice'` | `dsh-tool-jobs:208-226` 作业完成 |

**历史教训（别再走回头路）**：曾经把规范读成"**一份也不许构造**"，于是访问通知被逼去挤
`systemPrompt.context` 的运行时快照。代价是实测出来的：提交单位从"一行"变成**整份合并快照**
（持久化事件 581 B → 3124 B）、投递**依赖 `systemPrompt` 服务可用**、通知**没有自己的一行**。
收窄到"禁止冒充"之后，既保住内核，又回到生态的通行写法。**当前 `src/access.ts` 用的就是 `agent.inject`。**

顺带一条**不是问题**的实测：这条文本不会伤缓存 —— 它落在 `surfaceOp:append` 的追加消息里，
动不了系统提示那段前缀。单会话 691 次请求整体命中 96.9%，4 个低命中样本全部紧跟 `compaction`。

### 机械检查

`tests/collab-message-provenance.mjs`（已进 `npm test`）。它剥掉注释后扫 `src/` 与 `lib/`：

- 禁 `role: 'user'` / `source.kind === 'user'`；
- 禁自定义 `createUserMessage` / `createMessage` / `freezeMessage` / `boundContextSummary`；
- 凡有 `createUserMessage(` 的文件，必须同时有 `source:`、`plugin:`、`form:`；
  `form:'notice'` 还必须带 `summary:`；
- 必须有 `from '@deepseek-ai/dsh-llm'` 的 import；
- 访问通知必须经 `agent.inject` 逐事件投递，且 `src/access.ts` 里**不许**再出现 `systemPrompt`
  —— 防止悄悄退回"挤运行时上下文快照"的老载体；
- 手抄副本 `src/plugin-message.ts` / `lib/plugin-message.js` 必须**不存在**（不许复活）。

规则要能被一次命令判定，否则它只是愿望。

### 生态定位（已普查，别再重新论证）

- **构造 `UserMessage` 的有 30 个包 / 40 处调用点**（含 `dsh-agent-loop` 自己）——
  在"追加进会话历史"这条路上，这是**压倒性主流**；
- 用 `systemPrompt.context` 的只有 3 个包，且都用于**运行时状态**（沙箱/审批/子代理委派）；
- 用 `systemPrompt.section` 的约 21 个包目录 / 25 个文件；
- `id` / `role` / 深冻结**全部由构造函数自动补**，40 处调用点没有一处自己生成 uuid；
- 全部署**没有**"收纯 text 就能逐次注入历史"的接口（唯一收 content 且非用户气泡的是
  `subagents.sendMessage`，但它限死邻接）。

所以本规范是"**与生态一致地构造、只是额外要求来源诚实**"，不是逆向选择。

---

## 2. 其它既有约定（在别处，此处只指路）

- **测试里"跳过"默认判失败**：只有显式 `COLLAB_ALLOW_SKIP=1` 才放行，且要打「未验证」横幅。
  见 `README.md`「运行测试」。
- **两形态必须同步**：`src/index.ts` 一侧（包形态）与 `src/collab-plugin.host.ts`（动态形态内联副本）
  改动语义时要一起改，并由 `tests/collab-inline-parity.mjs`（18 个同名函数逐输出对拍）
  与 `tests/collab-hostcode-parity.mjs`（行为对拍）守护。
- **契约只有一份**：`src/schema/collab.schema.json` 是 SSOT，TS / Python / Rust 三份派生物由
  `tests/collab-contract-derivation.mjs` 逐字段核对。
- **不验证不许说"没问题"**：区分「没测出问题」与「没有问题」；用户可见文案改动要配负向对照。
- **使用上的已知别扭之处**（含实测统计）见 `docs/collab-ux-backlog.md`，改之前先看有没有人已经记过。
- **本仓库的 `lib/` 是构建产物**：`build` 先 `rm -rf lib`。`tsc` 不清理已删源文件的输出，
  残留的僵尸产物曾经**掩盖**一个真实失败。
