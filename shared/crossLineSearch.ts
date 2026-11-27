/**
 * 统一文档搜索与跨行正则匹配（方案 §3.1）
 * 对全文扫描并返回相对全文的 UTF-16 偏移区间，支持纯文本、跨行正则与整词边界（分隔符字符 + 空格/制表符 + 换行）。
 */
export interface MultilineMatch {
  /** 相对全文的起始偏移 */
  index: number
  /** 匹配长度（UTF-16 code unit） */
  length: number
  /** [0] 是整个匹配，[1..] 是捕获组 */
  groups: string[]
}

export interface DocumentSearchMatch {
  from: number
  to: number
  groups: string[] | null
}

export interface DocumentSearchOptions {
  regex: boolean
  matchCase: boolean
  wordSeparators: string | null
}

/**
 * 统一文档搜索入口（纯文本 + 跨行正则），返回相对全文的 UTF-16 偏移区间 [from, to)
 */
export function searchDocument(
  text: string,
  pattern: string,
  options: DocumentSearchOptions
): DocumentSearchMatch[] {
  if (pattern.length === 0) return []

  if (options.regex) {
    return searchMultilineRegex(text, pattern, options.matchCase, options.wordSeparators).map(
      (m) => ({
        from: m.index,
        to: m.index + m.length,
        groups: m.groups
      })
    )
  }

  const separatorCodes =
    options.wordSeparators === null ? null : buildSeparatorCodes(options.wordSeparators)
  const results: DocumentSearchMatch[] = []

  if (options.matchCase) {
    const len = pattern.length
    let pos = 0
    while (pos <= text.length) {
      const idx = text.indexOf(pattern, pos)
      if (idx === -1) break
      if (!separatorCodes || isWholeWord(text, idx, len, separatorCodes)) {
        results.push({ from: idx, to: idx + len, groups: null })
      }
      pos = idx + len
    }
    return results
  }

  // 忽略大小写纯文本：转义正则元字符 + giu 扫描，避免 toLowerCase() 在极少数 Unicode 字符上产生长度偏移
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(escaped, 'giu')
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
    results.push({ from: match.index, to: match.index + value.length, groups: null })
  }
  return results
}

/**
 * 全文正则扫描。
 * - `m` 标志保持逐行 ^ / $ 语义；
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

/** 整词分隔符集合：传入的分隔符 + 空格 + 制表符（换行单独判） */
function buildSeparatorCodes(wordSeparators: string): Set<number> {
  const codes = new Set<number>([9, 32])
  for (let i = 0; i < wordSeparators.length; i++) codes.add(wordSeparators.charCodeAt(i))
  return codes
}

/** 整词边界判定：两侧是分隔符/换行/文档边界，或匹配自身首尾就是分隔符 */
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
