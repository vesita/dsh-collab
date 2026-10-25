# 优化提案：接手交互 + 完全 TS 化

> 在 `handoff-proposal.md` 之上加两件事：**接手交互**（让对方知道"有人要交给你"）
> 与 **tests 的 TS 化**。`src/` 已经是 100% TS，剩下的是 tests。

---

## 一、接手交互：从"留言板"到"有人接手了"

### 现状的三个断点

| 环节 | 现在 | 断在哪 |
|---|---|---|
| A 写下交接 | `board.post({ body })` | B 不知道有新交接（board **没有投递面**） |
| B 接手 | B 恰好在读 board | 大概率不会恰好读到 |
| A 确认 | 无 | A 不知道 B 接没接，只能假设 |

`docs/collab-usage.md:206` 自己写着：**"它没有已读回执 —— 谁读没读过，插件不知道。"**

### 但 `awareness` 已经有每步注入

`src/awareness.ts` 的机制是：**每个会话每一步都会自动看到同项目的实时占用**，
通过 `systemPrompt.context`（order 130）注入，读盘走后合缓存。

```ts
// 已经存在的能力：每个会话每步看到 "同项目还有谁占着什么"
const agents = ctx.get('agents')   // currentInitiator() → 正在装配的会话
```

**这是接手交互的正确载体**，而且不需要新增投递面：

> 有人在 `path:dsh-pod/` 留了一份待接手交接 ⇒ 任何声明了该路径的会话，
> **下一步**就在自己的上下文里看到 `【待接手】…`

### 三个动作

```
① A 写交接      board.post({ kind:'handoff', paths:[...], items:[...] })
② B 看到        awareness 注入一行 —— 只注入给**声明了相关路径**的会话
③ B 接手        board.post({ kind:'handoff-accept', replyTo:<id> })
④ A 下次聚合    看到 acceptedBy，知道有人接了
```

**不新增工具，不改投递面**（`board` 按设计没有投递面，这一条不打破）。
接手交互全部靠"下一次 prompt 装配时注入"完成。

### 不变量（每条都要有强制点）

| 不变量 | 判据 | 强制点 |
|---|---|---|
| **只注入相关会话** | 无关会话的 prompt 里不出现 `【待接手】` | 测试：两个会话，只声明路径那个能看到 |
| **不重复注入** | 同一条交接连续 3 步只出现 1 次 | 结构：注入后写 `notifiedAt`，已通知的不再进 |
| **接手是幂等的** | 两个会话同时 accept 同一条 ⇒ 只有一个成功 | 结构：`acceptedBy` 有值者胜（join 规则） |
| **不注入自己写的** | A 不会看到自己的交接被当成"待接手" | 结构：跳过 `author === 自己` |
| **不阻塞** | 注入只是提示，不改变任何门控 | 测试：有交接时 claim 行为不变 |

### 为什么不做"通知/唤醒"

`AGENTS.md` 第 1 节定了铁律：跨会话通知**只能**经 `agent.inject` + 自造显式来源消息。
而 `board` 的定位明写"不投递、不唤醒"。

用 `awareness` 的注入（本来就是每步都发生的）**恰好绕开这个矛盾**：
不是"推送一条消息"，是"下一步的上下文里本来就有这一行"。

---

## 二、完全 TS 化

### 现状

| 目录 | `.ts` | 非 TS | 说明 |
|---|---|---|---|
| `src/` | 17 | 1 | `host-shell.js` 是**模板字面量字符串**，不是模块 —— 不该迁 |
| `tests/` | 0 | 27 | **这才是真实目标** |

`src/` 实际上**已经 100% TS**（`host-shell.js` 是构建期被内联的 JS 字符串模板，
由 `scripts/build-host.mjs` 消费，迁 TS 没有意义）。

### 已验证：tests 可以直接 `.ts`

```bash
$ cp tests/collab-pure-logic.mjs tests/_probe.ts && node tests/_probe.ts
ALL PASS: 147 passed, 0 failed
```

Node 24 原生类型擦除，不需要编译步骤。`tsconfig.json` 的 `include` 加
`tests/**/*.ts` 即可让它们受类型检查。

### 迁移顺序（按"被依赖越少越先"）

| 批 | 文件 | 判据 |
|---|---|---|
| 1 | `_harness.mjs`、`collab-pure-logic`、`collab-convergence` | 纯逻辑，无外部依赖 |
| 2 | `collab-write-merge`、`collab-merge-golden`、`collab-state-split` | 涉及磁盘，但只依赖 harness |
| 3 | `collab-integration`、`collab-e2e`、`collab-hostcode-parity` | 端到端 |
| 4 | 其余（awareness / access-gate / reap / skill / client-config） | 逐个 |

`package.json` 的 `test` 脚本里 `node tests/xxx.mjs` 要跟着改成 `.ts`。

### 一个真实的坑：`_harness.mjs`

27 个测试全都 `import { createHarness } from './_harness.mjs'`。
它一旦迁成 `.ts`，**27 个文件的 import 路径都要改** —— 是 `scripts/ts-migrate.mjs`
（dsh-pod 里那个 AST 工具）的典型场景，可以直接复制过来用。

---

## 三、`strict` 该不该开

现在 `tsconfig.json` 是 `strict: false`。这是**迁移遗留**，不是设计选择。

建议：**先不开**。理由：
- 17 个 `.ts` + 即将迁移的 27 个测试一起开 strict，一次会报几百条
- 先让 tests 变成 `.ts`（有了类型检查就比 `.mjs` 强得多），再单独一轮收紧 strict
- 收紧时按"`noImplicitAny` → `strictNullChecks` → 全 strict"三档，每档单独提交

---

## 四、和 `handoff-proposal.md` 的关系

那份讲**数据结构**（`kind`/`handoff`/`joinMessage` 合并规则），这份讲**交互**与**工程**。

合并后的完整交付顺序：

| 步 | 内容 | 前置 |
|---|---|---|
| 1 | schema + `Message.kind`/`handoff` 字段 + **`joinMessage` 合并规则** | — |
| 2 | `post` 接受 `kind:'handoff'`，校验四条不变量（final 必带标记 / done 必带负向对照 / measured 必带 evidence / blocked 必带 reason） | 1 |
| 3 | `awareness` 注入 `【待接手】`（只在相关会话、只一次、跳过自己） | 2 |
| 4 | `handoff-accept` 条目 + `acceptedBy` join | 2 |
| 5 | tests TS 化（4 批） | 可并行 |

**第 1 步是地基**：合并规则错的话，后面全白搭（跨进程并发会静默丢数据）。

---

## 五、不做的事

- 不做"自动交接"（上下文快满时自动生成文档）—— 交接质量取决于判断
- 不打破 `board` 的"不投递"设计 —— 接手交互靠 awareness 注入，不靠推送
- 不迁 `host-shell.js` —— 它是模板字符串，迁 TS 没有意义
- 不一次开 `strict` —— 会淹没在几百条报错里
