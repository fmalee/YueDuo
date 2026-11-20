//! 书库查询与书目仓储（对齐 electron/services/bookRepository.ts，方案 §2.5）：
//! 历史/追更/标签/评分排序口径与旧项目一致；连接与书库根由调用方注入。

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::types::*;

/// 评分页未筛选时最多列出的书目数量（对齐 Python RATED_LIST_LIMIT）
pub const RATED_LIST_LIMIT: i64 = 100;

const FOLLOWING_TAG: &str = "追更";

/// 标签在库里以空格分隔；前后补空格精确匹配，避免「追更中」被当成「追更」
fn tag_pattern(tag: &str) -> String {
    format!(" {tag} ")
}

fn to_book(row: &BookRow, root: &str) -> LibraryBook {
    LibraryBook {
        id: row.id,
        relative_path: row.relative_path.clone(),
        path: if root.is_empty() {
            row.relative_path.clone()
        } else {
            format!("{root}/{}", row.relative_path)
        },
        filename: row.filename.clone(),
        title: row.title.clone(),
        author: row.author.clone(),
        tags: row
            .tags
            .split(' ')
            .filter(|t| !t.is_empty())
            .map(String::from)
            .collect(),
        rating: row.rating,
        word_count: row.word_count,
        progress_line: row.progress_line,
        last_read_at: row.last_read_at,
    }
}

struct BookRow {
    id: i64,
    relative_path: String,
    filename: String,
    title: String,
    author: String,
    tags: String,
    rating: i64,
    word_count: i64,
    progress_line: i64,
    last_read_at: i64,
}

const BOOK_COLUMNS: &str = "id, relative_path, filename, title, author, tags, rating,
    word_count, progress_line, last_read_at";

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BookRow> {
    Ok(BookRow {
        id: row.get(0)?,
        relative_path: row.get(1)?,
        filename: row.get(2)?,
        title: row.get(3)?,
        author: row.get(4)?,
        tags: row.get(5)?,
        rating: row.get(6)?,
        word_count: row.get(7)?,
        progress_line: row.get(8)?,
        last_read_at: row.get(9)?,
    })
}

fn query_books(db: &Connection, sql: &str, root: &str, params: impl rusqlite::Params) -> Result<Vec<LibraryBook>, String> {
    let mut stmt = db.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params, read_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|r| to_book(r, root)).collect())
}

/// 快速检索快照：全量书目，最近读过的在前（方案 §2.12）
pub fn list_all_books(db: &Connection, root: &str) -> Result<Vec<LibraryBook>, String> {
    query_books(
        db,
        &format!(
            "SELECT {BOOK_COLUMNS} FROM books
             ORDER BY (last_read_at = 0), last_read_at DESC, title"
        ),
        root,
        [],
    )
}

/// 历史：有阅读记录的书，按最近阅读时间倒序
pub fn list_history(db: &Connection, root: &str) -> Result<Vec<LibraryBook>, String> {
    query_books(
        db,
        &format!(
            "SELECT {BOOK_COLUMNS} FROM books
             WHERE last_read_at > 0
             ORDER BY last_read_at DESC, id DESC"
        ),
        root,
        [],
    )
}

/// 追更：标签精确匹配「追更」；与标签/评分页统一按评分、最近阅读排序
pub fn list_following(db: &Connection, root: &str) -> Result<Vec<LibraryBook>, String> {
    query_books(
        db,
        &format!(
            "SELECT {BOOK_COLUMNS} FROM books
             WHERE instr(' ' || tags || ' ', ?1) > 0
             ORDER BY rating DESC, (last_read_at = 0), last_read_at DESC, title"
        ),
        root,
        params![tag_pattern(FOLLOWING_TAG)],
    )
}

/// 某个标签下的书：评分优先，同分按最近阅读时间
pub fn list_books_by_tag(db: &Connection, root: &str, tag: &str) -> Result<Vec<LibraryBook>, String> {
    query_books(
        db,
        &format!(
            "SELECT {BOOK_COLUMNS} FROM books
             WHERE instr(' ' || tags || ' ', ?1) > 0
             ORDER BY rating DESC, (last_read_at = 0), last_read_at DESC, title"
        ),
        root,
        params![tag_pattern(tag)],
    )
}

/// 评分页：评分从高到低，同分最近阅读在前；无筛选时最多 100 本
pub fn list_rated(db: &Connection, root: &str, rating: Option<i64>) -> Result<Vec<LibraryBook>, String> {
    let mut sql = format!("SELECT {BOOK_COLUMNS} FROM books WHERE rating > 0");
    if rating.is_some() {
        sql.push_str(" AND rating = ?1");
    }
    sql.push_str(" ORDER BY rating DESC, (last_read_at = 0), last_read_at DESC, title");
    if rating.is_none() {
        sql.push_str(&format!(" LIMIT {RATED_LIST_LIMIT}"));
    }
    query_books(db, &sql, root, params![rating.unwrap_or(0)])
}

/// 标签页：名称/数量/标签评分；先按标签评分、再按该标签下最近阅读时间排序
pub fn list_tags(db: &Connection) -> Result<Vec<LibraryTagSummary>, String> {
    let mut stmt = db
        .prepare("SELECT tags, last_read_at FROM books")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut rated: std::collections::HashMap<String, i64> = Default::default();
    let mut stmt = db
        .prepare("SELECT tag, rating FROM tag_ratings")
        .map_err(|e| e.to_string())?;
    let rated_rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (tag, rating) in rated_rows {
        rated.insert(tag, rating);
    }
    let mut counts: std::collections::HashMap<String, i64> = Default::default();
    // 标签下所有书的最近阅读时间（取最大值），同分时排在最近读过的标签前
    let mut latest: std::collections::HashMap<String, i64> = Default::default();
    for (tags, last_read_at) in rows {
        for tag in tags.split(' ').filter(|t| !t.is_empty()) {
            *counts.entry(tag.to_string()).or_default() += 1;
            let latest_entry = latest.entry(tag.to_string()).or_default();
            *latest_entry = (*latest_entry).max(last_read_at);
        }
    }
    let mut summaries: Vec<LibraryTagSummary> = counts
        .into_iter()
        .map(|(name, count)| LibraryTagSummary {
            rating: rated.get(&name).copied().unwrap_or(0),
            name,
            count,
        })
        .collect();
    summaries.sort_by(|a, b| {
        b.rating
            .cmp(&a.rating)
            .then((latest.get(&b.name).copied().unwrap_or(0))
                .cmp(&(latest.get(&a.name).copied().unwrap_or(0))))
            .then(b.count.cmp(&a.count))
            .then(a.name.cmp(&b.name))
    });
    Ok(summaries)
}

/// 打开/激活标签即写最近阅读时间；文件不在书库内返回 0（打开任意 txt 都不报错）
pub fn mark_read(db: &Connection, root: &str, absolute_path: &str) -> Result<i64, String> {
    let Some(relative) = relative_in_library(root, absolute_path) else {
        return Ok(0);
    };
    let now = now_ms();
    let changed = db
        .execute(
            "UPDATE books SET last_read_at = ?1, updated_at = ?1 WHERE relative_path = ?2",
            params![now, relative],
        )
        .map_err(|e| e.to_string())?;
    Ok(if changed > 0 { now } else { 0 })
}

/// 书籍评分：只写库（0～5）；Finder 星级由调用方拿到 relativePath 后另行写 xattr（P3）
pub fn set_book_rating(db: &Connection, id: i64, rating: i64) -> Result<(i64, Option<String>), String> {
    let value = rating.clamp(0, 5);
    let row: Option<String> = db
        .query_row(
            "SELECT relative_path FROM books WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE books SET rating = ?1, updated_at = ?2 WHERE id = ?3",
        params![value, now_ms(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok((value, row))
}

/// 标签评分只进数据库、不写正文；0 分也保留一行
pub fn set_tag_rating(db: &Connection, tag: &str, rating: i64) -> Result<i64, String> {
    let value = rating.clamp(0, 5);
    db.execute(
        "INSERT INTO tag_ratings (tag, rating, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(tag) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at",
        params![tag, value, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(value)
}

/// 按相对路径取单本（元数据栏读取；未入库返回 None）
pub fn find_book_by_relative_path(
    db: &Connection,
    root: &str,
    relative_path: &str,
) -> Result<Option<LibraryBook>, String> {
    let sql = format!("SELECT {BOOK_COLUMNS} FROM books WHERE relative_path = ?1");
    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let row = stmt
        .query_row(params![relative_path], read_row)
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| to_book(&r, root)))
}

/// 保存后回写当前文件的元数据（书名/作者/标签），不触发全库重扫
pub fn update_book_metadata(
    db: &Connection,
    relative_path: &str,
    title: &str,
    author: &str,
    tags: &str,
) -> Result<bool, String> {
    let changed = db
        .execute(
            "UPDATE books SET title = ?1, author = ?2, tags = ?3, updated_at = ?4
              WHERE relative_path = ?5",
            params![title, author, tags, now_ms(), relative_path],
        )
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

/// 文件改名/移动后同步库身份：只改 relative_path/filename，id 不变，
/// 书签、评分、最近阅读都随行保留；目标路径已有残留记录时删旧行（新文件刚改名而来）。
pub fn rename_book_record(
    db: &Connection,
    old_relative_path: &str,
    new_relative_path: &str,
    filename: &str,
) -> Result<bool, String> {
    db.execute_batch("BEGIN;").map_err(|e| e.to_string())?;
    let result = (|| -> Result<bool, String> {
        let target: Option<i64> = db
            .query_row(
                "SELECT id FROM books WHERE relative_path = ?1",
                params![new_relative_path],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if target.is_some() {
            let changed = db
                .execute("DELETE FROM books WHERE relative_path = ?1", params![old_relative_path])
                .map_err(|e| e.to_string())?;
            return Ok(changed > 0);
        }
        let changed = db
            .execute(
                "UPDATE books SET relative_path = ?1, filename = ?2, updated_at = ?3
                  WHERE relative_path = ?4",
                params![new_relative_path, filename, now_ms(), old_relative_path],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    })();
    match result {
        Ok(v) => db.execute_batch("COMMIT;").map(|_| v).map_err(|e| e.to_string()),
        Err(e) => {
            let _ = db.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

/// 文件移入废纸篓后删除库记录（书签随 FK CASCADE）
pub fn delete_book_record(db: &Connection, relative_path: &str) -> Result<bool, String> {
    let changed = db
        .execute("DELETE FROM books WHERE relative_path = ?1", params![relative_path])
        .map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

/// 绝对路径 → 库内相对路径（POSIX 分隔）；不在书库内返回 None
pub fn relative_in_library(root: &str, path: &str) -> Option<String> {
    if root.is_empty() || path.is_empty() {
        return None;
    }
    let resolved = std::fs::canonicalize(path).ok()?;
    let real_root = std::fs::canonicalize(root).ok()?;
    let rel = resolved.strip_prefix(&real_root).ok()?;
    let rel_str = rel.to_string_lossy();
    if rel_str.is_empty() {
        return None;
    }
    Some(rel_str.replace('\\', "/"))
}

/// 判定路径是否是 txt（大小写不敏感，兼容 .TXT）
pub fn is_txt_file(name: &str) -> bool {
    name.to_lowercase().ends_with(".txt")
}

/// 复用检查（保持 pub 供扫描器等使用）
pub fn _root_unused(_root: &Path) {}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
