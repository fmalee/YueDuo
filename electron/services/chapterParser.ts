import type { ChapterInfo } from '../../shared/types'

/**
 * 章节提取（方案 §2.6）：正则与 Python `tidy_rules.EXTRACT_CHAPTERS` 逐字一致，
 * 按行匹配「第…章/回/节/卷/集/部/篇」及序章/楔子/卷首/尾声/后记/番外。
 * 纯 Node 实现，可独立单测；不做全文结构化，只返回标题行与行号供右栏跳转。
 */
const CHAPTER_PATTERN =
  /^[ \t\u3000]*(?:第[0-9零〇一二三四五六七八九十百千万两]+[章回节卷集部篇][^\n]*|序章[^\n]*|楔子[^\n]*|卷首[^\n]*|尾声[^\n]*|后记[^\n]*|番外[^\n]*)$/

export function parseChapters(text: string): ChapterInfo[] {
  const chapters: ChapterInfo[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (CHAPTER_PATTERN.test(line)) {
      chapters.push({ title: line.trim(), line: i + 1 })
    }
  }
  return chapters
}
