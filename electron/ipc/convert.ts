import type { ConvertResult, TidyResult } from '../../shared/types'
import { toSimplified, toTraditional } from '../services/chineseConvert'
import { toHalfwidth } from '../services/textConvert'
import { tidyText } from '../services/tidy'

/**
 * 文本转换（方案 §3.2）：右键「转换」组与一键整理共用。
 * 选区/整文范围由渲染层决定，这里只做纯文本进出，全部可撤销由编辑器侧保证。
 */
export function convertHalfwidth(text: string): ConvertResult {
  return toHalfwidth(text)
}

export function convertTraditional(text: string): ConvertResult {
  return toTraditional(text)
}

export function convertSimplified(text: string): ConvertResult {
  return toSimplified(text)
}

export function tidyDocument(text: string): TidyResult {
  return tidyText(text)
}
