# dsh-collab 使用不便清单（优化方向）

> **这是什么**：一份「用起来别扭」的清单，不是 bug 列表。每条都写了**代码依据**或**实测出处**，
> 都能独立复核。目的不是现在就修，而是**别让这些摩擦被忘掉**。
>
> **怎么用**：挑选时优先看 §1（按修复性价比排序）。§4 是实测使用统计，§5 是刻意保留的设计取舍
> （不是缺陷，但使用者应当知道）。§6 明确区分「实测」与「未验证」，不要把后者当结论。
>
> **旧文件名的读法（0.14.0）**：下面各条里出现的 `src/collab-plugin.host.ts` 是**当时**的动态形态源码，
> 它已被删除：现在那份纯逻辑由 `scripts/build-host.mjs` 构建期把 `lib/collab-core.js` 原样内联进
> `src/host-shell.js`，生成 `lib/collab-plugin.host.js`。行号是**写下当时的**，只作历史锚点。

证据口径：`文件:行` 对应本次清理后的 `0.9.0` 树（`src/index.ts` 的单体在 0.9.0 被拆成 11 个模块，
行号已随之重映射）。标「实测」的表示有代码路径或运行时输出为凭；标「一手」的是主 AI 在真实协作
会话里亲自撞上的；标「记录取证」的来自 §4 的会话记录统计。

---

## 1. Top 5（按修复性价比）

| # | 摩擦 | 为什么排这儿 |
|---|---|---|
| 1 | **它进不了决策路径**：25 个会话被明确推荐 `op=wait`，实测调用 **0 次**；`heartbeat`/`status` 同样 0 次；一个会话自述「用了 6 个子代理，协作工具调用 0 次」，子代理甚至**自己发明了排他协议**（静默 40s 探测 + md5 冻结）（§4.3、§2.1） | 工具存在但不被想到 = 等于不存在。这是**发现性失败**，比任何单点功能缺陷都致命 |
| 2 | **名单认不出人**：常驻注入里唯一携带的身份信息是 `holderName`，实测渲染出的 17 个名字里 **11 个是提示词碎片**（§2.3、§4.1） | 不改锁语义，只改渲染与返回值，却同时解决「认不出人」和「不知道找谁协商」 |
| 3 | **子代理是独立 holder**：父会话一独占，自己派出去改该目录的子代理就被自己的锁硬拒绝，而子代理无权重放（§2.1、§2.2、§4.3） | 会让核心工作流（派子代理写代码）**直接卡死**；修复面集中在 holderId 构造一处 — **0.9.11 已修**（会话家族，见 §2.1） |
| 4 | **建议性边界没被显式化**：`bash` 完全绕过门控；写门控在全部真实使用中**一次都没触发过**（只在自造 fixture 里出现过）（§2.4、§2.5、§4.2） | 「以为被保护其实没有」是沉默的错误，会误导决策；一句运行时提示即可消除 |
| 5 | **语义不一致制造误判**：`release` 匹配不到也回 `ok:true`、`collab_board` 漏 `op` 的报错看不懂、worktree 与申报路径错位（§2.10、§2.17、§2.18） | 这类不是「难用」而是「用错」，最伤对工具的信任 |

---

## 2. 逐条摩擦

### 2.1 子代理与父会话是不同 holder ⇒「我占了自己却写不了」【一手 + 实测】

- **依据**：`src/store.ts:247` 把 holderId 构造成 `agent:<exec.agent.id>`；冲突扫描只跳过
  `c.holderId === h.holderId`（`src/collab-core.ts:497`），写门控同理（`src/gate.ts:52`）。
  子代理运行在**自己的会话**里，`exec.agent.id` 与父会话不同。
- **场景**：主 AI `claim src/backend/`（exclusive），然后派子代理去改 `src/backend/` 下的文件。
- **后果**：子代理的 `write`/`edit` 被判定为「他人独占」而**硬拒绝**（本部署审批关闭，`ask` 即 `deny`）；
  子代理既不知道这是「自己家」的锁，**也没有权限释放它**（`src/collab-core.ts:539` 只允许持有者本人释放），
  只能回到父会话求助。
- **一手**：本次技术债清理中，主 AI 为了不让自己的 5 个子代理被挡住，**刻意把 `dsh-collab/`
  声明成 `shared` 而不是 `exclusive`** —— 等于放弃了唯一真正需要保护的独占保护。
- **优化方向**：把声明绑定到「会话家族」（父会话 + 其子代理共享 holder 身份），或让 `claim`
  支持显式的 `forSubagents` 语义。
- **0.9.10 部分缓解（不是修好）**：循环终止自动释放（§见 README 0.9.10）会在父会话 `idle`
  超过 15 秒后放掉它的锁，于是"父独占、子代理写不了"不再需要人工干预 —— 但要等一个宽限期，
  且持有者身份仍然各自独立（`holderId` 没有家族概念）。
- **0.9.11 已修**：按上面「优化方向」的第一条落地 —— 新增会话家族（血缘）判据
  `collab-core.inFamily`（血缘现算自 `session.header.parentSession`，**不落盘**、不进契约），
  取代了散在 6 处的裸 `c.holderId === h.holderId`（`claim` / `blockers` / `gate` /
  `awareness` / `access` / 动态形态内联副本）。父子的独占声明互不构成冲突，子代理不再需要
  父会话放锁。与此**配对**的两项改动：自动释放补第四道闸门（有自家子代理在 running 就不放）、
  宽限期默认值 15s → 120s（次序不可颠倒，理由见 README「循环终止自动释放」）。
  见 README「会话家族（血缘）」。

### 2.2 反向：自家子代理在父会话的态势里像个陌生会话【实测】

- **依据**：摘要过滤 `c.holderId !== mine`（`src/awareness.ts:53`），渲染只用 `holderName`（`src/collab-core.ts:308`）。
- **场景**：父会话派出的子代理自己 claim 了一块路径。
- **后果**：父会话的常驻摘要把它报成「同项目其他会话占用」，父 AI 会去 `wait`／`board` 协商一个
  **根本不存在的外部竞争者**。
- **优化方向**：摘要/名单标注 lineage（「你的子代理」），或按家族聚合。

### 2.3 名单认不出人【一手 + 实测】

- **依据**：`cleanName` 只保留 24 字（`src/collab-core.ts:190-196`），回退到 holderId（`src/store.ts:252`）；
  摘要、访问通知、`gateReason` 三处都**只渲染 `holderName`**（`src/collab-core.ts:308,441`；`src/gate.ts:23-28`）。
  `sessionIdOf()` 有解析能力，但只用于推送（`src/spec.ts:129`）。
- **场景**：会话标题是提示词首段（子代理都是这样），或形如默认名时，去看 `list`/`overview` 决定找谁协商。
- **一手**：本次会话的运行时提示字面渲染成
  `…其他会话当前占用：你是一个子代理，在**隔离的 g（独占）占用 tests/ .github/…`
  —— 那个"名字"是子代理提示词的开头被截断的残段，**无法用于辨认是谁**。
- **机制（已实测）**：`holderName` 来自**会话标题**，标题由 `@deepseek-ai/dsh-session-title-first-prompt-llm`
  从**首条人类消息**生成（DSH 配置：`targetCjkCharacters: 10` / `fallbackMaxBytes: 40` / `maxTitleBytes: 80`），
  再经 `cleanName` 截到 24 字。所以**名字 = 父 AI 写的那条 prompt 的开头**。
- **已经可以缓解（零代码，实测有效）**：父 AI 把委派 prompt 的**第一行写成短标签**即可。
  对照实验（同一个路径，只改 prompt 首行）：
  ```
  改前：你是一个子代理，在**主检出**（独占）占用 src/store.ts …
  改后：【身份探针A7】 上面那一行（`（只读）占用 dsh-collab/ …
  ```
  `claim` / `overview` / `release` **三条路径返回的 `holderName` 完全一致**，均为 `【身份探针A7】 …`。
  已写进 skill（§3.4）：标签 ≤ 约 40 字节（CJK ≈ 13 字），带括号以便看出截断边界。
  **注意**：这条依赖"标题取自首个 prompt"这个 DSH 实现细节，本次 2 个样本走的都是**机械字节前缀兜底**
  （与 `fallbackMaxBytes: 40` 吻合，n=2，属推断）——LLM 标题若成功则是"对同一段做摘要"，
  两种分支下结论一致，但都不该被当作稳定契约。
- **优化方向**：不要依赖标题。①**已实现（0.12.2）**：渲染时在名字后附**稳定短句柄** ——
  `holderLabel()` = `名字#句柄`，句柄是 `holderId` 去掉 `agent:` 与 `session-` 前缀后的前 8 字符；
  凡是把 holder 名字渲染给人/模型的地方都换成它：占用摘要（`renderDigest`）、访问通知
  （`renderAccessNotice`）、`gateReason`、同一段注入里的交叉预警行（`teamCrossWarnLine`，
  它是 `systemPrompt.context` 的第 4 行）、团队写域重叠预警（`gate.ts`）、`reap` 读者通知
  （`push.ts`）、循环结束留痕正文（`releaseOnLoopEnd`）；`human:console` 没有会话 id 就不附。
  实测本机 35 个 holder 只有 14 种名字（一个名字占 10 份）、
  句柄 0 碰撞（2026-10-06 复算；8 字符是短标识，不是身份保证）
  ⇒ 同名会话从此可区分；②让 `claim` 接受显式 `owner` 标签，由会话自己命名（**未做**）；
  ③可选：用**上下文注入**给每个会话一行自我标识（插件已有两条 `systemPrompt.context`，
  加第三条成本很低），让对端可被 `agent:<holderId>` 频道寻址（**未做**）。

### 2.4 `read` / `shared` 声明零门控，但契约读起来像有保护【实测】

- **依据**：门控先按 mode 跳过 shared/read（`src/gate.ts:62`），read 也跳过冲突扫描（`src/collab-core.ts:497`）。
- **场景**：使用者按插件自己注入的 `OPEN_HINT`（`src/awareness.ts`）用 `mode=read` 宣布"这块我在看"。
- **后果**：声明**不产生任何拦截**，别人照写；而提示词恰恰推荐 read 模式，很容易被理解成一种保护。
  只有 README 与 `docs/collab-usage.md` 说明了这一点，**工具返回值与常驻提示里一句都没有**。
- **注**：0.9.0 已修掉一个相关文案问题 —— 访问通知原先会对 `read` 声明渲染「不可读」（其实读不会被拦）。
- **优化方向**：命中 shared/read 声明时，在返回值里显式回一句「该声明不产生门控」。

### 2.5 门控是建议性的：`bash`/`pwsh` 完全绕过【实测】

- **依据**：写工具白名单只有 6 个（`src/spec.ts:56-72`），刻意不含 shell；未知工具直接放行（`src/gate.ts:37`）。
- **场景**：用 `bash` 写文件、`python - <<EOF`、`sed -i` 改被占路径。
- **后果**：写保护看起来"拦住写入"（设置卡片文案是"拦截"），实际只拦住模型工具的那几个参数名。
  同一路径用 shell 写，门控一次都不触发。README 承认了，但**模型侧没有任何运行时提示**。
- **优化方向**：`bash` 命中被占路径时给一条**旁路提示**（不是拒绝），让使用者知道这次没被保护。

### 2.6 被拒时的 reason 不含可操作身份【实测】

- **依据**：`gateReason` 只有名字 + 模式 + UTC 窗口（`src/gate.ts:23`）。
- **后果**：写入被硬拒绝后想找人协商，reason 里**没有 claimId、没有 sessionId、没有频道名**，
  只能再调一次 `overview` 自己拼。
- **优化方向**：reason 里直接带 claimId 与 `agent:<holderId>` 频道名，让「协商」一步可达。

### 2.7 常驻摘要只显示前 3 条且按最早到期排序【实测】

- **依据**：`slice(0,3)`（`src/collab-core.ts:304`）、按 `expiresAt` 升序（`:302-303`）、折叠成「另有 N 条」（`:311`）。
- **后果**：你要改的目录若排在折叠里，常驻态势里就看不见它；「另有 N 条」甚至不告诉你有没有你关心的路径。
- **优化方向**：折叠时优先展示与**你最近访问路径相关**的声明，或给出可一眼扫到的路径前缀列表。

### 2.8 租约到期对持有者是静默的【实测】

- **依据**：`sweep` 只做 filter（`src/collab-core.ts:226`）；唯一的警告是创建时的「ttl < 60s」（`:529`）；
  `heartbeat` 只能手动调（`src/collab-core.ts:557`）。README 把「自然过期不推送」列为已知限制。
- **后果**：租约一过期锁**直接消失**（不是残留），别的会话可以静默接手；持有者没有任何信号，
  返回里也没有「剩余租约」字段（只有 `expiresAt` 毫秒，要自己算）。
- **优化方向**：`claim`/`list` 返回剩余秒数；剩余不足时在常驻摘要里给持有者自己的那一行加警示。

### 2.9 心跳续租必须记住 claimId【实测】

- **依据**：`heartbeat` 只认 claimId（`src/collab-core.ts:557-562`）；同 mode 重叠路径的重复 claim 会合并续租（`:517-521`），
  但那要在锁**还没过期**时才有意义。
- **后果**：claimId 没留在上下文里（或被扫掉）就只能新建一份。
- **优化方向**：允许 `heartbeat paths=[...]`（与 release 对称），或让 claim 返回稳定的续租门牌。

### 2.10 项目键只由 cwd 决定 ⇒ 跨 worktree 就「看起来占着其实没占」【一手 + 实测】

- **依据**：项目键 = cwd（`src/paths.ts:66-69`），文件名由 cwd 哈希（`src/collab-core.ts:171-177`），
  `relToProject` 只在路径落在 cwd 下时剥前缀（`:339-349`）。
- **一手**：本次清理中，子代理 A1 在 `/tmp/collab-debt-tests` 这个 git worktree 里改 `tests/`，
  却申报占用了 `tests/ .github/`；锁说它在占主仓库的 `tests/`，而它物理上写的是**另一个目录**。
  同时主 AI 在 `/tmp/collab-debt-notice` 里改 `src/collab-core.ts`，那个位置**不在任何申报里**。
- **后果**：worktree 会话的声明与主仓库会话的声明落在**两个不同的状态文件**里，互不可见；
  而两边的物理文件其实是同一份。锁形同不存在。
- **优化方向**：允许显式指定项目键（claim 传仓库根），或按 git 顶层目录派生键。

### 2.11 绝对路径落在 cwd 外时被静默相对化【实测】

- **依据**：`norm` 直接去掉开头的 `/`（`src/collab-core.ts:147-154`）；不匹配 cwd 就原样返回（`:339-349`）。
- **后果**：`/x/y` 被归一成 `x/y`，于是「另一个项目下的同名相对路径」可能撞上你的锁（假阳性拒绝），
  或者本该匹配的声明匹配不上（假阴性放行）。**两者都没有任何提示**。
- **优化方向**：门控/匹配阶段把「落在 cwd 外的绝对路径」显式判为不可判定并给提示，而不是静默相对化。

### 2.12 通知可达性只对释放者透明，对读者完全不可见【实测】

- **依据**：`notify` 汇总是给释放者的（`src/push.ts:196`）；`not-live` 绝不唤醒（`:231-234`）；
  `agents` 服务缺失时整条通道不可用 ⇒ 落 `inject-failed/no-agents-service`（`:217-226`）；
  0.9.6 起投递面只有 `agent.inject` 一条，解析不到读者记 `agent-not-resolvable`（`:146-163`、`:255-260`）。
- **后果**：读者永远不知道自己**没被通知到**（README 明说冷会话直接丢弃）。这是刻意设计，
  但读者侧没有任何「我可能收不到」的提示。
- **优化方向**：在 claim / 访问通知的返回里说明这条订阅是 best-effort，并建议用 `collab_board` 留一手。

### 2.13 留言板的 `mentions` / `agent:<holderId>` 频道不产生投递【实测】

- **依据**：`mentions` 只是存进 message（`src/collab-core.ts:570`），`read` 无任何按 mentions/channel 的路由
  （`src/tools.ts:72`）。
- **后果**：`@` 了对方**不等于**通知了对方；被 @ 的会话不会因此被唤醒或收到提示。
- **优化方向**：至少在 `post` 返回值里说明「未投递，对方需自行 read」，或让 mention 走一次读者推送。

### 2.14 态势提示有覆盖面空洞【未验证】

- **依据**：拿不到 cwd 就返回通用 `OPEN_HINT`（`src/awareness.ts:32`）。
- **疑点**：子代理会话能否取到 cwd 取决于 `agent.session.header.cwd` 是否继承（**未验证**）。
- **后果（若成立）**：该会话永远看不到「别人占着什么」，只能靠自觉 `overview`；而它自己一旦 claim，
  反而会出现在别人的摘要里，形成**单向可见**。
- **优化方向**：退化时在 `OPEN_HINT` 里显式说明「当前看不到态势，请手动 overview」。

### 2.15 两形态能力不对称，且使用者分辨不出【实测】

- **依据**：动态形态 `src/collab-plugin.host.ts` 无 pre/post-execute 接线（`:80-81`），`release` 不带 `notify`（`:363-371`），
  不注册随包技能（`:22-24`），没有 `readable` 参数（`:209-218`），TTL 固定、读不到 env（`:429`）。
- **后果**：工具名、description、参数表几乎与包形态一致，但**少了功能 A/C/D 整条链**：
  没有写保护、没有访问通知、没有读者推送、没有随包技能。使用者按同样的文档操作，却得不到任何拦截。
- **优化方向**：动态形态至少在工具 description 或返回值里标注「受限形态：无写保护 / 无通知」。
- **0.14.0 复核更新**：写保护**已补** —— 宿主外壳现在接线 `tools/pre-execute`，判据直接调内联核心
  （与包形态同源，含 0.14.0 的两处修正），两形态的 ask 文案逐字节对拍。**仍未接**：访问通知
  （`tools/post-execute`）、读者推送、随包技能、官方 Agent Teams 的反向交叉预警 —— 它们要
  `agent.inject` / `dsh-llm`，受限宿主里没有。另：宿主形态读不到 env/Config ⇒ `enforceWriteLock`
  恒开、`DSH_COLLAB_NO_PROMPT_HINT` 无效。所以这条现在只剩"通知/技能那半边"成立。

### 2.16 设置卡片两项开关的影响面比卡片说的大【实测】

- **依据**：`exposeDelegationDiscipline=false` 会**同时**撤掉随包 skill 与 `dsh-collab/delegation` 常驻注入
  （`src/delegation.ts:36`）；写保护开关只影响拦截，**不影响** `claim()` 的冲突判断
  （`src/collab-core.ts:496-517`）。
- **后果**：为了「少点提示词噪声」关掉纪律开关的人，不会预期到纪律块一起消失；而写保护开关
  让人以为关掉就等于"不再参与协作"。
- **优化方向**：卡片里写清每个开关各自失效的范围。

### 2.17 `collab_board` 漏传 `op` 时，报错读不出「你漏了 op」【实测·已复现于 0.9.0】

- **依据**：`src/tools.ts` 的 `boardHandler` 在 `op` 既非 `'read'` 也非 `'post'` 时返回
  `bad-request` + `未知操作：<值>`。而 `op` 是 schema 的 `required: ["op"]`。
- **复现（0.9.0，隔离副本）**：
  ```
  board.parameters.required = ["op"]
  {"ok":false,"error":"bad-request","message":"未知操作：undefined"}
  ```
- **后果**：错误信息**不含"缺 op"**这个事实；调用方（模型）看到 `未知操作：undefined` 很难反推
  是漏了参数还是传错了值。会话记录里有 2 次（占全部 81 次调用的 2.5%）因此**把几百字正文重发了一遍**。
- **优化方向**：`op` 缺失时单独给一条 `missing op (one of: post, read)`，与"传了非法值"区分开。

### 2.18 `release` 用 `paths` 匹配不到任何声明时，仍返回 `ok: true`【实测·已复现于 0.9.0】

- **依据**：`release` 返回 `{ ok, data: { released: [...] } }`，**没有把「释放了 0 条」当作异常**。
- **复现（0.9.0，隔离副本）**：
  ```
  {"op":"release","paths":["no/such/path/"]}
  -> {"ok":true,"data":{"released":[],"serverTime":…,"notify":{"readers":0,…}}}
  ```
- **后果**：调用方无法从 `ok` 判断"我还持有吗"；`ok:true` 制造**虚假的完成感**。会话记录里有 1 次
  真实出现（`released: []` 且 `ok` 为真），随后该会话又手写重试了一次。
- **优化方向**：`released` 为空时给 `ok: true` 但带 `warning`（或改判 `not-found`），并在文案里
  指出「没有任何声明匹配这些路径」。

### 2.19 僵尸声明只能等租约（最长 24h）或手工清状态文件【实测·0.9.8 已解决】

- **原始实测记录（2026-09-13 深夜，保留不改）**：一个子代理会话（W10）被**强杀**（dsh 重启），
  它持有的 `src/` + `tests/` exclusive 声明**留了下来**。尝试由其他会话回收时得到：
  ```
  collab_lock op=release (paths=[...])
  -> {"ok":false,"error":"forbidden","message":"only holder can release"}
  ```
  而租约 `ttlSec` 最长可到 `86400` 秒 ⇒ **最长 24 小时内，任何其他会话对这些路径的写入都会被
  写门控硬拒绝**（本部署审批被禁用，`ask` 即 `deny`）。当时主 AI 只能**手工改状态文件**
  （`~/.dsh/collab/projects/*.json`）才解开。
- **为什么不能自动清**：`agents.get()/agents.list()` 对**休眠但可唤回**的会话同样返回
  undefined/缺席（实测活进程 `agents.list()` 只有 2 个 agent，`sessionController.list()` 有 224 个
  会话）。按它自动回收 = 把"只是空闲"判成"已死"，而 0.8.2 已经因此静默丢过通知、W7 又禁止
  `agent/disposed` 提前释放未到期声明。运行时注册表**无法区分**"休眠可唤回"与"真死"。
- **解决（0.9.8）**：新增**显式** `collab_lock op=reap`，默认 dry-run（只列候选、绝不改状态），
  `confirm: true` 才删除；候选须同时满足「未过期 / holder 不在 `agents.list()` / 不是自己 /
  age 严格大于 `olderThanSec`（默认 600s）」并可 `paths` 限定；`human:console` 无活体信号一律不收；
  活体检查跑不成时一个也不收。**绝不自动触发**（不进 `sweep()`/读路径/定时器/`agent/disposed`）。
  回收后复用功能 D 的 `notifyReaders` 通知读者。负向对照见 `tests/collab-reap.mjs`：
  临时去掉活体检查一行 → 「活着的 holder 的声明被误删」立即红。
- **0.9.11 补齐（不是新问题，是 0.9.8 漏的一半）**：`reap` 过去只过滤 `s.claims`、**从不碰
  `s.holders`**，于是它清掉的僵尸在 holders 表里继续留着，要等 24h 的 `sweep()` 才自愈
  （实测：`omni_deploy` 的项目文件里 20 个 holder、`my` 里 0 声明却留着 5 个）。现在 confirm
  时级联摘掉"本次被回收 + 已无未过期声明 + 不在活体名单里"的 holder，dry-run 里以
  `candidateHolders` 预告。判据仍然**只缩不放**，`HOLDER_TTL_MS = 24h` 没动
  （它是保守值，且 0.9.8 的僵尸口径与测试依赖它）。

### 2.20 `overview` 看不见别的项目（0.9.11 已解决）

- **场景（一手）**：排障时要在 `my` 项目里确认 `omni_deploy` 的占用，`collab_lock op=overview`
  只报当前 cwd 的项目 —— 状态文件就在旁边（`~/.dsh/collab/projects/`），工具却读不到。
- **解决（0.9.11）**：`overview` 的返回里附 `otherProjects`（文件名 / `statePath` / 活跃声明数 /
  占用明细；按声明数降序、最多 10 条；无活跃声明的不列）。**走输出侧附加、不加工具入参**：
  加 `project`/`all` 参数要同步 SSOT 契约的 4 份派生物，而排障缺的是"能看见"，不是"按名字精确查"。
  降级：宿主 fs 无 `listDir`、目录缺失、单个文件损坏 ⇒ 只返 `otherProjects: []` + `otherProjectsNote`，
  本项目的数字一字不动。

---

### 2.21 与官方 Agent Teams 的接缝：家族豁免 + 单向交叉预警（0.11.0 实测并实现）

- **场景**：同一棵会话树里跑官方 `Agent Teams` 的 teammate（`spawn_teammate` 造出的直属
  continuable 子会话，`TeamId` = Lead 的 `SessionId`）时，两边都看不见对方的路径声明。
- **怎么测的（可复现）**：隔离 profile `~/.dsh/profiles/teamlab` = `dsh-base` + `dsh-headless` +
  `@deepseek-ai/dsh-experimental-agent-team-profile` + 本仓库 symlink 进 `node_modules/dsh-collab`
  （`profiles/web` 那套组合的等价物，但不动线上 profile）。真实会话：`cd /tmp/collab-evidence &&
  DSH_PERMISSION_MODE=danger-full-access dsh --profile teamlab "<步骤化提示>"`；证据一律从**持久化的
  会话日志**（`~/.dsh/sessions/--tmp-collab-evidence--/<id>/session.v4.jsonl.zstd`）与 collab 状态
  文件里取，不看模型的自我叙述。原始命令与输出片段：`docs/agent-teams-interop-evidence.md`。

- **实测结论四件**：
  1. **teammate 确实拿到本插件的态势注入**。teammate 会话（`917be146-…`，日志里有
     `subagent/descriptor`，即 Lead 的直属子会话）持久化的 `user/message`
     （`source.kind='runtime-context'`, `form='snapshot'`）里带着 `dsh-collab/awareness` 与
     `dsh-collab/delegation` 两段。机制：teammate 与 Lead 同进程、同 cordis 根、继承 Lead 的 preset，
     而 `systemPrompt.context` 对所有 scope 的会话生效。
  2. **家族豁免让"自动态势"和"写门控"对 Lead↔teammate 失效；`op=overview` 却看得见。**
     Lead `collab_lock op=claim paths=["seam.txt"] mode="exclusive"` → `ok:true`（`c_1`）；
     teammate 的 awareness 段仍只有 OPEN_HINT；teammate 的 `collab_lock op=overview` 报
     `totalClaims: 1` 并列出该声明；随后 teammate `write seam.txt` **成功**（`Updated file`），
     文件从 `LEAD_CONTENT` 被覆盖成 `TEAMMATE_WROTE`。
     **负向对照**：另一个**无血缘**的独立会话对同一路径强制写入 → `Error: the user rejected tool "write"`，
     并收到 `[dsh-collab] 你刚访问的路径处于其他会话的占用范围内…` 的访问通知。
     ⇒ 门控本身有效，失效只来自家族豁免。**更正 README 原先的"双方都看不见"**：自动注入与门控看不见，
     显式 `op=overview`/`op=status` 看得见；同层级的两个 teammate 互不为祖先/后代，故彼此可见。
  3. **`send_message` / `list_agents` 语义换了，但"先唤醒、别重派"仍然成立**（真跑了一次唤醒）。
     `list_agents` → `[{"target":"lead","role":"lead","status":"running"},{"target":"probe-w",
     "role":"teammate","status":"inactive"}]`（名字寻址 + running/inactive 词表）；
     `send_message {target,message}` → `{"messageId":"team-message-…","status":"accepted"}`；
     只剩 inactive 成员时 `wait_agent` 返回
     `{"timedOut":false,"noProgress":{"reason":"no-active-peer","message":"…use send_message to wake each
     required inactive teammate before waiting again."}}`。唤醒后 teammate 会话 `turn/start` 从 1 → 3，
     并按第二条消息里的指令写了两个文件 ⇒ **恢复路径有效**。
     真正变的是"主体"：legacy `tool-subagent*` 被 agent-team bundle 在部署层禁用，`list_agents` 不再
     列出它们（Web profile 的 preset 里仍有 legacy 控件，只是被同名团队工具**遮蔽**）。0.11.0 曾据此在
     `ctx.agentTeams` 在场时给委托纪律追加一段面向 teammate 的措辞（`TEAM_DISCIPLINE_ADDENDUM`）；
     **0.12.0 已删除** —— 那些语义官方 `team:policy` 段
     （`dsh-experimental-tool-agent-team/lib/index.js:21-27`）自己会讲，现在服务在场/缺席的纪律文本逐字节相同。
  4. **`write_scopes` 实测纯 advisory，没有任何人按它写**。`team_task_create write_scopes=["inside/"]`
     → `writeScopes:["inside"]`；`team_task_update action=claim` → `status:"in_progress"`、
     `writeScopeWarnings:[]`；被唤醒的 teammate 同时写 `outside/proof.txt`（**在声明写域之外**）与
     `inside/proof.txt`，两个都 `Created file`，无警告、无拒绝；teammate 自己 `team_task_list` 看到的
     也只是同一份 advisory 视图。与官方自述一致（`dsh-experimental-tool-agent-team/lib/index.js:23`、
     `dsh-experimental-agent-team/README.md:138`）。

- **0.11.0 的实现（交叉预警：不改锁语义、不重做任务 DAG）**：
  - **正向（本插件读官方）**：`ctx.agentTeams.listTasks(活 Agent)` 里 `status='in_progress'` 且
    `writeScopes` 非空的任务被当作 advisory 占用 —— 进态势摘要（`teamTaskScopeLine`，order 130 那一段）、
    进 `collab_lock op=overview` 的 `teamTasks` + `teamTasksNote`、进 `op=claim` 成功返回的 `teamOverlaps`。
    这些数据**永远不参与** `blockers()` / `claimsCovering()` / gate 的判定。
  - **反向（本插件提示官方一侧）**：官方没有给第三方插件"任务即将创建"的钩子，但它和别的工具一样走
    DSH 的 `tools/pre-execute`。本插件在 `team_task_create` / `team_task_update` 上做**只提示不阻断**的
    交叉预警：`write_scopes` 与外部（非家族、非 shared/read、未过期）的 collab 声明重叠时，投一条
    `agent.inject` + `form:'notice'` 的显式来源消息；没有重叠就什么都不发。host 动态形态没有
    `tools/pre-execute` 接线（§2.15），那一侧退化为文档约定。
  - **降级契约（负向对照逐个断言）**：服务缺席 / `listTasks` 抛错（如 `TEAM_NOT_MEMBER`）都折成三态里的
    `null` ⇒ 本插件所有输出**一字不变**；服务在场但没有在跑任务 ⇒ `teamTasks: []` + 明说"没有在跑任务"。
    `tests/collab-agent-teams.mjs` 对"一字不变"逐字段断言。
- **契约**：`TeamScopeTask` / `TeamScopeOverlap` 进 SSOT `src/schema/collab.schema.json`，
  并同步 TS / Python / Rust 四份派生物（`tests/collab-contract-derivation.mjs`）。这两个类型描述的是
  **别的插件拥有的数据**，所以写进契约（与 `otherProjects` 那种纯排障字段不同）。
- **仍未验证**：`fork` 上下文的 teammate 与 `fresh` 在可见性上是否有差异；同一 checkout、两个 dsh
  进程时官方 Team 状态不跨进程而本插件的路径占用跨进程 —— 两者叠加的表现没测；多 teammate 并发争用
  同一写域时的实际覆盖顺序没测。

---

### 2.22 插件页里 collab 的配置卡片"没有内容"（0.11.0 已修）

- **场景（用户报）**：启用官方 agent-team bundle 之后，"collab 的设置页配置可能看不见了"。
- **定位（实测，2026-09-22）**：**与 agent-team 无关**，是 0.10.0 起的既有回归。用官方的 Config 检视
  读**活体树**（不是磁盘上的组合结果）：
  ```
  cordis_inspect_query(host/Config, listConfigs, {name:"dsh-collab"})
  → {"id":"include:collab","patchId":"collab","name":"dsh-collab","status":"absent",
     "packageDir":"/home/vesita/.dsh/profiles/web/node_modules/dsh-collab"}
  ```
  `status:'absent'` 的定义是 **`fiber.runtime.Config` 为 undefined**
  （`dsh-tool-cordis/lib/types/config.js:12-14`），而 `fiber.runtime` 就是插件的**默认导出对象**
  （`cordis/lib/index.js:1347` 的 `resolveConfig(this.runtime, config)`）。0.10.0 把偏好迁到
  profile Config 时，`Config` 只留了具名导出，默认导出仍是 `{ name, inject, apply }` ⇒ Loader 没有
  可投影的 Config ⇒ 浏览器半边的卡片（其实注册得好好的：`plugins.bundle.config` 的 occupant
  `dsh-collab` 一直是 `active: true`）拿不到表单，于是看起来"配置消失了"。
  **对照**：`dsh-antigravity` 的默认导出是 `{ name, inject, apply, Config }`，同一检视报
  `status:'schema'`；两者差的就是这一项。
- **修（0.11.0）**：`src/index.ts` 的默认导出补上 `Config`；
  `tests/collab-client-config-page.mjs` 新增 ⑦ 段钉死它（默认导出带 Config、与具名导出同引用、
  本部署 profile 里那四个值能被校验通过）。修前 `Object.keys(default)` 实测为
  `['name','inject','apply']`，修后为 `['name','inject','apply','Config']`。
  连带修的两处**测试基建**（都不改产品行为）：
  1. `tests/_harness.mjs` 说清"测试里造插件 Config 的正确方式"：把**普通值**交给
     `ctx.plugin`，由 cordis 按 `Config` schema 校验并生成 volatile 引用；改值用 cosmokit 的
     `updateVolatile`（与 `cordis-plugin-loader` 的 `_commitVolatile` 同一个函数）。
     `collab-access-gate.mjs` / `collab-auto-release.mjs` / `collab-skill.mjs` 里手工造 `{get,set}`
     引用的写法已删除 —— 那种写法会绕过校验，声明 `Config` 之后必然
     `ValidationError: expected boolean but got [object Object]`。
  2. `tests/collab-skill-real.mjs`（`npm run test:real`）**从 0.9.0 起就没再跟上 0.1.7**：
     它把 `@deepseek-ai/dsh-settings-file` 列为前置依赖，而该包在 0.1.7 已被 `dsh-settings`
     取代（0.1.7 的 `dsh-settings` 里没有 `installSection`），所以 `npm run test:real` 一直是
     **硬失败**（拒绝静默跳过，按设计 exit 1）。偏好既然已经是插件自己的 Config，这个文件改为：
     真实 `SkillRegistry` + **真实 cordis 的 Config 校验/volatile 引用**，用 `updateVolatile` 模拟
     用户在插件页改开关。现状 `npm run test:real` 17 条断言全绿。
- **生效条件**：这是**代码**修复，需要重新打包安装进 `profiles/web`（或让该插件从本仓库加载）
  并重载插件；运行中的进程仍加载着旧的 0.10.1 模块。
- **未验证**：重装后在浏览器里那张卡片真的渲染出四个字段（本次只验证到 Host 侧
  `default.Config` 存在、schema 接受本部署的值、且卡片注册面未变）。

---

### 2.23 持有者异常退场时的锁滞留：逐条边界与处置（0.12.0）

- **场景（用户提出）**：子代理突然空回复、网络中断（回合以 `error` 结束）、会话意外结束
  这三种情况下，它持有的声明会怎样？
- **审计方式**：只读代码审计 + `tests/collab-auto-release.mjs` 的假计时器/假注册表复现
  （不是读代码猜的；`file:line` 见下）。
- **逐条现状（0.12.0 之前）**：
  1. **子代理正常转 `idle`**：它自己的自动释放会在宽限后放掉它的声明；父会话不被它挡
     （家族豁免，`collab-core.ts:747,947`、`gate.ts:64`）。**已覆盖**。
  2. **子代理回合以 `error` / 空收尾结束、随后转 `idle`**：同上，走第 1 条。**已覆盖**。
  3. **子代理状态**停在** `running`**（回合结束了但状态没落地，或驱动卡在网络上不再推进）：
     父会话的第 4 道闸门（`auto-release.ts:172-186`）**无限重新武装**，父锁被一个已经不在干活的
     后代永久扣住。**这是 0.12.0 修的洞**：延期上限 10 轮宽限期（默认约 20 分钟），到顶照常释放；
     会话恢复 `running` 时预算清零（`auto-release.ts` 的 `CHILD_DEFER_MAX_ROUNDS` / `deferrals`，
     动态形态同源 `collab-plugin.host.ts`）。测试：`tests/collab-auto-release.mjs` §14。
  4. **会话被 `dispose`**：只回收**已过期**声明并摘 readers（`collab-core.ts:587-600`），未过期的
     保留 —— W7 的取舍（`collab-core.ts:808-818`），**未改**。
  5. **进程被杀**：既没有 `agent/status` 也没有 `agent/disposed`，**没有任何代码路径**能看到它；
     声明只能等租约到期（下次写 op 的 `sweep`，`collab-core.ts:266-268`）或显式
     `op=reap confirm:true`。**未改**，原因见下。
- **为什么不动 4 和 5**：判据只能来自 `agents.list()`，而它**只含本进程此刻加载着的 agent**
  （`store.ts:120-135`）—— 跨进程活着的会话同样不在里面。把它接进自动回收会**误杀**跨进程持有者
  （被回收的一方恢复后仍以为自己持锁，两边同时写，见 `collab-core.ts:808-818` 的 W7 论证）。
  要安全自动化，必须先有一条**跨进程的活性见证**（按项目落盘的进程心跳），那是独立一块工作。
- **6. 子代理会话退场后，它的未过期声明会挡住**父会话**（本次现场实测）**：家族豁免靠
  `agents.list()` 现算血缘（`store.ts:182-211`），而子代理一旦 `dispose` 就离开注册表 ⇒ 父算不出
  它是自家人 ⇒ 它这条**未过期**声明在父会话眼里是"陌生人的锁"，写门控直接 `ask`（本部署=拒）。
  现场：本次会话派出的子代理持声明 `c_75`（`dsh-collab/docs/dsh-subagent-routing.md`，
  `ttlSec 1800`）后结束，父会话随后编辑同一文件被拒（`the user rejected tool "edit"`）；
  `op=status` 里两条 exclusive 并列而 `op=claim` 的家族判据已不含 `c_75`；
  `op=reap olderThanSec=0 confirm=true` 把它回收，`reasons` 原文为
  `["unexpired","agent-holder","not-self","holder-not-in-agents-list","age-over-threshold","paths-intersect"]`、
  `ageSec 428`、`remainingSec 1372` —— 也就是说：**若不手工 reap，父会话要被自己子代理的锁挡到租约到期**。
  注意它没走"循环终止自动释放"：子代理直接退场（没有可用的 `agent/status → idle` 窗口）。
  **未改**：正解是让血缘**随声明落盘**（claim 记下持有时刻的祖先链），或给跨进程活性见证；
  两者都是契约级改动（schema SSOT + 四份派生物 + 两形态），不在本次范围内。
- **仍未验证**：`subagent/end` 事件能否作为"后代已结束"的精确信号（它带子会话 id，
  `dsh-subagent/lib/types/types.d.ts:93-111`）；若可用，第 3 条可以做到秒级而不是 20 分钟。

**0.13.0 复核（用户再次提出：更新后旧会话的失效锁不会自动清理）**：

- **装备面被堵死的证据（新增，读 DSH 源码）**：`agents` 服务的 `get(id)` 是
  `this.store.get(id)?.agent`、`list()` 是 `[...this.store.values()]`
  （`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js:594,612`）
  —— **两者读的是同一个 live 注册表**。所以"装机时遍历 `agents.list()` 补武装"
  （`src/auto-release.ts:234-243`）**看不到的持有者，`svc.get()` 同样解析不到**，
  装机期对账**不可能**覆盖第 4/5 条那批旧持有者。这一条把"再加一次遍历就能修"的可能性排除了。
- **仍成立**：自动清理要安全，前提是一条**跨进程/持久化的活性见证**（按项目落盘的进程心跳，
  或把"持有时刻的进程身份"随声明落盘）。三个候选（装机期 session 存储对账 / 装机期租约强制截断 /
  进程 epoch 绑定）的代价与误杀风险已评估：只有"见证"能同时满足"终结即释放"与"不误杀跨界活锁"。
  **本轮未实现**（它是独立一块工作，且改判据必须配负向对照测试）。
- **现场代价（本轮实测）**：子代理 `11adb78f` 因上下文耗尽异常退出，其独占声明 `c_191`
  在 `experiments/entity_identity_v2/` 上滞留，直到 Lead 手动 `op=reap confirm=true` 才解开；
  即"没有任何自动路径能回收它"。同一天 `op=wait` 2 次全部超时（15.25s / 90.29s），
  另有 4 次 `claim` 被 `conflict` 顶回。

### 2.24 `list` 的 holders 被读成「过期锁」（0.12.2 已缓解）

- **一手**：使用者看着 `collab_lock op=list` 的返回问「是不是在罗列过期锁」。该次实测：
  `claims` 1 条（未过期）、`expiredCount` 0，而 `holders` 34 条、其中 32 条 `stale: true`
  —— 名册被当成了锁。
- **事实**：`holders` 是**会话名册**（谁在这个项目上出现过），锁在 `claims`；stale（无未过期
  声明且静默 >1h）与"过期声明"不是同一对象，`sweep()` 只按 `expiresAt` 清 `claims`。
  逐行核对两形态：`list`/`overview`/`status`/`reap`/`wait` 都**不**返回已过期声明。
- **处置（0.12.2）**：`holderRosterNote()` —— **有 stale 条目时**才附一句「holders 是会话名册，
  不是锁（锁在 claims）…静默超过 24 小时后由下一次 sweep 回收」，没有 stale 则一个字段都不加
  （与 `otherProjects` / `teamTasks` 同一降级纪律）。负向对照在
  `tests/collab-hostcode-parity.mjs`：空状态 list 断言 `!('holdersNote' in data)`。
- **仍未做（已被 0.14.0 做掉，见 §2.27）**：当时名册照旧逐条返回（`STALE-VISIBLE` 那条测试明确
  要求 stale holder 可见），所以那条返回的量级没变 —— 变的是它不再能被读成锁。

### 2.26 句柄结束即删：推翻 W7（0.13.0，用户决策）

- **一手（用户提出）**：「失效锁清除少处理了一个边界情况 —— 更新后旧会话的失效锁不会自动清理」。
- **审计结论（三路只读审计 + 读 DSH 源码）**：
  1. `agents.get(id)` 与 `agents.list()` 读的是**同一个 live 注册表**
     （`dsh-agent/lib/index.js:594` / `:612`）⇒ 不在名单里的持有者，`get()` 也解析不到；
     "装机时再遍历一次"这类修法**不可能**覆盖它们。
  2. 现场实证：子代理 `11adb78f` 上下文耗尽退场后，独占声明 `c_191` 挡住
     `experiments/entity_identity_v2/`，直到人工 `op=reap confirm=true` 才解开。
  3. 因此候选只有两条：跨进程活性见证（落盘心跳）或**句柄生命周期**。
- **决策（用户）**：不用心跳包，**句柄结束自动删除**。`agent/disposed` 是"句柄结束"的确定性事件
  （`agent.dispose()` 停循环 + 注销注册表，`dsh-agent/lib/types/index.d.ts:135-145`），
  这一刻立即释放该 holder **全部未过期**声明。
- **实现（0.13.0）**：`releaseOnLoopEnd` 加 `cause`（'loop-end' | 'disposed'）；包形态在
  `src/push.ts` 的 `agent/disposed` 处理器里释放 + `dropHolder` + 通知读者；动态形态
  （`src/collab-plugin.host.ts`）同源但**不投递**（受限宿主构造不出诚实来源的消息）。
  两形态的 `releaseOnLoopEnd` 逐输出对拍（含 `cause:'disposed'` 语料）。
- **风险与缓解（如实记）**：W7 当年的顾虑仍然成立 —— dispose 后被**恢复**的会话会按对话历史
  以为自己持锁。缓解是留痕：频道 `agent:<holderId>` 里那条"句柄已结束（agent/disposed）"的
  审计留言 + 发给等待者的"锁已释放"通知。**残余风险**：恢复的会话若从不读留言板，就会以为自己
  还持锁（与租约到期那条老路径的风险同级，但发生得更早）。
- **仍未覆盖**：①**被杀的进程**（没有 `agent/disposed`）；②**升级前就已退场**的旧持有者
  （没有新事件可等）—— 两者的声明只能等租约到期或 `op=reap`。跨进程活性见证这条路本轮被否，
  但需求仍在（若将来要做，判据与代价见 §2.23 的候选表）。
- **测试**：`collab-auto-release.mjs` §8（释放 + 留痕 + 通知读者 + 与 idle 武装路径幂等）、
  `collab-integration.mjs` step 5-6、`collab-readers-push.mjs`、
  `collab-hostcode-parity.mjs`（两形态对拍）。

### 2.27 名册行只靠 24h 计时器回收：句柄结束了、进程被杀了，行都还在（0.14.0 修）

- **一手（用户提出）**：「为什么现在还是会有这么多锁？之前不是针对性修过这个 bug 吗？」
  现场返回：`claims` 3 条（未过期 **2**，都是正当占用）、`holders` **56** 行 / 其中 52 行 `stale: true`。
  —— 真锁一把都没多；用户看的是**名册**。但"这 52 行不该在"这个判断是**对的**，而且确实从没修过：
  此前四次修复（0.9.8 reap / 0.9.10 循环终止 / 0.12.2 `holderRosterNote` / 0.13.0 句柄结束即删）
  **动的都是声明（claim），一次也没碰过名册行**。
- **根因**：名册行的生死挂在 `HOLDER_TTL_MS = 24h` 这个**计时器**上，不挂在会话句柄上。
  三条证据：
  1. 代码：唯一的删行口是 `sweep()` 的 `active || holderFresh(24h)`；`holder()` 只被 `claim`/`post` 调用，
     `release`/`heartbeat` 都不刷 `lastSeenAt`；
  2. 探针（跑在运行中的已安装副本上）：`dropHolder()` 执行后 holders 行 **1 → 1**，一行没删；
  3. 现场反证：状态文件里 9 条「会话句柄已结束（agent/disposed）」留言，对回名册行 ——
     **5/5 条超过 24h 的行都被 TTL 收走了，4/4 条 24h 内的行都还在**（且每次 dispose 都晚于该行 `lastSeenAt`）。
     即 0.13.0 的"句柄结束即删"只删了声明，名册行照样躺满 24h。
- **处置（0.14.0，五条一起做）**：
  - **A**：`dropHolder()` 连名册行一起摘（调用点上 `releaseOnLoopEnd('disposed')` 已在**同一事务**里
    删光未过期声明 ⇒ 摘行不可能藏住活锁）。不变量：**还有未过期声明就绝不摘行**
    （否则出现"claims 有人、holders 没人"）。
  - **B2**：名册行盖**进程身份章** `proc = <pid>:<开机节拍>`（`src/proc-id.ts`，读 `/proc/<pid>/stat` 第 22 字段；
    带节拍是为了防 pid 复用）。`sweep()` 只保留"写它的那个进程还活着"的行 ⇒ **被杀的进程**
    （本机 harness 重启就是 SIGKILL 整条 cgroup，既无 `status` 也无 `disposed`）留下的行，下一次
    有人碰这个项目时就消失，不必等 24h。**判据不可用时一个也不收**（fail-closed，与 reap 同纪律）。
  - **B**：`procStamping: true` 的形态里，没有章的行一律作废（升级前的旧行；下一次操作自动重新登记）。
  - **C**：`list` 的名册**有界**返回（`HOLDER_VIEW_LIMIT = 12`）+ 恒带 `holdersTotal`，截断可察觉。
  - **D**：留言正文加**字符**上限 `MESSAGE_BODY_MAX_CHARS = 8000`（SSOT 的 `Message.body.maxLength` 同值）；
    超限由 `post()` 以 `bad-request` 挡回，**不静默截断**。只封条数（`MAX_MESSAGES`）会让状态"任意大"——
    实测一条 5MB 的 body 原样落盘，`sweep()` 也不会缩小它。
- **证据**：`tests/collab-proc-id.mjs`（真实 `/proc` 对拍 + 同 pid 两令牌的顺序无关性）、
  `collab-inline-parity.mjs` 的 proc 语料（两形态逐输出）、`collab-e2e.mjs` T11/T12（**接线**端到端，
  带负向对照：拿掉盖章/上界即红）、`collab-hostcode-parity.mjs` 的 12 行 / `holdersTotal` / `expiredCount` 断言；
  D 由 `collab-pure-logic.mjs`（边界含 + SSOT 同值）与 `collab-integration.mjs`（超限不落盘）覆盖。
- **残留（如实记，未做）**：
  1. **TTL 是惰性的** ⇒ 没人碰的项目里死行能躺很久。实测本机 `arch-canvas` 8 行 @398–399h
     （16.6 天）、`nanoSeek` 1 行 @406h —— 也就是说"24h 有界"在**墙钟**意义上不成立，B2 只在
     下一次有人读写该项目时才生效。
  2. **跨进程 CAS 不成立**：`mutate()` 的乐观并发依赖 `replaceIfVersion`，而 dsh-fs-local 的写锁是
     **每实例**的、"probe → rename"两个进程可同时成功（实测 4/4 轮双 OK = 丢更新）。
  3. **仓库自带的 Rust CLI** `save_state` 是 `fs::write`（`O_TRUNC` + write，**非原子**）且**零版本守卫**，
     与插件共享同一状态文件：实测 6 个并发 CLI claim 只剩 1 条；一次大文件写入期间并发读者观测到
     文件长度 **0**（随后 `load` 的 JSON.parse 失败 → 自愈分支把活状态覆盖成 `init()`）。

### 2.28 后来的 exclusive 静默压掉已在场的 shared（0.14.0 改为「允许协商」，用户决策）

- **一手（审计发现）**：A 先 `claim shared` 占住 `src/`，B 随后 `claim exclusive` 同一路径 ——
  `claim()` 的冲突扫描里有一句无条件 `c.mode === 'shared' → continue`，于是 B **静默获准**。
  代价：B 的独占一生效，A 的写入立刻被门控硬拒（本部署 `ask` 即 `deny`），而"冲突"这件事
  **双方都没看见** —— 后来者反客为主。
- **当时的理由（成文在 `src/gate.ts`）**：shared 按定义是"声明共用"，两个共享方不该互相挡死。
  这句对**执行层**成立，对**取得层**不成立：允许 B 拿 exclusive 恰恰会让 A 被挡死。
- **决策（用户）**：「按照更合理的方式实现，变成允许协商的模式」。判据改成**由本请求的意图决定**：
  - 请求 `exclusive` ⇒ 与已在场的 `exclusive` **和 `shared`** 都冲突；
  - 请求 `shared` ⇒ 只与已在场的 `exclusive` 冲突（与 shared 不冲突，0.9.x 语义保持）；
  - `read` ⇒ 一律不冲突。
  冲突不是硬失败：返回的 `ConflictInfo` 已带 `suggestedAction(wait|negotiate)`、`holderName`、
  `remainingSec`、`overlapsWith` —— 协商所需的全部信息。
- **一处刻意的不对称（别再当漂移修掉）**：`tests/collab-access-gate.mjs` 里原本有一条
  「writeGate 阻塞 ≡ claim() 冲突」的**逐例等价**断言，它把旧策略写成了等价式。现在改成：
  对 exclusive 声明仍断言等价，对已在场的 shared 声明**显式断言 `gate=放行 且 claim=冲突`** ——
  **取得层比执行层严一档**。理由：执行层回答"我能不能写"，取得层回答"我能不能把这块变成我的"。
- **证据**：`tests/collab-pure-logic.mjs` 的四种组合（exclusive/shared/read × shared/exclusive）+
  `collab-access-gate.mjs` 的一致性组；负向对照：把取得层改回无条件跳过 shared ⇒ 7 条断言红。

### 2.25 留言板「写了没人读、@ 了没人知道」（0.13.0 部分修）

**现场取证**（卡片式训练框架 Lead 会话家族 47 个会话，2026-10-07 全天转录 + 同一个
`my-16d6093f0d1330.json`；数法与脚本见取证报告，原始命令为解压 `.zstd` 后按 `tool/call` 聚合）：

| 数字 | 值 | 说明 |
| --- | --- | --- |
| `collab_board` post / read | **14 / 2** | 一天 14 条留言，全天只被读 2 次 |
| 带 `mentions` 的留言 | 3 条，**回应 0 条** | 目标会话转录里连 msgId 都没出现过 —— 不是"没回"，是**从未收到** |
| 两次 read 的结果 | 一次漏掉当天全部留言；一次返回 49.9 KB 触发宿主 spill 截断 30 KB | 两次都是 `since=0`（默认）|
| `collab_board` 漏 `op` | 1 次 `未知操作：undefined` | §2.17 |
| `collab_lock` release 失败 | **23 / 46** | 10 次缺参 `bad-request`、13 次 `not-found`（锁已被自动释放，模型扑空）|

**根因（三条，都是本板的设计问题，不是使用问题）**：

1. **默认读到远古**：`since` 缺省 = 0，而旧实现 `matched.slice(-limit)` 取的是"最新 limit 条"——
   但当历史已累积几十条时，调用方以为自己按文档"增量拉取"，实际读到的窗口与它想要的错位；
   更要命的是返回里**没有 `hasMore`/`earliestSeq`**，"窗口被截断"这件事不可察觉（§2.25 修）。
2. **`since` 方向与文档矛盾**：给 `since` 时旧实现仍取"最新 limit 条"，于是被跳过的**中段**永久不可达
   （现场 62 条留言、默认 limit 50：一次只回 50 条，最旧 12 条再也拿不回来）（§2.25 修）。
3. **mentions 没有任何投递面**（§2.13 的根因，行号已漂移）：`post` 只入库，
   `agent.inject` 全仓只有 access / push（release/reap/auto）/ gate 三处调用，**没有一处由 board 触发**；
   返回也不告诉调用方"没投递"。

**0.13.0 处置**：

- `filterMessages` 分**两种模式**：不给 `since`（或 0）= **tail**（最新 limit 条，追平用）；
  `since > 0` = **forward**（从游标往后、旧→新，可循环到 `hasMore === false` 无损追平）。
  回传 `mode` / `hasMore` / `nextSince` / `earliestSeq`，"截断"与"被回收"从此可察觉。
- `post` 返回固定带 `delivered: false` + `deliveryNote`（不投递、不唤醒；要对方动起来用它自己的消息工具），
  并原样回显 `channel` / `mentions`。
- 频道未命中时返回 `channelNote`：列出**现有频道**（按条数降序，最多 5 个）。
  实测踩过两种写法不一致 —— 文档写 `agent:<holderId>` 而 holderId 本身已含 `agent:`
  （读 0 条，现场 K=10 vs L=0）、path 频道少个尾斜杠（读 0 条，I=6 vs J=0）。
  schema 与 `collab-usage.md` 的模板同时改正。
- `read` 透传 `load()` 的 warning（以前只解构 `{state}`，把"按项目隔离已失效"丢了）。
- 宿主形态把读取逻辑抽成同名纯函数 `filterMessages` / `channelRosterNote` 进对拍集合
  （25 → **30 个**）—— 此前这段逻辑两边各抄一份，一起退化时**无人守护**。

**仍未做（如实记，含理由）**：

1. **mention / channel 的投递**：按定位（README「与官方 Agent Teams 的分工」）树内转向归官方
   `send_message`，本插件不重做。跨树**未投递**只能如实告知 —— 是否给同进程、非团队成员的会话
   补一条 best-effort notice（`agent.inject`，不唤醒），是一个**定位取舍**，待拍板。
2. **已读游标 / "你有 N 条未读"**：消息结构里没有已读字段（`Message` 是
   `additionalProperties:false`），态势摘要里也没有留言信号 ⇒ **发了没人读**这一半没解决。
   要做就得升契约（SSOT + 四份派生物），是独立一块。
3. **更早的历史不可达**：tail 只给最新 `limit` 条（上限 200）；`before` 反向翻页未做。
4. **单次 read 可能很大**：现场 50 条 = 49.9 KB，触发宿主 spill 截断。`limit` 可调小，但返回值里
   没有"体量"提示。
5. **`release` 无参默认释放自己的全部声明**（现场 10 次缺参报错）、**`not-found` 不算失败**
   （现场 13 次）：都会改变锁语义，未动。

---

### 2.29 一次 claim 重写整份状态文件（97% 的字节是留言）（0.15.0 修）

- **一手（实测盘面）**：状态文件是**一份 JSON、每次操作整份重写**。实测 `my-16d6093f0d1330.json`
  共 82,248 B，其中**留言 79,815 B（97%）**、声明 1,313 B、名册 1,058 B —— 一次 `claim` 要写
  82 KB，只为改 1.3 KB 的锁状态。留言上限当时只有**条数**（`MAX_MESSAGES = 2000`），
  最坏可到约 2 MB。
- **处置（0.15.0，R2：只改磁盘布局，不停用任何功能）**：
  - 主文件 `<name>.json` = `{schemaVersion, seq, claims, holders}`；
    留言旁挂 `<name>.messages.json` = `{schemaVersion, seq, messages}`。
  - **内存里的 `StateDocument` 一个字不改**（SSOT `src/schema/collab.schema.json` 与三份派生物零改动），
    只在**加载期合并**、**落盘时拆分**。
  - 旧布局（主文件里仍有 `messages`）以主文件为准，**首次写盘搬进旁挂**并去掉主文件里那个键；
    **只搬不删**，`collab_board op=read` 迁移前后返回一致。
  - 写盘**先旁挂后主文件**（迁移那一次主文件里的键会被去掉，反过来一旦旁挂写失败就只剩内存里的留言）。
  - **只在留言变化时才写旁挂**：判据是 `条数 | 首条 msgId | 末条 msgId` 指纹 —— 留言只有
    "尾部追加"（`post`，msgId 唯一递增）与"头部截断"（`sweep`）两种变化，两者都必然改变条数或首条 msgId。
  - `sweep()` 加**字节预算** `MAX_MESSAGES_BYTES = 256 KiB`，与条数上限**取先到者**、同丢最旧，
    口径 = 每条留言 JSON 序列化的 UTF-8 字节之和（超限由 `swept.droppedMessages` 如实报数）。
  - `otherProjects()` 排除 `*.messages.json`，不把旁挂当成一个项目。
  - **两形态都改**：`src/store.ts`（包形态）与 `src/host-shell.js`（动态外壳）各自实现同一布局。
- **实测（强，同一支探针 `/tmp/r2-probe.mjs` 跑改前/改后构建）**：留言 118 条 / 245,932 B 时，
  一次 `claim` 的写盘字节数 **246,454 B（改前，1 次写）→ 391 B（改后稳态，1 次写，旁挂 0 次）**，
  降幅 99.8%；升级后第一次操作含一次性迁移 246,092 B（旁挂）+ 391 B（主文件）。
- **证据**：`tests/collab-state-split.mjs`（迁移不丢 / 写放大 / 字节预算 / 两形态同构 / `otherProjects`
  排除，含把"只在变化时写旁挂"改成"每次都写"的负向对照 ⇒ 写放大断言变红）；
  `collab-integration.mjs` 的留言截断断言已改为读**主文件 + 旁挂合并**的逻辑状态。
- **残留（如实记，未做）**：
  1. **两形态仍是两份存储层**（`src/store.ts` 与 `src/host-shell.js` 各一份 load/mutate），
     本单元只保证布局同构，抽公共源仍是待办。
  2. **混合版本并存**时（旧版本往主文件写 `messages`、新版本往旁挂写），加载期以主文件为准 ⇒
     旁挂那一份会被下次写盘覆盖。单版本部署下不成立，跨版本滚动升级未处理。
  3. 仓库自带的 Rust CLI `save_state` 仍是整份覆盖写（见 §2.27 残留 3），且它读的是主文件
     —— 声明/名册仍读得到，留言它本来就只做备份，未改。

---

## 3. 噪声与重复

### 3.1 常驻占用行每轮都在上下文里【一手】

- **现象**：`[dsh-collab] 同项目其他会话当前占用：…`（态势摘要）会出现在**每一轮**的运行时上下文里。
- **它是什么**：这条来自 `systemPrompt.context` 的常驻段（`src/awareness.ts:63`，order 130），
  **不是** user 消息。DSH 按整串相等去重 **committed 快照**，所以它不会把**历史**撑大；
  但它每轮都**可见**，因此每轮都占注意力——一旦你已经知道谁占着什么，后续轮次就没有新增信息量。
- **曾经更贵**：摘要里只要掺进任何会变的字符（例如早期的"剩 N 分"倒计时），就会击穿去重、
  让**整份快照**反复重提交。实测 415 次提交、337,014 字符里，237 对（57.1%）只差倒计时数字。
  0.4.3 改成绝对 UTC 租约窗口后消失（见 §4.4）。
- **更正（本文档早先写错，已改）**：**访问通知那一路没有重复问题**——它按
  `(agent, claim 集合签名)` 去重（`src/access.ts` 的 `accessNotified`），同一组占用只暂存一次；
  且它**不是**常驻段，而是"命中才出现、5 分钟后消失"的临时段。
  先前写的"优化方向：访问通知按 claim 集合签名去重"是**已经实现了的东西**。
- **载体变迁（2025-09，两度）**：访问通知最初由插件构造一条手抄的 user 消息塞进
  `additionalContexts`；随后规范收紧成"一份也不许构造"，它被逼去挤 `systemPrompt.context`
  的运行时快照（代价：每次重提整块快照、依赖 `systemPrompt` 可用、没有独立一行）；
  最终规范**收窄为"严禁冒充用户"**，它回到 **`agent.inject` + `form:'notice'`** 的逐事件
  写法 —— 经真实 `@deepseek-ai/dsh-llm` 构造，来源显式非 user，渲染成 notice 行。
  期间的实测（缓存中性、快照尺寸、生态普查）都留在 `AGENTS.md` §1 里，别再重新论证。
- **优化方向**：要动只能动常驻摘要本身——① 让它在没有变化时更短（例如只列与**最近访问路径**相关的条目，
  即 §2.7）；② 或者接受它，因为它是"不用调工具就知道有谁在占"的唯一来源。**不建议**改成按需拉取：
  那样每个会话都得先想起来调 `overview`，而实测 `op=overview` 之外的协作调用几乎是零（§4.2）。

---

## 4. 实测使用统计（会话记录取证）

口径：`~/.dsh/sessions/--home-vesita-coding-my-dsh-collab--/` 下 29 个 `session.v3.jsonl.zstd`，
解压后 12,888 行。统计的是**真实使用**，不是 fixture。

### 4.1 身份可读性

| 数字 | 值 |
|---|---|
| 出现过的不同 `holderId` | 16 |
| 渲染出的 `holderName` 种数 | 17，其中 **11 种是提示词/标题碎片**、3 种是 fixture 名（`Alpha`/`Beta`） |
| `…` 结尾的截断名 | 7 种（如 `Work autonomously in an …`、`修复 \`dsh-collab\` 插件（仓库 \`/…`） |

⇒ §1 第 2 条的量化依据：**常驻注入里唯一携带身份的那一格，多数时候不是人名。**

### 4.2 功能存在但从未在真实路径触发

| 功能 | 实测 |
|---|---|
| `op=wait` | 被 **25 个会话**的注入文案明确推荐，实际调用 **0 次**（81 次调用里） |
| `op=heartbeat` / `op=status` | **0 次 / 0 次** |
| 按 op 分布 | claim 27 / overview 19 / release 18 / list 5（合计 69），board post 6 / read 4 |
| claim : release | 27 : 18 —— **9 条 claim 从未被显式释放** |
| 写门控（功能 C） | 真实业务路径触发 **0 次**；记录里所有 `非持有者写入需要先协商` 的持有者名都是自造 fixture |
| 释放通知送达读者 | 真实送达 **0 次**；`已释放 …` 只出现在自造的验收探针里 |
| `collab_board` 协商 | 6 次 post 里只有 1 次是 `channel:"path:…"` 的对等协商，**0 条回复**（发起者只能"先推进"） |

⇒ 这组数字是 §1 第 1、4 条的依据：**最强的两道机制（冲突等待、写保护）在真实协作里都没被用到过。**

### 4.3 发现性失败的两个实例

- 一个会话自述：**「我这一整场用了 6 个子代理，在你问起之前，协作工具调用次数是 0。」**
  同一份记录里，一个子代理为了拿到排他性**自己发明了协议**（静默 40s 探测 + md5 冻结 + 窗口内重跑）。
- 父子身份错位在真实记录里两头都出现过：父会话 `claim src/` 后，被显式指派的子代理对
  `src/paths.ts` 申报时拿到 `{"error":"conflict", … "overlapsWith":"src/"}` —— 于是它**放弃申报**
  （board 原话：「本任务由父代理显式指派的三个文件，不额外 claim，改完即报」），
  结果是它改的三个文件对外**完全不可见**。

### 4.4 已修（留着这段是为了记住它当初值多少）

- 态势摘要里的「剩 N 分」倒计时曾让**整个快照**每次重新提交。实测：415 次提交、337,014 字符中，
  **237 对（57.1%）只差倒计时的数字**，另有 28 对逐字相同。0.4.3 改成**绝对 UTC 租约窗口**后消失。
  —— 这条**不需要再修**，列在这里是为了说明"看起来无害的相对时间"能造成多大浪费。

---

## 5. 刻意保留的设计取舍（不是缺陷，但使用者应知道）

| 取舍 | 依据 | 使用者应知道 |
|---|---|---|
| 锁是**建议性**的，不是强制隔离 | 只有模型工具走门控 | 别把它当沙箱 |
| **绝不唤醒冷会话** | `src/push.ts:231-239` | 释放通知可能永远送不到；`notify.skipped` 会如实记录（`not-live` / `agent-not-resolvable`） |
| `read`/`shared` 不参与门控 | `src/gate.ts:62` | 想真保护就用 `exclusive` |
| （0.9.6 已删）子代理投递**邻接**约束 | 旧 `src/push.ts` 的 `subagents.sendMessage` 回退通道（已整体删除） | 0.9.6 起投递面只有 `agent.inject`：跨父会话的子代理读者只要能解析到**自己的活 agent** 就收到，**不再要求邻接**；解析不到记 `agent-not-resolvable` |
| **`agent/disposed` 不再提前释放未到期声明** | 0.9.6 起租约 `expiresAt` 是声明生命周期的唯一权威 | 会话死亡后声明会占用到租约到期，期间他人只能 `wait` 或 `board` 协商；`heartbeat` 是唯一续租方式。被回收的**已过期**声明仍会走 `notify`（旧行为是 dispose 即释放，且当时没有活着的 sender 就不通知子代理读者） |
| **僵尸声明回收只由显式 `op=reap` 驱动，绝不自动** | 0.9.8；`agents.list()` 无法区分"休眠可唤回"与"真死"（0.8.2/W7 的教训），误杀代价不对称 | 被强杀的会话留下的未到期声明不会自己消失：先 `op=reap` 看候选（dry-run），确认后用 `confirm:true` 回收。要自己死后的锁立刻释放，仍应在结束前显式 `release` |
| 本部署 `ask` = 硬拒绝 | 审批提示被禁用 | `ask` 决策在这里等价于 `deny` |
| **访问通知依赖 `agent.inject`，拿不到带 `inject` 的 Agent 就不投递** | `src/access.ts`；`inject` 的契约见 `dsh-agent/lib/types/runtime-types.d.ts:209` | 受限宿主里访问通知会静默消失（写保护仍在）。**绝不退回"自己造一条消息"** —— 那是规范要挡的 |
| **`dsh-persona` 的 `includeRuntimeContext=false` 会让态势摘要与纪律块消失** | 该开关调 `systemPrompt.suppressRuntimeContext()`（`dsh-persona/lib/index.js:47`），对所有 scope 的所有 context 段生效 | 关掉它等于关掉协作**可见性**（访问通知不受影响 —— 它是消息，不是上下文段）；插件侧无法绕过 |
| **态势段（order 130）与纪律段（order 131）是我们自选的号，不在 DSH 注册表里** | DSH 的 `CONTEXT_ORDERS` 只有 `SANDBOX_POLICY=110 / APPROVAL_POLICY=115 / SUBAGENT_DELEGATION=120`（`dsh-system-prompt/lib/index.js:43-47`），别的插件都走 `getContextOrder(名)` | 排序冲突无人仲裁：DSH 若新增段占用 130 区段，会出现顺序不确定。**自选 order 是权宜**，DSH 一旦给出登记入口就该改过去 |
| **`DSH_COLLAB_NO_PROMPT_HINT=1` 也关掉访问通知** | `src/access.ts` 的 `NOTICE_ENABLED`；契约见 `src/awareness.ts:34` 与 `src/delegation.ts:90` | 这是**有意**的：总开关的契约是"关掉所有运行时注入的内容"，而访问通知正是运行时状态派生再注入进会话的。只关投递，读者反向登记（功能 D）照常。换载体（上下文段 → `agent.inject`）时**特意保留**了这条语义，没有顺手改掉 |
| **`form:'notice'` 必须带非空 `summary`，否则渲染退化成 opaque** | `dsh-client-ui-chat/lib/client.js:825-831`（`case "notice"` 先算 `noticeSummary`，为 null 即 opaque） | 我们这条由 `boundContextSummary` 保证；但**DSH 自家有翻车的**：`dsh-tool-cordis` 与 `dsh-tool-skill` 声明 `form:'instructions'` 却没给 `changes`，实际是 opaque 行 |
| **释放推送在 GUI 里以"用户气泡"呈现**（旧 `sessionController.prompt` 通道）—— **0.9.6 已解决** | 旧通道由 **DSH** 把消息落库为 `source{kind:'user', rpcId}`（`dsh-api-session-controller`），客户端第一道判据是 `source.kind !== 'user' → context 节点`，否则按 `steering`/`user` 渲染（`dsh-client-ui-chat/lib/client.js:8757`）。**实测**：本会话 42 条 `kind:'user'` 里有 1 条是 `[dsh-collab] …已释放…` | **0.9.6 起插件自造消息 + `agent.inject`**：`createUserMessage({ source: { kind:'dsh-collab', form:'notice', summary: boundContextSummary(…) } })`，来源显式 `dsh-collab/notice`（0.1.7 起生产者各自声明 `kind`，见 `src/contract.ts` 的 `MessageSourceMap` augment），GUI 里渲染成**独立 notice 行、不是气泡**（`client.js:8757` 的 `source.kind` 分流、`:825-831` 的 `form:'notice'`）。旧结论"插件**无法改变**来源、得 DSH 在 UI 侧按 rpcId 区分"已被推翻 —— 不再需要 DSH 侧改动 |

---

## 6. 证据强度

- **实测（强，逐行核对代码路径）**：§2.1（`src/store.ts:247` / `src/collab-core.ts:497` / `src/gate.ts:52`）、
  §2.4（`src/gate.ts:62` / `src/collab-core.ts:497`）、§2.5（`src/spec.ts:56-72` / `src/gate.ts:37`）、
  §2.7（`src/collab-core.ts:304,302-303,311`）、§2.8（`:226,:529`）、§2.9（`:557-562`）、
  §2.10（`src/paths.ts:66-69` / `src/collab-core.ts:171-177`）、§2.11（`:147-154`）、§2.12（`src/push.ts` 各处）、
  §2.13（`src/collab-core.ts:570` / `src/tools.ts:72`）、§2.15（`src/collab-plugin.host.ts:80-81,363-371,22-24,209-218,429`）、
  §2.16（`src/delegation.ts:36`）、§5 全部。
- **实测（强，隔离副本上运行时复现）**：§2.17、§2.18 —— 在 `/tmp` 的隔离副本里构建 0.9.0 后直接调用
  工具拿到原始返回，**不是**读代码推断。
- **实测（强，真实会话 + 持久化日志取证）**：§2.21 —— 在隔离 profile `teamlab`（base + headless +
  官方 agent-team bundle + 本仓库）上跑真实 `dsh --profile teamlab` 会话，四件结论各自的原始命令、
  原始工具返回与会话日志片段见 `docs/agent-teams-interop-evidence.md`；覆盖写、门控拒绝、唤醒轮次
  都是从会话日志与文件内容读出的事实，不是模型叙述。
- **实测（强，官方检视工具读活体树 + 编译产物对照）**：§2.22 —— 用 `cordis_inspect_query` 的
  `host/Config` 读**活体**条目状态（`collab` → `absent`，`antigravity` → `schema` 作对照），
  再由 `status` 的定义（`fiber.runtime.Config`）与 Loader 取 `runtime` 的那行代码定位到
  默认导出缺项；修前/修后 `Object.keys(default)` 都实测过。
- **记录取证（强，只读会话记录）**：§4 全部数字（81 次调用、op 分布、16 个 holderId、
  17 种 holderName、0 次 wait/heartbeat/status、1354 次占用行、415 快照/237 对倒计时）。
  数法见 §4 各表；原始记录未改动，解压在 `/tmp` 临时目录。
- **一手（强，本次会话）**：§2.1（为绕开自锁而降级为 `shared`）、§2.3（通知里渲染出提示词残段）、
  §2.10（worktree 与申报路径错位）、§3.1（重复出现十余次）。
- **推断（中）**：§2.2 的「子代理 holderId 与父不同」依据 DSH 源码（子会话由 `agents.create({sessionId: childId})`
  单独创建、`exec.agent` 携带调用方身份），但**没有真的跑一次工具调用去观察两边的 holderId**。
- **未验证（弱）**：§2.14 全部；§2.10 对「普通子代理（非 worktree）是否也错位」未验证。
- **已排除（不要当成现存缺陷）**：会话记录里出现的 `mode:"read"` 被存成 `exclusive`、以及
  `statePath` 里出现未展开的 `~` —— 这两条都在 0.9.0 的隔离副本上**未能复现**
  （实测 `mode:"read"` 返回 `mode="read"`），属于早期版本的历史现象。
- **没做的**：没有跑端到端的浏览器/真机复现；§2 的条数来自代码审计、运行时复现与记录取证，
  **不是**穷举。
