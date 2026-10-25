"""
collab_models.py
基于 src/schema/collab.schema.json 契约派生的 Python 数据类型定义。
支持使用 uv 直接运行和集成。
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import List, Optional, Literal

Mode = Literal["exclusive", "shared", "read"]
OpLock = Literal["claim", "release", "list", "overview", "status", "wait", "reap"]
OpBoard = Literal["post", "read"]
SuggestedAction = Literal["wait", "negotiate", "switch_path"]

@dataclass
class Claim:
    claimId: str
    holderId: str
    paths: List[str]
    mode: Mode
    createdAt: int
    holderName: Optional[str] = None
    note: Optional[str] = None
    # 0.8.0：可读性（默认 True；缺字段的老状态文件即"可读"）
    readable: bool = True
    # 单元 C：Lamport 序号 + 写者戳（id = c_<seq>@<writer>；两个写者撞 seq 也不撞 id）
    seq: int = 0
    writer: str = ""
    # 0.2.9：写这条声明的进程身份令牌（<pid>:<开机节拍>）。自动回收的第二证据 ——
    # oracle 说持有者不活了 + 这个进程确实不在了，两条同时成立才删锁。老状态文件没有它。
    proc: str = ""

@dataclass
class Message:
    msgId: str
    seq: int
    channel: str
    author: str
    ts: int
    # 正文上限 8000 字符（SSOT $defs.Message.properties.body.maxLength；
    # 同值常量见 collab-core 的 MESSAGE_BODY_MAX_CHARS；超限由 post() 以 bad-request 挡回，不截断）
    body: str
    replyTo: Optional[str] = None
    # 单元 C：写者戳（msgId = m_<seq>@<writer>）
    writer: str = ""
    # 条目类型：缺省 note = 普通留言（老写法行为逐字节不变）
    kind: Literal["note", "handoff", "handoff-accept"] = "note"
    # 仅 kind=handoff 时有值
    handoff: Optional["Handoff"] = None


@dataclass
class Handoff:
    status: Literal["draft", "final"]
    items: list["HandoffItem"]
    # 接手者 holderId：只由接手方写，有值者胜
    acceptedBy: Optional[str] = None
    acceptedAt: Optional[int] = None


@dataclass
class HandoffItem:
    text: str
    status: Literal["done", "unverified", "blocked"]
    # status=done 时必填
    negativeControl: Optional["NegativeControl"] = None
    # status=blocked 时必填
    reason: Optional[str] = None
    claim: Optional["HandoffClaim"] = None


@dataclass
class NegativeControl:
    command: str
    became: str


@dataclass
class HandoffClaim:
    strength: Literal["measured", "inferred"]
    evidence: Optional[str] = None

@dataclass
class Holder:
    holderId: str
    name: str
    kind: Literal["agent", "human"]
    sessionId: Optional[str] = None
    lastSeenAt: Optional[int] = None
    proc: Optional[str] = None

@dataclass
class StateDocument:
    schemaVersion: int
    seq: int
    claims: List[Claim]
    messages: List[Message]
    holders: List[Holder]
    # 单元 C：最后一次落盘的写者戳（写后验证用）+ 终态墓碑表（claimId -> 该声明的 Lamport seq）
    writer: str = ""
    released: dict = field(default_factory=dict)

@dataclass
class ConflictInfo:
    claimId: str
    holderId: str
    path: str
    overlapsWith: str
    mode: Mode
    holderName: Optional[str] = None
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
