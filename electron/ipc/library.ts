import { BrowserWindow } from 'electron'
import { readFile, realpath, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import { listDirectory, scanLibrary } from '../services/libraryScanner'
import { reconcileLibrary } from '../services/reconcile'
import {
  findBookByRelativePath,
  listAllBooks,
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
import { parseChapters } from '../services/chapterParser'
import {
  addBookmark,
  listBookmarks,
  listLibraryBookmarks,
  removeBookmark,
  replaceBookmarks
} from '../services/bookmarkRepository'
import type {
  BookmarkInfo,
  ChapterInfo,
  LibraryBook,
  LibraryBookmarkGroup,
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

/**
 * 快速检索快照（方案 §2.12）：每次唤出面板读一遍全量书目，
 * 未打开书库返回空列表（面板显示空态，不报错）。
 */
export function libraryAllBooks(): LibraryBook[] {
  return activeRoot ? listAllBooks(activeRoot) : []
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
 * 当前打开这本书的库记录（方案 §2.9）：元数据栏读取书名/作者/标签/评分与 book id。
 * 不在活动书库内或尚未入库返回 null，评分入口随之禁用。
 */
export async function libraryBookByPath(path: unknown): Promise<LibraryBook | null> {
  if (!activeRoot || typeof path !== 'string' || !path) return null
  const relativePath = await relativeInLibrary(activeRoot, path)
  return relativePath ? findBookByRelativePath(activeRoot, relativePath) : null
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

/** 解析正文并写回 books（不读盘）；返回是否命中库内记录 */
function syncMetadataFromText(resolved: string, relativePath: string, text: string): boolean {
  const meta = parseMetadata(text, basename(resolved), basename(dirname(resolved)))
  return updateBookMetadata(relativePath, meta.title, meta.author, meta.tags.join(' '))
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
  return { updated: syncMetadataFromText(resolved, relativePath, decodeBytes(data).text) }
}

/**
 * 元数据写回后按编辑器内存正文同步库（方案 §2.8 B1）：
 * 不等保存，提交即更新 books；文件不在活动书库内返回 false（打开任意 txt 不报错）。
 */
export async function syncBookMetadataFromText(path: unknown, text: unknown): Promise<boolean> {
  if (!activeRoot || typeof path !== 'string' || !path || typeof text !== 'string') return false
  const relativePath = await relativeInLibrary(activeRoot, path)
  if (!relativePath) return false
  return syncMetadataFromText(join(activeRoot, relativePath), relativePath, text)
}

/**
 * 章节提取（方案 §2.6）：读文件 → 解码 → 按 Python 同口径正则提取标题行。
 * 章节属于当前打开的书，不要求文件在书库内；读取失败由 registry 收敛为错误。
 */
export async function bookChapters(path: unknown): Promise<ChapterInfo[]> {
  if (typeof path !== 'string' || !path) return []
  const data = await readFile(path)
  return parseChapters(decodeBytes(data).text)
}

/** 当前书的书签；文件不在活动书库内时返回空列表（打开任意 txt 不报错） */
export async function bookBookmarks(path: unknown): Promise<BookmarkInfo[]> {
  if (!activeRoot || typeof path !== 'string' || !path) return []
  const relativePath = await relativeInLibrary(activeRoot, path)
  return relativePath ? listBookmarks(relativePath) : []
}

/** 添加书签：仅对活动书库内的书开放，行号 1-based，摘要按 Python 截 40 字 */
export async function addBookBookmark(
  path: unknown,
  line: unknown,
  note: unknown
): Promise<BookmarkInfo[]> {
  const root = requireRoot()
  const absolute = String(path)
  const relativePath = await relativeInLibrary(root, absolute)
  if (!relativePath) throw new Error('这本书不在当前书库中，无法添加书签')
  const lineNumber = Math.round(Number(line))
  if (!Number.isFinite(lineNumber) || lineNumber < 1) throw new Error('书签行号不合法')
  return addBookmark(relativePath, basename(absolute), lineNumber, String(note ?? '').slice(0, 40))
}

/** 删除书签（同行唯一） */
export async function removeBookBookmark(path: unknown, line: unknown): Promise<BookmarkInfo[]> {
  const root = requireRoot()
  const relativePath = await relativeInLibrary(root, String(path))
  if (!relativePath) return []
  return removeBookmark(relativePath, Math.round(Number(line)))
}

/**
 * 全库书签按书分组（方案 §2.7）：数据库只存相对路径，这里拼回绝对路径给渲染层打开。
 * 未打开书库时返回空列表，右栏「书签」页保持空态（与其它书库查询一致）。
 */
export function libraryAllBookmarks(): LibraryBookmarkGroup[] {
  if (!activeRoot) return []
  return listLibraryBookmarks().map((group) => ({
    path: join(activeRoot, group.relativePath),
    title: group.title,
    bookmarks: group.bookmarks
  }))
}

/**
 * 整体回写某本书的书签（方案 §2.7）：编辑后行号漂移由渲染层按差量调整，
 * 这里只负责校验与落库，返回最新列表供右栏刷新。
 */
export async function replaceBookBookmarks(
  path: unknown,
  bookmarks: unknown
): Promise<BookmarkInfo[]> {
  const root = requireRoot()
  const absolute = String(path)
  const relativePath = await relativeInLibrary(root, absolute)
  if (!relativePath) throw new Error('这本书不在当前书库中，无法更新书签')
  const rows = Array.isArray(bookmarks) ? (bookmarks as BookmarkInfo[]) : []
  const sanitized = rows.map((row) => ({
    line: Math.round(Number(row.line)),
    note: String(row.note ?? '').slice(0, 40)
  }))
  return replaceBookmarks(relativePath, basename(absolute), sanitized)
}
