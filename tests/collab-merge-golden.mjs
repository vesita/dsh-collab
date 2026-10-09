// tests/collab-merge-golden.mjs
//
// 黄金语料守卫（单元 D，TS 侧）：`mergeDocs` 有两份实现（TS 与 Rust），靠
// `tests/fixtures/merge-golden.json` 机械化防漂移。本文件断言 TS 的产出与语料
// `expected` **逐字节相同**；Rust 侧在 crates/collab-cli/src/main.rs 的
// `test_merge_golden_corpus_matches_ts` 里断言同一件事。
//
// 语料由 `tests/gen-merge-golden.mjs` 从 lib/collab-core.js 现算生成。改了 TS 的 mergeDocs
// 而没重跑生成器 ⇒ 本文件红（expected 还是旧的）；重跑了而 Rust 没跟上 ⇒ Rust 测试红。
//
// 另配两项独立检查：
//   · 交换律（mergeDocs(a,b) 与 mergeDocs(b,a) 逐字节相同）—— 语料的 expected 同时是这一条的判据；
//   · **负向对照**：把"逐字段 join"退回"整条取键大的"⇒ 语料确实能抓到它（半更新用例必红）。
//
// 运行：node tests/collab-merge-golden.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHarness } from './_harness.mjs'
import { mergeDocs, normalizeDoc } from '../lib/collab-core.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'merge-golden.json')

const h = createHarness()
const { ok } = h

const show = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s === undefined ? String(v) : (s.length > 260 ? s.slice(0, 260) + '…' : s)
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const cases = Array.isArray(fixture.cases) ? fixture.cases : []

ok(cases.length >= 12, '黄金语料至少 12 个用例（重复 id / 半更新 / 墓碑 / 空文档 / 撞 seq / 求并 / readable false / 规范序）', show(cases.length))

const names = []
for (const c of cases) {
  ok(typeof c.name === 'string' && c.name.length > 0, '用例有名字', show(c))
  ok(typeof c.expected === 'string', `语料「${c.name}」的 expected 是序列化字符串（逐字节比较的前提）`, show(c.expected))
  const got = JSON.stringify(mergeDocs(c.a, c.b))
  ok(got === c.expected, `语料「${c.name}」：TS 的 mergeDocs 产出与语料逐字节相同`,
    got === c.expected ? undefined : 'got=' + show(got) + ' expected=' + show(c.expected))
  const swapped = JSON.stringify(mergeDocs(c.b, c.a))
  ok(swapped === c.expected, `语料「${c.name}」：交换律（b,a 与 a,b 逐字节相同）`,
    swapped === c.expected ? undefined : 'got=' + show(swapped) + ' expected=' + show(c.expected))
  names.push(c.name)
}
ok(new Set(names).size === names.length, '用例名不重复', show(names))

// 幂等律的语料版：mergeDocs(a, a) 逐字段等于 normalizeDoc(a)。
let idemBad = null
for (const c of cases) {
  if (JSON.stringify(mergeDocs(c.a, c.a)) !== JSON.stringify(normalizeDoc(c.a))) { idemBad = c.name; break }
}
ok(idemBad === null, '幂等律：mergeDocs(a, a) 逐字节等于 normalizeDoc(a)', idemBad)

// ---------------------------------------------------------------- 负向对照
// 「整条取键大的」不是 join：同一条记录两边各更新了一半时，它会把另一份独有的字段整条丢掉。
// 语料必须能抓到这一点，否则它就是一张恒真的表格。
console.log('# 负向对照（RED）：整条取键大的 merge 必须与语料不同')
{
  const wrongMerge = (a, b) => {
    const A = normalizeDoc(a); const B = normalizeDoc(b)
    const at = new Map(A.claims.map((c) => [c.claimId, c]))
    for (const c of B.claims) {
      const cur = at.get(c.claimId)
      // 整条二选一：取 (seq, writer) 大的那条，丢掉另一条独有的字段。
      if (!cur || c.seq > cur.seq || (c.seq === cur.seq && c.writer > cur.writer)) at.set(c.claimId, c)
    }
    return normalizeDoc({
      schemaVersion: 1,
      seq: Math.max(A.seq || 0, B.seq || 0),
      writer: '',
      claims: [...at.values()],
      messages: A.messages,
      holders: A.holders,
      released: A.released
    })
  }
  const target = cases.find((c) => c.name === 'half-update-paths-readers-union')
  ok(!!target, '负向对照的目标用例（半更新：paths/readers 各更新一半）在语料里', show(names))
  if (target) {
    const wrong = JSON.stringify(wrongMerge(target.a, target.b))
    ok(wrong !== target.expected,
      '负向对照（RED）成立：整条取键大的产出与语料不同（语料确实能抓到丢失字段的合并）',
      'wrong=' + show(wrong))
    const right = JSON.stringify(mergeDocs(target.a, target.b))
    ok(right === target.expected, '同一用例上逐字段 join 仍然逐字节相等（红的只有错的那个）', show(right))
  }
}

h.finish()
