import { statSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { decodeBytes, encodeForWrite } from '../services/textCodec'
import { findTopic } from '../services/metadataParser'
import { writeFinderComment } from '../services/finderMetadata'
import { writeDraft, readDraft, clearDraft } from '../services/draftStore'
import { getDatabase } from '../services/database'
import type { DraftEntry, DraftTabMeta, FileReadResult, FileStat } from '../../shared/types'

function statOf(path: string): FileStat {
  const s = statSync(path)
  return {
    dev: Number(s.dev),
    ino: Number(s.ino),
    size: s.size,
    mtimeMs: s.mtimeMs,
    realPath: realpathSync(path)
  }
}

/** file:readText —— 打开/按需重载标签（textCodec 探测+转换+换行归一） */
export function fileReadText(path: string): FileReadResult {
  const { text, encoding } = decodeBytes(readFileSync(path))
  return { text, encoding, stat: statOf(path) }
}

/** file:stat —— 同文件去重（inode 优先，realpath 兜底在调用侧做） */
export function fileStat(path: string): FileStat {
  return statOf(path)
}

/**
 * file:writeText —— 保存（UTF-16LE + 临时文件写 + rename 原子替换）
 * 临时文件与目标同盘（先试同目录，失败退系统 tmp），中断不破坏原文件（Python 同款语义）；
 * 落盘后按正文前十行的「主题」同步 Finder 注释（方案 §2.10，无主题/相同由 service 跳过）。
 */
export async function fileWriteText(
  path: string,
  text: string
): Promise<{ encoding: string; stat: FileStat }> {
  const data = encodeForWrite(text)
  let tmpPath = join(dirname(path), `.${randomUUID()}.yueduo-tmp`)
  try {
    writeFileSync(tmpPath, data)
  } catch {
    // 同目录不可写时退系统 tmp（跨盘 rename 会失败，此时复制语义退化为直接写）
    tmpPath = join(tmpdir(), `yueduo-${randomUUID()}`)
    writeFileSync(tmpPath, data)
    copySync(tmpPath, path)
    unlinkSync(tmpPath)
    await writeFinderComment(path, findTopic(text))
    return { encoding: 'utf-16-le', stat: statOf(path) }
  }
  renameSync(tmpPath, path)
  await writeFinderComment(path, findTopic(text))
  return { encoding: 'utf-16-le', stat: statOf(path) }
}

function copySync(src: string, dest: string): void {
  writeFileSync(dest, readFileSync(src))
}

/** file:writeDraft —— LRU 卸载时存 dirty 全文与 viewState（方案 §1.7，1.8 起落 SQLite） */
export function fileWriteDraft(
  tabId: string,
  text: string | null,
  viewState: unknown,
  meta?: DraftTabMeta | null
): void {
  writeDraft(getDatabase(), tabId, text, viewState, meta)
}

/** file:readDraft —— 重载已卸载标签时读草稿；null = 无草稿（走 file:readText） */
export function fileReadDraft(tabId: string): DraftEntry | null {
  return readDraft(getDatabase(), tabId)
}

/** file:clearDraft —— 保存/关闭后清草稿（方案 §1.4 保存后清 draft） */
export function fileClearDraft(tabId: string): void {
  clearDraft(getDatabase(), tabId)
}
