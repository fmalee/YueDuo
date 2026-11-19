import { readFile } from 'fs/promises'
import { basename, dirname } from 'path'
import { findTopic, parseMetadata, splitTags } from '../services/metadataParser'
import { decodeBytes } from '../services/textCodec'
import { applyTextEdit, rewriteHeader } from '../services/metadataWriter'
import { writeFinderComment, readFinderRating, writeFinderRating } from '../services/finderMetadata'
import { libraryBookByPath, librarySetBookRating, syncBookMetadataFromText } from './library'
import type {
  MetadataEditResult,
  MetadataField,
  MetadataTextEdit,
  ParsedMetadata,
  RatingReadResult,
  RatingWriteResult
} from '../../shared/types'

const FIELDS: MetadataField[] = ['title', 'author', 'tags']

/**
 * meta:read（方案 §2.9）：按磁盘正文解析元数据，供元数据栏首屏展示。
 * 文件已在库内时元数据栏优先读库记录，这里只覆盖库外/尚未入库的文件。
 */
export async function readMetadata(path: unknown): Promise<ParsedMetadata> {
  if (typeof path !== 'string' || !path) throw new Error('缺少文件路径')
  const data = await readFile(path)
  return parseMetadata(decodeBytes(data).text, basename(path), basename(dirname(path)))
}

/**
 * meta:applyEdit（方案 §2.8）：
 * 渲染层把编辑器当前正文传进来（可能是未保存内容），主进程只在内存里算最小替换区间，
 * 再按写回后的正文重解析并同步 books（B1：不等保存），不写文件。
 */
export async function applyMetadataEdit(
  path: unknown,
  text: unknown,
  field: unknown,
  value: unknown
): Promise<MetadataEditResult> {
  if (typeof path !== 'string' || !path) throw new Error('缺少文件路径')
  if (typeof text !== 'string') throw new Error('缺少当前正文')
  if (!FIELDS.includes(field as MetadataField)) {
    throw new Error(`不支持的元数据字段：${String(field)}`)
  }
  const key = field as MetadataField
  const raw = typeof value === 'string' ? value : String(value ?? '')

  let edit: MetadataTextEdit | null
  if (key === 'title') edit = rewriteHeader(text, { title: raw })
  else if (key === 'author') edit = rewriteHeader(text, { author: raw })
  else edit = rewriteHeader(text, { tags: splitTags(raw) })

  const nextText = edit ? applyTextEdit(text, edit) : text
  const metadata = parseMetadata(nextText, basename(path), basename(dirname(path)))
  const updated = await syncBookMetadataFromText(path, nextText)
  // 主题写回后同步 Finder 注释（方案 §2.10）：无主题与「旧注释相同」都由 service 跳过
  if (key === 'tags') await writeFinderComment(path, findTopic(nextText))
  return { edit, updated, metadata }
}

/**
 * meta:readRating —— 元数据栏评分读回，判定与书名/作者/标签一致：只要有路径就读。
 * 库内取 books.rating（与文件星级保持同步），库外没有 books 行则取文件 Finder 星级。
 */
export async function readRating(path: unknown): Promise<RatingReadResult> {
  if (typeof path !== 'string' || !path) throw new Error('缺少文件路径')
  const book = await libraryBookByPath(path)
  if (book) return { rating: book.rating, inLibrary: true }
  return { rating: (await readFinderRating(path)) ?? 0, inLibrary: false }
}

/** 库外文件评分只能写文件 Finder 星级；返回是否真的持久化（非 macOS / xattr 失败为 false） */
async function writeFileRating(path: string, value: number): Promise<boolean> {
  const current = await readFinderRating(path)
  if (current === null) return false
  if (current === value) return true
  return writeFinderRating(path, value)
}

/**
 * meta:applyRating —— 评分写回，与文本三项同一入口：渲染层只传路径，库内/库外由主进程判定。
 * 库内走 librarySetBookRating（books + 文件星级）；库外没有 books 行，只写文件 Finder 星级，
 * persisted=false 时渲染层必须回退，不能让点击看起来成功却在重开后消失。
 */
export async function applyRating(path: unknown, rating: unknown): Promise<RatingWriteResult> {
  if (typeof path !== 'string' || !path) throw new Error('缺少文件路径')
  const value = Math.min(5, Math.max(0, Math.round(Number(rating) || 0)))
  const book = await libraryBookByPath(path)
  if (book) {
    return { rating: await librarySetBookRating(book.id, value), inLibrary: true, persisted: true }
  }
  return { rating: value, inLibrary: false, persisted: await writeFileRating(path, value) }
}
