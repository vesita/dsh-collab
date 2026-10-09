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
  ttlSec: number;
  expiresAt: number;
  note?: string;
  createdAt: number;
  /**
   * 可读性（功能 C）：true = 他人可读这些路径（默认），false = 他人读取也要走审批。
   * 可选字段是为了兼容 0.7.0 之前写下的状态文件 —— 缺省即**可读**（见 collab-core 的 isReadable）。
   * 写入对**非持有者永远**要走审批，与 readable 无关。
   */
  readable?: boolean;
  /**
   * 读者（功能 D，反向注册）：被本声明通知过的会话 holderId 列表（形如 `agent:<id>`）。
   * 缺省即 `[]`（见 collab-core 的 readersOf）。摘除时机：持有者 `op=release`（整条声明消失）、
   * 或 `agent/disposed`（dropHolder 只摘登记 —— 会话被 dispose 之后往往还会恢复）。
   *
   * **声明的回收路径（0.14.0 现状，四条）**：
   *   1) 租约到期 `expiresAt`（sweep）—— 唯一无条件的一条；
   *   2) 持有者显式 `op=release`；
   *   3) **句柄结束**（0.13.0，`agent/disposed`）：立即释放该 holder **全部未过期**声明
   *      —— 这一条**推翻了 0.9.6 起的 W7 取舍**（旧口径是"dispose 只回收已过期声明"，
   *      0.13.0 由用户决策改成"句柄结束即删"，见 src/push.ts 的 disposed 处理器）；
   *   4) **循环终止自动释放**（0.9.10，`releaseOnLoopEnd`）：`agent/status` → `idle` 且空闲超过
   *      宽限期（默认两分钟，可在 settings 关掉）—— 触发者是"循环停了、但 agent 还加载着"。
   * 3) 与 4) 都留一条审计留言（频道 `agent:<holderId>`）；恢复工作前必须重新 claim。
   * 3) 的残余风险如实记：dispose 后被**恢复**的会话会按对话历史以为自己仍持锁。
   * 0.8.3 起 sweep() 不再按 liveness 清理 —— `agents.get()` 对休眠但可唤回的会话
   * 返回 undefined，按它清理会把只是空闲的读者删掉，静默丢掉释放通知。
   */
  readers?: string[];
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
   * 只影响名册行，不改变任何声明（claim）的租约语义。
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
   * 终态墓碑表（单元 C）：`claimId → 原租约 expiresAt`。release / 自动释放 / reap 不再把
   * 声明"从数组里删掉"，而是记进这里 —— 删除在 join 下不单调（另一份旧副本会把记录带回来），
   * 墓碑才单调。`claims` 仍然只含有效记录，所以门控与全部视图不受影响。
   * GC 规则**确定性**：原租约 `expiresAt <= t` 时由 sweep 丢掉（那一刻起该记录在所有副本上
   * 都已过期、不可见，复活无害）。**可选**：老状态文件缺省为空表。
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
  expiresAt: number;
  // 优化增强：为 AI 决策提供更丰富协作建议
  suggestedAction?: 'wait' | 'negotiate' | 'switch_path';
  remainingSec?: number;
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
  op: 'claim' | 'release' | 'list' | 'overview' | 'status' | 'heartbeat' | 'wait' | 'reap';
  paths?: string[];
  claimId?: string;
  mode?: Mode;
  readable?: boolean;
  ttlSec?: number;
  timeoutMs?: number;
  confirm?: boolean;
  olderThanSec?: number;
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
