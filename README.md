# dsh-collab — 多智能体协作插件（Collab）

一个 DSH 部署级协作能力，用于让**多个 AI / 人类会话在同一项目上协作时减少写冲突**。它提供两个模型工具：

| 工具 | 作用 |
| --- | --- |
| `collab_lock` | **中央注册锁**：开工前声明"我占用哪些文件夹/文件"，并查询/等待他人释放 |
| `collab_board` | **协作留言板**：发消息 / 增量读消息，用于协商、交接、同步进展 |

> 💡 **外置无侵入数据管理**：协作状态与留言数据**不再污染项目代码目录**，而是统一隔离存放于用户环境 `${DSH_HOME:-~/.dsh}/collab/projects/<project-hash>.json`。按项目工作区路径安全哈希隔离，代码仓库保持 100% 纯净，彻底杜绝 `.gitignore` 遗漏与意外 Git 提交冲突。

> 面向使用者的完整协作规范见 [`docs/collab-usage.md`](docs/collab-usage.md)。

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
│   ├── index.ts                  # 包入口：注册 collab_lock / collab_board 工具
│   ├── collab-core.ts            # 纯逻辑唯一事实源（可 import / 可测 / 供多语言对照）
│   ├── collab-plugin.host.ts     # 自包含 Cordis Host 插件源码（导出 hostCode 字符串，可直接作为 code.host）
│   ├── schema/
│   │   └── collab.schema.json    # JSON Schema v1：状态文档 + 工具参数（单一契约）
│   └── types/
│       └── collab.d.ts           # TypeScript 类型定义（公共类型面，构建时复制到 lib/types/）
├── lib/                          # tsc 构建产物（git 忽略，随 npm 包发布）
└── tests/
    └── collab-pure-logic.mjs     # 纯逻辑 + 宿主一致性的回归测试（对 lib/ 运行）
```

### 多工具链协同设计（Python + TS + Rust）

1. **`src/collab-core.ts` & `src/types/collab.d.ts` (TS/fnm)**
   - 纯逻辑事实源与 TypeScript 强类型定义。
   - 增强了冲突建议语义（`remainingSec`、`suggestedAction`: wait/negotiate/switch_path），为 AI 决策提供确定性下一步方案。
   - 运行类型校验：`pnpm run test:types`。

2. **`scripts/simulate_collab.py` (Python/uv)**
   - 使用 `uv` 运行多 Agent 并发协作高压测试，模拟多 Agent 抢占、冲突等待、消息同步场景，验证高并发下系统无死锁。
   - 运行压测仿真：`uv run python scripts/simulate_collab.py`。

3. **`crates/collab-cli` (Rust/cargo)**
   - 高性能本地 CLI，支持离线状态查询、手动 claim/release、消息互动。
   - 提供专属 `git-check` 命令：在提交或修改代码前，自动检查当前工作区修改与项目内他人声明的冲突，防止多智能体踩踏覆盖。
   - 编译运行：`cargo build --manifest-path crates/collab-cli/Cargo.toml`。

---

## 运行测试

```bash
# 0. 构建（测试与发布均针对 lib/ 产物，故需先构建）
pnpm run build

# 1. 运行 Node.js 纯逻辑与宿主对拍测试
node tests/collab-pure-logic.mjs   # 56/56 通过

# 2. 运行 TypeScript 契约静态类型检查
pnpm run test:types

# 3. 运行 Python 多智能体高并发压测仿真
uv run python scripts/simulate_collab.py

# 4. 运行 Rust CLI 单元测试
cargo test --manifest-path crates/collab-cli/Cargo.toml
```

---

## 状态维护（自动，无需人工干预）

`src/collab-core.ts` 的 `sweep()` 在每次读/写前惰性执行，保证状态文件不会无限增长：

| 行为 | 阈值 | 说明 |
| --- | --- | --- |
| 过期声明回收 | 租约到期 | `expire()` 的既有语义 |
| 留言保留 | 最近 `MAX_MESSAGES = 2000` 条 | 超出部分从最旧的开始丢弃，写入时回报 `swept.droppedMessages` |
| 陈旧 holder 回收 | 无活跃声明且 `HOLDER_TTL_MS = 24h` 未出现 | 避免 holders 数组长期膨胀 |
| 损坏状态自愈 | JSON 解析失败 | 备份为 `<state>.corrupt-<ts>` 后重置为空状态，并以 `warning` 上报，而不是让协作工具永久不可用 |

工具返回统一信封：失败时 `error` / `message` 在顶层（如 `bad-request`、`not-found`、`conflict`、`forbidden`、`timeout`），调用方无需再挖 `data`。

---

## 作为动态插件运行

把 `collab-plugin.host.ts` 导出的 `hostCode` 作为 `code.host` 传给 `cordis_define` 即可：

```js
// ESM（构建产物；源码为 src/collab-plugin.host.ts）
import { hostCode } from './lib/collab-plugin.host.js'
// cordis_define({ plugin: { kind: 'new', idPrefix: 'coll' }, code: { host: hostCode } })
```

---

## 待办（见设计文档 §18.5）

- 正式化接入 host 组合（`~/.dsh/profiles/web/cordis.patch.yml`，进程重启不丢、多会话自动获得工具）；
- 状态文件迁移到 `.dsh-collab/state.json` 目录形态（需 `shell` mkdir / 确认 fs 行为）；
- 进程内事件广播；
- 真实双会话自动化测试。
