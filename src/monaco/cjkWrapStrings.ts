/**
 * 替换 Monaco `base/common/strings.js`：在开关开启时把部分中文标点视为全角。
 * 对本文件内指向原版 strings.js 的导入，Vite 插件按 importer 放行，避免循环。
 * 来源：
 * https://github.com/ssnangua/ColorTxt/blob/main/src/renderer/src/monaco/cjkWrapStrings.ts
 * https://github.com/ssnangua/ColorTxt/blob/main/src/renderer/src/monaco/cjkWrapOptimize.ts
 */
// Monaco 深层 ESM 无配套 .d.ts
export * from '../../node_modules/monaco-editor/esm/vs/base/common/strings.js'
import { isFullWidthCharacter as originalIsFullWidthCharacter } from '../../node_modules/monaco-editor/esm/vs/base/common/strings.js'

export function isFullWidthCharacter(charCode: number): boolean {
  if (isCjkWrapOptimizeFullWidthCodePoint(charCode)) {
    return true
  }

  return originalIsFullWidthCharacter(charCode)
}

/**
 * Monaco 默认 `isFullWidthCharacter` 从 CJK 部首 U+2E80 起算，不含：
 * ASCII 运算/标记符、箭头、General Punctuation、拉丁文 ·×、几何/杂项符号（♡♥☆※ 等）。
 * 中文字体里这些常占约 1em，半角估算会让简单换行右侧溢出。
 */
function isCjkWrapOptimizeFullWidthCodePoint(charCode: number): boolean {
  // # % + - / \ <=> @ | ~
  if (charCode < 0x80) {
    return (
      charCode === 0x23 ||
      charCode === 0x25 ||
      charCode === 0x2b ||
      charCode === 0x2d ||
      charCode === 0x2f ||
      charCode === 0x5c ||
      (charCode >= 0x3c && charCode <= 0x3e) ||
      charCode === 0x40 ||
      charCode === 0x7c ||
      charCode === 0x7e
    )
  }
  // · × ÷（拉丁-1，中文排版常按全角）
  if (charCode === 0x00b7 || charCode === 0x00d7 || charCode === 0x00f7) {
    return true
  }
  // ‐-‒–—―
  if (charCode >= 0x2010 && charCode <= 0x2015) return true
  // ‘’‚‛“”„‟
  if (charCode >= 0x2018 && charCode <= 0x201f) return true
  // †‡•‣․‥…
  if (charCode >= 0x2020 && charCode <= 0x2026) return true
  // ‰‱′″‴‵※‼‾ 及 ‹›
  if (charCode >= 0x2030 && charCode <= 0x203e) return true
  // ←↑→↓ 及对角、双向箭头
  if (charCode >= 0x2190 && charCode <= 0x2199) return true
  // Ⅰ-Ⅻ ⅰ-ⅹ 等 Number Forms
  if (charCode >= 0x2160 && charCode <= 0x2188) return true
  // ①-⑳⑴-⒇⒈-⒛ 等 Enclosed Alphanumerics
  if (charCode >= 0x2460 && charCode <= 0x24ff) return true
  // ⋯ √
  if (charCode === 0x22ef || charCode === 0x221a) return true
  // 盒线 / 方块 / 几何 / 杂项符号（♡♥☆★）/ Dingbats（✲❈✔✘）
  if (charCode >= 0x2500 && charCode <= 0x27bf) return true
  // 竖排标点、CJK 兼容形式（Monaco 默认忽略 FE10–FE4F）
  if (charCode >= 0xfe10 && charCode <= 0xfe4f) return true
  return false
}
