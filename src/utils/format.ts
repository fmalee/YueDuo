/**
 * 渲染层共用的小工具：错误文案、路径拆分、时间格式化、正文头部提取。
 * 从各 composable / 组件的重复实现收敛而来；路径处理主体在 Rust 侧，
 * 这里只做展示层的拆分与格式化。
 */
import type * as monaco from 'monaco-editor'
import { parseMetadata } from '../../shared/metadataParser'

/** IPC 错误统一文案（bridge.ts 已包上 `[command]` 前缀，这里只取 message） */
export function formatError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 路径末段（即文件名） */
export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** 路径父目录的末段（即所在目录名，元数据标签兜底用） */
export function dirNameOf(path: string): string {
  const parent = path.slice(0, path.lastIndexOf('/'))
  return parent.slice(parent.lastIndexOf('/') + 1)
}

/** 正文文本 → 书名（前两行书名号优先，否则文件名去后缀，方案 §1.5/§2.4 口径） */
export function titleFromMetadata(text: string, path: string): string {
  return parseMetadata(text, fileNameOf(path), dirNameOf(path)).title
}

/** Monaco model 前 maxLines 行文本（元数据只在前 10 行，与主进程扫描同口径） */
export function modelHeadText(model: monaco.editor.ITextModel, maxLines: number): string {
  const count = Math.min(maxLines, model.getLineCount())
  const lines: string[] = []
  for (let i = 1; i <= count; i++) lines.push(model.getLineContent(i))
  return lines.join('\n')
}

/** YYYY-MM-DD HH:mm（Python last_read_at[:16] 同口径）；0/空值回落 fallback */
export function formatDateTime(timestamp: number, fallback = '未读'): string {
  if (!timestamp) return fallback
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
