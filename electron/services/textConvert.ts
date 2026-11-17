import { DEFAULT_RULES } from '../../shared/findRules'
import type { ConvertResult } from '../../shared/types'

/**
 * 全角转半角（方案 §3.2）：只换规则表 to_halfwidth 命中的全角字母、数字与加减号。
 * 全角空格是正文缩进依据，中文标点也没有对应半角，两者都不在规则内（对齐 Python text_convert.py）。
 */
const FULLWIDTH_OFFSET = 0xfee0
const TO_HALFWIDTH = DEFAULT_RULES.find((rule) => rule.key === 'to_halfwidth')
if (!TO_HALFWIDTH) throw new Error('规则表缺少 to_halfwidth')
const PATTERN = new RegExp(TO_HALFWIDTH.pattern, 'g')

export function toHalfwidth(text: string): ConvertResult {
  return {
    text: text.replace(PATTERN, (match) =>
      String.fromCharCode((match.codePointAt(0) ?? 0) - FULLWIDTH_OFFSET)
    ),
    kept: 0,
    keptWords: 0
  }
}
