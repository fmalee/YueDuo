//! 数据库骨架（对齐 electron/services/database.ts）：
//! WAL + `PRAGMA user_version` 迁移执行器（v1–v3 与 Electron 版逐字一致，幂等）。

use std::path::Path;

use rusqlite::Connection;

/// 打开（必要时创建）一个库文件并执行迁移。
/// WAL + foreign_keys 在事务外设置才对后续连接生效。
pub fn open_database(file: &Path) -> Result<Connection, String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建数据库目录失败: {e}"))?;
    }
    let db =
        Connection::open(file).map_err(|e| format!("打开数据库失败 {}: {e}", file.display()))?;
    db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| e.to_string())?;
    migrate(&db)?;
    Ok(db)
}

/// 迁移 v1–v3：SQL 与 Electron 版逐字一致，建表只对新库生效，幂等。
fn migrate(db: &Connection) -> Result<(), String> {
    let current: i64 = db
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let migrations: [&str; 3] = [
        // v1：会话恢复表（session_state 恒一行；session_tabs 按 position 还原标签顺序）
        "CREATE TABLE session_state (
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
         );",
        // v2：会话恢复补光标位置
        "ALTER TABLE session_tabs ADD COLUMN cursor_line INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE session_tabs ADD COLUMN cursor_column INTEGER NOT NULL DEFAULT 0;",
        // v3：书库主表（miss_count 供对账跟踪连续零匹配次数）
        "CREATE TABLE books (
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
         );",
    ];
    for (version, sql) in migrations.iter().enumerate() {
        let version = version as i64;
        if current <= version {
            // 每个迁移与 user_version 自增在同一事务内，中断不会留下半套表
            db.execute_batch(&format!("BEGIN;{sql};PRAGMA user_version = {};", version + 1))
                .and_then(|_| db.execute_batch("COMMIT;"))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent_and_match_electron_schema() {
        let dir = std::env::temp_dir().join(format!("yueduo-db-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("yueduo.db");
        {
            let db = open_database(&file).unwrap();
            let version: i64 = db
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(version, 3);
            db.execute(
                "INSERT INTO session_tabs (id, position, path, title) VALUES ('t1', 0, 'a.txt', 'A')",
                [],
            )
            .unwrap();
        }
        // 重开不重放迁移，数据仍在
        let db = open_database(&file).unwrap();
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM session_tabs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let tables: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN
                 ('session_state','session_tabs','books','bookmarks','tag_ratings')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 5);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
