# 方案：用状态机重构 collab 核心逻辑（Claim 状态机与操作流转）

> 目标：将 `collab-ops.ts` 和 `collab-core.ts` 中分散的隐式状态操作（filter、bury、push、手动清理 holder）收敛为**统一的状态机管理**，杜绝死锁、漏立墓碑、状态抖动和两形态分叉。

---

## 1. 为什么现在的核心逻辑需要状态机？

### 现状的问题剖析

当前 `src/collab-ops.ts` 中管理着两种核心资源：**锁（Claim）** 与 **交接/留言（Message/Handoff）**。
然而它们的状态并没有显式的状态机，而是依赖隐式的数据结构布局来表达：

1. **锁（Claim）的生命周期散落在 3 处不同的独立函数中**：
   - 主动释放：`release()` 手动 `state.claims = filter(...)` + `bury(...)`
   - 句柄退出释放：`releaseOnDispose()` 手动 `filter(...)` + `bury(...)` + 手动合成审计 `Message` + `dropHolder(...)`
   - 死亡回收：`reap()` 手动 `filter(...)` + `bury(...)` + 手动查找 deadHolder 并 `filter(holders)`
   
   **缺陷**：
   - 缺乏单一的"声明状态跃迁"原语。如果未来增加一种释放场景（例如超时收回、主动转让），必须把这套「移出列表 + 立墓碑 + 清理名册 + 留痕通知」重新手写一遍，极易遗漏（历史中多次出现漏立墓碑导致被并发旧副本复活，或漏清理 holders）。

2. **交接（Handoff）的状态转移散落在 post() 内部的一串 if 分支**：
   - `draft` 状态
   - `final` 状态
   - `handoff-accept`（接手后把目标交接转换为 `accepted`）
   
   当前在 `post()` 里直接写 `targetHandoffMsg.handoff.acceptedBy = ...`，这是典型的直接修改对象内部属性，而不是走状态机的 `transition`。

3. **并发合并（mergeDocs）是半格 join，但缺乏状态迁移约束**：
   - 合并规则（如 `joinHandoff`、`joinMessage`、`joinStatusRank`）各自独立计算，没有统一声明「哪些状态跃迁是合法的只读前进、哪些是不允许的非法回退」。

---

## 2. 核心状态机架构设计

我们将状态机划分为两个正交的维度：
- **资源状态机（Resource State Machine）**：管理单个声明（Claim）或交接（Handoff）的生命周期。
- **操作事务管道（Operation Pipeline）**：管理一次 op 请求从输入到输出的流水线。

### 2.1 Claim 声明生命周期状态机

单个声明的生命周期为严格的**单向有向无环图（DAG）**，不允许任何逆向复活：

```
               claim() [exclusive / shared / read]
                        │
                        ▼
                  ┌───────────┐
                  │  ACTIVE   │ (在 state.claims 中)
                  └─────┬─────┘
                        │
         ┌──────────────┼──────────────┐
         │              │              │
         │ release()    │ onDispose()  │ reap()
         ▼              ▼              ▼
   ┌───────────┐  ┌───────────┐  ┌───────────┐
   │ RELEASED  │  │ DISPOSED  │  │  REAPED   │ (移至 state.released 墓碑)
   └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
         │              │              │
         └──────────────┼──────────────┘
                        │ 自动附带动作：
                        ├─▶ bury(state, claim) 立 Lamport 墓碑
                        ├─▶ dropHolderIfOrphan(state, holderId)
                        └─▶ (仅 disposed) 产生 system:dsh-collab 审计留言
```

#### 状态定义
```ts
export type ClaimLifecycleState = 'active' | 'released' | 'disposed' | 'reaped';
```

#### 统一跃迁原语：`transitionClaim`
所有导致声明离开 active 态的操作，必须**唯一调用**该原语：
```ts
export function transitionClaim(
  state: StateDocument,
  claim: Claim,
  to: 'released' | 'disposed' | 'reaped',
  context: { now: number; actor: HolderInput; auditNote?: string }
): ClaimTransitionResult
```
这个函数原子化保证：
1. 从 `state.claims` 移除
2. 写入 `state.released` 墓碑（Lamport seq）
3. 检查 holder 是否变为孤儿（若已无有效 claim 且 oracle 判定死亡，则从 `state.holders` 移除）
4. 如果是 `disposed`，原子生成并追加 `AUTO_RELEASE_AUTHOR` 留言
5. 递增单调 `seq`

---

### 2.2 Handoff 交接生命周期状态机

交接条目挂载在 `Message` 上，其生命周期是单调向前的：

```
    post(kind='handoff', status='draft')
                 │
                 ▼
           ┌───────────┐
           │   DRAFT   │ (草稿状态，仅作者可追加/修改内容)
           └─────┬─────┘
                 │ post(kind='handoff', status='final', 末行必须是 "写完了")
                 ▼
           ┌───────────┐
           │   FINAL   │ (定稿状态，只读等待接手，awareness 注入广播)
           └─────┬─────┘
                 │ post(kind='handoff-accept', replyTo=msgId)
                 ▼
           ┌───────────┐
           │ ACCEPTED  │ (已接手，锁定 acceptedBy 与 acceptedAt，提示从 awareness 退出)
           └─────┬─────┘
                 │ (未来扩展：验收结算)
                 ▼
           ┌───────────┐
           │  SETTLED  │ (所有 items 均 done 或归档)
           └───────────┘
```

#### 统一跃迁原语：`transitionHandoff`
```ts
export function transitionHandoff(
  message: Message,
  action: HandoffAction,
  actor: HolderInput,
  tNow: number
): HandoffTransitionResult
```
严格守卫：
- `draft -> final`：必须校验正文末行是否为 `HANDOFF_FINAL_MARK`，item 为 `done` 时必须包含 `negativeControl`。
- `final -> accepted`：非本人接手、非已接手、必须携带合法 `replyTo`。
- 任何逆向转换直接拒绝。

---

## 3. 为什么这样设计？（不变量与强制点）

遵循 `invariants-first` 纪律，每个状态机必须守住明确的不变量：

### 不变量 1：声明消亡必立碑且单向，不可逆转
- **陈述**：任何从 `state.claims` 移出的声明，必须且只能在一处逻辑中进入 `state.released` 墓碑字典。
- **违背后果**：并发写者在合并时会根据旧副本将已释放/已回收的声明再次复活，造成脏锁。
- **强制点**：所有移除操作收敛至 `transitionClaim`，直接操作 `state.claims.filter` 视为反模式。

### 不变量 2：持有者名册与声明状态严格同步
- **陈述**：当一个持有者的所有声明全部处于终态且 oracle 确认 dead 时，`state.holders` 中绝不残留该持有者记录。
- **违背后果**：名册膨胀，造成 overview 和协同界面出现幽灵持有者。
- **强制点**：由 `transitionClaim` 自动级联调用名册收敛检查。

### 不变量 3：交接状态在半格合并中严格单调
- **陈述**：合并任意两份消息副本，交接状态只能向前演进（`draft < final < accepted`），`acceptedBy` 冲突时按结合律收敛。
- **违背后果**：网络抖动或跨进程同步时，定稿状态被旧副本覆盖回草稿，接手人信息丢失。
- **强制点**：`joinMessage` 内部调用状态机定义的秩函数 `joinStatusRank`，并通过 `tests/collab-convergence.mts` 400 轮随机语料保证结合律、交换律与幂等律。

---

## 4. 实施计划与步骤

### 第 1 步：实现状态机核心原语（纯逻辑无副作用）
- 在 `src/collab-core.ts` 中定义 `ClaimLifecycleState` 与状态跃迁函数 `transitionClaim`。
- 抽离 `HandoffStateMachine`，规范化 `draft -> final -> accepted` 的校验与跃迁。

### 第 2 步：重构 `collab-ops.ts` 对接状态机
- 重构 `release()`、`releaseOnDispose()`、`reap()`，统一使用 `transitionClaim` 代替手写的 filter/bury/dropHolder。
- 重构 `post()` 中的 handoff 逻辑，使用 `transitionHandoff`。

### 第 3 步：两形态同源校验与测试守卫
- 运行 `scripts/build-host.mjs`，确保内联脚本与包形态保持同源，`tests/collab-inline-parity.mjs` 绿灯。
- 为状态机跃迁编写完整的单元测试（涵盖非法跃迁阻断、墓碑原子落盘、并发收敛）。
