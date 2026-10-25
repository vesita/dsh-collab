# 提案：把「交接」做成 `collab_board` 的结构化条目

> 从 2026-10-25 那次 dsh-pod 跨会话协同里长出来的。那天暴露 5 个问题，
> 其中 4 个不是"某个人不仔细"，是**机制缺失**。

## 先决：为什么不新增工具

`collab_board` 的定位就是「跨会话交接的留痕」（`docs/collab-usage.md:204`）。
再开一个 `collab_handoff` 工具必然是**同一判定的第二处实现** —— 本仓库的纪律
明写"同一判定出现第二处实现，那里就是漂移源"。

而且实测它现在缺的恰好是**结构化**：

| 现状 | 缺什么 |
|---|---|
| `post` 写入自由文本 | 没有"这条做完了没"的字段 |
| `read` 按游标增量读 | 接手方要自己读几百字散文判断状态 |
| 没有已读回执（文档承认） | 交接方不知道对方有没有接手 |

所以方向是**给 board 加一个条目类型**，不是加工具。

## 场景

会话 A 做到一半要交给 B（可能是另一个模型、另一个进程、隔一天才接手）。
A 写交接，B 判断"能不能开始"。

不变量（每个前缀上都成立）：

| 时刻 | 必须成立 |
|---|---|
| A 说"交接完成" | B 跑一遍验收，每条都符合 A 声称的状态 |
| B 接手前 | B 能分辨"定稿"与"A 写到一半被切断" |
| B 动手前 | B 知道哪些路径别人正在改 |
| B 引用 A 的结论时 | 那条结论带强度标记，且能一条命令复核 |

## 四个机制（对应那天暴露的四个问题）

### ① 定稿要有可判定的标记 —— 不是散文

**现象**：`READTHIS.md` 是散文，B 无法判断是否完整。

**不变量**：*交接条目的 `status` 只有 `draft` / `final` 两值；`final` 时正文的最后一行必须是固定串。*

**强制点**：
- ① 结构：`post({ kind:'handoff', status:'final' })` 时由插件**自己**在校验前追加那一行 ——
  不靠人记得写
- ② 测试：`status:'final'` 但正文末行不是固定串 ⇒ 拒绝写入（不是警告）

### ② "送达 ≠ 接手" 必须能分辨

**现象**：`send_message` 返回 `sent: true`，但成员根本没起来（provider 额度耗尽），
我试了 3 次才意识到。

**不变量**：*交接条目区分"我写下了"与"对方接手了"两个状态，且后者只由接手方自己置位。*

**强制点**：
- ① 结构：`post` 写 `{ by: 'A', at }`；接手方 `post({ kind:'handoff-accept', replyTo: id })`
  才产生 `acceptedBy`
- ③ 门禁：交接方 `read` 时返回 `pendingAcceptance: true` —— 提醒它别假设对方在干活

### ③ 没有负向对照的"完成"不算完成

**现象**：`inbound-ttl` 里名为 `postpones` 的用例**从没调用被测函数**，删掉实现照样绿 ——
是我事后翻出来的。

**不变量**：*声称 `done` 的条目必须带 `negativeControl`（命令 + 变红证据）；缺了记 `unverified`。*

**强制点**：
- ② 测试：`record({ status:'done' })` 不带 `negativeControl` ⇒ 插件改写成 `unverified`
  并在返回里说明为什么（不是静默降级 —— 那正是本仓库反的模式）

### ④ 结论要带强度标记，接手方要能复核

**现象**：审计说"每条回复都被判成未送达"，我实测后发现不成立
（`providerMessageIdsFor` 认 `messageId`，正常路径是对的）。如果我不复核就照着修，
会去改一个没坏的地方。

**不变量**：*每条 `claim` 带 `strength: 'measured' | 'inferred'`；`measured` 必须有
`evidence`（命令 + 输出摘要），没有就拒绝写入。*

**强制点**：
- ① 结构：`measured` 而 `evidence` 为空 ⇒ 拒绝（不是降级成 `inferred` ——
  那会让"我测过了"变成一句可以随便说的话）

## 数据结构（挂在现有 board 条目上，不新增文件）

```ts
type BoardEntry = {
  // …现有的 seq / channel / body / by / at
  kind?: 'note' | 'handoff' | 'handoff-accept',   // 默认 'note'（向后兼容）
  handoff?: {
    status: 'draft' | 'final',
    items: Array<{
      text: string,
      status: 'done' | 'unverified' | 'blocked',
      negativeControl?: { command: string, became: string },  // done 必填
      reason?: string,                                        // blocked 必填
      claim?: { strength: 'measured' | 'inferred', evidence?: string },
    }>,
  },
}
```

**向后兼容是硬要求**：现有 `post({ body })` 不带 `kind` ⇒ 走 `'note'`，
行为与今天**逐字节一致**。判据是一条测试：旧写法的输出不变。

## 不做的事

- **不新增工具**（理由见上）
- **不改 `collab_lock`**（写门控是另一件事，`docs/collab-ux-backlog.md` 第 1/2/3 条已在跟）
- **不做自动交接**（上下文快满时自动生成文档）—— 交接质量取决于判断，自动化会产出
  一份"看起来完整"的空壳
- **不做已读回执之外的通知**（`board` 按设计没有投递面，这一条不打破）

## 验收（交付时逐条核对）

| 不变量 | 强制点 | 落点 |
|---|---|---|
| `final` 必须有定稿标记 | 拒绝写入 | `tests/collab-pure-logic.mjs` |
| 送达 ≠ 接手 | `pendingAcceptance` 字段 | 同上 |
| 无负向对照不算 done | 降级为 `unverified` + 返回说明 | 同上 |
| `measured` 必须有 evidence | 拒绝写入 | 同上 |
| 旧写法行为不变 | 逐字节对比 | `tests/collab-integration.mjs` |

每条都要配**负向对照**（这一条也适用于本提案自己）。

## 需要先确认的两件事

1. **schema 是 SSOT**：`src/schema/collab.schema.json` 的改动会牵动 TS/Python 两份派生
   （`tests/collab-contract-derivation.mjs` 逐字段核对）。加 `kind`/`handoff` 字段要同时改
   三处，工作量比看起来大。
2. **两形态同源**：改动必须落在 `src/collab-core.ts`（辅助面）或 `src/collab-ops.ts`
   （操作面），**不能只改包形态** —— 否则 `tests/collab-inline-parity.mjs` 会红。

## 最容易被漏掉的一处：`joinMessage`

`src/collab-core.ts:407` 的 `joinMessage` 是**半格 join**（合并两写者各自的副本）。
新字段如果**不参与合并**，跨进程并发时会静默丢数据 —— 而这个仓库的收敛不变量
（0.17.0 起）正是围绕"两写者不丢更新"建立的。

```ts
function joinMessage(a: Message, b: Message): Message {
  const out: Message = {
    msgId: a.msgId,
    seq: joinMaxNum(a.seq, b.seq),
    channel: …, author: …, ts: …, body: …,
    // ← 这里必须加 kind / handoff 的合并规则，否则并发时丢
  }
  …
}
```

**`handoff` 怎么 join**（这是设计难点，不能随手定）：

| 字段 | 合并规则 | 为什么 |
|---|---|---|
| `kind` | 有值者胜（两边不一致时取字典序大的，保证交换律） | 同一条 `msgId` 的 `kind` 理论不变；不一致说明有 bug，但合并仍须确定 |
| `status` | `draft` < `final`，取大 | 只前进（单调），与发布语义一致 |
| `items` | 按 `text` 为键求并；同键时各自字段 join | 两边可能各补了一部分条目 |
| `items[].status` | `unverified` < `done`，`blocked` 是终态（不再变） | 待办只会前进 |
| `negativeControl` / `evidence` / `reason` | 有值者胜 | 只写一次的事实 |
| `acceptedBy` | 有值者胜 | 接手只发生一次 |

**判据**：这条 join 必须进 `tests/fixtures/merge-golden.json` 的黄金语料
（`tests/gen-merge-golden.mjs` 现算），且 `tests/collab-convergence.mjs` 的代数律
（交换/结合/幂等）对含 `handoff` 的条目也成立。

**没有这一条，整个提案是半成品** —— 加了字段但不参与合并，等于给并发埋了一个
静默丢数据的洞，而现有的并发测试**不会覆盖到它**（它们用的是旧形状）。
