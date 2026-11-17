import type Database from 'better-sqlite3'
import { getDatabase } from './database'
import type { BookmarkInfo } from '../../shared/types'

/**
 * 书签持久化（方案 §2.6，以 Python bookmark_repository 为准）：
 * 书签挂在 books 之下，按 books.relative_path 定位；行号 1-based，同行唯一。
 * 添加时若该书尚未入库（例如 enrich 还没跑到），先补一条最小书籍记录，
 * 后续扫描按 relative_path 直命中时会把书名/作者/标签补全，不会产生重复行。
 * 纯 Node 实现，连接可注入（单测用 :memory:）。
 */
interface BookmarkRow {
  line: number
  note: string
}

export function listBookmarks(
  relativePath: string,
  db: Database.Database = getDatabase()
): BookmarkInfo[] {
  const rows = db
    .prepare(
      `SELECT m.line, m.note
         FROM bookmarks AS m
         JOIN books AS b ON b.id = m.book_id
        WHERE b.relative_path = ?
        ORDER BY m.line`
    )
    .all(relativePath) as BookmarkRow[]
  return rows.map((row) => ({ line: row.line, note: row.note }))
}

function ensureBookId(relativePath: string, filename: string, db: Database.Database): number {
  const now = Date.now()
  const title = filename.replace(/\.[^./]+$/, '') || filename
  db.prepare(
    `INSERT INTO books (relative_path, filename, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(relative_path) DO NOTHING`
  ).run(relativePath, filename, title, now, now)
  const row = db.prepare('SELECT id FROM books WHERE relative_path = ?').get(relativePath) as
    { id: number } | undefined
  if (!row) throw new Error(`书籍记录写入失败：${relativePath}`)
  return row.id
}

/** 添加书签（同行重复时更新摘要），返回该书最新的书签列表 */
export function addBookmark(
  relativePath: string,
  filename: string,
  line: number,
  note: string,
  db: Database.Database = getDatabase()
): BookmarkInfo[] {
  const bookId = ensureBookId(relativePath, filename, db)
  db.prepare(
    `INSERT INTO bookmarks (book_id, line, note, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(book_id, line) DO UPDATE SET note = excluded.note`
  ).run(bookId, line, note, Date.now())
  return listBookmarks(relativePath, db)
}

/** 删除书签，返回该书最新的书签列表 */
export function removeBookmark(
  relativePath: string,
  line: number,
  db: Database.Database = getDatabase()
): BookmarkInfo[] {
  db.prepare(
    `DELETE FROM bookmarks
      WHERE line = ?
        AND book_id IN (SELECT id FROM books WHERE relative_path = ?)`
  ).run(line, relativePath)
  return listBookmarks(relativePath, db)
}
