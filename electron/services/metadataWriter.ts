/**
 * 元数据写回（方案 §2.8）：逐行对齐 Python metadata_writer.rewrite_header。
 * 只改正文前 10 行，返回一处最小替换区间，供编辑器一次可撤销编辑应用；
 * 无变化返回 null（避免无意义的 dirty）。纯 Node 实现，便于脚本单测。
 */
import type { MetadataTextEdit } from '../../shared/types'

const TITLE_PATTERN = /《[^》]*》/
const AUTHOR_PATTERN = /^\s*作者\s*[：:]\s*(.*?)\s*$/
const TAGS_PATTERN = /^\s*主题\s*[：:]\s*(.*?)\s*$/
const HEADER_LINES = 10

export interface MetadataWriteFields {
  title?: string | null
  author?: string | null
  tags?: string[] | null
}

/** 书名必须落在前两行才能被解析（对齐 Python _title_line_index） */
function titleLineIndex(lines: string[]): number | null {
  const limit = Math.min(lines.length, 2)
  for (let index = 0; index < limit; index++) {
    if (TITLE_PATTERN.test(lines[index])) return index
  }
  return null
}

function matchingIndex(lines: string[], pattern: RegExp): number | null {
  for (let index = 0; index < lines.length; index++) {
    if (pattern.test(lines[index])) return index
  }
  return null
}

/** 每行行首相对正文的字符偏移（行间固定一个 \n） */
function lineStarts(lines: string[]): number[] {
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  return starts
}

/**
 * 把字段写进正文头部，返回最小替换区间；字段全为 null 或内容无变化时返回 null。
 * 缺失行的补入顺序固定：书名 → 作者（紧随书名行）→ 标签（紧随作者行）。
 */
export function rewriteHeader(text: string, fields: MetadataWriteFields): MetadataTextEdit | null {
  const lines = text.split('\n')
  const oldHeader = lines.slice(0, HEADER_LINES)
  const header = oldHeader.slice()

  let titleIndex = titleLineIndex(header)
  if (fields.title != null) {
    if (titleIndex === null) {
      // 书名必须出现在前两行才能被解析，缺省时补在正文最前面
      header.unshift(`《${fields.title}》`)
      titleIndex = 0
    } else {
      header[titleIndex] = header[titleIndex].replace(TITLE_PATTERN, () => `《${fields.title}》`)
    }
  }

  let authorIndex = matchingIndex(header, AUTHOR_PATTERN)
  if (fields.author != null) {
    const value = `作者：${fields.author}`
    if (authorIndex === null) {
      // 解析只认前 10 行的作者行，紧随书名行补入即可
      const anchor = titleIndex !== null ? titleIndex + 1 : 0
      header.splice(anchor, 0, value)
      authorIndex = anchor
    } else {
      header[authorIndex] = value
    }
  }

  if (fields.tags != null) {
    const tagsIndex = matchingIndex(header, TAGS_PATTERN)
    const value = `主题：${fields.tags.join(',')}`
    if (tagsIndex === null) {
      let anchor = 0
      if (authorIndex !== null) anchor = authorIndex + 1
      else if (titleIndex !== null) anchor = titleIndex + 1
      header.splice(anchor, 0, value)
    } else {
      header[tagsIndex] = value
    }
  }

  const changed =
    header.length !== oldHeader.length || header.some((line, index) => line !== oldHeader[index])
  if (!changed) return null

  // 前缀/后缀相同行不纳入替换区间：改一行只返回一行
  let prefix = 0
  const max = Math.min(oldHeader.length, header.length)
  while (prefix < max && oldHeader[prefix] === header[prefix]) prefix++
  let suffix = 0
  while (
    suffix < max - prefix &&
    oldHeader[oldHeader.length - 1 - suffix] === header[header.length - 1 - suffix]
  ) {
    suffix++
  }

  const oldBlock = oldHeader.slice(prefix, oldHeader.length - suffix)
  const newBlock = header.slice(prefix, header.length - suffix)
  const starts = lineStarts(oldHeader)
  const start =
    prefix < oldHeader.length
      ? starts[prefix]
      : starts[starts.length - 1] + oldHeader[oldHeader.length - 1].length
  const end = start + oldBlock.join('\n').length

  let replacement: string
  if (oldBlock.length > 0) {
    replacement = newBlock.join('\n')
  } else if (prefix > 0) {
    // 追加在既有行之后，先补一个换行再写新行
    replacement = '\n' + newBlock.join('\n')
  } else {
    // 插在正文最前面，新行后需要一个换行与下文分隔
    replacement = newBlock.join('\n') + '\n'
  }
  return { start, end, replacement }
}

/** 按 TextEdit 生成写回后的正文（主进程据此重解析并同步库） */
export function applyTextEdit(text: string, edit: MetadataTextEdit): string {
  return text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)
}
