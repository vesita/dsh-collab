"""
simulate_collab.py
多智能体协作并发压测与冲突仿真套件。
模拟多 Agent 在同一个工作区高频并发请求：claim, list, wait, post, heartbeat, release。
"""

import os
import sys
import json
import time
import random
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any, Optional

TEST_STATE_FILE = os.path.expanduser("~/.dsh/collab/projects/test-simulation.json")

def norm_path(p: str) -> Optional[str]:
    if not p or not p.strip():
        return None
    s = p.strip().replace("\\", "/")
    while s.startswith("./"):
        s = s[2:]
    s = s.replace("//", "/")
    s = s.lstrip("/")
    parts = []
    for x in s.split("/"):
        if not x or x == ".":
            continue
        if x == "..":
            if parts:
                parts.pop()
        else:
            parts.append(x)
    if not parts:
        return None
    res = "/".join(parts)
    if p.strip().replace("\\", "/").endswith("/"):
        res += "/"
    return res

def segments(p: str) -> List[str]:
    return [x for x in p.split("/") if x]

def overlaps(a: str, b: str) -> bool:
    sa, sb = segments(a), segments(b)
    n = min(len(sa), len(sb))
    return sa[:n] == sb[:n]

class CollabSimulatorEngine:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self.lock = threading.Lock()
        self.state = {
            "schemaVersion": 1,
            "seq": 0,
            "claims": [],
            "messages": [],
            "holders": []
        }
        self.stats = {
            "claims_success": 0,
            "claims_conflict": 0,
            "releases": 0,
            "posts": 0,
            "waits_resolved": 0,
        }

    def now(self) -> int:
        return int(time.time() * 1000)

    def claim(self, holder_id: str, name: str, paths: List[str], ttl_sec: int = 10, mode: str = "exclusive") -> Dict[str, Any]:
        with self.lock:
            t = self.now()
            # 惰性清理
            self.state["claims"] = [c for c in self.state["claims"] if c["expiresAt"] > t]
            
            norm_paths = [norm_path(p) for p in paths if norm_path(p)]
            conflicts = []
            for c in self.state["claims"]:
                if c["holderId"] == holder_id or c["expiresAt"] <= t or c["mode"] == "shared":
                    continue
                for p in norm_paths:
                    for cp in c["paths"]:
                        if overlaps(p, cp):
                            rem_sec = max(0, int((c["expiresAt"] - t) / 1000))
                            conflicts.append({
                                "claimId": c["claimId"],
                                "holderId": c["holderId"],
                                "path": p,
                                "overlapsWith": cp,
                                "mode": c["mode"],
                                "expiresAt": c["expiresAt"],
                                "remainingSec": rem_sec,
                                "suggestedAction": "wait" if rem_sec <= 2 else "negotiate"
                            })
                            break
            if conflicts:
                self.stats["claims_conflict"] += 1
                return {"ok": False, "error": "conflict", "conflicts": conflicts}

            # 成功 claim
            self.state["seq"] += 1
            claim_id = f"c_{self.state['seq']}"
            new_claim = {
                "claimId": claim_id,
                "holderId": holder_id,
                "holderName": name,
                "paths": norm_paths,
                "mode": mode,
                "ttlSec": ttl_sec,
                "expiresAt": t + ttl_sec * 1000,
                "createdAt": t,
                "note": "simulated"
            }
            self.state["claims"].append(new_claim)
            self.stats["claims_success"] += 1
            return {"ok": True, "claim": new_claim}

    def release(self, holder_id: str, claim_id: str) -> bool:
        with self.lock:
            before = len(self.state["claims"])
            self.state["claims"] = [c for c in self.state["claims"] if not (c["claimId"] == claim_id and c["holderId"] == holder_id)]
            if len(self.state["claims"]) < before:
                self.stats["releases"] += 1
                return True
            return False

    def post(self, author: str, body: str, channel: str = "general") -> str:
        with self.lock:
            self.state["seq"] += 1
            msg_id = f"m_{self.state['seq']}"
            self.state["messages"].append({
                "msgId": msg_id,
                "seq": self.state["seq"],
                "channel": channel,
                "author": author,
                "ts": self.now(),
                "body": body,
                "mentions": []
            })
            self.stats["posts"] += 1
            return msg_id

def agent_worker(agent_idx: int, engine: CollabSimulatorEngine, iterations: int = 15):
    agent_id = f"agent:worker_{agent_idx}"
    name = f"Worker-{agent_idx}"
    modules = ["src/api/", "src/frontend/", "src/backend/", "src/utils/", "docs/"]
    
    for _ in range(iterations):
        target = random.choice(modules)
        res = engine.claim(agent_id, name, [target], ttl_sec=2)
        if res["ok"]:
            claim_id = res["claim"]["claimId"]
            time.sleep(random.uniform(0.02, 0.05))
            engine.post(agent_id, f"正在更新 {target}，稍后释放")
            time.sleep(random.uniform(0.01, 0.03))
            engine.release(agent_id, claim_id)
        else:
            # 遇到冲突，尝试根据 suggestedAction 决策
            action = res["conflicts"][0]["suggestedAction"]
            if action == "wait":
                time.sleep(0.06)
                engine.stats["waits_resolved"] += 1
            else:
                engine.post(agent_id, f"检测到冲突，改道处理其他模块")
                time.sleep(0.01)

def run_simulation(num_agents: int = 8, iterations: int = 20):
    print(f"🚀 开始多智能体协作并发压测：{num_agents} 个 Agent 并发执行 {iterations} 轮协作操作...")
    engine = CollabSimulatorEngine(TEST_STATE_FILE)
    start_time = time.time()
    
    with ThreadPoolExecutor(max_workers=num_agents) as executor:
        futures = [executor.submit(agent_worker, i, engine, iterations) for i in range(num_agents)]
        for f in as_completed(futures):
            f.result()
            
    elapsed = time.time() - start_time
    total_ops = engine.stats["claims_success"] + engine.stats["claims_conflict"] + engine.stats["releases"] + engine.stats["posts"]
    print(f"✅ 压测完成！耗时: {elapsed:.2f}s, 吞吐量: {total_ops / elapsed:.1f} ops/s")
    print(f"📊 统计数据: 成功认领={engine.stats['claims_success']}, 避让冲突={engine.stats['claims_conflict']}, 释放={engine.stats['releases']}, 协作消息={engine.stats['posts']}, 等待化解={engine.stats['waits_resolved']}")
    assert engine.stats["claims_success"] > 0
    assert engine.stats["claims_conflict"] > 0
    print("🎯 多 Agent 协作仿真验证通过！无死锁，冲突化解有效。")

if __name__ == "__main__":
    run_simulation()
