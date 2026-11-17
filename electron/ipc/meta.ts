import { readFile } from 'fs/promises'
import { basename, dirname } from 'path'
import { findTopic, parseMetadata, splitTags } from '../services/metadataParser'
import { decodeBytes } from '../services/textCodec'
import { applyTextEdit, rewriteHeader } from '../services/metadataWriter'
import { writeFinderComment } from '../services/finderMetadata'
import { syncBookMetadataFromText } from './library'
import type {
  MetadataEditResult,
  MetadataField,
  MetadataTextEdit,
  ParsedMetadata
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
