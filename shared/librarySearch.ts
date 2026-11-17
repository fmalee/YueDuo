import type { LibraryBook } from './types'

/**
 * 快速检索匹配（方案 §2.12）：口径为「空白切词、每词都要命中」，
 * 排序沿用 Python `library_search._match_score` 的字段优先级；
 * 多词时对每个词的字段分求和，同分保持快照顺序（最近阅读在前）。
 */
export const PALETTE_LIMIT = 50
/** 空输入默认列表比查询结果短，避免一打开就是一屏长列表（对齐 Python） */
export const PALETTE_EMPTY_LIMIT = 20

/** 检索快照条目：只存展示字段与预转换的小写副本，输入时不重复转换 */
export interface PaletteEntry {
  path: string
  title: string
  author: string
  tags: string[]
  wordCount: number
  lastReadAt: number
  titleLower: string
  authorLower: string
  tagsLower: string[]
}

/** 书库快照 → 检索条目（每次唤出面板读一遍库，以后只在内存里过滤） */
export function buildPaletteEntries(books: readonly LibraryBook[]): PaletteEntry[] {
  return books.map((book) => ({
    path: book.path,
    title: book.title,
    author: book.author,
    tags: book.tags,
    wordCount: book.wordCount,
    lastReadAt: book.lastReadAt,
    titleLower: book.title.toLowerCase(),
    authorLower: book.author.toLowerCase(),
    tagsLower: book.tags.map((tag) => tag.toLowerCase())
  }))
}

/** 单个词的字段分：书名全等 0 → 前缀 1 → 包含 2 → 作者包含 3 → 标签包含 4；未命中 null */
function termScore(entry: PaletteEntry, term: string): number | null {
  if (entry.titleLower === term) return 0
  if (entry.titleLower.startsWith(term)) return 1
  if (entry.titleLower.includes(term)) return 2
  if (entry.authorLower.includes(term)) return 3
  if (entry.tagsLower.some((tag) => tag.includes(term))) return 4
  return null
}

/**
 * 过滤 + 排序：空输入按快照顺序（最近阅读优先）取前 20；
 * 查询词按空白切分，每个词都必须命中某个字段，字段分求和后升序，同分保持快照顺序。
 */
export function queryEntries(
  entries: readonly PaletteEntry[],
  text: string,
  limit = PALETTE_LIMIT
): PaletteEntry[] {
  const query = text.trim().toLowerCase()
  if (!query) return entries.slice(0, Math.min(limit, PALETTE_EMPTY_LIMIT))

  const terms = query.split(/\s+/).filter(Boolean)
  const scored: { score: number; index: number; entry: PaletteEntry }[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    let total = 0
    let matched = true
    for (const term of terms) {
      const score = termScore(entry, term)
      if (score === null) {
        matched = false
        break
      }
      total += score
    }
    if (matched) scored.push({ score: total, index, entry })
  }
  scored.sort((a, b) => a.score - b.score || a.index - b.index)
  return scored.slice(0, limit).map((item) => item.entry)
}
