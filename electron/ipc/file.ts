import {
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  realpathSync,
  existsSync
} from 'fs'
import { basename, dirname, join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { shell } from 'electron'
import { decodeBytes, encodeForWrite } from '../services/textCodec'
import { findTopic } from '../services/metadataParser'
import { writeFinderComment } from '../services/finderMetadata'
import { writeDraft, readDraft, clearDraft } from '../services/draftStore'
import { getDatabase } from '../services/database'
import { deleteBookRecord, renameBookRecord } from '../services/bookRepository'
import { activeLibraryRoot, relativeInLibrary } from './library'
import type {
  DraftEntry,
  DraftTabMeta,
  FileReadResult,
  FileRenameResult,
  FileStat,
  FileTrashResult
} from '../../shared/types'

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
 * file:rename —— 重命名当前标签的文件（方案 §3.5）：
 * 只在原目录改名、自动补 .txt；同名校验走 existsSync，失败抛错由渲染层展示。
 * 改名成功后再同步 books 身份（relative_path/filename），id 不变，书签/评分/进度全保留；
 * 库外文件只改磁盘，不动库。
 */
export async function fileRename(path: string, newName: unknown): Promise<FileRenameResult> {
  if (!path) throw new Error('当前标签没有可重命名的文件')
  let name = String(newName ?? '').trim()
  if (!name) throw new Error('文件名不能为空')
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error('文件名不能包含路径分隔符')
  }
  if (!name.toLowerCase().endsWith('.txt')) name += '.txt'

  const newPath = join(dirname(path), name)
  if (newPath === path) {
    return { path, title: basename(path), stat: statOf(path) }
  }
  if (existsSync(newPath)) throw new Error(`「${name}」已存在`)

  // 改名后旧路径不复存在，库内相对路径必须在 rename 前取（realpath 需要文件仍在）
  const root = activeLibraryRoot()
  const oldRelative = root ? await relativeInLibrary(root, path) : null

  renameSync(path, newPath)
  const stat = statOf(newPath)

  if (root && oldRelative) {
    try {
      const newRelative = await relativeInLibrary(root, newPath)
      if (newRelative) renameBookRecord(oldRelative, newRelative, basename(newPath))
    } catch (e) {
      // 文件已改名成功；库身份同步失败交给下次扫描对账修复，不能反过来报改名失败
      console.error('[file] 重命名后同步库身份失败:', e)
    }
  }
  return { path: newPath, title: name, stat }
}

/**
 * file:trash —— 移到废纸篓（方案 §3.5）。
 * 先 realpath 取库内相对路径，再 shell.trashItem；成功后删 books 行（书签 FK CASCADE）。
 * 库记录清理失败只记日志，磁盘操作已成功，下次扫描对账会补齐。
 */
export async function fileTrash(path: string): Promise<FileTrashResult> {
  if (!path) throw new Error('当前标签没有可删除的文件')
  const root = activeLibraryRoot()
  const relativePath = root ? await relativeInLibrary(root, path) : null
  await shell.trashItem(path)
  let removedBook = false
  if (relativePath) {
    try {
      removedBook = deleteBookRecord(relativePath)
    } catch (e) {
      console.error('[file] 移入废纸篓后清理库记录失败:', e)
    }
  }
  return { removedBook }
}

/** file:reveal —— 在 Finder 中显示文件（方案 §3.5） */
export function fileReveal(path: string): null {
  if (!path) throw new Error('当前标签没有可显示的文件')
  shell.showItemInFolder(path)
  return null
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
