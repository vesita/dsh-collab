/**
 * Type definitions derived from src/schema/collab.schema.json (Single Source of Truth)
 */

export type Mode = 'exclusive' | 'shared' | 'read';

export interface Claim {
  claimId: string;
  holderId: string;
  holderName?: string;
  paths: string[];
  mode: Mode;
  note?: string;
  createdAt: number;
  /**
   * 可读性（功能 C）：true = 他人可读这些路径（默认），false = 他人读取也要走审批。
   * 可选字段是为了兼容 0.7.0 之前写下的状态文件 —— 缺省即**可读**（见 collab-core 的 isReadable）。
   * 写入对**非持有者永远**要走审批，与 readable 无关。
   */
  readable?: boolean;
  /**
   * Lamport 逻辑时钟的序号（单元 C）：写时 bump 过所见最大值（= 合并基里的最大值 + 1）。
   * **可选**：0.16.0 之前写下的状态文件没有它（缺省 0）。记录 id 由 `(seq, writer)` 决定，
   * 全序也是 `(seq, writer)`。
   */
  seq?: number;
  /**
   * 写者戳（单元 C）：产生这条记录的进程身份。两个写者撞上同一个 seq 也不会撞 id
   * （`c_<seq>@<writer>`）。**可选**：老状态文件缺省为空串。
   */
  writer?: string;
  /**
   * 写这条声明的进程身份令牌（`<pid>:<开机节拍>`，0.2.9）。自动回收的**第二证据**：
   * oracle 说持有者不活了 + 这个进程确实不在了，两条同时成立才删锁（只有 oracle 不够 ——
   * 它查的是本进程的 agents 注册表，多开一个 dsh 实例会误判另一个进程里的活会话）。
   * 可选：老状态文件与盖不了章的形态没有它 ⇒ 届时自动回收不生效（fail-closed）。
   */
  proc?: string;
}

export interface Message {
  msgId: string;
  seq: number;
  channel: string;
  author: string;
  ts: number;
  /**
   * 消息正文。上限 8000 字符（SSOT `$defs.Message.properties.body.maxLength`，
   * 同值常量见 collab-core 的 `MESSAGE_BODY_MAX_CHARS`）。
   * 超限由 `post()` 以 `bad-request` **显式挡回**，不静默截断：
   * `MAX_MESSAGES = 2000` 只封条数，单条不封 ⇒ 状态文件大小"任意大"。
   */
  body: string;
  replyTo?: string;
  /**
   * 写者戳（单元 C）：产生这条留言的进程身份。msgId 形如 `m_<seq>@<writer>`；
   * 两个写者撞同一个 seq 也不会撞 id。**可选**：老状态文件缺省为空串（游标按 `(seq, "")` 处理）。
   */
  writer?: string;
  /**
   * 条目类型（SSOT `$defs.Message.properties.kind`）。
   * 缺省 `note` = 普通留言 —— **老写法的行为逐字节不变**。
   * `handoff` = 一份结构化交接；`handoff-accept` = 声明接手了某份交接。
   */
  kind?: 'note' | 'handoff' | 'handoff-accept';
  /** 仅 `kind='handoff'` 时有值。 */
  handoff?: Handoff;
}

/**
 * 结构化交接（SSOT `$defs.Handoff`）。
 *
 * 为什么不用自由文本：接手方要判断"能不能开始"，而散文里没有可判定的字段 ——
 * 那天一份 `READTHIS.md` 写了 300 行，接手方仍不知道哪条做完了、哪条只是声称。
 */
export interface Handoff {
  /** `draft` 还在写；`final` 定稿（正文末行必须是 HANDOFF_FINAL_MARK）。只有 final 允许被接手。 */
  status: 'draft' | 'final';
  items: HandoffItem[];
  /**
   * 接手者 holderId。**只由接手方写**；并发接手时按 join 规则收敛（有值者胜），只留一个。
   */
  acceptedBy?: string;
  /** 接手时刻（Unix 毫秒）。与 acceptedBy 同源写入。 */
  acceptedAt?: number;
}

/** 一条交接事项（SSOT `$defs.HandoffItem`）。 */
export interface HandoffItem {
  /** 一句话说清做了什么 / 没做什么。 */
  text: string;
  /**
   * `done` = 做完了**且有负向对照**；`unverified` = 做了但没验证；`blocked` = 没做（必须给 reason）。
   *
   * 三值而不是布尔：把"没验证"与"没做"混成一个 false，接手方就没法区分
   * "可以直接用"与"还得自己验一遍"。
   */
  status: 'done' | 'unverified' | 'blocked';
  /** `status='done'` 时必填。 */
  negativeControl?: NegativeControl;
  /** `status='blocked'` 时必填。 */
  reason?: string;
  /** 这条事项若含结论，用它标注证据强度。 */
  claim?: HandoffClaim;
}

/** 负向对照（SSOT `$defs.NegativeControl`）：破坏被测行为后观察到的变红。 */
export interface NegativeControl {
  /** 破坏被测行为的那条命令。 */
  command: string;
  /** 执行后观察到的变红现象（如「3 failed」）。 */
  became: string;
}

/**
 * 结论的证据强度（SSOT `$defs.HandoffClaim`）。
 *
 * `measured` 必须给 `evidence` —— 否则"我测过了"就成了一句可以随便说的话。
 */
export interface HandoffClaim {
  strength: 'measured' | 'inferred';
  /** `strength='measured'` 时必填：命令 + 输出摘要。 */
  evidence?: string;
}

export interface Holder {
  holderId: string;
  name: string;
  kind: 'agent' | 'human';
  sessionId?: string;
  lastSeenAt?: number;
  /**
   * 写这一行的进程身份令牌 `<pid>:<开机节拍>`（0.14.0）。
   * 名册行的生死按它判：写它的那个进程不在了 ⇒ 下一次 sweep 就删掉这一行，不等 24h。
   * 缺省 = 升级前留下的旧行，或该形态拿不到进程身份（受限动态宿主里 process 是 undefined）。
   * 只影响名册行，不改变任何声明（claim）的语义。
   */
  proc?: string;
}

export interface StateDocument {
  schemaVersion: 1;
  seq: number;
  claims: Claim[];
  messages: Message[];
  holders: Holder[];
  /**
   * 写者戳（单元 C）：**最后一次**落盘这份文档的写者身份。写路径在每次写入前盖上自己的戳；
   * 写后验证据此判断"我的写入是否被别人覆盖了"（覆盖 ⇒ 重读 + 重合并 + 重试）。
   * **可选**：老状态文件缺省为空串（无法据此判定，视作"观测不到"）。
   */
  writer?: string;
  /**
   * 终态墓碑表（单元 C）：`claimId → 墓碑值`。release / 句柄结束释放 / reap 不再把声明
   * "从数组里删掉"，而是记进这里 —— 删除在 join 下不单调（另一份旧副本会把记录带回来），
   * 墓碑才单调。`claims` 仍然只含有效记录，所以门控与全部视图不受影响。
   * 墓碑值取该声明的 Lamport `seq`（只用于**确定性 GC 排序**，不是时间）。
   * GC 规则：超过 MAX_RELEASED（4096）条时按「值降序、claimId 降序」保留最大的那些 ——
   * 只看数据，故任何副本 GC 出同样结果。**可选**：老文件缺省为空表。
   */
  released?: Record<string, number>;
}

export interface ConflictInfo {
  claimId: string;
  holderId: string;
  holderName?: string;
  path: string;
  overlapsWith: string;
  mode: Mode;
  // 优化增强：为 AI 决策提供更丰富协作建议
  suggestedAction?: 'wait' | 'negotiate' | 'switch_path';
}

/**
 * 官方 Agent Teams 任务的只读视图（`$defs.TeamScopeTask`）：数据由 dsh-experimental-agent-team 拥有，
 * 不是本插件的状态；只取在跑任务（status `in_progress`）的 `writeScopes`（项目相对路径前缀）做 advisory 交叉预警。
 */
export interface TeamScopeTask {
  id: string;
  subject?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  ownerName?: string;
  writeScopes: string[];
}

/** 团队任务写域与 collab_lock 声明的重叠（`$defs.TeamScopeOverlap`，advisory 预警，不改变任何门控）。 */
export interface TeamScopeOverlap {
  taskId: string;
  subject?: string;
  scope: string;
  path: string;
}

export interface CollabLockParams {
  op: 'claim' | 'release' | 'list' | 'overview' | 'status' | 'wait' | 'reap';
  paths?: string[];
  claimId?: string;
  mode?: Mode;
  readable?: boolean;
  timeoutMs?: number;
  confirm?: boolean;
  note?: string;
}

export interface CollabBoardParams {
  op: 'post' | 'read';
  channel?: string;
  body?: string;
  replyTo?: string;
  since?: number;
  limit?: number;
}
