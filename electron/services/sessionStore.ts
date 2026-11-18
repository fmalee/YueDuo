import type { Database } from 'better-sqlite3'
import { existsSync, realpathSync } from 'fs'
import { isAbsolute, join, relative, sep } from 'path'
import type { SessionRelocation, SessionRestore, SessionSnapshot } from '../../shared/types'

/**
 * 会话持久化（方案 §1.8）：
 * - 库内标签落 `book_id` + 相对路径（`path` 列），库外标签 `book_id` NULL + 绝对路径，
 *   空白标签两者为空；判定与换算只在主进程做（先 realpath 书库根与文件）
 * - 恢复时 `book_id` 优先按 `books.relative_path` 拼当前书库根，查不到/文件不存在退回
 *   会话里存的相对路径；仍不存在则标记缺失，等对账扫完按 `book_id` 重试一次
 * - draft/view_state 两列归 file:writeDraft 维护，persist 只更新其余字段，绝不覆盖草稿
 * 纯 Node 实现（AGENTS.md：services 不 import Electron），连接与书库根由调用方注入
 */
interface SessionStateRow {
  active_tab_id: string | null
}

interface SessionTabRow {
  id: string
  position: number
  book_id: number | null
  path: string
  title: string
  progress_line: number
  cursor_line: number
  cursor_column: number
  dirty: number
  has_draft: number
  last_focused_at: number
}

interface NextPositionRow {
  next: number
}

interface BookIdRow {
  id: number
}

interface BookPathRow {
  relative_path: string
}

interface StoredTabRow {
  book_id: number | null
  path: string
}

/** 落盘位置：库内 = 相对路径（POSIX）+ book_id，库外 = 绝对路径 + NULL */
export interface StoredTabLocation {
  path: string
  bookId: number | null
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * 绝对路径 → session_tabs 落盘位置。
 * 文件已不存在（外部移动后尚未对账）时退回原路径做文本比较，
 * 这样库内标签仍能保留相对路径与旧 book_id，不会因为一次 realpath 失败降级成库外标签。
 */
export function storedTabLocation(
  db: Database,
  root: string,
  absolutePath: string
): StoredTabLocation {
  if (!absolutePath) return { path: '', bookId: null }
  const realRoot = root ? safeRealpath(root) : null
  if (!realRoot) return { path: absolutePath, bookId: null }
  const target = safeRealpath(absolutePath) ?? absolutePath
  const rel = relative(realRoot, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { path: absolutePath, bookId: null }
  }
  const relativePath = rel.split(sep).join('/')
  const row = db.prepare('SELECT id FROM books WHERE relative_path = ?').get(relativePath) as
    BookIdRow | undefined
  return { path: relativePath, bookId: row?.id ?? null }
}

/** 占位行的默认位置用：表格已空时从 0 开始 */
export function nextPosition(db: Database): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM session_tabs')
    .get() as NextPositionRow | undefined
  return row?.next ?? 0
}

/**
 * 全量落盘（单事务）：
 * - 快照内标签按数组顺序写 position（INSERT 或 UPDATE，draft/view_state 不在更新列表里）
 * - 库内标签写相对路径 + book_id；库外标签写绝对路径 + NULL（见 storedTabLocation）
 * - 文件暂时不可达但 path 与上次一致时沿用旧 book_id，避免外部移动未对账时丢掉身份
 * - 快照外的行删除（关掉的标签不残留；其草稿随行一起消失）
 * - session_state 恒一行，保存 active
 */
export function persistSession(db: Database, snapshot: SessionSnapshot, root = ''): void {
  const upsertTab = db.prepare(`
    INSERT INTO session_tabs
      (id, position, book_id, path, title, progress_line, cursor_line, cursor_column, dirty,
       last_focused_at)
    VALUES
      (@id, @position, @bookId, @path, @title, @progressLine, @cursorLine, @cursorColumn, @dirty,
       @lastFocusedAt)
    ON CONFLICT(id) DO UPDATE SET
      position = excluded.position,
      book_id = excluded.book_id,
      path = excluded.path,
      title = excluded.title,
      progress_line = excluded.progress_line,
      cursor_line = excluded.cursor_line,
      cursor_column = excluded.cursor_column,
      dirty = excluded.dirty,
      last_focused_at = excluded.last_focused_at
  `)
  const readStored = db.prepare('SELECT book_id, path FROM session_tabs WHERE id = ?')
  const setState = db.prepare(`
    INSERT INTO session_state (id, active_tab_id) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET active_tab_id = excluded.active_tab_id
  `)
  const ids = snapshot.tabs.map((t) => t.id)
  const deleteOthers =
    ids.length > 0
      ? db.prepare(`DELETE FROM session_tabs WHERE id NOT IN (${ids.map(() => '?').join(',')})`)
      : db.prepare('DELETE FROM session_tabs')

  db.transaction(() => {
    snapshot.tabs.forEach((tab, position) => {
      const stored = storedTabLocation(db, root, tab.path)
      const previous = readStored.get(tab.id) as StoredTabRow | undefined
      if (
        stored.bookId == null &&
        previous?.book_id != null &&
        stored.path !== '' &&
        !isAbsolute(stored.path) &&
        previous.path === stored.path
      ) {
        stored.bookId = previous.book_id
      }
      upsertTab.run({
        id: tab.id,
        position,
        bookId: stored.bookId,
        path: stored.path,
        title: tab.title,
        progressLine: tab.progressLine,
        cursorLine: tab.cursorLine,
        cursorColumn: tab.cursorColumn,
        dirty: tab.dirty ? 1 : 0,
        lastFocusedAt: tab.lastFocusedAt
      })
    })
    deleteOthers.run(...ids)
    setState.run(snapshot.activeTabId)
  })()
}

/**
 * 恢复路径候选：book_id 对应的库内新路径优先，其次会话里存的路径（相对路径拼当前库根）。
 * 第一个存在的候选即命中；都不存在时取 book 路径作为展示路径并标记缺失。
 */
function restoredPath(
  db: Database,
  root: string,
  row: { book_id: number | null; path: string }
): { path: string; missing: boolean } {
  const candidates: string[] = []
  if (row.book_id != null) {
    const book = db.prepare('SELECT relative_path FROM books WHERE id = ?').get(row.book_id) as
      BookPathRow | undefined
    if (book) {
      candidates.push(root ? join(root, book.relative_path) : book.relative_path)
    }
  }
  if (row.path) {
    const stored = isAbsolute(row.path) || !root ? row.path : join(root, row.path)
    if (!candidates.includes(stored)) candidates.push(stored)
  }
  if (candidates.length === 0) return { path: '', missing: false }
  const existing = candidates.find((candidate) => existsSync(candidate))
  return existing ? { path: existing, missing: false } : { path: candidates[0], missing: true }
}

/**
 * 读取会话：按 position 升序。
 * 不在恢复时丢弃任何行：草稿行由 file:writeDraft 带着标签元信息写入，
 * 即使 persist 还没跑过也能恢复；空 title 只做兜底命名，不能让标签整个消失。
 * root 用于把库内相对路径拼回绝对路径，空串表示没有活动书库（历史绝对路径行按原样打开）。
 */
export function loadSession(db: Database, root = ''): SessionRestore {
  const rows = db
    .prepare(
      `SELECT id, position, book_id, path, title, progress_line, cursor_line, cursor_column, dirty,
              last_focused_at,
              (draft IS NOT NULL OR view_state IS NOT NULL) AS has_draft
         FROM session_tabs
        ORDER BY position`
    )
    .all() as SessionTabRow[]
  const state = db.prepare('SELECT active_tab_id FROM session_state WHERE id = 1').get() as
    SessionStateRow | undefined

  const tabs = rows.map((row) => {
    const resolved = restoredPath(db, root, row)
    return {
      id: row.id,
      position: row.position,
      path: resolved.path,
      title: row.title || '未命名',
      progressLine: row.progress_line,
      cursorLine: row.cursor_line,
      cursorColumn: row.cursor_column,
      // 无草稿的 dirty 行只可能来自异常退出，恢复后按干净处理（文件内容与内存不一致）
      dirty: row.dirty === 1 && row.has_draft === 1,
      lastFocusedAt: row.last_focused_at,
      hasDraft: row.has_draft === 1,
      bookId: row.book_id,
      missing: resolved.missing
    }
  })
  const storedActive = state?.active_tab_id ?? null
  const activeTabId =
    storedActive && tabs.some((t) => t.id === storedActive) ? storedActive : (tabs[0]?.id ?? null)
  return { activeTabId, tabs }
}

/**
 * 对账扫完后重试缺失标签：按 book_id 取 books.relative_path 拼当前书库根，
 * 行不存在或文件仍不在时退回会话里存的相对路径。只返回重新找到文件的标签。
 */
export function relocateSessionTabs(
  db: Database,
  root: string,
  tabIds: string[]
): SessionRelocation[] {
  if (!root || tabIds.length === 0) return []
  const rows = db
    .prepare(
      `SELECT id, book_id, path FROM session_tabs
        WHERE id IN (${tabIds.map(() => '?').join(',')})`
    )
    .all(...tabIds) as { id: string; book_id: number | null; path: string }[]
  const relocated: SessionRelocation[] = []
  for (const row of rows) {
    const resolved = restoredPath(db, root, row)
    if (!resolved.missing && resolved.path) {
      relocated.push({ tabId: row.id, path: resolved.path })
    }
  }
  return relocated
}
