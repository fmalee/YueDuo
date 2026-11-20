//! 书库扫描（方案 §2.2，以 Python library_scanner 为准翻译）：
//! - fast_scan：只读文件系统铺目录树，一层一读，不碰数据库也不读正文
//! - scan_library：后台递归遍历 .txt，解码全文 → 解析元数据 → 按 relative_path 直命中写库
//!   （移动识别/删除清理属 2.3 对账，由 reconcile.rs 做）
//! - ingest_file：单文件入库（保存/另存为到书库根内后立即收录）
//!
//! 扫描运行在独立线程 + 独立 SQLite 连接（WAL 多连接安全），不占主锁；
//! 逐文件检查取消标志，换库/退出时最多写完当前一本。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::services::codec::decode_bytes;
use crate::services::metadata::parse_metadata;
use crate::types::*;

/// 中文名称排序：数字感知（第2章 < 第10章）+ 码位序。
/// 与 TS 的 Intl.Collator('zh-Hans', numeric) 相比缺少拼音序（中文按码位排），
/// 目录树/扫描顺序可能与 Electron 版有细微差异；后续可用 ICU collator 补齐（方案 §五）。
pub fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    compare_numeric(a.as_bytes(), b.as_bytes())
}

fn compare_numeric(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            // 数字段：前导零对齐后按数值比较，等值时短的在前
            let ai = digit_run_end(a, i);
            let bj = digit_run_end(b, j);
            let (da, db) = (trim_leading_zeros(&a[i..ai]), trim_leading_zeros(&b[j..bj]));
            if da.len() != db.len() {
                return da.len().cmp(&db.len());
            }
            let ord = da.cmp(db);
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
            i = ai;
            j = bj;
        } else {
            if a[i] != b[j] {
                return a[i].cmp(&b[j]);
            }
            i += 1;
            j += 1;
        }
    }
    (a.len() - i).cmp(&(b.len() - j))
}

fn digit_run_end(bytes: &[u8], start: usize) -> usize {
    bytes[start..]
        .iter()
        .position(|b| !b.is_ascii_digit())
        .map(|p| start + p)
        .unwrap_or(bytes.len())
}

fn trim_leading_zeros(slice: &[u8]) -> &[u8] {
    let first_non_zero = slice.iter().position(|b| *b != b'0').unwrap_or(slice.len());
    &slice[first_non_zero..]
}

fn is_txt_file(name: &str) -> bool {
    name.to_lowercase().ends_with(".txt")
}

/// 书架目录树的一层（library:fastScan）：
/// 目录在前、TXT 在后，均按名称排序；符号链接按目标类型分类（断链跳过），
/// 展开下一层由渲染层按需再调，不在这一步递归。
pub fn list_directory(root: &Path, relative_dir: &str) -> Result<Vec<LibraryEntry>, String> {
    let dir = if relative_dir.is_empty() {
        root.to_path_buf()
    } else {
        root.join(relative_dir)
    };
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(vec![]), // 单个目录不可读不中断
    };
    let mut directories: Vec<LibraryEntry> = Vec::new();
    let mut files: Vec<LibraryEntry> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let relative_path = if relative_dir.is_empty() {
            name.clone()
        } else {
            format!("{relative_dir}/{name}")
        };
        let metadata = match entry.metadata() {
            Ok(md) => md, // 符号链接按目标解析；断链在此报错 → 跳过
            Err(_) => continue,
        };
        if metadata.is_dir() {
            directories.push(LibraryEntry {
                name,
                relative_path,
                is_dir: true,
            });
        } else if metadata.is_file() && is_txt_file(&name) {
            files.push(LibraryEntry {
                name,
                relative_path,
                is_dir: false,
            });
        }
    }
    let sort = |list: &mut Vec<LibraryEntry>| {
        list.sort_by(|a, b| compare_names(&a.name, &b.name));
    };
    sort(&mut directories);
    sort(&mut files);
    directories.extend(files);
    Ok(directories)
}

/// 深度优先遍历 .txt（对齐 Python _iter_txt_files）：
/// 每层先按名称输出本层文件，再按名称进入子目录；
/// 不进入符号链接目录（Python os.walk 默认 followlinks=False，避免环）。
fn walk_txt_files(dir_abs: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let entries = match fs::read_dir(dir_abs) {
        Ok(entries) => entries,
        Err(_) => return result, // 单个目录不可读不中断整次扫描
    };
    let mut names: Vec<(String, PathBuf, bool, bool, bool)> = Vec::new();
    // (name, path, is_file, is_symlink, is_dir)
    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        names.push((
            entry.file_name().to_string_lossy().to_string(),
            entry.path(),
            file_type.is_file(),
            file_type.is_symlink(),
            file_type.is_dir(),
        ));
    }
    names.sort_by(|a, b| compare_names(&a.0, &b.0));
    // 本层文件（含指向文件的符号链接，断链跳过）
    for (name, path, _, is_symlink, _) in &names {
        if *is_symlink {
            match fs::metadata(path) {
                Ok(md) if md.is_file() => {}
                _ => continue, // 断链或指向目录的链接不作为文件
            }
        }
        if is_txt_file(name) {
            result.push(path.clone());
        }
    }
    // 再进入子目录（符号链接目录不递归）
    for (_, path, _, is_symlink, is_dir) in &names {
        if *is_dir && !*is_symlink {
            result.extend(walk_txt_files(path));
        }
    }
    result
}

/// 扫描/单文件入库共用的写入口径（只维护一处，对齐 prepareBookWriters）
struct BookWriters<'a> {
    select_book: rusqlite::Statement<'a>,
    update_book: rusqlite::Statement<'a>,
    insert_book: rusqlite::Statement<'a>,
}

impl<'a> BookWriters<'a> {
    fn prepare(db: &'a Connection) -> Result<Self, String> {
        Ok(BookWriters {
            select_book: db
                .prepare("SELECT id FROM books WHERE relative_path = ?1")
                .map_err(|e| e.to_string())?,
            update_book: db
                .prepare(
                    "UPDATE books SET
                       filename = ?2, title = ?3, author = ?4, tags = ?5,
                       word_count = ?6, size_bytes = ?7, encoding = ?8,
                       rating = COALESCE(?9, rating), updated_at = ?10
                     WHERE id = ?1",
                )
                .map_err(|e| e.to_string())?,
            insert_book: db
                .prepare(
                    "INSERT INTO books
                       (relative_path, filename, title, author, tags, word_count, size_bytes,
                        encoding, rating, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, 0), ?10, ?10)",
                )
                .map_err(|e| e.to_string())?,
        })
    }

    /// 写一条扫描结果，返回是否新插入（重复路径只更新，不产生重复行）
    fn write(
        &mut self,
        fields: &BookWriteFields,
        rating: Option<i64>,
        now: i64,
    ) -> Result<bool, String> {
        let existing: Option<i64> = self
            .select_book
            .query_row(params![fields.relative_path], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        match existing {
            Some(id) => {
                self.update_book
                    .execute(params![
                        id,
                        fields.filename,
                        fields.title,
                        fields.author,
                        fields.tags,
                        fields.word_count,
                        fields.size_bytes,
                        fields.encoding,
                        rating,
                        now
                    ])
                    .map_err(|e| e.to_string())?;
                Ok(false)
            }
            None => {
                self.insert_book
                    .execute(params![
                        fields.relative_path,
                        fields.filename,
                        fields.title,
                        fields.author,
                        fields.tags,
                        fields.word_count,
                        fields.size_bytes,
                        fields.encoding,
                        rating,
                        now
                    ])
                    .map_err(|e| e.to_string())?;
                Ok(true)
            }
        }
    }
}

struct BookWriteFields {
    relative_path: String,
    filename: String,
    title: String,
    author: String,
    tags: String,
    word_count: i64,
    size_bytes: i64,
    encoding: String,
}

/// 扫描进度推送（每 10 个成功入库的文件一次，对齐 Python _ScanThread）
pub trait ScanProgressSink: FnMut(LibraryScanProgress) + Send {}
impl<T: FnMut(LibraryScanProgress) + Send> ScanProgressSink for T {}

/// 后台补元数据（library:enrich）：
/// 逐本读取 → 探测解码 → 解析书名/作者/标签/字数 → 按 relative_path 直命中写库。
/// 不可读文件与重复 inode 一律跳过，不中断整次扫描；
/// 更新只覆盖扫描可得字段，评分/进度/最近阅读与 miss_count 留给其它流程。
/// shouldContinue 每个文件前检查（换库/退出时置位取消，已入库的结果保留）。
pub fn scan_library(
    root: &Path,
    db: &Connection,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(LibraryScanProgress),
) -> Result<LibraryScanResult, String> {
    let mut writers = BookWriters::prepare(db)?;
    let mut seen = std::collections::HashSet::new();
    let mut result = LibraryScanResult {
        total: 0,
        skipped: 0,
        books: Vec::new(),
    };
    let real_root = match fs::canonicalize(root) {
        Ok(p) => p,
        Err(_) => return Ok(result),
    };
    let mut index: i64 = 0;
    for abs_path in walk_txt_files(root) {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        index += 1;
        let resolved = match fs::canonicalize(&abs_path) {
            Ok(p) => p,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        // 落库身份用 realpath 后的真实目标：符号链接与真实文件只入一次
        let rel = match resolved.strip_prefix(&real_root) {
            Ok(rel) if !rel.as_os_str().is_empty() => rel.to_string_lossy().replace('\\', "/"),
            _ => {
                result.skipped += 1; // 指向书库外的链接没有库内相对路径
                continue;
            }
        };
        if !seen.insert(resolved.clone()) {
            result.skipped += 1;
            continue;
        }
        let data = match fs::read(&resolved) {
            Ok(d) => d,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        let size_bytes = fs::metadata(&resolved).map(|m| m.len() as i64).unwrap_or(0);
        let decoded = decode_bytes(&data);
        let filename = resolved
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let dir_name = resolved
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let meta = parse_metadata(&decoded.text, &filename, &dir_name);
        let now = now_ms();
        let fields = BookWriteFields {
            relative_path: rel.clone(),
            filename,
            title: meta.title.clone(),
            author: meta.author,
            tags: meta.tags.join(" "),
            word_count: meta.word_count,
            size_bytes,
            encoding: decoded.encoding,
        };
        let inserted = writers.write(&fields, None, now)?;
        result.total += 1;
        result.books.push(ScannedBook {
            relative_path: rel,
            filename: fields.filename.clone(),
            title: meta.title,
            word_count: fields.word_count,
            size_bytes,
            inserted,
        });
        if index % 10 == 0 {
            on_progress(LibraryScanProgress {
                scanned: index,
                path: resolved.to_string_lossy().to_string(),
            });
        }
    }
    Ok(result)
}

/// 单文件入库结果（全库扫描与保存后单文件收录共用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestedBook {
    pub relative_path: String,
    pub filename: String,
    pub title: String,
    pub word_count: i64,
    pub size_bytes: i64,
    /// 本次是否新插入一行（false = 命中已有记录并更新）
    pub inserted: bool,
}

/// 单文件入库（另存为保存到书库根内后立即收录，不做全库扫描）：
/// 与 scan_library 同一口径 —— realpath 判定库内、解码正文、解析书名/作者/标签/字数，
/// 按 relative_path 直命中写库。文件不在库内、非 .txt 或不可读时返回 None（库外行为不变）。
pub fn ingest_file(
    root: &Path,
    absolute_path: &Path,
    db: &Connection,
) -> Result<Option<IngestedBook>, String> {
    let Some(name) = absolute_path.file_name().map(|n| n.to_string_lossy().to_string()) else {
        return Ok(None);
    };
    if !root.as_os_str().is_empty() && is_txt_file(&name) {
        let real_root = fs::canonicalize(root).ok();
        let resolved = fs::canonicalize(absolute_path).ok();
        if let (Some(real_root), Some(resolved)) = (real_root, resolved) {
            if let Ok(rel) = resolved.strip_prefix(&real_root) {
                if !rel.as_os_str().is_empty() {
                    let relative_path = rel.to_string_lossy().replace('\\', "/");
                    let data = fs::read(&resolved).map_err(|e| e.to_string())?;
                    let size_bytes = fs::metadata(&resolved).map(|m| m.len() as i64).unwrap_or(0);
                    let decoded = decode_bytes(&data);
                    let dir_name = resolved
                        .parent()
                        .and_then(|p| p.file_name())
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let meta = parse_metadata(&decoded.text, &name, &dir_name);
                    let now = now_ms();
                    let mut writers = BookWriters::prepare(db)?;
                    let fields = BookWriteFields {
                        relative_path: relative_path.clone(),
                        filename: name.clone(),
                        title: meta.title.clone(),
                        author: meta.author,
                        tags: meta.tags.join(" "),
                        word_count: meta.word_count,
                        size_bytes,
                        encoding: decoded.encoding,
                    };
                    let inserted = writers.write(&fields, None, now)?;
                    return Ok(Some(IngestedBook {
                        relative_path,
                        filename: fields.filename,
                        title: meta.title,
                        word_count: fields.word_count,
                        size_bytes,
                        inserted,
                    }));
                }
            }
        }
    }
    Ok(None)
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

    fn numeric_order_cases() {
        // 占位：具体断言见下方测试函数
    }

    #[test]
    fn numeric_aware_name_ordering() {
        numeric_order_cases();
        assert_eq!(compare_names("第2章", "第10章"), std::cmp::Ordering::Less);
        assert_eq!(compare_names("abc", "abd"), std::cmp::Ordering::Less);
        assert_eq!(compare_names("file2", "file10"), std::cmp::Ordering::Less);
        assert_eq!(compare_names("v01", "v1"), std::cmp::Ordering::Equal);
    }

    #[test]
    fn list_directory_dirs_first_then_txt_sorted() {
        let dir = std::env::temp_dir().join(format!("yueduo-scan-{}", std::process::id()));
        let root = dir.join("库");
        fs::create_dir_all(root.join("乙目录")).unwrap();
        fs::create_dir_all(root.join("甲目录")).unwrap();
        fs::write(root.join("b.txt"), "内容").unwrap();
        fs::write(root.join("a.txt"), "《书名》").unwrap();
        fs::write(root.join("skip.md"), "非文本").unwrap();
        let entries = list_directory(&root, "").unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["乙目录", "甲目录", "a.txt", "b.txt"]);
        assert!(entries[0].is_dir && !entries[2].is_dir);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scan_and_ingest_write_books() {
        let dir = std::env::temp_dir().join(format!("yueduo-scanlib-{}", std::process::id()));
        let root = dir.join("库");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("书甲.txt"), "《甲》\n作者：A\n主题：玄幻 追更\n内容一").unwrap();
        fs::create_dir_all(root.join("子")).unwrap();
        fs::write(root.join("子/书乙.txt"), "《乙》\n作者：B\n正文").unwrap();
        let db = open_database(&dir.join("yueduo.db")).unwrap();
        let cancel = AtomicBool::new(false);
        let result = scan_library(&root, &db, &cancel, |_| {}).unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.skipped, 0);
        // 重复扫描不产生重复行
        let again = scan_library(&root, &db, &cancel, |_| {}).unwrap();
        assert_eq!(again.total, 2);
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        // 书甲命中追更标签
        let following = crate::state::books::list_following(&db, root.to_str().unwrap()).unwrap();
        assert_eq!(following.len(), 1);
        assert_eq!(following[0].title, "甲");
        // ingest 更新已有书
        let ingested = ingest_file(&root, &root.join("书甲.txt"), &db)
            .unwrap()
            .unwrap();
        assert!(!ingested.inserted);
        assert_eq!(ingested.title, "甲");
        // 库外文件不入库
        fs::write(dir.join("外部.txt"), "《外》").unwrap();
        assert!(ingest_file(&root, &dir.join("外部.txt"), &db)
            .unwrap()
            .is_none());
        fs::remove_dir_all(&dir).unwrap();
    }
}
