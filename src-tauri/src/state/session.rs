//! 会话持久化与草稿（对齐 electron/services/sessionStore.ts + draftStore.ts，方案 §1.8）：
//! - 库内标签落 `book_id` + 相对路径（`path` 列），库外标签 `book_id NULL` + 绝对路径，
//!   空白标签两者为空；判定与换算在这里做（先 realpath 书库根与文件）
//! - 恢复时 `book_id` 优先按 `books.relative_path` 拼当前书库根，查不到/文件不存在退回
//!   会话里存的相对路径；仍不存在则标记缺失，等对账扫完按 `book_id` 重试一次
//! - draft/view_state 两列归 file:writeDraft 维护，persist 只更新其余字段，绝不覆盖草稿

use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::types::*;

/// 落盘位置：库内 = 相对路径（POSIX）+ book_id，库外 = 绝对路径 + NULL
pub struct StoredTabLocation {
    pub path: String,
    pub book_id: Option<i64>,
}

fn safe_realpath(path: &str) -> Option<std::path::PathBuf> {
    fs::canonicalize(path).ok()
}

fn is_within(root: &Path, target: &Path) -> bool {
    target.starts_with(root) && target != root
}

/// 绝对路径 → session_tabs 落盘位置。
/// 文件已不存在（外部移动后尚未对账）时退回原路径做文本比较，
/// 这样库内标签仍能保留相对路径与旧 book_id，不会因为一次 realpath 失败降级成库外标签。
pub fn stored_tab_location(db: &Connection, root: &str, absolute_path: &str) -> StoredTabLocation {
    if absolute_path.is_empty() {
        return StoredTabLocation {
            path: String::new(),
            book_id: None,
        };
    }
    let Some(real_root) = (if root.is_empty() { None } else { safe_realpath(root) }) else {
        return StoredTabLocation {
            path: absolute_path.to_string(),
            book_id: None,
        };
    };
    let target = safe_realpath(absolute_path)
        .unwrap_or_else(|| std::path::PathBuf::from(absolute_path));
    if !is_within(&real_root, &target) {
        return StoredTabLocation {
            path: absolute_path.to_string(),
            book_id: None,
        };
    }
    let relative_path = target
        .strip_prefix(&real_root)
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    let book_id = db
        .query_row(
            "SELECT id FROM books WHERE relative_path = ?",
            [&relative_path],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None);
    StoredTabLocation {
        path: relative_path,
        book_id,
    }
}

/// 占位行的默认位置用：表格已空时从 0 开始
pub fn next_position(db: &Connection) -> i64 {
    db.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM session_tabs",
        [],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

/// 全量落盘（单事务）：
/// - 快照内标签按数组顺序写 position（INSERT 或 UPDATE，draft/view_state 不在更新列表里）
/// - 库内标签写相对路径 + book_id；库外标签写绝对路径 + NULL
/// - 文件暂时不可达但 path 与上次一致时沿用旧 book_id，避免外部移动未对账时丢掉身份
/// - 快照外的行删除（关掉的标签不残留；其草稿随行一起消失）
/// - session_state 恒一行，保存 active
pub fn persist_session(
    db: &Connection,
    snapshot: &SessionSnapshot,
    root: &str,
) -> Result<(), String> {
    let read_stored = |db: &Connection, id: &str| -> Option<(Option<i64>, String)> {
        db.query_row(
            "SELECT book_id, path FROM session_tabs WHERE id = ?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .unwrap_or(None)
    };
    let ids: Vec<&str> = snapshot.tabs.iter().map(|t| t.id.as_str()).collect();
    db.execute_batch("BEGIN;").map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        for (position, tab) in snapshot.tabs.iter().enumerate() {
            let mut stored = stored_tab_location(db, root, &tab.path);
            // 文件暂不可达但相对路径与上次一致：沿用旧 book_id（保留库内身份）
            if let Some((prev_book_id, prev_path)) = read_stored(db, &tab.id) {
                if stored.book_id.is_none()
                    && prev_book_id.is_some()
                    && !stored.path.is_empty()
                    && !stored.path.starts_with('/')
                    && prev_path == stored.path
                {
                    stored.book_id = prev_book_id;
                }
            }
            let changed = db.execute(
                "INSERT INTO session_tabs
                   (id, position, book_id, path, title, progress_line, cursor_line, cursor_column,
                    dirty, last_focused_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                   position = excluded.position, book_id = excluded.book_id, path = excluded.path,
                   title = excluded.title, progress_line = excluded.progress_line,
                   cursor_line = excluded.cursor_line, cursor_column = excluded.cursor_column,
                   dirty = excluded.dirty, last_focused_at = excluded.last_focused_at",
                params![
                    tab.id,
                    position as i64,
                    stored.book_id,
                    stored.path,
                    tab.title,
                    tab.progress_line,
                    tab.cursor_line,
                    tab.cursor_column,
                    tab.dirty,
                    tab.last_focused_at
                ],
            );
            changed.map_err(|e| e.to_string())?;
        }
        if ids.is_empty() {
            db.execute("DELETE FROM session_tabs", [])
                .map_err(|e| e.to_string())?;
        } else {
            let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("DELETE FROM session_tabs WHERE id NOT IN ({placeholders})");
            let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
            stmt.execute(rusqlite::params_from_iter(ids.iter()))
                .map_err(|e| e.to_string())?;
        }
        db.execute(
            "INSERT INTO session_state (id, active_tab_id) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET active_tab_id = excluded.active_tab_id",
            params![snapshot.active_tab_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    match result {
        Ok(()) => db.execute_batch("COMMIT;").map_err(|e| e.to_string()),
        Err(e) => {
            let _ = db.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

/// 恢复路径候选：book_id 对应的库内新路径优先，其次会话里存的路径（相对路径拼当前库根）。
/// 第一个存在的候选即命中；都不存在时取 book 路径作为展示路径并标记缺失。
fn restored_path(
    db: &Connection,
    root: &str,
    row: &(Option<i64>, String),
) -> (String, bool) {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(book_id) = row.0 {
        if let Ok(relative) = db.query_row(
            "SELECT relative_path FROM books WHERE id = ?",
            [book_id],
            |r| r.get::<_, String>(0),
        ) {
            candidates.push(if root.is_empty() {
                relative
            } else {
                format!("{root}/{relative}")
            });
        }
    }
    if !row.1.is_empty() {
        let stored = if row.1.starts_with('/') || root.is_empty() {
            row.1.clone()
        } else {
            format!("{root}/{}", row.1)
        };
        if !candidates.contains(&stored) {
            candidates.push(stored);
        }
    }
    if candidates.is_empty() {
        return (String::new(), false);
    }
    match candidates.iter().find(|c| Path::new(c).exists()) {
        Some(existing) => (existing.clone(), false),
        None => (candidates[0].clone(), true),
    }
}

/// 读取会话：按 position 升序。
/// 不在恢复时丢弃任何行：草稿行由 file:writeDraft 带着标签元信息写入，
/// 即使 persist 还没跑过也能恢复；空 title 只做兜底命名，不能让标签整个消失。
/// root 用于把库内相对路径拼回绝对路径，空串表示没有活动书库（历史绝对路径行按原样打开）。
pub fn load_session(db: &Connection, root: &str) -> Result<SessionRestore, String> {
    let mut stmt = db
        .prepare(
            "SELECT id, position, book_id, path, title, progress_line, cursor_line, cursor_column,
                    dirty, last_focused_at,
                    (draft IS NOT NULL OR view_state IS NOT NULL)
               FROM session_tabs
              ORDER BY position",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, bool>(10)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let active_stored: Option<String> = db
        .query_row(
            "SELECT active_tab_id FROM session_state WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None);

    let tabs = rows
        .into_iter()
        .map(|row| {
            let (id, position, book_id, stored_path, title, progress_line, cursor_line,
                 cursor_column, dirty, last_focused_at, has_draft) = row;
            let (path, missing) = restored_path(db, root, &(book_id, stored_path.clone()));
            SessionTabRecord {
                id,
                position,
                path,
                // 无草稿的 dirty 行只可能来自异常退出，恢复后按干净处理
                dirty: dirty == 1 && has_draft,
                title: if title.is_empty() { "未命名".into() } else { title },
                progress_line,
                cursor_line,
                cursor_column,
                last_focused_at,
                has_draft,
                book_id,
                missing,
            }
        })
        .collect::<Vec<_>>();
    let active_tab_id = active_stored
        .filter(|id| tabs.iter().any(|t| &t.id == id))
        .or_else(|| tabs.first().map(|t| t.id.clone()));
    Ok(SessionRestore { active_tab_id, tabs })
}

/// 对账扫完后重试缺失标签：按 book_id 取 books.relative_path 拼当前书库根，
/// 行不存在或文件仍不在时退回会话里存的相对路径。只返回重新找到文件的标签。
pub fn relocate_session_tabs(
    db: &Connection,
    root: &str,
    tab_ids: &[String],
) -> Result<Vec<SessionRelocation>, String> {
    if root.is_empty() || tab_ids.is_empty() {
        return Ok(vec![]);
    }
    let mut relocated = Vec::new();
    for id in tab_ids {
        let row: Option<(Option<i64>, String)> = db
            .query_row(
                "SELECT book_id, path FROM session_tabs WHERE id = ?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(row) = row else { continue };
        let (path, missing) = restored_path(db, root, &row);
        if !missing && !path.is_empty() {
            relocated.push(SessionRelocation {
                tab_id: id.clone(),
                path,
            });
        }
    }
    Ok(relocated)
}

// ---------- 草稿（对齐 electron/services/draftStore.ts） ----------
// 只写 draft/view_state 两列，其余列归 session:persist，互不覆盖。
// 全文只经 IPC 进出本存储，绝不进渲染进程 Vue 响应式（方案 §二根因教训 2）。

/// file:writeDraft —— 卸载时写入（text=null 表示非 dirty 卸载，只存进度）。
/// persist 尚未落盘就被卸载时用 meta 建行；路径口径与 persist 一致：库内相对路径 + book_id。
pub fn write_draft(
    db: &Connection,
    tab_id: &str,
    text: Option<&str>,
    view_state: &serde_json::Value,
    meta: Option<&DraftTabMeta>,
    root: &str,
) -> Result<(), String> {
    let blob = text.map(|t| t.as_bytes().to_vec());
    let view = if view_state.is_null() {
        None
    } else {
        Some(serde_json::to_string(view_state).map_err(|e| e.to_string())?)
    };
    let exists = db
        .query_row("SELECT 1 FROM session_tabs WHERE id = ?", [tab_id], |_| Ok(()))
        .optional()
        .map_err(|e| e.to_string())?;
    if exists.is_none() {
        let meta = meta.cloned().unwrap_or(DraftTabMeta {
            path: String::new(),
            title: "未命名".into(),
            progress_line: 0,
            last_focused_at: now_ms(),
        });
        let stored = stored_tab_location(db, root, &meta.path);
        let now = now_ms();
        db.execute(
            "INSERT INTO session_tabs
               (id, position, book_id, path, title, progress_line, dirty, draft, view_state,
                last_focused_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                tab_id,
                next_position(db),
                stored.book_id,
                stored.path,
                meta.title,
                meta.progress_line,
                text.is_some(),
                blob,
                view,
                if meta.last_focused_at > 0 { meta.last_focused_at } else { now }
            ],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    db.execute(
        "UPDATE session_tabs SET draft = ?1, view_state = ?2 WHERE id = ?3",
        params![blob, view, tab_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// file:readDraft —— 重载时读取；null = 该标签无草稿（从未被卸载）。
/// view_state 损坏只影响滚动位置，不牵连正文。
pub fn read_draft(db: &Connection, tab_id: &str) -> Result<Option<DraftEntry>, String> {
    let row: Option<(Option<Vec<u8>>, Option<String>)> = db
        .query_row(
            "SELECT draft, view_state FROM session_tabs WHERE id = ?",
            [tab_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((draft, view_state)) = row else {
        return Ok(None);
    };
    if draft.is_none() && view_state.is_none() {
        return Ok(None);
    }
    let view = view_state
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    Ok(Some(DraftEntry {
        text: draft.map(|b| String::from_utf8_lossy(&b).into_owned()),
        view_state: view,
    }))
}

/// file:clearDraft —— 保存/关闭后清理，防泄漏（方案 §1.4：保存后清 draft）
pub fn clear_draft(db: &Connection, tab_id: &str) -> Result<(), String> {
    db.execute(
        "UPDATE session_tabs SET draft = NULL, view_state = NULL WHERE id = ?",
        [tab_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::db::open_database;

    fn temp_db(tag: &str) -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!("yueduo-session-{}-{}", tag, std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let db = open_database(&dir.join("yueduo.db")).unwrap();
        (dir, db)
    }

    fn snapshot(tabs: Vec<(&str, &str)>, active: Option<&str>) -> SessionSnapshot {
        SessionSnapshot {
            active_tab_id: active.map(String::from),
            tabs: tabs
                .into_iter()
                .map(|(id, path)| SessionTabInput {
                    id: id.into(),
                    path: path.into(),
                    title: "书名".into(),
                    progress_line: 3,
                    cursor_line: 3,
                    cursor_column: 5,
                    dirty: false,
                    last_focused_at: 111,
                })
                .collect(),
        }
    }

    #[test]
    fn persist_restore_roundtrip_and_out_of_library_paths() {
        let (_dir, db) = temp_db("roundtrip");
        // 库外绝对路径标签 + 空白标签
        let snap = snapshot(
            vec![("t1", "/tmp/外面的书.txt"), ("t2", "")],
            Some("t1"),
        );
        persist_session(&db, &snap, "").unwrap();
        let restored = load_session(&db, "").unwrap();
        assert_eq!(restored.active_tab_id.as_deref(), Some("t1"));
        assert_eq!(restored.tabs.len(), 2);
        assert_eq!(restored.tabs[0].path, "/tmp/外面的书.txt");
        assert_eq!(restored.tabs[1].path, "");
        // 快照外行删除：只留 t2
        let snap2 = snapshot(vec![("t2", "")], None);
        persist_session(&db, &snap2, "").unwrap();
        let restored = load_session(&db, "").unwrap();
        assert_eq!(restored.tabs.len(), 1);
        assert_eq!(restored.tabs[0].id, "t2");
        assert!(restored.active_tab_id.is_none() || restored.active_tab_id.as_deref() == Some("t2"));
    }

    #[test]
    fn draft_write_read_clear_and_placeholder_row() {
        let (_dir, db) = temp_db("draft");
        // persist 未跑过：meta 建行
        write_draft(
            &db,
            "t9",
            Some("未保存的正文"),
            &serde_json::json!({"scrollTop": 42}),
            Some(&DraftTabMeta {
                path: "/tmp/x.txt".into(),
                title: "X".into(),
                progress_line: 7,
                last_focused_at: 222,
            }),
            "",
        )
        .unwrap();
        let entry = read_draft(&db, "t9").unwrap().unwrap();
        assert_eq!(entry.text.as_deref(), Some("未保存的正文"));
        assert_eq!(entry.view_state["scrollTop"], 42);
        // persist 不覆盖草稿两列
        let snap = snapshot(vec![("t9", "/tmp/x.txt")], None);
        persist_session(&db, &snap, "").unwrap();
        let entry = read_draft(&db, "t9").unwrap().unwrap();
        assert_eq!(entry.text.as_deref(), Some("未保存的正文"));
        // 清空后 → None
        clear_draft(&db, "t9").unwrap();
        assert!(read_draft(&db, "t9").unwrap().is_none());
        // has_draft 恢复口径：dirty 行无草稿 → 恢复按干净处理
        let restored = load_session(&db, "").unwrap();
        assert!(!restored.tabs[0].dirty);
    }

    #[test]
    fn relocate_reconnects_by_book_id() {
        let dir = std::env::temp_dir().join(format!("yueduo-relocate-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let root = dir.join("库");
        fs::create_dir_all(&root).unwrap();
        let db = open_database(&dir.join("yueduo.db")).unwrap();
        // 书入库
        let now = now_ms();
        db.execute(
            "INSERT INTO books (relative_path, filename, title, created_at, updated_at)
             VALUES ('a.txt', 'a.txt', 'A', ?1, ?1)",
            params![now],
        )
        .unwrap();
        let _book_id: i64 = db.query_row("SELECT id FROM books", [], |r| r.get(0)).unwrap();
        // 标签按库内口径落盘（相对路径 + book_id）
        let path = root.join("a.txt");
        fs::write(&path, "x").unwrap();
        let snap = snapshot(vec![("t1", path.to_str().unwrap())], None);
        persist_session(&db, &snap, root.to_str().unwrap()).unwrap();
        // 文件「移动」到新相对路径并更新 books（模拟对账接手）
        fs::rename(&path, root.join("moved.txt")).unwrap();
        db.execute("UPDATE books SET relative_path = 'moved.txt'", [])
            .unwrap();
        let out = relocate_session_tabs(&db, root.to_str().unwrap(), &["t1".into()]).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, format!("{}/moved.txt", root.to_str().unwrap()));
        fs::remove_dir_all(&dir).unwrap();
    }
}
