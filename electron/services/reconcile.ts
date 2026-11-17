import type { Database } from 'better-sqlite3'
import { getDatabase } from './database'
import type { ScannedBook } from '../../shared/types'

/**
 * 书库身份对账（方案 §2.3 / §四 三步）：
 * 1. 直命中：库内记录的 relative_path 仍在本次扫描结果里 → 正常（清掉 miss_count）
 * 2. 移动识别：未直命中的记录在「本次扫描未匹配的新文件」中按综合评分找唯一候选，
 *    命中则沿用旧记录（id/评分/进度/书签全保留）改写到新路径，删掉扫描时临时插入的新行
 * 3. 删除清理：连续两次扫描零匹配（miss_count ≥ 2）才删记录（书签随 FK CASCADE），先列出清单
 * 纯 Node 实现（AGENTS.md：services 不 import Electron），连接由调用方注入
 */
const SIZE_TOLERANCE = 0.05
const WORD_TOLERANCE = 0.02
const DELETE_THRESHOLD = 2

export interface MovedBook {
  id: number
  from: string
  to: string
  title: string
}

export interface DeletedBook {
  id: number
  relativePath: string
  title: string
}

/** 最近一次对账的内存日志（方案 §2.3：UI 可查「已识别移动 N 本 / 疑似删除 N 本」） */
export interface ReconcileLog {
  moved: MovedBook[]
  /** 本轮零匹配的疑似删除数（含已删除的） */
  pending: number
  /** 本轮达到阈值并删除的记录（删除前清单） */
  deleted: DeletedBook[]
  finishedAt: number
}

interface BookRow {
  id: number
  relative_path: string
  filename: string
  title: string
  word_count: number
  size_bytes: number
  miss_count: number
}

interface BookMetaRow {
  filename: string
  title: string
  author: string
  tags: string
  word_count: number
  size_bytes: number
  encoding: string
}
let lastLog: ReconcileLog | null = null

/** 取最近一次对账结果（内存级，重启清零） */
export function getReconcileLog(): ReconcileLog | null {
  return lastLog
}

/** 相对偏差是否在容忍范围内（分母取较大值，双方为 0 视为相同） */
function withinRatio(left: number, right: number, tolerance: number): boolean {
  const max = Math.max(left, right)
  return max === 0 || Math.abs(left - right) / max <= tolerance
}

/** 移动候选条件（方案 §四，任一满足即可） */
function isMoveCandidate(row: BookRow, book: ScannedBook): boolean {
  if (row.title === book.title && row.filename === book.filename) return true
  if (
    row.filename === book.filename &&
    withinRatio(row.size_bytes, book.sizeBytes, SIZE_TOLERANCE)
  ) {
    return true
  }
  if (row.title === book.title && withinRatio(row.word_count, book.wordCount, WORD_TOLERANCE)) {
    return true
  }
  return false
}

/**
 * 扫描入库后调用：scanned 为本次 enrich 命中的书目。
 * 空结果直接返回——扫描失败/根目录不可达时不能把全库当成「连续零匹配」删掉。
 */
export function reconcileLibrary(
  scanned: ScannedBook[],
  db: Database = getDatabase()
): ReconcileLog {
  const log: ReconcileLog = { moved: [], pending: 0, deleted: [], finishedAt: 0 }
  if (scanned.length === 0) {
    lastLog = { ...log, finishedAt: Date.now() }
    return lastLog
  }

  const rows = db
    .prepare(
      `SELECT id, relative_path, filename, title, word_count, size_bytes, miss_count
         FROM books ORDER BY id`
    )
    .all() as BookRow[]
  const scannedPaths = new Set(scanned.map((book) => book.relativePath))
  // 扫描时临时插入的新文件行：本次扫描未匹配上的旧记录只能从这里找移动目标
  const newPaths = new Set(scanned.filter((book) => book.inserted).map((book) => book.relativePath))
  const unmatchedNew = scanned.filter((book) => book.inserted)

  const resetMiss = db.prepare('UPDATE books SET miss_count = 0 WHERE id = ?')
  const bumpMiss = db.prepare('UPDATE books SET miss_count = miss_count + 1 WHERE id = ?')
  const deleteBook = db.prepare('DELETE FROM books WHERE id = ?')
  const findNewRow = db.prepare('SELECT id FROM books WHERE relative_path = ?')
  const readMeta = db.prepare(
    `SELECT filename, title, author, tags, word_count, size_bytes, encoding
       FROM books WHERE id = ?`
  )
  const adopt = db.prepare(`
    UPDATE books SET
      relative_path = @relativePath, filename = @filename, title = @title, author = @author,
      tags = @tags, word_count = @wordCount, size_bytes = @sizeBytes, encoding = @encoding,
      miss_count = 0, updated_at = @updatedAt
    WHERE id = @id
  `)

  db.transaction(() => {
    for (const row of rows) {
      // 扫描临时插入的行不参与直命中/挂起：要么被移动合并删掉，要么作为新书保留
      if (newPaths.has(row.relative_path)) continue
      if (scannedPaths.has(row.relative_path)) {
        if (row.miss_count !== 0) resetMiss.run(row.id)
        continue
      }

      const candidates = unmatchedNew.filter((book) => isMoveCandidate(row, book))
      const target = candidates.length === 1 ? candidates[0] : null
      const newRow = target
        ? (findNewRow.get(target.relativePath) as { id: number } | undefined)
        : undefined
      if (target && newRow) {
        const meta = readMeta.get(newRow.id) as BookMetaRow
        // 先删扫描临时行再改写旧行，避免 relative_path 唯一约束冲突（事务内失败会整体回滚）
        deleteBook.run(newRow.id)
        // 旧 id 接手新路径与扫描元数据，评分/进度/最近阅读/书签原样保留
        adopt.run({
          relativePath: target.relativePath,
          filename: meta.filename,
          title: meta.title,
          author: meta.author,
          tags: meta.tags,
          wordCount: meta.word_count,
          sizeBytes: meta.size_bytes,
          encoding: meta.encoding,
          updatedAt: Date.now(),
          id: row.id
        })
        unmatchedNew.splice(unmatchedNew.indexOf(target), 1)
        log.moved.push({
          id: row.id,
          from: row.relative_path,
          to: target.relativePath,
          title: target.title
        })
        continue
      }

      // 零候选或多候选：挂起累计，达到阈值才删除
      log.pending++
      bumpMiss.run(row.id)
      if (row.miss_count + 1 >= DELETE_THRESHOLD) {
        log.deleted.push({ id: row.id, relativePath: row.relative_path, title: row.title })
        deleteBook.run(row.id)
      }
    }
  })()

  log.finishedAt = Date.now()
  lastLog = log
  return log
}
