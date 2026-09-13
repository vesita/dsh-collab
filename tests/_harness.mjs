// tests/_harness.mjs
// dsh-collab 测试共享脚手架（⑨ 去重）。
//
// 这 9 个 collab-*.mjs 过去各自复制同一段脚手架：
//     let pass = 0, fail = 0[, skipped = 0]
//     const ok = (cond, label, extra) => { ... }
//     const skip = (label) => { ... }
//     console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed[, N skipped]`)
//     process.exit(fail === 0 ? 0 : 1)
// 现在统一从这里取。**输出格式逐字节保持不变**（见 tests/README 或 commit message 里
// 的 before/after 日志 diff），否则就是在悄悄改断言口径。
//
// ⑷ 静默跳过政策：跳过默认是**失败**。
//   历史缺陷：`skip()` 只把 skipped++，退出码只看 fail ⇒ 真身对拍根本没跑，却报 ALL PASS。
//   现在只有操作者显式设置 COLLAB_ALLOW_SKIP=1 才允许跳过，且必须打印"未验证"横幅。
//
// 用法：
//   import { createHarness } from './_harness.mjs'
//   const h = createHarness()                 // 无 skipped 变体
//   const h = createHarness({ skipped: true })// 汇总行带 ", N skipped" 的变体
//   const { ok } = h
//   ...
//   h.finish()                                // 打印汇总 + process.exit

/** 只有显式 COLLAB_ALLOW_SKIP=1 才允许跳过；其余一律按失败计。 */
export const ALLOW_SKIP = process.env.COLLAB_ALLOW_SKIP === '1'

const BAR = '='.repeat(72)

/**
 * 打印"这次运行有东西没被验证"的醒目横幅。含"未验证"字样，必须出现。
 * @param {string} what 被跳过的内容描述
 */
export function printSkipBanner (what) {
  console.log('')
  console.log(BAR)
  console.log('!!  未验证：本次运行跳过了断言（COLLAB_ALLOW_SKIP=1 显式放行）')
  console.log('!!  跳过项：' + what)
  console.log('!!  跳过的内容**不代表通过**；默认模式与 CI 一律把跳过当作失败。')
  console.log(BAR)
  console.log('')
}

/**
 * 统一的"跳过或失败"决策，供自带 harness 的测试（collab-e2e.mjs）复用。
 * @param {string} what 被跳过的内容描述
 * @returns {boolean} true = 已被操作者显式放行（调用方按"跳过"处理）；false = 调用方必须按失败处理
 */
export function skippedOrRejected (what) {
  if (ALLOW_SKIP) {
    printSkipBanner(what)
    console.log('SKIPPED: ' + what)
    return true
  }
  console.log('')
  console.log(BAR)
  console.log('!!  拒绝静默跳过：' + what)
  console.log('!!  跳过的断言等于未验证，默认按**失败**计。')
  console.log('!!  确需在本机放行，请设置 COLLAB_ALLOW_SKIP=1（会打印未验证横幅）。')
  console.log(BAR)
  console.log('')
  return false
}

/**
 * 创建一套计数器 + ok/skip/summary/finish。
 * @param {{ skipped?: boolean, name?: string }} [options]
 *        skipped: true 时汇总行追加 ", N skipped"（保持 readers-push 的历史格式）
 */
export function createHarness (options = {}) {
  const trackSkipped = options.skipped === true
  let pass = 0
  let fail = 0
  let skipped = 0
  let bannerShown = false

  const ok = (cond, label, extra) => {
    if (cond) { pass++; console.log('  ok  ' + label) }
    else { fail++; console.log('  FAIL ' + label + (extra ? '  <-- ' + extra : '')) }
  }

  const skip = (label) => {
    if (ALLOW_SKIP) {
      skipped++
      if (!bannerShown) { bannerShown = true; printSkipBanner(label) }
      console.log('  SKIP ' + label)
      return true
    }
    fail++
    console.log('  FAIL ' + label)
    console.log('        <-- 拒绝静默跳过：该断言未执行 = 未验证。设 COLLAB_ALLOW_SKIP=1 才允许跳过。')
    return false
  }

  const summary = () => {
    const head = fail === 0
      ? (skipped > 0 ? 'ALL PASS (含未验证项)' : 'ALL PASS')
      : 'FAILURES'
    const tail = trackSkipped ? `, ${skipped} skipped` : ''
    return `\n${head}: ${pass} passed, ${fail} failed${tail}`
  }

  const finish = () => {
    console.log(summary())
    process.exit(fail === 0 ? 0 : 1)
  }

  return {
    ok,
    skip,
    summary,
    finish,
    get pass () { return pass },
    get fail () { return fail },
    get skipped () { return skipped }
  }
}
