// proc-id.ts
// 进程身份令牌（0.14.0，B2）：把一个**跨进程可核验**的身份钉在名册行上。
//
// 令牌形如 `<pid>:<starttime>`，starttime 取 `/proc/<pid>/stat` 第 22 字段（自开机起的时钟节拍）。
// 为什么必须带 starttime：pid 会被内核复用，只比 pid 会把"新进程顶了旧 pid"误判成
// "旧进程还活着" —— 那正好是 fail-safe 的反方向（留着死行）。starttime 不同即两个进程。
//
// fail-closed（与 collab-core 的 reap 同一条纪律）：
//   · 判据不可用（非 Linux：没有 /proc）⇒ `liveProcsOf` 返回 null，接线层据此**一个也不收**；
//   · 读不到某个 pid 的 stat ⇒ 该 pid 视为**不在**（这是 Linux 上进程已退场的正常形态）；
//   · 解析不出 starttime ⇒ 该 pid 也视为不在。
// 漏收只是维持现状（退回 24h TTL），误收会让活会话的名册行消失。

import { existsSync, readFileSync } from 'node:fs'

/** 判据是否可用：本机有 /proc（Linux）。没有 ⇒ 退回保守路径。 */
export function procJudgeAvailable(): boolean {
  try {
    return existsSync('/proc/self')
  } catch (e) {
    return false
  }
}

/**
 * 读 `<pid>` 的 starttime（`/proc/<pid>/stat` 第 22 字段）。
 * 解析要点：comm（第 2 字段）可以含空格与括号，所以从**最后一个** `)` 之后开始切；
 * 切出来的第一个 token 是 state（第 3 字段），starttime 是第 22 字段 ⇒ 下标 19。
 */
export function procStartTicks(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const raw = readFileSync('/proc/' + pid + '/stat', 'utf8')
    const close = raw.lastIndexOf(')')
    if (close < 0) return null
    const rest = raw.slice(close + 2).split(' ')
    const v = rest[19]
    return typeof v === 'string' && /^\d+$/.test(v) ? v : null
  } catch (e) {
    return null
  }
}

/** 本进程的令牌；拿不到（无 /proc / 解析失败）返回 null ⇒ 接线层不盖章。 */
export function selfProcToken(): string | null {
  const pid = process.pid
  const ticks = procStartTicks(pid)
  return ticks === null ? null : pid + ':' + ticks
}

/**
 * 一组令牌里，哪些的进程**此刻还活着**。
 * 返回 `null` = 判据不可用（一个也不许收）；空数组 / 全部不在 ⇒ 返回空 Set（判据可用）。
 *
 * **必须逐令牌判，不能按 pid 去重**（2026-10 审计抓到的真缺陷）：去重键是 pid、判活键是
 * `pid:starttime`，而 pid 会被内核复用 —— 文件里同时存在同一 pid 的两个令牌时（进程被杀、
 * pid 被新进程顶上，旧行还在文件里），按 pid 去重只会核验**排在最前面的那一个**：
 * 若它是旧令牌 ⇒ 不加入活集，而**真正活着**的那个被跳过 ⇒ 活名册行被 sweep 当死行删掉。
 * 正确做法是：`/proc/<pid>/stat` 每个 pid 只读一次（缓存），但**每个令牌都各自比对**。
 */
export function liveProcsOf(tokens: string[]): Set<string> | null {
  if (!procJudgeAvailable()) return null
  const out = new Set<string>()
  const ticksByPid = new Map<number, string | null>()
  for (const tok of tokens) {
    if (typeof tok !== 'string') continue
    const cut = tok.indexOf(':')
    if (cut <= 0) continue
    const pid = Number(tok.slice(0, cut))
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!ticksByPid.has(pid)) ticksByPid.set(pid, procStartTicks(pid))
    const ticks = ticksByPid.get(pid)
    if (ticks !== null && ticks !== undefined && tok.slice(cut + 1) === ticks) out.add(tok)
  }
  return out
}
