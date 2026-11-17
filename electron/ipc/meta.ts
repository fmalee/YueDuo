import { basename, dirname } from 'path'
import { parseMetadata, splitTags } from '../services/metadataParser'
import { applyTextEdit, rewriteHeader } from '../services/metadataWriter'
import { syncBookMetadataFromText } from './library'
import type { MetadataEditResult, MetadataField, MetadataTextEdit } from '../../shared/types'

const FIELDS: MetadataField[] = ['title', 'author', 'tags']

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
  return { edit, updated, metadata }
}
