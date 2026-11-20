//! 书签持久化（对齐 electron/services/bookmarkRepository.ts，方案 §2.6）：
//! 书签挂在 books 之下，按 books.relative_path 定位；行号 1-based，同行唯一。
//! 添加时若该书尚未入库（例如 enrich 还没跑到），先补一条最小书籍记录，
//! 后续扫描按 relative_path 直命中时会把书名/作者/标签补全，不会产生重复行。

use rusqlite::{params, Connection, OptionalExtension};

use crate::types::*;

/// 服务层分组：只带相对路径，绝对路径由命令层拼书库根
pub struct LibraryBookmarkGroupRow {
    pub relative_path: String,
    pub title: String,
    pub bookmarks: Vec<BookmarkInfo>,
}

pub fn list_bookmarks(db: &Connection, relative_path: &str) -> Result<Vec<BookmarkInfo>, String> {
    let mut stmt = db
        .prepare(
            "SELECT m.line, m.note
               FROM bookmarks AS m
               JOIN books AS b ON b.id = m.book_id
              WHERE b.relative_path = ?1
              ORDER BY m.line",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([relative_path], |row| {
            Ok(BookmarkInfo {
                line: row.get(0)?,
                note: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn ensure_book_id(db: &Connection, relative_path: &str, filename: &str) -> Result<i64, String> {
    let now = now_ms();
    // title 兜底：文件名去最后一个后缀
    let title = match filename.rfind('.') {
        Some(idx) if idx > 0 => &filename[..idx],
        _ => filename,
    };
    db.execute(
        "INSERT INTO books (relative_path, filename, title, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(relative_path) DO NOTHING",
        params![relative_path, filename, title, now],
    )
    .map_err(|e| e.to_string())?;
    db.query_row(
        "SELECT id FROM books WHERE relative_path = ?1",
        params![relative_path],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("书籍记录写入失败：{relative_path}"))
}

/// 添加书签（同行重复时更新摘要），返回该书最新的书签列表
pub fn add_bookmark(
    db: &Connection,
    relative_path: &str,
    filename: &str,
    line: i64,
    note: &str,
) -> Result<Vec<BookmarkInfo>, String> {
    let book_id = ensure_book_id(db, relative_path, filename)?;
    db.execute(
        "INSERT INTO bookmarks (book_id, line, note, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(book_id, line) DO UPDATE SET note = excluded.note",
        params![book_id, line, note, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    list_bookmarks(db, relative_path)
}

/// 删除书签，返回该书最新的书签列表
pub fn remove_bookmark(
    db: &Connection,
    relative_path: &str,
    line: i64,
) -> Result<Vec<BookmarkInfo>, String> {
    db.execute(
        "DELETE FROM bookmarks
          WHERE line = ?1
            AND book_id IN (SELECT id FROM books WHERE relative_path = ?2)",
        params![line, relative_path],
    )
    .map_err(|e| e.to_string())?;
    list_bookmarks(db, relative_path)
}

/// 全库书签按书分组（方案 §2.7）：按 relative_path 排序后顺序聚合
pub fn list_library_bookmarks(db: &Connection) -> Result<Vec<LibraryBookmarkGroupRow>, String> {
    let mut stmt = db
        .prepare(
            "SELECT b.relative_path, b.title, b.filename, m.line, m.note
               FROM bookmarks AS m
               JOIN books AS b ON b.id = m.book_id
              ORDER BY b.relative_path COLLATE NOCASE, b.filename, m.line",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                BookmarkInfo {
                    line: row.get(3)?,
                    note: row.get(4)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut groups: Vec<LibraryBookmarkGroupRow> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = Default::default();
    for (relative_path, title, filename, bookmark) in rows {
        let position = *index.entry(relative_path.clone()).or_insert_with(|| {
            // title 可能为空（enrich 未跑到）：退回文件名去后缀，与最小书籍记录一致
            let fallback = match filename.rfind('.') {
                Some(idx) if idx > 0 => &filename[..idx],
                _ => filename.as_str(),
            };
            groups.push(LibraryBookmarkGroupRow {
                title: if title.is_empty() { fallback.to_string() } else { title },
                relative_path: relative_path.clone(),
                bookmarks: Vec::new(),
            });
            groups.len() - 1
        });
        groups[position].bookmarks.push(bookmark);
    }
    Ok(groups)
}

/// 整体回写某本书的书签（行号漂移后合并写入）。
/// 行号重复时保留先出现的一条，避免撞 (book_id, line) 唯一约束。
pub fn replace_bookmarks(
    db: &Connection,
    relative_path: &str,
    filename: &str,
    bookmarks: &[BookmarkInfo],
) -> Result<Vec<BookmarkInfo>, String> {
    let book_id = ensure_book_id(db, relative_path, filename)?;
    let now = now_ms();
    db.execute_batch("BEGIN;").map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        db.execute("DELETE FROM bookmarks WHERE book_id = ?1", params![book_id])
            .map_err(|e| e.to_string())?;
        let mut seen = std::collections::HashSet::new();
        for row in bookmarks {
            if row.line < 1 || !seen.insert(row.line) {
                continue;
            }
            db.execute(
                "INSERT INTO bookmarks (book_id, line, note, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![book_id, row.line, row.note, now],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => db.execute_batch("COMMIT;").map_err(|e| e.to_string())?,
        Err(e) => {
            let _ = db.execute_batch("ROLLBACK;");
            return Err(e);
        }
    }
    list_bookmarks(db, relative_path)
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
