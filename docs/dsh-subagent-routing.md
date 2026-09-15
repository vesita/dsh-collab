# DSH 子代理路由：默认继承 vs 固定配置（实测）

> 本文是**文档**，不是提示词：不进 `skills/`、不进 `src/spec.ts` 常驻文本。记的是"子代理跑哪条路由"的机制、可用做法、验证与排障。
> 证据标注：**实测** = 本机跑出/读文件读出；**推断** = 由源码或单次观察推出、未单独复现。

## 1. 机制

### 1.1 子代理用的是「父会话当前所用的 preset」（最重要）

- 子会话 preset = **父会话实时作用链上的 preset**，不是 `agent-presets.default`，也不是父会话头部那个创建时字段。
- **实测**：父 `session-93594468-aa20-461d-8f76-295a60d873ef` 头部是 `agentPreset: "standard"`（创建时快照），其裸派子会话 `6502d243-ae82-479b-b3e4-07c024e651ef` 头部是 `agentPreset: "cordis"`、`origin: "subagent"`，路由 `deepseek-official/deepseek-flash`（descriptor 与 `request/header` 一致）—— 父会话界面切到创造模式，子代理就跟 cordis，尽管当时 `agent-presets.default` 已是 `no-inherit-subagent`。同现象见 `24655d15-…`、`d5030032-…`。
- **推断**：`agent-presets.default` **只影响新会话**，管不到已在跑的会话。
- **结论**：要让某会话的子代理固定路由，必须让**该会话本身**跑带 `agentOptions` 的 preset（见 2）；否则每次调用显式点名（见 3.1）。

### 1.2 默认继承：调用层无法区分"点名"与"继承"

- `dsh-subagent` 的 `resolveChildAgentOptions(parent, requested, childDepth)`（`lib/index.js:468-484`）**以父路由为底、用 `requested` 覆盖**；裸委派 `requested` 为空 ⇒ 拿到父路由。父路由口径 `parentAgentOptionsForDelegation`（`:446-456`）= `parent.session.requestHeader()?.config`，退回 `parent.options`。
- ⇒ 子代理 `agent.options` **永远是一条完整路由**，两种意图同形，任何反推判据都得额外引入信息。

### 1.3 工具侧 schema 与能力前置校验（写错「挂载即炸」）

`dsh-tool-subagent/lib/index.js`：

- **schema**（**实测** `:258-263`）：`agentOptions` 四键并列 `provider` / `model` / `reasoningEffort` / `maxTokens`；写 preset 时给前三（`maxTokens` 可选）。

  ```js
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
  }).default(void 0)
  ```

  **反直觉（实测）**：本机 rc.2 的 schemastery 验证器**不拒绝缺字段** —— `{}`、`{provider}` 都能过。别指望 schema 挡错，兜底是下面的前置校验。
- **provider 必须声明能力**：spawn provider `capabilities.agentOptions = true`（**实测** `dsh-subagent-spawn-in-process/lib/index.js:24`）；换 provider 前先查。
- **前置校验在挂载期**（**实测** `:376-380`，报错在 `:378`）：

  ```js
  if (config.agentOptions !== void 0 && !subagentProvider.capabilities.agentOptions)
    throw new Error(`tool-subagent: provider "${name}" does not support child agentOptions`);
  ```

  **推断**：断言在挂载期抛出 ⇒ **整个 preset 挂载失败** ⇒ 依赖它的新建/恢复会话一起失败。

  ```bash
  grep -n "agentOptions: true" /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subagent-spawn-in-process/lib/index.js
  sed -n '258,263p' /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js
  ```

- **调用方请求优先**：`requestedAgentOptions`（`:62-81`）压过 `config.agentOptions`。
- **`provider`/`model`/`reasoning_effort` 只在 `modelSelectionSettings: true` 时进工具 schema**（`:374` 算能力、`:388` 算启用、`:412` 展开）；关掉它，模型无法点名，`config.agentOptions` 即唯一权威。
- `config.agentOptions` 存在 ⇒ `hasConfiguredLlmSelection` ⇒ `requiresRoutePreflight` ⇒ 派生**路由前置校验**（路由不存在就响亮失败）。

### 1.4 allowlist 只筛点名，且是会话快照

- `assertAllowedModelSelection`（`:91-98`）**无显式点名时直接 return**：只过滤"点名"，**不选模型、不阻止继承**。
- 名单是**会话组装时的快照**（`recordSubagentModelSelection`）：改 `settings.yaml` 对已有会话无效（**实测**：放开后旧会话仍报 `child LLM route … is not allowed for this Session`；子会话 `6502d243-…` 里可见 `subagent/model-selection-policy` 记录，名单可从子会话文件直接读出）。

## 2. 路径 (a)（推荐）：原生 preset 固定默认路由

复制 shipped preset 到用户预设根，只给 `tool-subagent` 行加 `agentOptions`（shipped `standard` 的原始位置 `presets/standard/agent.cordis.yml:181-186`）：

```yaml
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
    modelSelectionSettings: true      # 保留：显式点名仍可覆盖默认（并受 allowedModels 限制）
    backgroundMode: continuable       # 保留：否则退化成 one-shot，拿不到可续子代理
    agentOptions:                     # 新增：子代理默认跑这条，而不是继承父会话
      provider: google-antigravity
      model: gemini-3.8-flash
      reasoningEffort: high
```

- **优点**：**记录层 = 调用层** —— 路由在**派生那一刻**冻进子代理 `agentOptions`，不依赖插件逐请求改写，没有"日志写 A、实际跑 B"。
- **边界**：只覆盖**使用该 preset 的会话**；已在跑 `standard`/`cordis`（shipped，禁止改）的会话不变 —— 要钉就给每个用到的 preset 各复制一份。

### 2.1 两份现成副本（本机已就绪）

| 目录 | 显示名 | 与 shipped 的差别 |
|---|---|---|
| `~/.dsh/.agent-presets/no-inherit-subagent/` | 标准模式（子代理不继承） | = `standard` + `agentOptions`（含注释） |
| `~/.dsh/.agent-presets/cordis-no-inherit/` | 创造模式（子代理不继承） | = `cordis` + `agentOptions`（含注释），**且 `tool-cordis` 置 `disabled: true`** |

- 两者都把裸派子代理钉到 `google-antigravity/gemini-3.8-flash @ high`；显式点名仍可覆盖。
- **`cordis` 副本必须让出 cordis 工具集**：`tool-cordis` 把检视 provider 注册进**进程全局**的 `cordisInspect` 服务（host 组合装载：`dsh-web-app/cordis.patch.yml:122-123`；实现 `dsh-cordis-host-runner/lib/types/inspect-registry.js:11-14`，注释 "Register the process-global Host registry"），**一进程仅一份**。shipped `cordis` 已占住它，第二个含该行的 preset 挂载期抛 `Host Cordis inspect provider "Service" is already registered`（**实测**，见 4.3）；**preset 侧无法用 `isolate` 修**（服务是 host 提供的，不是 preset 自有的）。故副本禁用该行：**创作 preset 用 shipped 创造模式**，本副本只负责"创造模式能力面 + 钉死路由"，任何进程状态下都能挂载。
- 设为**新**会话默认：把 `~/.dsh/settings.yaml` 的 `agent-presets.default` 设为对应 id（本仓库不替你改；只影响新会话，见 1.1）。
- 核对差别（**实测**）：

  ```bash
  SHIP=/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets
  diff "$SHIP/standard/agent.cordis.yml" ~/.dsh/.agent-presets/no-inherit-subagent/agent.cordis.yml
  diff "$SHIP/cordis/agent.cordis.yml"   ~/.dsh/.agent-presets/cordis-no-inherit/agent.cordis.yml
  ```

- **升级 DSH 后必重跑上面的 diff**：副本冻结的是**复制那一刻**的 shipped 行名，部署改名后整份挂载失败（0.1.6 **实测**：`dsh-workflow-worker-thread` → `dsh-workflow-ptc`，报 `Cannot find package '@deepseek-ai/dsh-workflow-worker-thread'`，两个副本一起失效）。修法 = 把漂移行改回 shipped 现名，直到 diff 只剩上表的预期差别；`cordis-no-inherit/skills/` 里随行的 skill 副本同样冻结旧行名，一并重同步。

### 2.2 自己造一份

```bash
SHIP=/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets
ID=my-fixed-route                       # 目录名即 preset id（须匹配 PRESET_ID 规则才成为 roster 行）
mkdir -p ~/.dsh/.agent-presets/$ID
cp "$SHIP/standard/agent.cordis.yml" ~/.dsh/.agent-presets/$ID/agent.cordis.yml
cp "$SHIP/standard/preset.yml"       ~/.dsh/.agent-presets/$ID/preset.yml
# 再改 preset.yml 的 name/description，并在 agent.cordis.yml 的 tool-subagent 行 config 里加上面那段
```

> **源自 `cordis` 时另加一步**：把 `tool-cordis` 行置 `disabled: true`（或删除），否则副本在已有 cordis 系 preset 的进程里挂载失败（见 2.1）。源自 `standard` 无此步。

`preset.yml` 最小形状（**实测** `dsh-agent-presets/lib/index.js:67-72,85-91`：解析 `name`/`description`/`order`，缺则省）：

```yaml
name: 我的固定路由模式          # 必给（否则 picker 里没名字）
description: >-                # 建议给
  标准模式 + 子代理默认跑固定路由。
# order: 50                    # 可省；缺省按 Infinity 排到最后（:417）
```

### 2.3 生效条件与边界

- `agent-presets.default`：只影响**新**会话（见 1.1）；回滚即"下一个新会话别再用它"，一行。
- **改用户 preset 目录**：**不需重启** —— roster 每次读取都重扫目录（**实测** `dsh-agent-presets/lib/index.js:364` "Every directory whose name is a usable preset id is a roster row"；service 契约亦声明 discovery 不 memo，`list()`/`resolve()` 每次调用重读 roots）。
- **改 npm 依赖（插件包）**：**需重启** —— 组合里 `name:` 是 Node 模块，进程不热加载（**推断**）。
- 用带固定路由的会话：**新开一个**该 preset 的会话；已开会话切换 preset 后，**新派**的子代理才按新 preset 解析（见 1.1 实测）。

## 3. 路径 (b)：调用方点名；插件路线不建议

### 3.1 `subagent` 调用上显式点名

- 支持 `provider` / `model` / `reasoning_effort`，**仅当** `modelSelectionSettings: true`（`:374,388,412`）；受 `subagent-model-selection.allowedModels` 限制（`:91-98`，会话级快照，见 1.4）。
- **实测**：子会话 `d8d00aec-1629-4e35-b6b0-83ce51995db9` 用 `google-antigravity/gemini-3.8-flash @ high` 跑通（descriptor 与 `request/header` 一致；会话里 `RESULT=391` 出现 8 次）。
- **代价**：每次调用都要点名，漏了退回继承（见 1.2）。适合偶发换模型，不适合整个会话固定。

### 3.2 `subagent_fork` 不支持选择路由（设计如此）

- **实测**：shipped `standard` 的 `tool-subagent-fork` 行（`presets/standard/agent.cordis.yml:193-198`）只有 `provider: fork`、`toolName`、`backgroundMode`，**无 `modelSelectionSettings`、无 `agentOptions`** ⇒ fork schema 无 `provider`/`model`/`reasoning_effort`。
- 同处注释（`:188-190`）："Fork omits model selection so provider/model stay equal to the parent and the inherited history remains eligible for KV Cache reuse." —— fork 的 provider/model 必须等于父才能复用 KV cache。**是设计，不是缺陷。**

### 3.3 插件路线（原「做法 B」）：不建议

- 机制：监听 `agent/request`（waterfall，契约 "Replace the frozen call configuration"），对 `origin === 'subagent'` 的调用替换 `LlmCallConfig`。
- **代价与洞（全部实测）**：
  1. **记录层与调用层分裂**：descriptor / `agent.options` 仍写继承来的路由，实际跑改写后的（探针 `781077c5`）。排查**只能看 `request/header`**。
  2. **"点名 vs 继承"不可区分**（见 1.2），反推判据都有洞：
     - `agent.options` 完整即点名 ⇒ 普通委派被当点名，**继承漏回**；
     - 命中白名单即点名 ⇒ **角色路由恰等于父路由时，裸委派也命中**（**实测**：角色 `mechanical` = 父路由 `command-code/deepseek/deepseek-v4.1-flash`，裸委派跑了父路由）；
     - 与父路由不同即点名 ⇒ 必须解析父代理，父不可知时要在"漏继承"与"抹掉角色选择"间二选一。
  3. 结论：插件侧要做**按角色分派**，只能靠**显式信号**（如 `subagent_role` 工具在启动前登记角色、插件按父会话 id 绑定），**不能反推**。
- **适用场景**：只在**同一会话内需按调用选不同路由**（omp 风格 `modelRoles`）时才有价值；只为"固定一条路由/禁止继承"引入插件收益为负。**固定默认路由走 2，偶发换模型走 3.1。**

## 4. 验证与排障

### 4.1 一手验证：读子会话文件

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

裸派应打印**父会话路由**；跑带 `agentOptions` 的 preset 时应打印 `google-antigravity / gemini-3.8-flash @ high`。`subagent/descriptor` 的 `agentProvider`/`agentModel` 是同一路由的副本，可交叉核对。

### 4.2 排障：四类失败与一眼判据

判据是**报错里的路径前缀或服务名**：

| 失败 | 判据 | 处置 |
|---|---|---|
| 悬空默认 preset | 报错指向 `agent-presets.default` 里那个 id | 默认指向不存在的目录 ⇒ 新会话创建/恢复失败。改回存在的 id（default 只影响新会话，见 1.1） |
| 自建副本挂载失败 | `~/.dsh/.agent-presets/<id>/` | 自己的副本：`agentOptions` 字段写错、provider 不支持该能力（见 1.3）、YAML 缩进坏 |
| 升版后副本挂载失败 | 报错含 `Cannot find package '@deepseek-ai/…'`（roster 该行带 `broken`） | 副本里的 `name:` 被新版本改过。按 2.1 重跑 diff，把漂移行改回 shipped 现名 |
| 同进程第二个 `tool-cordis` | 报错含 `Host Cordis inspect provider "…" is already registered` | 进程里已有另一个含 `tool-cordis` 的 preset（通常是 shipped `cordis`）。`cordisInspect` 是 host 装载的进程全局服务，preset 侧不能 isolate。把副本 `tool-cordis` 置 `disabled: true`（见 2.1） |
| 部署 shipped preset 冲突 | `/usr/lib/node_modules/.../dsh-agent-presets/presets/<id>/` | 部署/版本层问题，非你所写。**单次实测**：`preset "cordis" failed to mount: prompt section "deployment:persona-prefix" is already registered`，发生在包刚换版本、旧进程仍在跑的半升级态；**重装成一致版本后消失** |

何时重启（见 2.3）：改**用户 preset 目录**不用重启（roster 重扫）；改**npm 依赖**要重启。

### 4.3 证据索引

| 事项 | 证据 |
|---|---|
| 子代理用父会话当前 preset | 父 `session-93594468-…` 头部 `standard`；子 `6502d243-…` 头部 `cordis` + `origin: subagent` |
| default 管不到已运行会话 | 当时 `agent-presets.default` 已是 `no-inherit-subagent`，`6502d243-…` 仍按父 cordis 路由跑 |
| 同现象重复 | `24655d15-05a6-47b4-afdf-a9ff412553e1`、`d5030032-7fea-4bee-8790-9e82ed412e9c` 头部均 `cordis` |
| 裸委派继承父路由 | `6502d243-…` descriptor 与 `request/header` = `deepseek-official/deepseek-flash@low`；另 `4ad0dc10` = `command-code/deepseek/deepseek-v4.1-flash` |
| 指定路由可用 | `aef90834`：`google-antigravity/gemini-3.8-flash@high`，用量库落 `stop`、无错、ttft 4873ms |
| 调用方点名跑通 | `d8d00aec-1629-4e35-b6b0-83ce51995db9`：descriptor/`request/header` = `google-antigravity/gemini-3.8-flash`，`RESULT=391` |
| allowlist 是会话快照 | 放开后旧会话仍报 `child LLM route … is not allowed for this Session`；`6502d243-…` 内有 `subagent/model-selection-policy` 快照 |
| 插件改写致记录/调用分裂 | `781077c5`（fork 子代理）descriptor 与 `request/header` 不同步 |
| 白名单判据的洞 | 角色 `mechanical` 与父路由重合 ⇒ 裸委派被放行 |
| schema 字段声明 | `dsh-tool-subagent/lib/index.js:258-263`（验证器不拒绝缺字段，见 1.3） |
| provider 能力声明 | `dsh-subagent-spawn-in-process/lib/index.js:24` → `agentOptions: true` |
| 挂载期断言 | `dsh-tool-subagent/lib/index.js:376-380`（报错 `:378`） |
| roster 每次读取重扫 | `dsh-agent-presets/lib/index.js:364` |
| 升版导致行名漂移 | 0.1.6：两副本报 `Cannot find package '@deepseek-ai/dsh-workflow-worker-thread'`；改回 `dsh-workflow-ptc` 后 `standingKeyFor` 双双 `OK`、roster `broken` 清空 |
| cordis 工具集进程单例 | cordis 会话存活时 `standingKeyFor('cordis-no-inherit')` = `failed to apply loader entry tool-cordis … already registered`；置 `disabled: true` 后同调用返回 `OK` |
| 全局注册表宿主归属 | `dsh-web-app/cordis.patch.yml:122-123` 装载 `dsh-cordis-host-runner`；`…/inspect-registry.js:11-14` `super(ctx, 'cordisInspect')` + "process-global Host registry"；`register()` 重名抛错 `:22-23` |

## 5. 本文不做什么

- 不把上述内容写进 `skills/**` 或运行时纪律文本 —— **本文只进 `docs/`**。
- **不建议插件路线**（原「做法 B」：插件改 `agent/request`）：记录/调用分裂、三种反推判据各有洞、只为固定路由收益为负（见 3.3）。
- 不改 shipped preset / 不改 host 组合来绕开限制（要改就复制到 `~/.dsh/.agent-presets/<id>/`）。
