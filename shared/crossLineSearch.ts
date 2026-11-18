/**
 * 跨行正则匹配（方案 §3.1）
 * Monaco 的 findMatches 逐行扫描，正则里的 `\n` 永远跨不过行；
 * 这里对全文跑一遍正则，返回相对全文的 UTF-16 偏移，跨行区间由调用侧换算成 Monaco 位置。
 * 整词边界与 Monaco 的 findMatches 同口径（分隔符字符 + 空格/制表符 + 换行）。
 */
export interface MultilineMatch {
  /** 相对全文的起始偏移 */
  index: number
  /** 匹配长度（UTF-16 code unit） */
  length: number
  /** [0] 是整个匹配，[1..] 是捕获组 */
  groups: string[]
}

/**
 * 全文正则扫描。
 * - `m` 标志复刻 Monaco 逐行搜索时的 ^ / $ 语义；
 * - `u` 与现有正则校验保持一致（编译失败由调用侧捕获，按「正则无效」处理）；
 * - 零长度命中直接跳过并强制前进，避免死循环（与旧的「过滤空区间」口径一致）。
 */
export function searchMultilineRegex(
  text: string,
  pattern: string,
  matchCase: boolean,
  wordSeparators: string | null
): MultilineMatch[] {
  const regex = new RegExp(pattern, matchCase ? 'gmu' : 'gimu')
  const separatorCodes = wordSeparators === null ? null : buildSeparatorCodes(wordSeparators)
  const results: MultilineMatch[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const value = match[0]
    if (value.length === 0) {
      regex.lastIndex = match.index + 1
      continue
    }
    if (separatorCodes && !isWholeWord(text, match.index, value.length, separatorCodes)) {
      continue
    }
    results.push({ index: match.index, length: value.length, groups: match.slice() })
  }
  return results
}

/** 与 Monaco 的 WordCharacterClassifier 一致：传入的分隔符 + 空格 + 制表符（换行单独判） */
function buildSeparatorCodes(wordSeparators: string): Set<number> {
  const codes = new Set<number>([9, 32])
  for (let i = 0; i < wordSeparators.length; i++) codes.add(wordSeparators.charCodeAt(i))
  return codes
}

/** 复刻 Monaco 的 isValidMatch：两侧是分隔符/换行/文档边界，或匹配自身首尾就是分隔符 */
function isWholeWord(
  text: string,
  start: number,
  length: number,
  separatorCodes: Set<number>
): boolean {
  const end = start + length
  return (
    leftIsWordBoundary(text, start, length, separatorCodes) &&
    rightIsWordBoundary(text, end, length, separatorCodes)
  )
}

function leftIsWordBoundary(
  text: string,
  start: number,
  length: number,
  separatorCodes: Set<number>
): boolean {
  if (start === 0) return true
  const before = text.charCodeAt(start - 1)
  if (separatorCodes.has(before)) return true
  if (before === 13 || before === 10) return true
  if (length > 0 && separatorCodes.has(text.charCodeAt(start))) return true
  return false
}

function rightIsWordBoundary(
  text: string,
  end: number,
  length: number,
  separatorCodes: Set<number>
): boolean {
  if (end === text.length) return true
  const after = text.charCodeAt(end)
  if (separatorCodes.has(after)) return true
  if (after === 13 || after === 10) return true
  if (length > 0 && separatorCodes.has(text.charCodeAt(end - 1))) return true
  return false
}
