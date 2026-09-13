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
   * 可选字段同样为了兼容老状态文件 —— 缺省即 `[]`（见 collab-core 的 readersOf）。
   * 移除时机只有两处：持有者 `op=release`（整条声明消失）、`agent/disposed`（dropHolder 摘登记，
   * 它在**会话被 dispose 之后往往还会恢复**，所以措辞不用"真正的会话结束"）。
   * **声明本身不因 dispose 而被回收**（W7）：claim 的生命周期只由租约 `expiresAt` 决定，
   * dispose 只是摘掉 reader 登记、并回收该 holder 已过期的声明。
   * 0.8.3 起 sweep() 不再按 liveness 清理 —— `agents.get()` 对休眠但可唤回的会话
   * 返回 undefined，按它清理会把只是空闲的读者删掉，静默丢掉释放通知。
   */
  readers?: string[];
}

export interface Message {
  msgId: string;
  seq: number;
  channel: string;
  author: string;
  ts: number;
  body: string;
  mentions?: string[];
  replyTo?: string;
}

export interface Holder {
  holderId: string;
  name: string;
  kind: 'agent' | 'human';
  sessionId?: string;
  lastSeenAt?: number;
}

export interface StateDocument {
  schemaVersion: 1;
  seq: number;
  claims: Claim[];
  messages: Message[];
  holders: Holder[];
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
  mentions?: string[];
  replyTo?: string;
  since?: number;
  limit?: number;
}
