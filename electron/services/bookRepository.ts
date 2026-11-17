import { join } from 'path'
import type Database from 'better-sqlite3'
import { getDatabase } from './database'
import type { LibraryBook, LibraryTagSummary } from '../../shared/types'

/**
 * 书库查询（方案 §2.5，以 Python book_repository 为准翻译）：
 * 历史/追更/标签/评分都从这里读，排序与筛选口径和旧项目一致；
 * 纯 Node 实现（AGENTS.md：services 不 import Electron），连接由调用方注入或取默认库。
 */
const FOLLOWING_TAG = '追更'

/** 评分页未筛选时最多列出的书目数量（对齐 Python RATED_LIST_LIMIT） */
export const RATED_LIST_LIMIT = 100

interface BookRow {
  id: number
  relative_path: string
  filename: string
  title: string
  author: string
  tags: string
  rating: number
  word_count: number
  progress_line: number
  last_read_at: number
}

/** 标签在库里以空格分隔；前后补空格精确匹配，避免「追更中」被当成「追更」 */
function tagPattern(tag: string): string {
  return ` ${tag} `
}

function toBook(row: BookRow, root: string): LibraryBook {
  return {
    id: row.id,
    relativePath: row.relative_path,
    path: root ? join(root, row.relative_path) : row.relative_path,
    filename: row.filename,
    title: row.title,
    author: row.author,
    tags: row.tags.split(' ').filter(Boolean),
    rating: row.rating,
    wordCount: row.word_count,
    progressLine: row.progress_line,
    lastReadAt: row.last_read_at
  }
}

function queryBooks(
  sql: string,
  root: string,
  params: unknown[] = [],
  db: Database.Database = getDatabase()
): LibraryBook[] {
  return (db.prepare(sql).all(...params) as BookRow[]).map((row) => toBook(row, root))
}

/** 历史：有阅读记录的书，按最近阅读时间倒序（方案 §2.5） */
export function listHistory(root: string, db: Database.Database = getDatabase()): LibraryBook[] {
  return queryBooks(
    `SELECT * FROM books
      WHERE last_read_at > 0
      ORDER BY last_read_at DESC, id DESC`,
    root,
    [],
    db
  )
}

/** 追更：标签精确匹配「追更」，最近读过的在前（同 Python list_following） */
export function listFollowing(root: string, db: Database.Database = getDatabase()): LibraryBook[] {
  return queryBooks(
    `SELECT * FROM books
      WHERE instr(' ' || tags || ' ', ?) > 0
      ORDER BY (last_read_at = 0), last_read_at DESC, title`,
    root,
    [tagPattern(FOLLOWING_TAG)],
    db
  )
}

/** 标签页：名称/数量/标签评分；按评分高低、数量、名称排序（方案 §2.5） */
export function listTags(db: Database.Database = getDatabase()): LibraryTagSummary[] {
  const rows = db.prepare('SELECT tags FROM books').all() as { tags: string }[]
  const rated = new Map<string, number>()
  for (const row of db.prepare('SELECT tag, rating FROM tag_ratings').all() as {
    tag: string
    rating: number
  }[]) {
    rated.set(row.tag, row.rating)
  }
  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const tag of row.tags.split(' ')) {
      if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count, rating: rated.get(name) ?? 0 }))
    .sort((a, b) => {
      if (a.rating !== b.rating) return b.rating - a.rating
      if (a.count !== b.count) return b.count - a.count
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
}

/** 某个标签下的书：精确匹配，最近读过的在前 */
export function listBooksByTag(
  root: string,
  tag: string,
  db: Database.Database = getDatabase()
): LibraryBook[] {
  return queryBooks(
    `SELECT * FROM books
      WHERE instr(' ' || tags || ' ', ?) > 0
      ORDER BY (last_read_at = 0), last_read_at DESC, title`,
    root,
    [tagPattern(tag)],
    db
  )
}

/**
 * 评分页：评分从高到低，同分最近阅读在前。
 * 无筛选时最多 100 本；有筛选时不设上限（对齐 Python list_rated）
 */
export function listRated(
  root: string,
  rating: number | null = null,
  db: Database.Database = getDatabase()
): LibraryBook[] {
  const params: unknown[] = []
  let sql = `SELECT * FROM books WHERE rating > 0`
  if (rating !== null) {
    sql += ' AND rating = ?'
    params.push(rating)
  }
  sql += ' ORDER BY rating DESC, (last_read_at = 0), last_read_at DESC, title'
  if (rating === null) {
    sql += ' LIMIT ?'
    params.push(RATED_LIST_LIMIT)
  }
  return queryBooks(sql, root, params, db)
}

/** 标签评分只进数据库、不写正文；0 分也保留一行，避免反复插入 */
export function setTagRating(
  tag: string,
  rating: number,
  db: Database.Database = getDatabase()
): number {
  const value = Math.max(0, Math.min(5, Math.round(rating)))
  db.prepare(
    `INSERT INTO tag_ratings (tag, rating, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(tag) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at`
  ).run(tag, value, Date.now())
  return value
}
