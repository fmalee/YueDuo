import { join } from 'path'
import Database from 'better-sqlite3'

/**
 * 数据库骨架（方案 §1.8 第一步 / §四 schema）：
 * - 库文件放 userData（书库根目录在阶段 2 才确定，届时按方案迁到库根并回落 userData）
 * - WAL + `PRAGMA user_version` 迁移执行器，重复启动幂等
 * - 本步只建会话恢复所需的 session_state / session_tabs，不含任何读写逻辑
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

/** 打开（必要时创建）yueduo.db 并执行迁移；重复调用直接复用连接 */
export function initDatabase(dir: string): void {
  if (handle) return
  const db = new Database(join(dir, 'yueduo.db'))
  db.pragma('journal_mode = WAL')
  migrate(db)
  handle = db
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
}
