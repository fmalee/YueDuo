import { join } from 'path'
import Database from 'better-sqlite3'

/**
 * 数据库骨架（方案 §1.8 第一步 / §四 schema）：
 * - 库文件放 userData（书库根目录在阶段 2 才确定，届时按方案迁到库根并回落 userData）
 * - WAL + `PRAGMA user_version` 迁移执行器，重复启动幂等
 * - v1/v2 建会话恢复表；v3 建书库主表（books/bookmarks/tag_ratings）
 * 纯 Node 实现（AGENTS.md：services 不 import Electron），目录由调用方注入
 */
type Migration = (db: Database.Database) => void

const MIGRATIONS: readonly Migration[] = [
  // v1：会话恢复表（session_state 恒一行；session_tabs 按 position 还原标签顺序）
  (db) => {
    db.exec(`
      CREATE TABLE session_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active_tab_id TEXT
      );

      CREATE TABLE session_tabs (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        book_id INTEGER,
        path TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        progress_line INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 0,
        draft BLOB,
        view_state TEXT,
        last_focused_at INTEGER NOT NULL DEFAULT 0
      );
    `)
  },
  // v2：会话恢复补光标位置（原 progress_line 只够还原视口顶部，重启后光标会跑到第一行）
  (db) => {
    db.exec(`
      ALTER TABLE session_tabs ADD COLUMN cursor_line INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE session_tabs ADD COLUMN cursor_column INTEGER NOT NULL DEFAULT 0;
    `)
  },
  // v3：书库主表（方案 §四）。miss_count 供 2.3 对账跟踪连续零匹配次数
  (db) => {
    db.exec(`
      CREATE TABLE books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        relative_path TEXT UNIQUE NOT NULL,
        filename TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        rating INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
        word_count INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        progress_line INTEGER NOT NULL DEFAULT 0,
        encoding TEXT NOT NULL DEFAULT '',
        last_read_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        miss_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX idx_books_last_read ON books(last_read_at DESC);

      CREATE TABLE bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        line INTEGER NOT NULL CHECK (line > 0),
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE (book_id, line)
      );

      CREATE TABLE tag_ratings (
        tag TEXT PRIMARY KEY,
        rating INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
        updated_at INTEGER NOT NULL
      );
    `)
  }
]

/** 逐个补齐版本：每个迁移与 user_version 自增在同一事务内，中断不会留下半套表 */
function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      MIGRATIONS[version](db)
      db.pragma(`user_version = ${version + 1}`)
    })()
  }
}

let handle: Database.Database | null = null
let activeFile = ''

/**
 * 打开（必要时创建）一个库文件并执行迁移，不切换活动库。
 * 换库（方案 §2.13）要先把新库建好并读出会话，旧库在 commit 前仍保持可写。
 */
export function openDatabase(file: string): Database.Database {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  // 书签随书删除靠 FK CASCADE；pragma 在事务外设置才对后续连接生效（迁移内部的事务不受影响）
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

/** 把已打开的库设为活动库（旧连接由调用方决定何时关闭） */
export function activateDatabase(db: Database.Database, file: string): void {
  handle = db
  activeFile = file
}

/**
 * 原子切换活动库：先换全局引用再返回旧连接，调用方在切换成功后关闭旧连接。
 * 该函数本身不失败，因此换库的提交点是安全的（失败只会发生在准备阶段）。
 */
export function swapDatabase(next: Database.Database, file: string): Database.Database | null {
  const previous = handle
  handle = next
  activeFile = file
  return previous
}

/** 当前活动库文件（诊断/验收用） */
export function getDatabaseFile(): string {
  return activeFile
}

/** 打开（必要时创建）yueduo.db 并设为活动库；重复调用直接复用连接 */
export function initDatabase(dir: string): void {
  if (handle) return
  const file = join(dir, 'yueduo.db')
  activateDatabase(openDatabase(file), file)
}

/** 取库连接（session/draft 服务用）；未初始化即抛错，由 registry 收敛为 {ok:false} */
export function getDatabase(): Database.Database {
  if (!handle) throw new Error('数据库尚未初始化')
  return handle
}

/** 关窗退出前收尾（WAL checkpoint 落盘，避免残留 -wal/-shm） */
export function closeDatabase(): void {
  handle?.close()
  handle = null
  activeFile = ''
}
