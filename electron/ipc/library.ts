import { app, BrowserWindow, dialog } from 'electron'
import { readFile, realpath } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import { ingestFile, listDirectory, scanLibrary } from '../services/libraryScanner'
import { reconcileLibrary } from '../services/reconcile'
import { LibraryDatabaseManager } from '../services/libraryDatabase'
import { readSettings } from '../services/settingsStore'
import { DEV_LIBRARY_ROOT, defaultLibraryRoot, isDevRuntime } from '../devEnv'
import { closeDatabase } from '../services/database'
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
  LibraryCurrentState,
  LibraryEnrichResult,
  LibraryEntry,
  LibraryOpenResult,
  LibraryScanProgress,
  LibrarySyncResult,
  LibraryTagSummary
} from '../../shared/types'

/**
 * 书库 IPC（方案 §2.5 / §2.13）：activeRoot 是当前活动书库，每个书库一份数据库。
 * 换库顺序：library:open（建新库 + 停扫描 + 读新会话）→ 渲染层存档旧会话 →
 * library:activate（切活动库）→ 渲染层恢复新会话；任一步失败用 library:abort 回到原库。
 */
let activeRoot = ''
let startupError = ''
let libraryManager: LibraryDatabaseManager | null = null

/** 当前活动书库根（文件改名/删除时同步库身份用，方案 §3.5） */
export function activeLibraryRoot(): string {
  return activeRoot
}

/** 另有 enrich 在跑时用于取消（换库必须先停扫描，不能让旧库扫描继续写） */
let enrichToken = 0
let enriching: { token: number; promise: Promise<LibraryEnrichResult> } | null = null

function manager(): LibraryDatabaseManager {
  if (!libraryManager) {
    libraryManager = new LibraryDatabaseManager(app.getPath('userData'))
  }
  return libraryManager
}

function requireRoot(): string {
  if (!activeRoot) throw new Error('尚未打开书库')
  return activeRoot
}

/**
 * 启动：按设置里的书库根打开它自己的数据库（main.ts 在建窗前调用）。
 * 根无效/库打不开时回落 userData 默认会话库，错误留给渲染层展示，不阻断启动。
 */
export function initActiveLibrary(): LibraryCurrentState {
  const userData = app.getPath('userData')
  const settings = readSettings(userData)
  const state = manager().init(defaultLibraryRoot(settings.libraryRoot))
  activeRoot = state.root
  startupError = state.error
  return { root: state.root, error: state.error, fallback: state.fallback }
}

/** library:current —— 渲染层启动时读取主进程已打开的活动书库（不再触发切换） */
export function libraryCurrent(): LibraryCurrentState {
  return {
    root: activeRoot,
    error: startupError,
    fallback: manager().currentFallback()
  }
}

/**
 * 开发态保险：只默认使用测试库；打开其它路径（很可能正是正式书库）先确认。
 * 扫描 enrich 会写 Finder 星级与注释，开发调试不应无声改动正式数据；
 * 自动化验收（YUE_TEST）走临时库，不弹框。
 */
async function confirmDevLibraryRoot(root: string): Promise<boolean> {
  if (!isDevRuntime() || process.env['YUE_TEST']) return true
  const requested = await realpath(root).catch(() => root)
  const devRoot = await realpath(DEV_LIBRARY_ROOT).catch(() => DEV_LIBRARY_ROOT)
  if (requested === devRoot) return true
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: '开发环境书库确认',
    message: `确定要在开发环境打开「${root}」吗？`,
    detail: `开发环境默认只使用测试书库：${DEV_LIBRARY_ROOT}。\n扫描会写入 Finder 星级和注释；如果这是正式书库，这些数据会被开发调试改动。`,
    buttons: ['取消', '仍然打开'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return response === 1
}

/**
 * library:open —— 换库第一步：建新库并读出新会话，旧库仍保持活动。
 * 同一书库直接返回 switched=false；目录无效或新库建不起来时抛错，原库不受影响。
 */
export async function openLibrary(root: unknown): Promise<LibraryOpenResult> {
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('尚未设置书库根目录')
  }
  if (!(await confirmDevLibraryRoot(root))) {
    throw new Error('已取消：开发环境不打开测试库以外的书库')
  }
  const prepared = manager().prepare(root)
  if (prepared.result.switched) {
    // 建好新库后再停扫描（顺序按 AGENTS.md：建新库 → 停扫描 → 存档旧会话 → …）
    await stopEnrichment()
    startupError = ''
  }
  return prepared.result
}

/** library:activate —— 换库第四步：关闭旧库连接并激活新库（提交点，不会失败） */
export function activateLibrarySwitch(): { root: string } {
  const root = manager().commit()
  activeRoot = root
  startupError = ''
  return { root }
}

/** library:abort —— 存档失败/取消：关掉待切换的新库，原库仍可继续使用 */
export function abortLibrarySwitch(): null {
  manager().abort()
  return null
}

/** 退出前收尾：待切换库与活动库一起关闭 */
export function shutdownLibrary(): void {
  if (libraryManager) libraryManager.close()
  else closeDatabase()
  libraryManager = null
  activeRoot = ''
}

/** library:fastScan —— 只读一层目录（书架惰性树按需展开） */
export function fastScanLibrary(relativeDir: unknown): Promise<LibraryEntry[]> {
  return listDirectory(requireRoot(), typeof relativeDir === 'string' ? relativeDir : '')
}

/**
 * 取消在跑的 enrich 并等它退出（换库前的「停扫描」）：
 * 扫描内每次读文件前检查 token，最多写完当前这一本；不用强杀线程，数据不会被撕裂。
 */
async function stopEnrichment(): Promise<void> {
  if (!enriching) return
  enrichToken++
  await enriching.promise.catch(() => undefined)
}

/**
 * library:enrich —— 后台补元数据 + 对账，进度经 library:scanProgress 推送。
 * 同一时刻只跑一次，重复调用复用同一个 Promise（启动与手动刷新撞车时不重复扫盘）。
 * 被换库中止的扫描不做对账：半份结果会把没扫到的书误记成「连续零匹配」。
 */
export function enrichLibrary(): Promise<LibraryEnrichResult> {
  const root = requireRoot()
  if (enriching) return enriching.promise
  const token = ++enrichToken
  let cancelled = false
  const promise = (async (): Promise<LibraryEnrichResult> => {
    const result = await scanLibrary(root, {
      onProgress: (progress: LibraryScanProgress) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('library:scanProgress', progress)
        }
      },
      shouldContinue: () => {
        if (token !== enrichToken) cancelled = true
        return !cancelled
      }
    })
    if (cancelled || token !== enrichToken) {
      return { total: result.total, skipped: result.skipped, moved: 0, pending: 0, deleted: 0 }
    }
    const log = reconcileLibrary(result.books)
    return {
      total: result.total,
      skipped: result.skipped,
      moved: log.moved.length,
      pending: log.pending,
      deleted: log.deleted.length
    }
  })().finally(() => {
    if (enriching?.token === token) enriching = null
  })
  enriching = { token, promise }
  return promise
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
export async function relativeInLibrary(root: string, path: string): Promise<string | null> {
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
 * 保存文件后同步这一本（方案 §2.5 验收补丁 + 另存为入库）：
 * 按扫描同口径解析书名/作者/标签并写库，命中则更新、未命中则插入一行——
 * 另存为到书库根内的新文件因此无需全库扫描即可出现在书架与左栏。
 * 退回库外/不可读时返回 updated=false（库外保存行为不变）。
 */
export async function syncBookMetadata(path: unknown): Promise<LibrarySyncResult> {
  const skipped: LibrarySyncResult = { updated: false, added: false, book: null }
  if (typeof path !== 'string' || !path) return skipped
  const root = requireRoot()
  // 库内判定与相对路径换算都在 ingestFile 内完成（先 realpath 书库根与文件）
  const ingested = await ingestFile(root, path)
  if (!ingested) return skipped
  return {
    updated: true,
    added: ingested.inserted,
    book: findBookByRelativePath(root, ingested.relativePath)
  }
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
