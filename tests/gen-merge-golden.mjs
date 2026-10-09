// tests/gen-merge-golden.mjs
//
// **黄金语料生成器**（单元 D）：把 `mergeDocs` 的行为固化成
// `tests/fixtures/merge-golden.json` —— 若干 `{name, a, b, expected}` 三元组。
//
// 为什么需要它：`mergeDocs` 有**两份实现**（TS 的 src/collab-core.ts 与 Rust 的
// crates/collab-cli/src/main.rs）。同一算法两份实现一定会漂移，必须机械化防：语料由 TS
// 实现现算 `expected`，两侧各自断言"我的输出与 expected 逐字节相同"。
//   · TS 改了而语料没重跑 ⇒ tests/collab-merge-golden.mjs 红；
//   · 重跑了而 Rust 没跟上 ⇒ Rust 侧 test_merge_golden_corpus_matches_ts 红。
//
// **一键重跑**：`npm run build && node tests/gen-merge-golden.mjs`
// （必须先 build：语料从构建产物 lib/collab-core.js 现算，与测试读的是同一份实现。）
//
// 覆盖面（每类都由下面的用例显式构造）：重复 id、半更新（同一条记录只更新部分字段）、
// 墓碑、空文档、撞 seq 不同写者、readers/paths 求并、`readable` false 优先、规范序排序、
// createdAt 取小、holders/messages 逐字段 join、顶层 seq/writer 取大。
//
// 纪律：语料里的每条 claim 都**显式**带齐 `readable` / `readers` / `seq` / `writer`
// （以及 holderName / note）。原因：Rust 的这几个字段不是 `Option`，它序列化时总会写出默认值；
// 语料不给的话 TS 会省略这些键、Rust 会写出默认值，字节比较必然不等 —— 那是**语料造得不合法**，
// 不是实现漂移。Rust 的字段顺序（与 TS normalizeDoc 的插入顺序）也是判据的一部分。

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mergeDocs } from '../lib/collab-core.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'fixtures', 'merge-golden.json')

// ---------------------------------------------------------------- 文档构造
const claim = (o = {}) => Object.assign({
  claimId: 'c_1@wA',
  holderId: 'agent:A',
  holderName: 'A',
  paths: ['src/a/'],
  mode: 'exclusive',
  ttlSec: 1800,
  expiresAt: 10000,
  createdAt: 9000,
  note: '',
  readable: true,
  readers: [],
  seq: 1,
  writer: 'wA'
}, o)

const msg = (o = {}) => Object.assign({
  msgId: 'm_1@wA',
  seq: 1,
  channel: 'general',
  author: 'agent:A',
  ts: 1000,
  body: 'hi',
  writer: 'wA'
}, o)

const holder = (o = {}) => Object.assign({ holderId: 'agent:A', name: 'A', kind: 'agent' }, o)

const doc = (o = {}) => Object.assign({
  schemaVersion: 1,
  seq: 0,
  writer: '',
  claims: [],
  messages: [],
  holders: [],
  released: {}
}, o)

// ---------------------------------------------------------------- 用例
const cases = [
  {
    name: 'empty-both',
    a: doc(),
    b: doc()
  },
  {
    name: 'duplicate-id-half-update-expiresAt',
    // 同一条声明两边各写了一半：expiresAt 只在 a 里更新过，a 的 readers 为空。
    a: doc({ claims: [claim({ expiresAt: 12000, readers: [] })] }),
    b: doc({ claims: [claim({ expiresAt: 10000, readers: ['agent:B'] })], seq: 1, writer: 'wB' })
  },
  {
    name: 'half-update-paths-readers-union',
    a: doc({ claims: [claim({ paths: ['src/a/'], readers: ['agent:X'] })] }),
    b: doc({ claims: [claim({ paths: ['src/b/'], readers: ['agent:Y'] })] })
  },
  {
    name: 'createdAt-takes-min',
    a: doc({ claims: [claim({ createdAt: 9000 })] }),
    b: doc({ claims: [claim({ createdAt: 8000 })] })
  },
  {
    name: 'tombstone-beats-claim',
    // 一边已经 release（墓碑），另一边还握着旧副本的那条声明 ⇒ 声明被剔除。
    a: doc({ released: { 'c_1@wA': 12000 } }),
    b: doc({ claims: [claim()] })
  },
  {
    name: 'tombstone-value-takes-max',
    a: doc({ released: { 'c_1@wA': 12000, 'c_2@wA': 5000 } }),
    b: doc({ released: { 'c_1@wA': 15000, 'c_3@wA': 8000 } })
  },
  {
    name: 'tombstone-filters-claims-in-same-doc',
    // 同一份文档里既有墓碑又有那条声明（不该发生，但合并必须把它规范化掉）。
    a: doc({ released: { 'c_1@wA': 12000 }, claims: [claim()] }),
    b: doc()
  },
  {
    name: 'seq-collision-two-writers',
    // 两个写者撞上同一个 seq：id 因写者戳不同而都保留，排序按 (seq, writer)。
    a: doc({
      claims: [claim({ claimId: 'c_5@wA', seq: 5, writer: 'wA', paths: ['src/a/'] })],
      seq: 5
    }),
    b: doc({
      claims: [claim({ claimId: 'c_5@wB', seq: 5, writer: 'wB', paths: ['src/b/'] })],
      seq: 5
    })
  },
  {
    name: 'readable-false-wins',
    a: doc({ claims: [claim({ readable: true })] }),
    b: doc({ claims: [claim({ readable: false })] })
  },
  {
    name: 'mode-takes-string-max',
    a: doc({ claims: [claim({ mode: 'exclusive' })] }),
    b: doc({ claims: [claim({ mode: 'shared' })] })
  },
  {
    name: 'unsorted-input-normalized',
    // 输入是乱序的（claims/messages/holders 各不相同）⇒ 输出必须是规范序。
    a: doc({
      claims: [
        claim({ claimId: 'c_3@wA', seq: 3, writer: 'wA', paths: ['src/c/'] }),
        claim({ claimId: 'c_1@wA', seq: 1, writer: 'wA', paths: ['src/a/'] }),
        claim({ claimId: 'c_2@wB', seq: 2, writer: 'wB', paths: ['src/b/'] })
      ],
      messages: [
        msg({ msgId: 'm_3@wA', seq: 3, body: 'third' }),
        msg({ msgId: 'm_1@wA', seq: 1, body: 'first' })
      ],
      holders: [holder({ holderId: 'agent:C' }), holder({ holderId: 'agent:A' })],
      seq: 3
    }),
    b: doc()
  },
  {
    name: 'holders-join-lastSeen-proc',
    a: doc({ holders: [holder({ holderId: 'agent:A', name: 'A', lastSeenAt: 100 })] }),
    b: doc({ holders: [holder({ holderId: 'agent:A', name: 'Z', lastSeenAt: 200, sessionId: 's1', proc: 'p1' })] })
  },
  {
    name: 'holders-different-ids-sorted',
    a: doc({ holders: [holder({ holderId: 'agent:B', name: 'B' })] }),
    b: doc({ holders: [holder({ holderId: 'agent:A', name: 'A' })] })
  },
  {
    name: 'messages-collision-and-distinct',
    // 同 msgId 两半（seq/body 各有一半）+ 不同 msgId 撞 seq。
    a: doc({
      messages: [
        msg({ msgId: 'm_1@wA', seq: 1, body: 'aa', writer: 'wA' }),
        msg({ msgId: 'm_2@wA', seq: 2, body: 'a2', writer: 'wA' })
      ],
      seq: 2
    }),
    b: doc({
      messages: [
        msg({ msgId: 'm_1@wA', seq: 1, body: 'zz', writer: 'wA' }),
        msg({ msgId: 'm_2@wB', seq: 2, body: 'b2', writer: 'wB' })
      ],
      seq: 2
    })
  },
  {
    name: 'top-level-seq-writer-take-max',
    a: doc({ seq: 3, writer: 'wA' }),
    b: doc({ seq: 7, writer: 'wB' })
  },
  {
    name: 'mixed-everything',
    a: doc({
      seq: 9,
      writer: 'wA',
      claims: [
        claim({ claimId: 'c_9@wA', seq: 9, writer: 'wA', paths: ['src/z/'] }),
        claim({ claimId: 'c_4@wA', seq: 4, writer: 'wA', paths: ['src/a/'], readable: true })
      ],
      messages: [msg({ msgId: 'm_9@wA', seq: 9, body: 'nine' })],
      holders: [holder({ holderId: 'agent:A', lastSeenAt: 10 })],
      released: { 'c_7@wB': 30000 }
    }),
    b: doc({
      seq: 8,
      writer: 'wB',
      claims: [
        claim({ claimId: 'c_4@wA', seq: 4, writer: 'wA', paths: ['src/b/'], readable: false, readers: ['agent:X'] }),
        claim({ claimId: 'c_8@wB', seq: 8, writer: 'wB', paths: ['src/y/'] })
      ],
      messages: [msg({ msgId: 'm_9@wA', seq: 9, body: 'nine' })],
      holders: [holder({ holderId: 'agent:A', name: 'Z', lastSeenAt: 20 })],
      released: { 'c_7@wB': 25000 }
    })
  }
]

// ---------------------------------------------------------------- 现算 + 落盘
const out = {
  note:
    '黄金语料（单元 D）：由 tests/gen-merge-golden.mjs 从 lib/collab-core.js 的 mergeDocs ' +
    '现算生成，勿手改。expected 是 TS JSON.stringify 的**逐字节**输出；TS 与 Rust 两侧都断言 ' +
    '自己产出与它相同。重跑：npm run build && node tests/gen-merge-golden.mjs',
  cases: cases.map((c) => ({
    name: c.name,
    a: c.a,
    b: c.b,
    expected: JSON.stringify(mergeDocs(c.a, c.b))
  }))
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
console.log('wrote ' + OUT + ' (' + out.cases.length + ' cases)')
