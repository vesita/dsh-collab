"""
collab_models.py
基于 src/schema/collab.schema.json 契约派生的 Python 数据类型定义。
支持使用 uv 直接运行和集成。
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import List, Optional, Literal

Mode = Literal["exclusive", "shared"]
OpLock = Literal["claim", "release", "list", "overview", "status", "heartbeat", "wait"]
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
    preset: Optional[str] = None
    lastSeenAt: Optional[int] = None

@dataclass
class StateDocument:
    schemaVersion: int
    seq: int
    claims: List[Claim] = field(default_factory=list)
    messages: List[Message] = field(default_factory=list)
    holders: List[Holder] = field(default_factory=list)

@dataclass
class Conflict:
    claimId: str
    holderId: str
    path: str
    overlapsWith: str
    mode: Mode
    expiresAt: int
    holderName: Optional[str] = None
    remainingSec: Optional[int] = None
    suggestedAction: Optional[SuggestedAction] = None
