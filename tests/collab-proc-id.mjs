// tests/collab-proc-id.mjs
//
// 守护什么
//   src/proc-id.ts 是 0.14.0（B2）新引入的**唯一**会碰操作系统的地方：它把「名册行是谁写的」
//   钉到一个跨进程可核验的身份上（`<pid>:<开机节拍>`）。它的判据错了，方向只有两种，都危险：
//     · 把活进程判成死的  ⇒ sweep 会删掉活会话的名册行（信息丢失，下次操作才补回来）；
//     · 把死进程判成活的  ⇒ 死行永远留着（这正是本次要修的那个 bug）。
//   所以这里不测"函数能跑"，只测**真实 /proc 上可判定的三件事**：
//     ① 自进程令牌与 /proc/self/stat 的第 22 字段逐字一致；
//     ② pid 对但节拍不对 ⇒ **不是**同一个进程（pid 复用防线）；
//     ③ 不可能存在的 pid ⇒ 判为不在（死进程防线）。
//
// 为什么必须在这一层测（不在对拍里）：对拍语料喂的是**假令牌**，它验的是"给定集合怎么筛行"，
// 验不了"这个集合本身算得对不对"。这是两条互补的防线，缺一条就会留下一个盲区。
//
// 运行：node tests/collab-proc-id.mjs   退出码非 0 即失败
// 本文件自包含：不依赖任何既有测试文件，也不改动任何既有文件。

import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label) }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  <-- ' + extra : '')) }
}
const show = (v) => { try { return JSON.stringify(v) } catch (e) { return String(v) } }

const procId = await import(new URL('../lib/proc-id.js', import.meta.url))
const core = await import(new URL('../lib/collab-core.js', import.meta.url))

console.log('# 判据可用性')
ok(procId.procJudgeAvailable() === true, '本机 /proc 可用（Linux）—— 不可用时本测试的后续断言无意义，故显式要求')

// 与内核原文对拍的独立参照实现：不复用 src 的解析路径（否则同一个错误会被两边一起复制）。
const refStartTicks = (pid) => {
  const raw = readFileSync('/proc/' + pid + '/stat', 'utf8')
  const close = raw.lastIndexOf(')')
  return raw.slice(close + 2).split(' ')[19]
}

console.log('\n# ① 自进程令牌 = <pid>:<内核原文节拍>')
{
  const pid = process.pid
  const ref = refStartTicks(pid)
  const tok = procId.selfProcToken()
  ok(typeof tok === 'string', 'selfProcToken() 返回字符串', show(tok))
  ok(tok === pid + ':' + ref, '令牌与 /proc/self/stat 第 22 字段逐字一致', 'got=' + show(tok) + ' want=' + show(pid + ':' + ref))
  // 参照实现与 src 的解析必须一致（comm 里带空格/括号时最容易错位 —— 用一个带括号的进程名验证不了，
  // 但至少验证两边对"普通进程"取值相同；comm 含空格的场景由 lastIndexOf(')') 的写法本身保证）。
  ok(procId.procStartTicks(pid) === ref, 'procStartTicks(pid) 与内核原文一致', show(procId.procStartTicks(pid)))
  ok(/^\d+$/.test(ref), '内核第 22 字段是纯数字', show(ref))
}

console.log('\n# ② 活进程：令牌在 liveProcsOf 里')
{
  const tok = procId.selfProcToken()
  const live = procId.liveProcsOf([tok])
  ok(live instanceof Set, 'liveProcsOf 返回 Set（判据可用）', show(live))
  ok(live !== null && live.has(tok), '自己的令牌活着', show(live && [...live]))
}

console.log('\n# ③ pid 复用防线：pid 对、节拍不对 ⇒ 不是同一个进程')
{
  const pid = process.pid
  const bogus = pid + ':0'
  const live = procId.liveProcsOf([bogus])
  ok(live instanceof Set && !live.has(bogus),
    '同 pid 但节拍为 0 ⇒ 判为不在（否则新进程顶了旧 pid 会把死行当活行留着）', show(live && [...live]))
}

console.log('\n# ③b 同一 pid 的**两个**令牌必须各自判（不能按 pid 去重）')
{
  // 现场形态：进程被杀、pid 被新进程顶上，而旧行还留在文件里 ⇒ state 同时含
  // `<pid>:<旧节拍>` 与 `<pid>:<新节拍>`。按 pid 去重只会核验排在前面的那一个，
  // 旧令牌在前时**活着**的令牌就被跳过 ⇒ 活名册行被 sweep 当死行删掉。
  const pid = process.pid
  const liveTok = procId.selfProcToken()
  const staleTok = pid + ':0'
  for (const [label, arr] of [['旧令牌在前', [staleTok, liveTok]], ['活令牌在前', [liveTok, staleTok]]]) {
    const got = procId.liveProcsOf(arr)
    ok(got instanceof Set && got.has(liveTok) && !got.has(staleTok),
      label + ' ⇒ 活令牌都必须在集合里（顺序无关）', show(got && [...got]))
  }
  // 端到端：sweep 不能把活那一行删掉。
  const T = Date.now()
  const s = {
    schemaVersion: 1, seq: 0, claims: [], messages: [],
    holders: [
      { holderId: 'agent:OLD', name: 'old', kind: 'agent', sessionId: 'o', lastSeenAt: T - 1000, proc: staleTok },
      { holderId: 'agent:LIVE', name: 'live', kind: 'agent', sessionId: 'l', lastSeenAt: T - 1000, proc: liveTok }
    ]
  }
  const r = core.sweep(s, T, { liveProcs: procId.liveProcsOf(s.holders.map((h) => h.proc)), procStamping: true })
  ok(s.holders.map((h) => h.holderId).join(',') === 'agent:LIVE' && r.prunedHolders === 1,
    '同 pid 复用场景下 sweep 只收走旧令牌那一行，活的那行留下', s.holders.map((h) => h.holderId).join(',') + ' pruned=' + r.prunedHolders)
}

console.log('\n# ④ 死进程防线：不可能存在的 pid ⇒ 判为不在')
{
  // 4294967294 > /proc/sys/kernel/pid_max 的上限（上限最大 2^22），/proc 下必然没有它。
  const dead = '4294967294:1'
  const live = procId.liveProcsOf([dead])
  ok(live instanceof Set && !live.has(dead), '不存在的 pid ⇒ 不在活体集合里', show(live && [...live]))
}

console.log('\n# ⑤ 与 sweep 的真实联动：死进程的行被删、活进程的行被留')
{
  const T = Date.now()
  const me = procId.selfProcToken()
  const mk = () => ({
    schemaVersion: 1, seq: 0, claims: [], messages: [],
    holders: [
      { holderId: 'agent:ME', name: 'me', kind: 'agent', sessionId: 'me', lastSeenAt: T - 1000, proc: me },
      { holderId: 'agent:GHOSTPROC', name: 'ghost', kind: 'agent', sessionId: 'gp', lastSeenAt: T - 1000, proc: '4294967294:1' },
      { holderId: 'agent:LEGACY', name: 'legacy', kind: 'agent', sessionId: 'lg', lastSeenAt: T - 1000 }
    ]
  })
  const s = mk()
  const opt = { liveProcs: procId.liveProcsOf(s.holders.map((h) => h.proc).filter(Boolean)), procStamping: true }
  const r = core.sweep(s, T, opt)
  const ids = s.holders.map((h) => h.holderId).join(',')
  ok(ids === 'agent:ME', '只留下活进程的那一行（死进程行与无章旧行都被收）', ids)
  ok(r.prunedHolders === 2, 'sweep 如实报出收掉了 2 行', String(r.prunedHolders))
  // 反向对照：判据不可用（liveProcs=null）时，带 proc 的行**一个也不许收**。
  const s2 = mk()
  core.sweep(s2, T, { liveProcs: null, procStamping: true })
  ok(s2.holders.map((h) => h.holderId).join(',') === 'agent:ME,agent:GHOSTPROC',
    'liveProcs=null ⇒ 带 proc 的行全留（fail-closed），无章的旧行仍按盖章规则作废',
    s2.holders.map((h) => h.holderId).join(','))
}

console.log('\n' + (fail === 0 ? 'ALL PASS: ' + pass + ' passed, 0 failed' : 'FAILURES: ' + pass + ' passed, ' + fail + ' failed'))
process.exit(fail === 0 ? 0 : 1)
