// scripts/inline-source.mjs
//
// 内联前的源码整形规则 —— **构建与守卫共用这一份**，否则"测试比的是另一条规则"。
//
// 动态宿主形态的 `code.host` 是纯文本、不接受 import/打包，所以内联段必须自包含。
// 两段（core / ops）进的是**同一个作用域**，顺序是 core 在前，于是：
//   · core 自身完全自包含；
//   · ops 顶部那条 `import {...} from './collab-core.js'` 在内联后必须消失 —— 名字就在同一个作用域里。

/** 剥掉顶层 `export ` 前缀（只匹配行首，不碰字符串/注释里的 export）。 */
export function stripTopLevelExports (src) {
  return src.replace(/^export /gm, '')
}

/** 剥掉指向另一段内联源码的 import 语句（含多行形式）：两段共享同一个作用域。 */
export function stripCrossModuleImports (src, specifier) {
  const re = new RegExp(
    '^import\\s*(?:type\\s*)?\\{[\\s\\S]*?\\}\\s*from\\s*[\'"]' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"];?[ \\t]*$',
    'gm'
  )
  return src.replace(re, '')
}
