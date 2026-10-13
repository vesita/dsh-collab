# DSH 子代理路由：继承、点名与验证（实测）

> 本文是**文档**，不是提示词：不进 `skills/`、不进 `src/spec.ts` 常驻文本。记的是"子代理跑哪条路由"的机制、可用做法、验证与排障。
> 证据标注：**实测** = 本机跑出/读文件读出；**推断** = 由源码或单次观察推出、未单独复现。

## 1. 机制

### 1.1 子代理用的是「父会话当前所用的 preset」（最重要）

- 子会话 preset = **父会话实时作用链上的 preset**，不是**部署配置里的默认 preset**（0.1.7 起是 profile 里 `agent-preset-registry` 条目的 `default` / `selectedDefault`），也不是父会话头部那个创建时字段。
- **实测**：父 `session-93594468-aa20-461d-8f76-295a60d873ef` 头部是 `agentPreset: "standard"`（创建时快照），其裸派子会话 `6502d243-ae82-479b-b3e4-07c024e651ef` 头部是 `agentPreset: "cordis"`、`origin: "subagent"`，路由 `deepseek-official/deepseek-flash`（descriptor 与 `request/header` 一致）—— 父会话界面切到创造模式，子代理就跟 cordis。同现象见 `24655d15-…`、`d5030032-…`。
- **推断**：默认 preset 只影响**新**会话，管不到已在跑的会话。
- **结论**：子代理默认继承父会话路由；要换路由就得每次调用显式点名（见 2.1），实际跑哪条可读子会话文件核对（见 3.1）。

### 1.2 默认继承：调用层无法区分"点名"与"继承"

- `dsh-subagent` 的 `resolveChildAgentOptions(parent, requested, childDepth)`（`lib/index.js:468-484`）**以父路由为底、用 `requested` 覆盖**；裸委派 `requested` 为空 ⇒ 拿到父路由。父路由口径 `parentAgentOptionsForDelegation`（`:446-456`）= `parent.session.requestHeader()?.config`，退回 `parent.options`。
- ⇒ 子代理 `agent.options` **永远是一条完整路由**，两种意图同形，任何反推判据都得额外引入信息。

### 1.3 allowlist 只筛点名，且是会话快照

- `assertAllowedModelSelection`（`:91-98`）**无显式点名时直接 return**：只过滤"点名"，**不选模型、不阻止继承**。
- 名单是**会话组装时的快照**（`recordSubagentModelSelection`）：事后改部署配置（本机是 profile 里的 `subagent-model-selection-settings` 条目）对已有会话无效（**实测**：放开后旧会话仍报 `child LLM route … is not allowed for this Session`；子会话 `6502d243-…` 里可见 `subagent/model-selection-policy` 记录，名单可从子会话文件直接读出）。

## 2. 调用方点名；插件路线不建议

### 2.1 `subagent` 调用上显式点名

- 支持 `provider` / `model` / `reasoning_effort`，**仅当** `modelSelectionSettings: true`（`:374,388,412`）；受 `subagent-model-selection.allowedModels` 限制（`:91-98`，会话级快照，见 1.3）。
- **实测**：子会话 `d8d00aec-1629-4e35-b6b0-83ce51995db9` 用 `google-antigravity/gemini-3.8-flash @ high` 跑通（descriptor 与 `request/header` 一致；会话里 `RESULT=391` 出现 8 次）。
- **代价**：每次调用都要点名，漏了退回继承（见 1.2）。适合偶发换模型，不适合整个会话固定。

### 2.2 `subagent_fork` 不支持选择路由（设计如此）

- **实测**：`standard` 的 `tool-subagent-fork` 行（`presets/standard/agent.cordis.yml:193-198`）只有 `provider: fork`、`toolName`、`backgroundMode`，**无 `modelSelectionSettings`、无固定路由配置** ⇒ fork schema 无 `provider`/`model`/`reasoning_effort`。
- 同处注释（`:188-190`）："Fork omits model selection so provider/model stay equal to the parent and the inherited history remains eligible for KV Cache reuse." —— fork 的 provider/model 必须等于父才能复用 KV cache。**是设计，不是缺陷。**

### 2.3 插件路线：不建议

- 机制：监听 `agent/request`（waterfall，契约 "Replace the frozen call configuration"），对 `origin === 'subagent'` 的调用替换 `LlmCallConfig`。
- **代价与洞（全部实测）**：
  1. **记录层与调用层分裂**：descriptor / `agent.options` 仍写继承来的路由，实际跑改写后的（探针 `781077c5`）。排查**只能看 `request/header`**。
  2. **"点名 vs 继承"不可区分**（见 1.2），反推判据都有洞：
     - `agent.options` 完整即点名 ⇒ 普通委派被当点名，**继承漏回**；
     - 命中白名单即点名 ⇒ **角色路由恰等于父路由时，裸委派也命中**（**实测**：角色 `mechanical` = 父路由 `command-code/deepseek/deepseek-v4.1-flash`，裸委派跑了父路由）；
     - 与父路由不同即点名 ⇒ 必须解析父代理，父不可知时要在"漏继承"与"抹掉角色选择"间二选一。
  3. 结论：插件侧要做**按角色分派**，只能靠**显式信号**（如 `subagent_role` 工具在启动前登记角色、插件按父会话 id 绑定），**不能反推**。
- **适用场景**：只在**同一会话内需按调用选不同路由**（omp 风格 `modelRoles`）时才有价值；只为"固定一条路由/禁止继承"引入插件收益为负。**偶发换模型走 2.1。**

## 3. 验证与排障

### 3.1 一手验证：读子会话文件

子会话 id = `subagent` 返回的 id，文件为 zstd jsonl：`~/.dsh/sessions/<项目目录>/<id>/session.v3.jsonl.zstd`（目录名由 cwd 派生；本机 cwd `/home/vesita/coding/my` → `--home-vesita-coding-my--`）。看两处即可：

1. 首条 `type:"session"` 的 `agentPreset`（实际挂的 preset）；
2. 所有 `type:"request/header"` 的 `data.header.config.provider` / `.model`（实际跑的路由）。

```bash
SESS_DIR=/home/vesita/.dsh/sessions/--home-vesita-coding-my--
ID=6502d243-ae82-479b-b3e4-07c024e651ef          # = subagent 工具返回的子会话 id
zstd -dc "$SESS_DIR/$ID/session.v3.jsonl.zstd" | python3 -c '
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    o = json.loads(line)
    if o.get("type") == "session":
        print("agentPreset =", o.get("agentPreset"),
              "| parent =", o.get("parentSession"),
              "| origin =", o.get("origin"))
    if o.get("type") == "request/header":
        c = o["data"]["header"]["config"]
        print("route =", c.get("provider"), "/", c.get("model"), "@", c.get("reasoningEffort"))
'
```

裸派应打印**父会话路由**；显式点名时应打印点名的那条（如 `google-antigravity / gemini-3.8-flash @ high`）。`subagent/descriptor` 的 `agentProvider`/`agentModel` 是同一路由的副本，可交叉核对。

### 3.2 排障：失败与一眼判据

判据是**报错里的关键串**：

| 失败 | 判据 | 处置 |
|---|---|---|
| allowlist 拒绝 | 报错含 `child LLM route … is not allowed for this Session` | 名单是会话组装时的快照（见 1.3）：放开限制后旧会话仍拒绝，换新会话才生效 |
| 部署态 preset 冲突 | 报错含 `prompt section "deployment:persona-prefix" is already registered` | 部署/版本层问题，非你所写。**单次实测**：包刚换版本、旧进程仍在跑时挂载失败；重装成一致版本后消失 |

### 3.3 证据索引

| 事项 | 证据 |
|---|---|
| 子代理用父会话当前 preset | 父 `session-93594468-…` 头部 `standard`；子 `6502d243-…` 头部 `cordis` + `origin: subagent` |
| default 管不到已运行会话 | 当时配置的默认 preset 已是另一个值，`6502d243-…` 仍按父 cordis 路由跑 |
| 同现象重复 | `24655d15-05a6-47b4-afdf-a9ff412553e1`、`d5030032-7fea-4bee-8790-9e82ed412e9c` 头部均 `cordis` |
| 裸委派继承父路由 | `6502d243-…` descriptor 与 `request/header` = `deepseek-official/deepseek-flash@low`；另 `4ad0dc10` = `command-code/deepseek/deepseek-v4.1-flash` |
| 指定路由可用 | `aef90834`：`google-antigravity/gemini-3.8-flash@high`，用量库落 `stop`、无错、ttft 4873ms |
| 调用方点名跑通 | `d8d00aec-1629-4e35-b6b0-83ce51995db9`：descriptor/`request/header` = `google-antigravity/gemini-3.8-flash`，`RESULT=391` |
| allowlist 是会话快照 | 放开后旧会话仍报 `child LLM route … is not allowed for this Session`；`6502d243-…` 内有 `subagent/model-selection-policy` 快照 |
| 插件改写致记录/调用分裂 | `781077c5`（fork 子代理）descriptor 与 `request/header` 不同步 |
| 白名单判据的洞 | 角色 `mechanical` 与父路由重合 ⇒ 裸委派被放行 |

## 4. 本文不做什么

- 不把上述内容写进 `skills/**` 或运行时纪律文本 —— **本文只进 `docs/`**。
- **不建议插件路线**：记录/调用分裂、三种反推判据各有洞、只为固定路由收益为负（见 2.3）。
