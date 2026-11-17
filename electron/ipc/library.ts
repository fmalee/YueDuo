import { BrowserWindow } from 'electron'
import { readFile, realpath, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import { listDirectory, scanLibrary } from '../services/libraryScanner'
import { reconcileLibrary } from '../services/reconcile'
import {
  listBooksByTag,
  listFollowing,
  listHistory,
  listRated,
  listTags,
  markRead,
  setBookRating,
  setTagRating,
  updateBookMetadata
} from '../services/bookRepository'
import { decodeBytes } from '../services/textCodec'
import { parseMetadata } from '../services/metadataParser'
import { writeFinderRating } from '../services/finderMetadata'
import type {
  LibraryBook,
  LibraryEnrichResult,
  LibraryEntry,
  LibraryOpenResult,
  LibraryScanProgress,
  LibrarySyncResult,
  LibraryTagSummary
} from '../../shared/types'

/**
 * 书库 IPC（方案 §2.5）：activeRoot 是当前活动书库，root 来自设置里的书库根。
 * 数据库仍在 userData（2.13 换库流程再按库根建库/切库），本步只做查询与扫描编排。
 */
let activeRoot = ''
let enriching: Promise<LibraryEnrichResult> | null = null

function requireRoot(): string {
  if (!activeRoot) throw new Error('尚未打开书库')
  return activeRoot
}

/** library:open —— realpath 归一后作为活动书库；目录不存在/不是目录直接报错（保留原活动书库） */
export async function openLibrary(root: unknown): Promise<LibraryOpenResult> {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('尚未设置书库根目录')
  }
  let resolved: string
  try {
    resolved = await realpath(root)
  } catch {
    throw new Error(`书库目录不存在：${root}`)
  }
  if (!(await stat(resolved)).isDirectory()) {
    throw new Error(`书库路径不是目录：${resolved}`)
  }
  activeRoot = resolved
  return { root: resolved }
}

/** library:fastScan —— 只读一层目录（书架惰性树按需展开） */
export function fastScanLibrary(relativeDir: unknown): Promise<LibraryEntry[]> {
  return listDirectory(requireRoot(), typeof relativeDir === 'string' ? relativeDir : '')
}

/**
 * library:enrich —— 后台补元数据 + 对账，进度经 library:scanProgress 推送。
 * 同一时刻只跑一次，重复调用复用同一个 Promise（启动与手动刷新撞车时不重复扫盘）。
 */
export function enrichLibrary(): Promise<LibraryEnrichResult> {
  const root = requireRoot()
  if (enriching) return enriching
  enriching = (async (): Promise<LibraryEnrichResult> => {
    const result = await scanLibrary(root, {
      onProgress: (progress: LibraryScanProgress) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('library:scanProgress', progress)
        }
      }
    })
    const log = reconcileLibrary(result.books)
    return {
      total: result.total,
      skipped: result.skipped,
      moved: log.moved.length,
      pending: log.pending,
      deleted: log.deleted.length
    }
  })().finally(() => {
    enriching = null
  })
  return enriching
}

export function libraryHistory(): LibraryBook[] {
  return listHistory(requireRoot())
}

export function libraryFollowing(): LibraryBook[] {
  return listFollowing(requireRoot())
}

export function libraryTags(): LibraryTagSummary[] {
  return listTags()
}

export function libraryBooksByTag(tag: unknown): LibraryBook[] {
  return listBooksByTag(requireRoot(), String(tag))
}

export function libraryRated(rating: unknown): LibraryBook[] {
  if (rating === null || rating === undefined || rating === '') return listRated(requireRoot())
  const value = Number(rating)
  return listRated(requireRoot(), Number.isFinite(value) ? value : null)
}

export function librarySetTagRating(tag: unknown, rating: unknown): number {
  return setTagRating(String(tag), Number(rating))
}

/** 打开/激活标签时写 last_read_at；不在书库内返回 0（打开任意 txt 不报错） */
export function markBookRead(path: unknown): Promise<number> {
  if (typeof path !== 'string' || !path) return Promise.resolve(0)
  return markRead(requireRoot(), path)
}

/**
 * 书籍评分：写库 + 写 Finder 星级（xattr）。
 * 路径由库内 relative_path 拼出，不接受渲染层传路径；xattr 失败静默，不影响库内评分。
 */
export async function librarySetBookRating(id: unknown, rating: unknown): Promise<number> {
  const result = setBookRating(Number(id), Number(rating))
  if (result.relativePath) {
    const absolute = join(requireRoot(), result.relativePath)
    await writeFinderRating(absolute, result.rating)
  }
  return result.rating
}

/** 绝对路径 → 库内相对路径（POSIX 分隔）；不在书库内返回 null */
async function relativeInLibrary(root: string, path: string): Promise<string | null> {
  let resolved: string
  try {
    resolved = await realpath(path)
  } catch {
    return null
  }
  const rel = relative(root, resolved)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/**
 * 保存文件后同步元数据（方案 §2.5 验收补丁）：读保存后的正文，按扫描同口径解析
 * 书名/作者/标签并只更新这一本，不做全库重扫。
 */
export async function syncBookMetadata(path: unknown): Promise<LibrarySyncResult> {
  if (typeof path !== 'string' || !path) return { updated: false }
  const root = requireRoot()
  const relativePath = await relativeInLibrary(root, path)
  if (!relativePath) return { updated: false }
  const resolved = join(root, relativePath)
  let data: Buffer
  try {
    data = await readFile(resolved)
  } catch {
    return { updated: false }
  }
  const { text } = decodeBytes(data)
  const meta = parseMetadata(text, basename(resolved), basename(dirname(resolved)))
  const updated = updateBookMetadata(relativePath, meta.title, meta.author, meta.tags.join(' '))
  return { updated }
}
