# DSH 子代理路由：默认继承 vs 固定配置（实测记录）

> 本文是**文档**，不是提示词：它不进 `skills/`、不进 `src/spec.ts` 的运行时纪律文本，也不参与任何 prompt 注入。
> 记录的是"子代理跑哪条路由"这件事在 DSH 里的机制、可用做法、验证与排障方法，以及我们实测踩到的洞。
> 文中每条事实都带证据标注：**实测** = 本机跑出来/读文件读出来的；**推断** = 由源码或单次观察推出、未单独复现。

## 1. 机制事实（读码 + 实测）

### 1.1 生效范围（最重要）：子代理用的是「父会话当前所用的 preset」

这条是今晚实测补上的关键一条，也是"照旧文档做却不生效"的根因。

- 子会话的 preset = **父会话当前所用的 preset**，不是 `agent-presets.default`，也不是父会话文件头里那个创建时字段。
- **实测**：父会话 `session-93594468-aa20-461d-8f76-295a60d873ef`（cwd `/home/vesita/coding/my`）文件头第一条
  `type:"session"` 记录写的是 `agentPreset: "standard"`（那是**创建时**的快照）；而它裸派的子会话
  `6502d243-ae82-479b-b3e4-07c024e651ef` 头部是 `agentPreset: "cordis"`、`origin: "subagent"`、
  `parentSession: session-93594468-…`，实际路由 `deepseek-official/deepseek-flash`
  （`subagent/descriptor` 与 `request/header` 一致）。即：父会话界面里已切到「创造模式」（cordis），
  派出的子代理就跟 cordis，尽管 `agent-presets.default` 当时已是 `no-inherit-subagent`。
- **实测（同现象重复）**：`24655d15-05a6-47b4-afdf-a9ff412553e1`、`d5030032-7fea-4bee-8790-9e82ed412e9c`
  的头部同样是 `agentPreset: "cordis"`，父会话同为 `session-93594468-…`。
- **推断**：`agent-presets.default` **只影响新会话**；它管不到已经在跑的会话（与该键自身的语义一致，
  见 `~/.dsh/settings.yaml` 里 `agent-presets` 段的注释）。
- **结论**：要让某个会话派出的子代理跑固定路由，必须让**那个会话本身**跑带 `agentOptions` 的 preset
  （见第 2 节）；否则只能在每次 `subagent` 调用上显式点名（见第 3.1 节）。

### 1.2 子代理默认继承父会话路由

- **子代理默认继承父会话路由**：`@deepseek-ai/dsh-subagent` 的
  `resolveChildAgentOptions(parent, requested, childDepth)`（`lib/index.js:468-484`）是
  **以父路由为底、再用 `requested` 覆盖**；普通委派（谁都没点名）时 `requested` 为空，
  子代理拿到的就是**父会话的路由**。父路由口径见 `parentAgentOptionsForDelegation`
  （`lib/index.js:446-456`）：`parent.session.requestHeader()?.config`，退回 `parent.options`。
- ⇒ **子代理的 `agent.options` 永远是一条完整路由**。因此**在调用层无法区分"调用方点名"与"继承"**
  —— 两者产生同一个 `agent.options`。任何试图从它反推意图的判据都必须额外引入别的信息。
- 子会话头部记录的 preset 来自父会话**实时作用链**，不是父会话头部里那个字段（见 1.1 实测）。

### 1.3 工具侧 schema 与能力前置校验（写错会「挂载即炸」）

`@deepseek-ai/dsh-tool-subagent`（`lib/index.js`）：

- **schema 声明**（**实测**，`dsh-tool-subagent/lib/index.js:258-263`）：

  ```js
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().min(1),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
  }).default(void 0)
  ```

  四个键在声明上并列；写 preset 时按 `provider` + `model` + `reasoningEffort`（可选 `maxTokens`）给全。
  **实测一条反直觉事实**：本机 rc.2 的验证器（`z` 来自 `@deepseek-ai/schemastery`，见该文件 `:1`）
  **不拒绝**缺字段的对象 —— 用 `node --input-type=module` 直接喂这份 schema，`{}`、`{provider}` 都能通过。
  所以别指望 schema 帮你挡错；真正的兜底是下面的前置校验与路由前置检查。
- **provider 必须声明能力**（**实测**，`dsh-subagent-spawn-in-process/lib/index.js:24`）：
  spawn provider 的 `capabilities` 里有 `agentOptions: true`。内置 `spawn` 满足；
  换别的 provider 前必须先查这一行。
- **前置校验在挂载时执行**（**实测** `dsh-tool-subagent/lib/index.js:376-380`，报错在 `:378`）：

  ```js
  if (config.agentOptions !== void 0 && !subagentProvider.capabilities.agentOptions)
    throw new Error(`tool-subagent: provider "${name}" does not support child agentOptions`);
  ```

  **推断**：该断言在 provider 注册 / 组合挂载期抛出 ⇒ **整个 preset 挂载失败** ⇒ 依赖它的
  新建/恢复会话一起失败。**改 preset 前先查能力**：

  ```bash
  # provider 是否声明 agentOptions 能力（spawn 应有）
  grep -n "agentOptions: true" \
    /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subagent-spawn-in-process/lib/index.js
  # agentOptions 的字段声明
  sed -n '258,263p' \
    /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js
  ```

- 工具侧其余机制：
  - `config.agentOptions` 存在 ⇒ `hasConfiguredLlmSelection` 为真 ⇒ `requiresRoutePreflight`
    为真 ⇒ 派生**前置校验**该路由（路由不存在就响亮失败）。
  - `requestedAgentOptions`（`:62-81`）：**调用方显式请求优先于 `config.agentOptions`**。
  - `provider` / `model` 参数**只在 `modelSelectionSettings: true` 时才出现在工具 schema 里**
    （`:374` 算 `modelSelectionCapable`、`:388` 算 `modelSelectionEnabled`、`:412` 才展开这三个参数）。
    关掉它，模型就没有点名的能力，`config.agentOptions` 即唯一权威。

### 1.4 modelSelectionSettings 与 allowlist

- `subagent-model-selection` 的 allowlist：`assertAllowedModelSelection`（`:91-98`）在
  **没有显式点名时直接 return** —— 它只过滤"点名"，**既不选模型、也不阻止继承**。
  并且它是**会话组装时的快照**（`recordSubagentModelSelection`）：改 `settings.yaml`
  对**已有会话无效**（**实测**：放开名单后，旧会话仍报
  `child LLM route … is not allowed for this Session`）。
- **实测**：子会话 `6502d243-…` 里落了一条 `subagent/model-selection-policy` =
  `{"allowedModels":[{"provider":"google-antigravity","model":"gemini-3.8-flash"}]}` —— 名单本身就是
  会话级快照，直接可从子会话文件读到。

## 2. 路径 (a)（推荐）：原生 preset 固定默认路由

复制 shipped preset 到用户预设根，只给 `tool-subagent` 那一行加 `agentOptions`：

```yaml
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
    modelSelectionSettings: true      # 保留：显式点名仍可覆盖默认（并受 allowedModels 限制）
    backgroundMode: continuable       # 保留：否则退化成 one-shot，拿不到可续子代理
    agentOptions:                     # ← 新增：子代理**默认**跑这条，而不是继承父会话
      provider: google-antigravity
      model: gemini-3.8-flash
      reasoningEffort: high
```

shipped `standard` 里这一行的原始位置是 `presets/standard/agent.cordis.yml:181-186`
（`tool-subagent` 行；本副本在 `:187` 之后插入上面 10 行）。

- **优点**：**记录层 = 调用层** —— 路由在**派生那一刻**就冻进子代理的 `agentOptions`，
  不依赖任何插件在每个请求上改写，因此不会有"日志写 A、实际跑 B"的分裂。
- **边界**：只覆盖**使用该 preset 的会话**。已经在跑 `standard` / `cordis`（shipped，禁止改）的会话
  不会被改变；要给它们也钉住，得为每个用到的 preset 各复制一份加同一行。

### 2.1 两份现成副本（本机已就绪，照抄即可）

| 用户 preset 目录 | 显示名 | 与 shipped 的差别 |
|---|---|---|
| `~/.dsh/.agent-presets/no-inherit-subagent/` | 标准模式（子代理不继承） | = shipped `standard` + `agentOptions`（含注释） |
| `~/.dsh/.agent-presets/cordis-no-inherit/` | 创造模式（子代理不继承） | = shipped `cordis` + `agentOptions`（含注释），**且 `tool-cordis` 行置 `disabled: true`**（见下） |

- 两者都把裸派子代理钉到 `google-antigravity/gemini-3.8-flash` / `reasoningEffort: high`；
  调用方显式点名 `provider`/`model` 仍可覆盖（`modelSelectionSettings: true` 保留）。
- **`cordis` 副本必须让出 cordis 工具集**：`tool-cordis` 把检视 provider 注册进**进程全局**的
  `cordisInspect` 服务（该服务由 `dsh-web-app` 这一 **host 组合**装载 —— `dsh-web-app/cordis.patch.yml:122-123`；
  服务自身注释原文 "Register the process-global Host registry"，实现见
  `dsh-cordis-host-runner/lib/types/inspect-registry.js:11-14`），同一进程里**只能存在一份实例**。
  shipped `cordis` 已经占住它；第二个含 `tool-cordis` 的 preset 会在挂载期抛
  `failed to apply loader entry tool-cordis … Host Cordis inspect provider "Service" is already registered`
  （**实测**，见 4.3）。**preset 侧无法用 `isolate` realm 修**：`cordisInspect` 是 host 提供的服务，
  不是 preset 自有的，两个实例仍会注册进同一个全局注册表。
  因此副本把 `tool-cordis` 置 `disabled: true`：**要创作 preset 就用 shipped 创造模式**，
  本副本只负责"创造模式的能力面 + 钉死的子代理路由"，从而**任何进程状态下都能挂载**。
- 要让**新**会话默认用其中一份，把 `~/.dsh/settings.yaml` 的 `agent-presets.default` 设为对应 id
  （本仓库不替你改；能改的只有 `~/.dsh/settings.yaml`，按 1.1 它只影响**新**会话）。
- 差别可用 `diff` 一眼核对（**实测**，本机）：

  ```bash
  SHIP=/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets
  diff "$SHIP/standard/agent.cordis.yml" ~/.dsh/.agent-presets/no-inherit-subagent/agent.cordis.yml
  diff "$SHIP/cordis/agent.cordis.yml"   ~/.dsh/.agent-presets/cordis-no-inherit/agent.cordis.yml
  ```

### 2.2 自己造一份（可复制粘贴）

shipped preset 的真实路径：

```
/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets/<standard|cordis>/
```

步骤：

```bash
SHIP=/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-presets/presets
ID=my-fixed-route                       # 目录名即 preset id（必须匹配 PRESET_ID 规则才成为 roster 行）
mkdir -p ~/.dsh/.agent-presets/$ID
cp "$SHIP/standard/agent.cordis.yml" ~/.dsh/.agent-presets/$ID/agent.cordis.yml
cp "$SHIP/standard/preset.yml"       ~/.dsh/.agent-presets/$ID/preset.yml
# 然后编辑 preset.yml 的 name/description，并在 agent.cordis.yml 的 tool-subagent 行 config 里加第 2 节那段
```

> **从 `cordis` 复制时另加一步**：把 `tool-cordis` 行置 `disabled: true`（或整行删掉）—— 理由见 2.1，
> 否则副本在已有 cordis 系 preset 的进程里**挂载失败**。`no-inherit-subagent`（源自 `standard`）无此步。

`preset.yml` 最小形状（**实测**，`dsh-agent-presets/lib/index.js:67-72,85-91`：解析 `name` /
`description` / `order`，缺哪个省哪个）：

```yaml
name: 我的固定路由模式          # 必给（否则 picker 里没名字）
description: >-                # 建议给
  标准模式 + 子代理默认跑固定路由。
# order: 50                    # 可省；缺省按 Infinity 排到最后（:417）
```

### 2.3 生效条件与边界（修订：旧版把"生效范围"说过头了）

- **改 `~/.dsh/settings.yaml` 的 `agent-presets.default`**：只影响**新会话**；对**已经在跑**的会话无效
  （1.1 实测）。回滚 default 只是"让下一个新会话别再用它"，一行即可。
- **改用户 preset 目录里的文件**：**不需要重启**。roster 每次读取都重扫目录
  （**实测**源码：`dsh-agent-presets/lib/index.js:382` "Every directory whose name is a usable
  preset id is a roster row"；`:242` 注释 "runs on every roster read"）。
- **npm 依赖（插件包）变更**：**需要重启** —— 组合里 `name:` 指向的包是 Node 模块，进程不会热加载。
  （**推断**：由 Node 模块加载语义 + shipped preset 里"Install the matching Bundle in this Profile
  and restart the Host"的既有说明得出。）
- **要用带固定路由的会话**：**新开一个**使用该 preset 的会话；已开的会话切回/切到别的 preset
  按界面能力操作，切完**新派**的子代理才按新 preset 解析（1.1 实测：父会话切到 cordis 后，
  子会话头跟着变成 cordis）。

## 3. 路径 (b)：调用方点名；以及本文不建议的插件路线

### 3.1 路径 (b)：`subagent` 调用上显式点名

- `subagent` 工具支持显式 `provider` / `model` / `reasoning_effort`，**仅当**
  `modelSelectionSettings: true`（`dsh-tool-subagent/lib/index.js:374,388,412`）；受
  `subagent-model-selection.allowedModels` 限制（`:91-98`，会话级快照，见 1.4）。
- **实测证据**：`d8d00aec-1629-4e35-b6b0-83ce51995db9` 用
  `google-antigravity/gemini-3.8-flash` 跑通 —— 该子会话 `subagent/descriptor` 为
  `agentProvider: google-antigravity, agentModel: gemini-3.8-flash`，`request/header.config` 同，
  `reasoningEffort: high`；会话里 `RESULT=391` 出现 8 次、`gemini-3.8-flash` 出现 18 次。
- **代价**：每次调用都要点名，漏了就退回继承（1.2）。适合"偶发换一次模型"，不适合"整个会话一律固定"。

### 3.2 `subagent_fork` 不支持选择路由（按设计如此）

- **实测**：shipped `standard` 的 `tool-subagent-fork` 行（`presets/standard/agent.cordis.yml:193-198`）
  只有 `provider: fork`、`toolName: subagent_fork`、`backgroundMode: continuable`，
  **没有 `modelSelectionSettings`、也没有 `agentOptions`** ⇒ fork 工具 schema 里没有
  `provider`/`model`/`reasoning_effort` 三个参数。
- 同一处的注释（`:188-190`）写明原因："Fork omits model selection so provider/model stay equal to
  the parent and the inherited history remains eligible for KV Cache reuse." —— 即 fork 的
  provider/model 必须等于父，才能复用继承历史的 KV cache。**这是设计，不是缺陷。**

### 3.3 插件路线（原「做法 B」）：不建议

- 机制：监听 `agent/request`，对 `agent.session.header.origin === 'subagent'` 的调用替换
  `LlmCallConfig`（`agent/request` 是 waterfall，契约即 "Replace the frozen call configuration"）。
- **代价与洞（全部实测过）**：
  1. **记录层与调用层分裂**：子会话 descriptor / `agent.options` 里写的仍是继承来的路由，
     实际调用却是改写后的路由（探针 `781077c5`：记录与 `request/header` 不同步）。
     排查时**只能看 `request/header`**，看 descriptor 会判错。
  2. **"点名 vs 继承"不可区分**（见 1.2），于是每种反推判据都有洞：
     - "`agent.options` 完整即点名" ⇒ 普通委派被当成点名，**继承漏回**；
     - "命中用户配置的路由白名单即点名" ⇒ **若某个角色的路由恰好等于父路由，裸委派也会命中白名单**
       而被放行（**实测**：角色 `mechanical` = 父路由 `command-code/deepseek/deepseek-v4.1-flash` 时，
       裸委派直接跑了父路由，而不是配置的默认角色）；
     - "与父路由不同即点名" ⇒ 必须解析父代理（`ctx.agents.get(parentSession)`），
       父代理不可知时又要在"漏继承"与"抹掉角色选择"之间二选一。
  3. 结论：插件侧若真要做**按角色分派**，只能靠**显式信号**（例如 `subagent_role` 工具在启动前
     把角色登记给插件、插件按**父会话 id** 绑定到子会话），**不能靠反推**。
- **适用场景**：只有在**同一条会话内需要按调用选择不同路由**（omp 风格 `modelRoles`）时才有价值；
  只为"固定一条路由/禁止继承"而引入插件，收益为负（多一处改写面、多一种记录不一致）。
  **固定默认路由请走第 2 节的 preset 路线，或第 3.1 节的点名。**

## 4. 验证、排障与实测证据索引

### 4.1 一手验证：读子会话文件

子会话 id = `subagent` 工具返回的 id。文件是 zstd 压缩的 jsonl：
`/home/vesita/.dsh/sessions/<项目目录>/<子会话 id>/session.v3.jsonl.zstd`
（项目目录名由 cwd 派生；本机实测 cwd `/home/vesita/coding/my` → `--home-vesita-coding-my--`，
也可直接 `ls ~/.dsh/sessions/` 找同名目录）。

看两处即可判定：

1. 第一条 `type:"session"` 记录的 `agentPreset`（这个子会话实际挂的 preset）；
2. 所有 `type:"request/header"` 记录的 `data.header.config.provider` / `.model`（实际跑的路由）。

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

裸派子代理应打印出**父会话的路由**（若父会话没跑带 `agentOptions` 的 preset）；
跑带 `agentOptions` 的 preset 时应打印 `google-antigravity / gemini-3.8-flash @ high`。
`subagent/descriptor` 记录里的 `agentProvider`/`agentModel` 是同一路由的副本，可交叉核对。

### 4.2 排障：四类失败与一眼判据

判据是**报错里的路径前缀或服务名**，一眼可分：

| 失败 | 路径前缀 | 含义与处置 |
|---|---|---|
| **悬空默认 preset** | 报错指向 `agent-presets.default` 里那个 id | 默认指向了一个已不存在的目录 ⇒ 新会话创建/恢复失败。改回存在的 id（**实测**语义：default 只影响新会话，见 1.1） |
| **自建副本挂载失败** | `~/.dsh/.agent-presets/<id>/` | 是**你自己的副本**：`agentOptions` 字段写错、provider 不支持该能力（1.3 的 `does not support child agentOptions`）、YAML 缩进坏等 |
| **同进程第二个 `tool-cordis`** | 报错含 `Host Cordis inspect provider "…" is already registered` | 该副本含 `tool-cordis`，而进程里已有另一个含它的 preset（通常是 shipped `cordis`）。`cordisInspect` 是 **host 组合装载的进程全局**服务，preset 侧不能 isolate（见 2.1、4.3）。把副本的 `tool-cordis` 置 `disabled: true` |
| **部署 shipped preset 冲突** | `/usr/lib/node_modules/.../dsh-agent-presets/presets/<id>/` | 部署/版本层问题，不是你写的。**实测一次**（原文：`preset "cordis" failed to mount: prompt section "deployment:persona-prefix" is already registered`；本次核查未在日志里找到留存副本，标注为**单次实测**）：发生在全局包刚换版本、旧进程/profile 仍在跑的半升级状态；**重装成一套一致版本后消失** |

**何时需要重启**（见 2.3）：新建/编辑**用户 preset 目录不需要重启**（roster 每次读取都重扫目录）；
**npm 依赖（插件包）变更需要重启**。

### 4.3 证据索引

| 事项 | 证据（会话 id / 位置） |
|---|---|
| **子代理用父会话当前 preset** | 父 `session-93594468-…` 头部 `agentPreset: "standard"`，其子会话 `6502d243-…` 头部 `agentPreset: "cordis"`、`origin: "subagent"` |
| **default 管不到已运行会话** | 当时 `settings.yaml` 的 `agent-presets.default` 已是 `no-inherit-subagent`，`6502d243-…` 仍按父会话 cordis 路由跑 |
| **同现象重复** | `24655d15-05a6-47b4-afdf-a9ff412553e1`、`d5030032-7fea-4bee-8790-9e82ed412e9c` 头部均 `agentPreset: "cordis"` |
| 裸委派继承父路由 | `6502d243-…`：`subagent/descriptor` 与 `request/header.config` = `deepseek-official/deepseek-flash@low`；另 `4ad0dc10`：`request/header` = `command-code/deepseek/deepseek-v4.1-flash` |
| 指定路由确实可用 | `aef90834`：`google-antigravity/gemini-3.8-flash@high`，用量库落库 `stop`、无错误、ttft 4873ms |
| **调用方点名跑通** | `d8d00aec-1629-4e35-b6b0-83ce51995db9`：descriptor/`request/header` = `google-antigravity/gemini-3.8-flash`，`RESULT=391` |
| allowlist 是会话快照 | 放开 `allowedModels` 后旧会话仍被拒：`child LLM route … is not allowed for this Session`；另 `6502d243-…` 内可见 `subagent/model-selection-policy` 快照记录 |
| 插件改写造成记录/调用分裂 | `781077c5`（fork 子代理）descriptor 与 `request/header` 不同步 |
| 白名单判据的洞 | 角色 `mechanical` 与父路由重合 ⇒ 裸委派被放行，跑成父路由 |
| schema 字段声明 | `dsh-tool-subagent/lib/index.js:258-263`（本机验证器不拒绝缺字段，见 1.3） |
| provider 能力声明 | `dsh-subagent-spawn-in-process/lib/index.js:24` → `agentOptions: true` |
| 挂载期断言 | `dsh-tool-subagent/lib/index.js:376-380`（报错在 `:378`） |
| roster 每次读取重扫 | `dsh-agent-presets/lib/index.js:382`、`:242` |
| **cordis 工具集进程单例** | 本机 cordis 会话存活时 `standingKeyFor('cordis-no-inherit')` 返回 `failed to apply loader entry tool-cordis … Host Cordis inspect provider "Service" is already registered`；同一副本把 `tool-cordis` 置 `disabled: true` 后，同一次调用返回 `OK`（副本：`~/.dsh/.agent-presets/cordis-no-inherit/agent.cordis.yml`） |
| **全局注册表的宿主归属** | `dsh-web-app/cordis.patch.yml:122-123` 装载 `@deepseek-ai/dsh-cordis-host-runner`；`dsh-cordis-host-runner/lib/types/inspect-registry.js:11-14` 以 `super(ctx, 'cordisInspect')` 注册，注释 "Register the process-global Host registry"；`register()` 在重名时抛错（`:22-23`） |

## 5. 本文不做什么

- 不把上面任何内容写进 `skills/**` 或运行时纪律文本 —— **本文只进 `docs/`**，
  **不进** `skills/**`、**不进** `src/spec.ts` 的常驻纪律文本（那些是提示词，会每次注入）。
- **不建议走插件路线（原「做法 B」：插件改 `agent/request`）**，理由沿用第 3.3 节：
  记录层与调用层分裂、三种"点名 vs 继承"判据各有洞、只为固定路由引入插件收益为负。
- 不改 shipped preset / 不改 host 组合来绕开限制（要改就复制到 `~/.dsh/.agent-presets/<id>/`）。
