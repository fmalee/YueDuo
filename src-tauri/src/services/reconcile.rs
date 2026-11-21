//! 书库身份对账（方案 §2.3 / §四 三步，对齐 electron/services/reconcile.ts）：
//! 1. 直命中：库内记录的 relative_path 仍在本次扫描结果里 → 正常（清掉 miss_count）
//! 2. 移动识别：未直命中的记录在「本次扫描未匹配的新文件」中按规则找唯一候选，
//!    命中则沿用旧记录（id/评分/进度/书签全保留）改写到新路径，删掉扫描时临时插入的新行
//! 3. 删除清理：连续两次扫描零匹配（miss_count ≥ 2）才删记录（书签随 FK CASCADE）

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use crate::services::now_ms;
use crate::types::ScannedBook;

const SIZE_TOLERANCE: f64 = 0.05;
const WORD_TOLERANCE: f64 = 0.02;
const DELETE_THRESHOLD: i64 = 2;

pub struct ReconcileLog {
    /// 本轮识别为移动并合并的记录数
    pub moved: usize,
    /// 本轮零匹配的疑似删除数（含已删除的）
    pub pending: i64,
    /// 本轮达到阈值并删除的记录数
    pub deleted: i64,
}

/// 相对偏差是否在容忍范围内（分母取较大值，双方为 0 视为相同）
fn within_ratio(left: i64, right: i64, tolerance: f64) -> bool {
    let max = left.max(right) as f64;
    max == 0.0 || ((left - right).abs() as f64) / max <= tolerance
}

/// 移动候选条件（方案 §四，任一满足即可）
fn is_move_candidate(row: &BookRow, book: &ScannedBook) -> bool {
    if row.title == book.title && row.filename == book.filename {
        return true;
    }
    if row.filename == book.filename && within_ratio(row.size_bytes, book.size_bytes, SIZE_TOLERANCE)
    {
        return true;
    }
    if row.title == book.title && within_ratio(row.word_count, book.word_count, WORD_TOLERANCE) {
        return true;
    }
    false
}

struct BookRow {
    id: i64,
    relative_path: String,
    filename: String,
    title: String,
    word_count: i64,
    size_bytes: i64,
    miss_count: i64,
}

/// 扫描入库后调用：scanned 为本次 enrich 命中的书目。
/// 空结果直接返回——扫描失败/根目录不可达时不能把全库当成「连续零匹配」删掉。
pub fn reconcile_library(db: &Connection, scanned: &[ScannedBook]) -> Result<ReconcileLog, String> {
    let mut log = ReconcileLog {
        moved: 0,
        pending: 0,
        deleted: 0,
    };
    if scanned.is_empty() {
        return Ok(log);
    }

    let mut stmt = db
        .prepare(
            "SELECT id, relative_path, filename, title, word_count, size_bytes, miss_count
               FROM books ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(BookRow {
                id: row.get(0)?,
                relative_path: row.get(1)?,
                filename: row.get(2)?,
                title: row.get(3)?,
                word_count: row.get(4)?,
                size_bytes: row.get(5)?,
                miss_count: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let scanned_paths: HashSet<&str> = scanned.iter().map(|b| b.relative_path.as_str()).collect();
    // 扫描时临时插入的新文件行：本次扫描未匹配上的旧记录只能从这里找移动目标
    let mut unmatched_new: Vec<&ScannedBook> =
        scanned.iter().filter(|b| b.inserted).collect();

    db.execute_batch("BEGIN;").map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        for row in &rows {
            // 扫描临时插入的行不参与直命中/挂起：要么被移动合并删掉，要么作为新书保留
            if scanned_paths.contains(row.relative_path.as_str()) {
                if row.miss_count != 0 {
                    db.execute("UPDATE books SET miss_count = 0 WHERE id = ?1", params![row.id])
                        .map_err(|e| e.to_string())?;
                }
                continue;
            }
            let candidates: Vec<&ScannedBook> = unmatched_new
                .iter()
                .filter(|book| is_move_candidate(row, book))
                .copied()
                .collect();
            let target = if candidates.len() == 1 {
                Some(candidates[0])
            } else {
                None
            };
            if let Some(target) = target {
                let new_row: Option<i64> = db
                    .query_row(
                        "SELECT id FROM books WHERE relative_path = ?1",
                        params![target.relative_path],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                if let Some(new_row_id) = new_row {
                    // 先删扫描临时行再改写旧行，避免 relative_path 唯一约束冲突
                    db.execute("DELETE FROM books WHERE id = ?1", params![new_row_id])
                        .map_err(|e| e.to_string())?;
                    // 旧 id 接手新路径与扫描元数据，评分/进度/最近阅读/书签原样保留
                    db.execute(
                        "UPDATE books SET
                           relative_path = ?2, filename = ?3, title = ?4,
                           word_count = ?5, size_bytes = ?6,
                           miss_count = 0, updated_at = ?7
                         WHERE id = ?1",
                        params![
                            row.id,
                            target.relative_path,
                            target.filename,
                            target.title,
                            target.word_count,
                            target.size_bytes,
                            now_ms()
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                    if let Some(pos) = unmatched_new.iter().position(|b| std::ptr::eq(*b, target)) {
                        unmatched_new.remove(pos);
                    }
                    log.moved += 1;
                    continue;
                }
            }
            // 零候选或多候选：挂起累计，达到阈值才删除
            log.pending += 1;
            db.execute(
                "UPDATE books SET miss_count = miss_count + 1 WHERE id = ?1",
                params![row.id],
            )
            .map_err(|e| e.to_string())?;
            if row.miss_count + 1 >= DELETE_THRESHOLD {
                db.execute("DELETE FROM books WHERE id = ?1", params![row.id])
                    .map_err(|e| e.to_string())?;
                log.deleted += 1;
            }
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
    Ok(log)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::db::open_database;

    fn scanned(rel: &str, title: &str, word: i64, size: i64, inserted: bool) -> ScannedBook {
        ScannedBook {
            relative_path: rel.into(),
            filename: rel.rsplit('/').next().unwrap().into(),
            title: title.into(),
            word_count: word,
            size_bytes: size,
            inserted,
        }
    }

    #[test]
    fn empty_scan_does_not_delete_anything() {
        let dir = std::env::temp_dir().join(format!("yueduo-rec-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = open_database(&dir.join("yueduo.db")).unwrap();
        db.execute(
            "INSERT INTO books (relative_path, title, created_at, updated_at) VALUES ('a.txt', 'A', 1, 1)",
            [],
        )
        .unwrap();
        let log = reconcile_library(&db, &[]).unwrap();
        assert_eq!(log.pending, 0);
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "空扫描保护：不能误删全库");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn direct_hit_resets_miss_count() {
        let dir = std::env::temp_dir().join(format!("yueduo-rec-hit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = open_database(&dir.join("yueduo.db")).unwrap();
        db.execute(
            "INSERT INTO books (relative_path, title, miss_count, created_at, updated_at) VALUES ('a.txt', 'A', 1, 1, 1)",
            [],
        )
        .unwrap();
        reconcile_library(&db, &[scanned("a.txt", "A", 10, 100, false)]).unwrap();
        let miss: i64 = db
            .query_row("SELECT miss_count FROM books WHERE relative_path = 'a.txt'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(miss, 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn move_recognition_keeps_bookmark_and_rating() {
        let dir = std::env::temp_dir().join(format!("yueduo-rec-move-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = open_database(&dir.join("yueduo.db")).unwrap();
        // 旧书（有评分与书签）+ 移动后的新路径（扫描临时插入）
        db.execute(
            "INSERT INTO books (relative_path, title, filename, word_count, size_bytes, rating, created_at, updated_at)
             VALUES ('旧/书.txt', '书名', '书.txt', 100, 1000, 4, 1, 1)",
            [],
        )
        .unwrap();
        let old_id: i64 = db.query_row("SELECT id FROM books", [], |r| r.get(0)).unwrap();
        db.execute(
            "INSERT INTO bookmarks (book_id, line, note, created_at) VALUES (?1, 3, '记', 1)",
            params![old_id],
        )
        .unwrap();
        db.execute(
            "INSERT INTO books (relative_path, title, filename, word_count, size_bytes, created_at, updated_at)
             VALUES ('新/书.txt', '书名', '书.txt', 102, 1010, 2, 2)",
            [],
        )
        .unwrap();
        // 扫描只看到移动后的新路径（旧路径已不存在，旧记录是库内残留）
        let log = reconcile_library(
            &db,
            &[scanned("新/书.txt", "书名", 102, 1010, true)],
        )
        .unwrap();
        assert_eq!(log.moved, 1);
        // 旧 id 接手新路径，评分/书签保留
        let (rating, bookmarks): (i64, i64) = db
            .query_row(
                "SELECT b.rating, (SELECT COUNT(*) FROM bookmarks WHERE book_id = b.id)
                   FROM books b WHERE b.relative_path = '新/书.txt'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(rating, 4);
        assert_eq!(bookmarks, 1);
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "临时插入的新行应被合并");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn second_zero_match_deletes_record() {
        let dir = std::env::temp_dir().join(format!("yueduo-rec-del-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = open_database(&dir.join("yueduo.db")).unwrap();
        db.execute(
            "INSERT INTO books (relative_path, title, word_count, size_bytes, created_at, updated_at)
             VALUES ('消失.txt', '消失', 10, 100, 1, 1)",
            [],
        )
        .unwrap();
        // 第一轮：挂起（miss_count 0→1）
        let log1 = reconcile_library(&db, &[scanned("在.txt", "别处", 10, 100, true)]).unwrap();
        assert_eq!(log1.pending, 1);
        assert_eq!(log1.deleted, 0);
        // 第二轮：达到阈值删除
        let log2 = reconcile_library(&db, &[scanned("在.txt", "别处", 10, 100, false)]).unwrap();
        assert_eq!(log2.deleted, 1);
        // reconcile 不插书（那是扫描器的职责）：删除后库内应为空
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
