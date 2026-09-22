# 官方 Agent Teams × dsh-collab：实测证据与结论（2026-09-22）

> 这份文件是**一次性取证记录**：原始命令 + 原始输出片段 → 结论 → 由此改了什么。
> 事实的家不在这里：定位事实在 `README.md`「与官方 Agent Teams 的分工（定位）」，
> 使用摩擦与结论在 `docs/collab-ux-backlog.md` §2.21。本文件只证明那两处说的是实测过的。

- DSH：`0.1.7-alpha.1`（`dsh --version`）
- 官方包：`@deepseek-ai/dsh-experimental-agent-team{,-profile}`、
  `dsh-experimental-tool-agent-team`（都在
  `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`）
- 本仓库：`dsh-collab@0.10.1`（本次改动即 0.11.0）

## 0. 取证环境（不动线上 profile）

`profiles/web` 里的启用由用户完成，本次取证**没有**动它。证据来自一个隔离 profile：

```jsonc
// ~/.dsh/profiles/teamlab/package.json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-headless",
  "@deepseek-ai/dsh-experimental-agent-team-profile",
  "dsh-collab"                      // → symlink 到本仓库
], "patchReload": "startup" } }
```

```console
$ cd /tmp/collab-evidence
$ DSH_PERMISSION_MODE=danger-full-access dsh --profile teamlab "…步骤化提示…"
DONE
```

两个环境事实（都不是本仓库的缺陷，但会让取证静默失真空转）：

1. **`dsh-headless` 的默认 sandbox 是 `workspace-write`**，而 collab 的状态文件在
   `~/.dsh/collab/projects/`（工作区之外）。插件走的是**无 session 的 agentless fs 调用**，
   它取部署默认模式（`dsh-sandbox-policy/lib/index.js:141-146` 的
   `request.mode ?? overrideOf(session) ?? defaultMode`，`defaultMode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`），
   于是即便会话自身是 `danger-full-access`，`collab_lock` 也会失败：
   ```json
   {"ok":false,"error":"internal","message":"cannot write \"/home/vesita/.dsh/collab/projects/collab-evidence-…json\": file access denied under workspace-write mode"}
   ```
   设 `DSH_PERMISSION_MODE=danger-full-access` 后正常。
2. **`profiles/web` 的启用是否对运行中的进程生效，要从进程而不是磁盘判断**：
   `package.json` mtime 17:28，而 `dsh web` 的 pid 406465 启动于 17:11 ⇒ bundle 列表的改动
   当时没有进到那个进程（`dsh --profile web --dump-config` 才代表"若现在启动会怎样"）。

## 1. teammate 是否拿到本插件的态势注入？——**拿到了**

命令同上（prompt 让 Lead `spawn_teammate` 一个 teammate）。teammate 会话出现在
`~/.dsh/sessions/--tmp-collab-evidence--/917be146-f676-458d-9ca3-f1cd5befc572/`
（无 `session-` 前缀 ⇒ `agents.create({sessionId})` 造的子会话），日志里有 `subagent/descriptor`。

```console
$ node /tmp/inspect_session.mjs …/917be146-…/session.v4.jsonl.zstd --sections
#11 [user/message] source.kind=runtime-context form=snapshot
  --- section: sandbox:policy ---
  --- section: approval:policy ---
  --- section: subagent:delegation ---
  --- section: dsh-collab/awareness ---
    多会话协作（dsh-collab）：同一项目可能有其他 DSH 会话并行工作。…
  --- section: dsh-collab/delegation ---
    [dsh-collab] 委托与验收（默认工作方式）：…
```

**结论**：teammate 与 Lead 同进程、同 cordis 根、继承 Lead 的 preset，
`systemPrompt.context` 的段对所有会话生效 ⇒ 插件对 teammate 完整生效。

## 2. 家族豁免在真实团队工作流里造成什么？——**自动态势与门控失效，`overview` 未失效**

Lead 持独占锁，teammate 写同一路径：

```console
# Lead
CALL collab_lock {"op":"claim","paths":["seam.txt"],"mode":"exclusive","note":"lead-holds-this"}
RESULT>>> {"ok":true,"data":{"claim":{"claimId":"c_1","holderId":"agent:session-9bca19cd-…",…}}}

# teammate c40f389e（无 session- 前缀）
AWARENESS>>> "多会话协作（dsh-collab）：…（只有 OPEN_HINT，没有列出 seam.txt）"
CALL collab_lock {"op":"overview"}
RESULT>>> {… "totalClaims": 1, "holders": [{"holderId":"agent:session-9bca19cd-…","claimCount":1,…
CALL read  {"file_path":"/tmp/collab-evidence/seam.txt"}   → 1: LEAD_CONTENT
CALL write {"file_path":"/tmp/collab-evidence/seam.txt","content":"TEAMMATE_WROTE"}
RESULT>>> <content>Updated file</content>

$ cat /tmp/collab-evidence/seam.txt
TEAMMATE_WROTE
```

**负向对照**（无血缘的独立会话，强制写同一路径）：

```console
CALL write {"file_path":"seam.txt","content":"CONTROL_WROTE_FORCED"}
RESULT isError=true >>> Error: the user rejected tool "write"
（并且收到）[dsh-collab] 你刚访问的路径处于其他会话的占用范围内：协作文档锁运行时取证测试（独占，可读）占用 seam.txt…
$ cat seam.txt   →   TEAMMATE_WROTE   （未被改写）
```

**结论**：`familyIds = 自己 + 祖先链 + 后代`（`src/store.ts:195-202`）让 Lead↔teammate 互相
"不是别人"：态势摘要过滤掉、写门控跳过，于是**覆盖写真的发生**。而门控本身是有效的（负向对照被拒）。
`op=overview` 没有家族过滤，所以**声明仍可见** —— 这一点更正了 README 原先"双方都看不见"的说法。
同层级的两个 teammate 互不为祖先/后代，因此彼此可见（本次未单独跑，按 `familyIds` 口径推断）。

## 3. `send_message` / `list_agents` 语义变化是否让"先唤醒、别重派"失效？——**没失效，但词表变了**

```console
CALL spawn_teammate {"name":"probe-w",…} → {"member":{"target":"probe-w","role":"teammate","status":"running",…}}
CALL wait_agent     {"timeout_ms":120000}
RESULT>>> {"timedOut":false,"noProgress":{"reason":"no-active-peer","message":"No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again."}}
CALL list_agents    {}
RESULT>>> [{"target":"lead","role":"lead","status":"running",…},{"target":"probe-w","role":"teammate","status":"inactive",…}]
CALL send_message   {"target":"probe-w","message":"再回复一个词：SECOND，然后停止。"}
RESULT>>> {"messageId":"team-message-2b477cb0-…","status":"accepted"}
CALL wait_agent     {"timeout_ms":120000} → {"timedOut":false}
```

teammate 会话的日志：`turn/start count = 3`（spawn 一轮 + 两次唤醒），并执行了第二条消息里的
文件指令（`outside/proof.txt`、`inside/proof.txt` 都 `Created file`）。

**结论**：唤醒路径**有效**（`send_message` 按 `target` 名字投递并真的唤醒 inactive teammate）；
失效的是**旧主体与旧词表**：legacy `tool-subagent*` 在部署层被禁用，`list_agents` 只列团队成员、
状态是 `running|inactive`（不是 `idle|ready`），且 `wait_agent` 明确不唤醒。
⇒ 启用 agent-team 时委托纪律追加 `TEAM_DISCIPLINE_ADDENDUM`；未启用时一字不变。

## 4. `write_scopes` 与实际改动对得上吗？——**对不上，纯 advisory，没人按它写**

```console
CALL team_task_create {"subject":"scope probe","description":"write_scopes 是否被强制","write_scopes":["inside/"]}
RESULT>>> {"id":"task-1","revision":1,"status":"pending","writeScopes":["inside"],"ready":true,"writeScopeWarnings":[]}
CALL team_task_update {"task_id":"task-1","expected_revision":1,"action":"claim"}
RESULT>>> {"id":"task-1","revision":2,"status":"in_progress","writeScopes":["inside"],"ownerName":"lead","writeScopeWarnings":[]}

# teammate（被 send_message 唤醒）
CALL write {"file_path":"outside/proof.txt","content":"OUTSIDE_WRITE"}  → Created file   ← 声明写域之外
CALL write {"file_path":"inside/proof.txt","content":"INSIDE_WRITE"}    → Created file
CALL team_task_list {}
RESULT>>> {"tasks":[{"id":"task-1",…,"status":"in_progress","writeScopes":["inside"],"writeScopeWarnings":[]}]}
```

**结论**：写域被归一化（`inside/` → `inside`）但**不参与任何门控**；越界写入成功、无警告，
`writeScopeWarnings` 只在**任务之间**写域重叠时才有内容。与官方自述一致
（`dsh-experimental-tool-agent-team/lib/index.js:23`、`dsh-experimental-agent-team/README.md:138`）。

## 5. 由此改了什么（0.11.0）

| 面 | 文件 | 改了什么 |
| --- | --- | --- |
| 纯逻辑 | `src/collab-core.ts` | `TeamScopeTask` / `TeamScopeOverlap` + `teamTaskScopeLine` / `teamScopeOverlaps` / `teamCrossWarnLine`（无时间参数、确定性排序） |
| 读服务 | `src/store.ts`、`src/contract.ts` | `teamTasks(agent)` 三态（`null` 服务缺席/读不到、`[]` 在场无在跑任务、非空）；`AgentTeamsServiceLike` 最小接口 |
| 态势摘要 | `src/awareness.ts` | order 130 追加团队写域行 + 反向交叉预警行；服务缺席时输出逐字节不变 |
| 工具输出 | `src/tools.ts`、`src/store.ts` | `op=claim` 追加 `teamOverlaps`；`op=overview` 追加 `teamTasks` + `teamTasksNote`（**只在服务在场时**，与 `otherProjects` 同一"输出侧附加"纪律） |
| 反向提示 | `src/gate.ts`、`src/push.ts`、`src/index.ts` | `tools/pre-execute` 上对 `team_task_create` / `team_task_update` 做只提示不阻断的重叠预警；投递走既有的 `agent.inject` + `dsh-collab/notice`，不新造通道、不冒充用户 |
| 委托纪律 | `src/spec.ts`、`src/delegation.ts` | `ctx.agentTeams` 在场时追加 `TEAM_DISCIPLINE_ADDENDUM`（面向 teammate 的词表），否则一字不变 |
| 动态形态 | `src/collab-plugin.host.ts` | 三个同名纯函数 + `teamTasks` + overview/claim 的等价改动（无 `tools/pre-execute` 接线 ⇒ 反向提示那一侧退化为文档，§2.15 的已知不对称） |
| 契约 | `src/schema/collab.schema.json` + `src/types/collab.d.ts` + `scripts/collab_models.py` + `crates/collab-cli/src/main.rs` | 两个新类型进 SSOT 并同步 4 份派生物 |
| 测试 | `tests/collab-inline-parity.mjs`（同名集合 22 → 25 + 逐输出语料）、`tests/collab-agent-teams.mjs`（新场景 + 负向对照）、`tests/collab-contract-derivation.mjs`（TYPES +2） | 正反两面都断言 |

**没有做**：不改 `blockers()` / `claimsCovering()` / gate 的判定语义，不动家族豁免，
不把团队任务写域当锁 —— 官方那侧是 advisory，本插件这一侧也只报不锁。

## 6. 顺带查实：插件页里 collab 的配置卡片"没有内容"（用户报，与 agent-team 无关）

用户报"启用 agent-team 后 collab 的设置页配置可能看不见了"。用官方检视工具读**活体树**：

```console
cordis_inspect_query(host/Config, listConfigs, {name:"dsh-collab"})
→ {"id":"include:collab","patchId":"collab","name":"dsh-collab","status":"absent",
   "packageDir":"/home/vesita/.dsh/profiles/web/node_modules/dsh-collab"}

cordis_inspect_query(host/Config, listConfigs, {name:"dsh-antigravity"})   # 对照
→ {"id":"include:antigravity",…,"status":"schema","schema":{…}}

cordis_inspect_query(client/Slots, listSubTree, {root:"plugins.bundle.config"})
→ occupants: [{ "registrant":"Sd", "key":"dsh-collab", "priority":0, "active":true }]
```

- **不是 agent-team 引起的**：`profiles/web/cordis.patch.yml` 里 `collab` 那一行的 `config:` 一直在
  （磁盘组合结果 `dsh --profile web --dump-config` 也在），卡片注册面也一直在（`active: true`）。
- **根因**：`status:'absent'` 的定义是 `fiber.runtime.Config === undefined`
  （`dsh-tool-cordis/lib/types/config.js:12-14`），而 `fiber.runtime` 是插件的**默认导出对象**
  （`cordis/lib/index.js:1347` `resolveConfig(this.runtime, config)`）。0.10.0 把偏好迁到 profile
  Config 时 `Config` 只留了具名导出：
  ```console
  $ node -e 'import("./lib/index.js").then(m=>console.log(Object.keys(m.default)))'   # 修前
  [ 'name', 'inject', 'apply' ]
  ```
  对照 `dsh-antigravity` 的默认导出是 `{ name, inject, apply, Config }` ⇒ 它才报 `schema`。
- **修**：`src/index.ts` 默认导出补 `Config`；`tests/collab-client-config-page.mjs` 新增 ⑦ 段
  （默认导出带 Config、与具名导出同引用、本部署那四个值可校验通过）。修后：
  ```console
  $ node -e 'import("./lib/index.js").then(m=>console.log(Object.keys(m.default)))'
  [ 'name', 'inject', 'apply', 'Config' ]
  $ node tests/collab-client-config-page.mjs
  ALL PASS: 32 passed, 0 failed
  ```
- **生效条件 / 未验证**：这是代码修复，运行中的进程仍加载旧的 0.10.1 模块 —— 需要重新打包安装进
  `profiles/web` 并重载插件，刷新页面后才能确认那张卡片真的渲染出四个字段（本次只验证到 Host 侧
  `default.Config` 存在、schema 接受本部署的值）。结论与未验证项记在 backlog §2.22。
  另外 `npm run test:real` 同期被修好（它自 0.9.0 起就没跟上 0.1.7：前置依赖
  `@deepseek-ai/dsh-settings-file` 已被 `dsh-settings` 取代，于是它一直硬失败）。现在它在真实部署上
  跑 17 条断言全绿，并顺带在**真实 cordis** 上验证了"普通值 → Config schema → volatile 引用"这条
  插件页配置卡片的前置链路。
