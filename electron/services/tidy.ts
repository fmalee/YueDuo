import iconv from 'iconv-lite'
import { DEFAULT_RULES } from '../../shared/findRules'
import type { TidyResult } from '../../shared/types'
import { toSimplified } from './chineseConvert'
import { toHalfwidth } from './textConvert'
import { WORK_ENCODING } from './textCodec'

/**
 * 一键整理（方案 §3.2）固定顺序：
 * 1. 归一换行 + 工作编码 UTF-16LE 往返（保存安全的前置处理，不进规则表）
 * 2. 繁转简（含保护词）
 * 3. 全角转半角（以 to_halfwidth 的 pattern 为准，走 textConvert）
 * 4. 按 shared/findRules.ts 数组顺序执行 tidyEnabled 的规则
 * 规则顺序即整理顺序；缺少替换文本的条目跳过并记 warning，不让整次整理失败。
 */
const TIDY_STEPS: { key: string; pattern: RegExp; replacement: string }[] = []
for (const rule of DEFAULT_RULES) {
  if (!rule.tidyEnabled) continue
  if (rule.replacement === null) {
    console.warn(`[tidy] 规则「${rule.key}」已开启整理但没有替换文本，已跳过`)
    continue
  }
  TIDY_STEPS.push({
    key: rule.key,
    pattern: new RegExp(rule.pattern, 'gm'),
    replacement: rule.replacement
  })
}

function normalizeEncoding(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // 与 Python encode(WORK_ENCODING, errors='replace').decode 同口径：临时往返一次
  return iconv.decode(iconv.encode(normalized, WORK_ENCODING), WORK_ENCODING)
}

export function tidyText(text: string): TidyResult {
  let result = normalizeEncoding(text)
  const converted = toSimplified(result)
  result = toHalfwidth(converted.text).text
  for (const step of TIDY_STEPS) result = result.replace(step.pattern, step.replacement)
  return {
    text: result,
    convertKept: converted.kept,
    convertKeptWords: converted.keptWords
  }
}
