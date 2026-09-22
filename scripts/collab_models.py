"""
collab_models.py
基于 src/schema/collab.schema.json 契约派生的 Python 数据类型定义。
支持使用 uv 直接运行和集成。
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import List, Optional, Literal

Mode = Literal["exclusive", "shared", "read"]
OpLock = Literal["claim", "release", "list", "overview", "status", "heartbeat", "wait", "reap"]
OpBoard = Literal["post", "read"]
SuggestedAction = Literal["wait", "negotiate", "switch_path"]

@dataclass
class Claim:
    claimId: str
    holderId: str
    paths: List[str]
    mode: Mode
    ttlSec: int
    expiresAt: int
    createdAt: int
    holderName: Optional[str] = None
    note: Optional[str] = None
    # 0.8.0：可读性（默认 True；缺字段的老状态文件即"可读"）
    readable: bool = True
    # 0.8.0：读者反向注册（被本声明通知过的会话 holderId）
    readers: List[str] = field(default_factory=list)

@dataclass
class Message:
    msgId: str
    seq: int
    channel: str
    author: str
    ts: int
    body: str
    mentions: List[str] = field(default_factory=list)
    replyTo: Optional[str] = None

@dataclass
class Holder:
    holderId: str
    name: str
    kind: Literal["agent", "human"]
    sessionId: Optional[str] = None
    lastSeenAt: Optional[int] = None

@dataclass
class StateDocument:
    schemaVersion: int
    seq: int
    claims: List[Claim]
    messages: List[Message]
    holders: List[Holder]

@dataclass
class ConflictInfo:
    claimId: str
    holderId: str
    path: str
    overlapsWith: str
    mode: Mode
    expiresAt: int
    holderName: Optional[str] = None
    remainingSec: Optional[int] = None
    suggestedAction: Optional[SuggestedAction] = None

@dataclass
class TeamScopeTask:
    # 官方 Agent Teams 任务的只读视图（数据由 dsh-experimental-agent-team 拥有，非本插件状态）
    id: str
    status: Literal["pending", "in_progress", "completed", "deleted"]
    writeScopes: List[str]
    subject: Optional[str] = None
    ownerName: Optional[str] = None

@dataclass
class TeamScopeOverlap:
    # 团队任务写域与 collab_lock 声明的重叠（advisory 交叉预警，不改变任何门控）
    taskId: str
    scope: str
    path: str
    subject: Optional[str] = None
