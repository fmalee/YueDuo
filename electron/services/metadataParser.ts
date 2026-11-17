/**
 * 元数据解析（方案 §2.4，对齐 Python metadata_parser）：
 * - 书名：正文前两行书名号内；否则文件名去后缀
 * - 作者：正文前十行「作者：」；否则「佚名」
 * - 标签：正文前十行「主题：」（逗号/空白分隔）；否则所在目录名
 * - 字数：非空白字符数（不扫全文，只切前 10 行做字段提取）
 * 纯 Node 实现（AGENTS.md：services 不 import Electron），便于脚本单测
 */
import { extname } from 'path'

const TITLE_PATTERN = /《([^》]+)》/
const AUTHOR_PATTERN = /^\s*作者\s*[：:]\s*(.+?)\s*$/
const TAGS_PATTERN = /^\s*主题\s*[：:]\s*(.+?)\s*$/
const TAG_SPLITTER = /[,，\s]+/

export interface ParsedMetadata {
  title: string
  author: string
  tags: string[]
  wordCount: number
}

/** 标签在库内以空格分隔；正文里逗号和空格都算分隔符（对齐 Python split_tags） */
export function splitTags(value: string): string[] {
  return value.split(TAG_SPLITTER).filter(Boolean)
}

function findValue(lines: string[], pattern: RegExp): string | null {
  for (const line of lines) {
    const match = pattern.exec(line)
    if (match) {
      const value = match[1].trim()
      if (value) return value
    }
  }
  return null
}

/** 取正文前十行「主题：」后的原文，供同步 Finder 注释等需要原样的场景使用（对齐 Python find_topic） */
export function findTopic(text: string): string | null {
  return findValue(text.split('\n', 10).slice(0, 10), TAGS_PATTERN)
}

/**
 * 解析单本书的元数据。
 * filename 只用于书名兜底（去最后一个后缀），directoryName 只用于标签兜底，均取文件名而非路径。
 */
export function parseMetadata(
  text: string,
  filename: string,
  directoryName: string
): ParsedMetadata {
  // 只切前 10 行，不扫描全文；元数据约定都位于开头
  const lines = text.split('\n', 10).slice(0, 10)

  let title: string | null = null
  for (const line of lines.slice(0, 2)) {
    const match = TITLE_PATTERN.exec(line)
    if (match) {
      title = match[1].trim()
      break
    }
  }

  const tagsText = findValue(lines, TAGS_PATTERN)
  const tags = tagsText ? splitTags(tagsText) : directoryName ? [directoryName] : []
  const author = findValue(lines, AUTHOR_PATTERN) ?? '佚名'
  // Python Path.stem 口径：只去最后一个后缀，'.txt' 这类无主名的点文件保留原名
  const suffix = extname(filename)
  const stem = suffix ? filename.slice(0, -suffix.length) : filename

  return {
    title: title || stem,
    author,
    tags,
    // Python 口径：len("".join(text.split()))，空行与全角缩进都不计
    wordCount: text.replace(/\s+/g, '').length
  }
}
