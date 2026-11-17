import iconv from 'iconv-lite'
import { DEFAULT_RULES } from '../../shared/findRules'
import type { TidyResult } from '../../shared/types'
import { toSimplified } from './chineseConvert'
import { WORK_ENCODING } from './textCodec'

/**
 * 一键整理（方案 §3.2）：固定五步顺序，从 Python `novelmanager/services/tidy.py` 翻译。
 * 顺序变更会影响结果，不要随意调整：
 * 1. 归一换行 + 工作编码 UTF-16LE 往返（确保保存时不会遇到不可编码字符）
 * 2. 制表符 / 半角空格转全角空格
 * 3. 删除段末不可见字符
 * 4. 繁转简（放在规则替换之前，后续规则只按简体写法编写）
 * 5. 执行 tidyEnabled 的规则正则替换
 */

/** 段落末尾除换行符以外的不可见字符（步骤 3，Python `_TRAILING_INVISIBLE` 同款） */
// eslint-disable-next-line no-control-regex -- 整理目标就是这些控制字符
const TRAILING_INVISIBLE = /[ \t\u3000\x0b\x0c\u00a0\u200b-\u200f\ufeff]+$/gm

/** 一键整理只执行显式开启 tidyEnabled 的规则（Python TIDY_RULES：多余空行 + 非法字符） */
const TIDY_RULE_KEYS = ['blank_lines', 'illegal_chars'] as const
const TIDY_RULES = TIDY_RULE_KEYS.map((key) => {
  const rule = DEFAULT_RULES.find((item) => item.key === key)
  if (!rule || rule.replacement === null) throw new Error(`缺少整理规则：${key}`)
  return { pattern: new RegExp(rule.pattern, 'gm'), replacement: rule.replacement }
})

function normalizeEncoding(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // 与 Python encode(WORK_ENCODING, errors='replace').decode 同口径：临时往返一次
  return iconv.decode(iconv.encode(normalized, WORK_ENCODING), WORK_ENCODING)
}

export function tidyText(text: string): TidyResult {
  let result = normalizeEncoding(text)
  result = result.replace(/\t/g, '\u3000').replace(/ /g, '\u3000')
  result = result.replace(TRAILING_INVISIBLE, '')
  const converted = toSimplified(result)
  result = converted.text
  for (const rule of TIDY_RULES) result = result.replace(rule.pattern, rule.replacement)
  return {
    text: result,
    convertKept: converted.kept,
    convertKeptWords: converted.keptWords
  }
}
