//! library 域：换库三步、目录/列表查询、评分、扫描入库、对账、章节与书签。
//! enrich 运行在独立线程 + 独立 SQLite 连接（WAL 多连接安全），不占主锁；
//! 单飞去重：同代际的并发调用共享同一个结果槽。
//!
//! 常用模式：`state.with_active_db(...)?.transpose()?` —— 未打开书库时按各命令
//! 原口径返回空值（与 Electron 版「打开任意 txt 不报错」一致）。

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::services::reconcile;
use crate::services::scanner;
use crate::state::books;
use crate::state::bookmarks;
use crate::state::db::open_database;
use crate::state::library as library_switch;
use crate::state::{EnrichJob, EnrichResultSlot};
use crate::state::AppState;
use crate::types::*;

fn require_root(state: &AppState) -> Result<String, String> {
    let root = state.active_root();
    if root.is_empty() {
        return Err("尚未打开书库".to_string());
    }
    Ok(root)
}

/// library:current —— 渲染层启动时读取已打开的活动书库状态。
#[tauri::command]
pub async fn library_current(state: State<'_, AppState>) -> Result<LibraryCurrentState, String> {
    Ok(state.library_current())
}

// ---------- 换库三步（方案 §2.13，顺序固定：建新库 → 停扫描 → 存档旧会话 → activate → 恢复） ----------

/// library:open —— 换库第一步：建新库 + 停扫描 + 读新会话（旧库仍活动）；
/// 同一书库返回 switched=false；目录无效或新库建不起来时抛错，原库不受影响。
#[tauri::command]
pub async fn library_open(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
) -> Result<LibraryOpenResult, String> {
    if root.trim().is_empty() {
        return Err("尚未设置书库根目录".into());
    }
    // 开发环境保险：非测试库先确认（自动化验收 YUE_TEST 直接放行）
    if !crate::commands::dialog::confirm_dev_library(&app, &root).await? {
        return Err("已取消：开发环境不打开测试库以外的书库".into());
    }
    let result = {
        let mut inner = state.inner.lock().unwrap();
        library_switch::prepare(&mut inner, &state.user_data, &root)?
    };
    if result.switched {
        // 建好新库后再停扫描（不能让旧库扫描继续写）
        state.stop_scan();
    }
    Ok(result)
}

/// library:activate —— 换库提交：关闭旧库连接并激活新库（提交点，不会失败）
#[tauri::command]
pub async fn library_activate(state: State<'_, AppState>) -> Result<LibraryActivateResult, String> {
    let root = {
        let mut inner = state.inner.lock().unwrap();
        library_switch::commit(&mut inner)?
    };
    Ok(LibraryActivateResult { root })
}

/// library:abort —— 存档失败/取消：关掉待切换的新库，原库仍可继续使用
#[tauri::command]
pub async fn library_abort(state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().unwrap();
    library_switch::abort(&mut inner);
    Ok(())
}

// ---------- 目录与列表 ----------

/// library:fastScan —— 只读一层目录（书架惰性树按需展开）
#[tauri::command]
pub async fn library_fast_scan(
    state: State<'_, AppState>,
    relative_dir: Option<String>,
) -> Result<Vec<LibraryEntry>, String> {
    let root = require_root(&state)?;
    let rel = relative_dir.unwrap_or_default();
    Ok(state
        .with_active_db(|_, _| scanner::list_directory(std::path::Path::new(&root), &rel))?
        .unwrap_or_default())
}

// ---------- enrich：独立线程扫描 + 对账 ----------

fn run_enrich(
    db_file: &str,
    root: &str,
    cancel: &std::sync::atomic::AtomicBool,
    app: &AppHandle,
) -> Result<LibraryEnrichResult, String> {
    let db = open_database(std::path::Path::new(db_file))?;
    let result = scanner::scan_library(
        std::path::Path::new(root),
        &db,
        cancel,
        |progress: LibraryScanProgress| {
            let _ = app.emit("library:scanProgress", &progress);
        },
    )?;
    // 被换库/退出中止的扫描不做对账：半份结果会把没扫到的书误记成「连续零匹配」
    if cancel.load(Ordering::SeqCst) {
        return Ok(LibraryEnrichResult {
            total: result.total,
            skipped: result.skipped,
            moved: 0,
            pending: 0,
            deleted: 0,
        });
    }
    let log = reconcile::reconcile_library(&db, &result.books)?;

    Ok(LibraryEnrichResult {
        total: result.total,
        skipped: result.skipped,
        moved: log.moved.len() as i64,
        pending: log.pending,
        deleted: log.deleted,
    })
}

/// library:enrich —— 后台补元数据 + 对账，进度经 library:scanProgress 推送。
/// 同一时刻只跑一次（单飞），重复调用等待并复用同一个结果。
#[tauri::command]
pub async fn library_enrich(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LibraryEnrichResult, String> {
    let job = {
        let mut inner = state.inner.lock().unwrap();
        let runtime = inner.active.as_ref().ok_or("尚未打开书库")?;
        let root = runtime.root.clone();
        let db_file = runtime.file.clone();
        if let Some(existing) = inner.enrich_job.clone() {
            existing
        } else {
            inner.enrich_generation += 1;
            let generation = inner.enrich_generation;
            // 重置取消标志供新一轮使用
            inner.scan_cancel.store(false, Ordering::SeqCst);
            let slot = Arc::new(EnrichResultSlot::default());
            let cancel = inner.scan_cancel.clone();
            let (app_for_thread, slot_for_thread) = (app.clone(), slot.clone());
            std::thread::spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_enrich(&db_file, &root, &cancel, &app_for_thread)
                }))
                .unwrap_or_else(|_| Err("扫描线程异常退出".into()));
                slot_for_thread.set(result);
                // 清理单飞槽位（若代际未被新作业替代）
                let state = app_for_thread.state::<AppState>();
                let mut inner = state.inner.lock().unwrap();
                if inner.enrich_generation == generation {
                    inner.enrich_job = None;
                }
            });
            let job = Arc::new(EnrichJob { generation, slot });
            inner.enrich_job = Some(job.clone());
            job
        }
    };
    // 在 spawn_blocking 中等待结果（不占用 async worker）
    tauri::async_runtime::spawn_blocking(move || job.slot.wait_with_timeout(Duration::from_secs(3600)))
        .await
        .map_err(|e| format!("扫描任务失败: {e}"))?
}

// ---------- 列表 / 评分 / 书目 ----------

/// library:history —— 有阅读记录的书，最近阅读在前
#[tauri::command]
pub async fn library_history(state: State<'_, AppState>) -> Result<Vec<LibraryBook>, String> {
    let root = require_root(&state)?;
    Ok(state
        .with_active_db(|db, _| books::list_history(db, &root))?
        .unwrap_or_default())
}

/// library:allBooks —— 快速检索快照：全量书目；未打开书库返回空列表
#[tauri::command]
pub async fn library_all_books(state: State<'_, AppState>) -> Result<Vec<LibraryBook>, String> {
    let root = state.active_root();
    if root.is_empty() {
        return Ok(vec![]);
    }
    Ok(state
        .with_active_db(|db, _| books::list_all_books(db, &root))?
        .unwrap_or_default())
}

/// library:following —— 追更：标签精确匹配「追更」
#[tauri::command]
pub async fn library_following(state: State<'_, AppState>) -> Result<Vec<LibraryBook>, String> {
    let root = require_root(&state)?;
    Ok(state
        .with_active_db(|db, _| books::list_following(db, &root))?
        .unwrap_or_default())
}

/// library:tags —— 名称/数量/标签评分三列
#[tauri::command]
pub async fn library_tags(state: State<'_, AppState>) -> Result<Vec<LibraryTagSummary>, String> {
    Ok(state
        .with_active_db(|db, _| books::list_tags(db))?
        .unwrap_or_default())
}

/// library:booksByTag —— 某个标签下的书（精确匹配）
#[tauri::command]
pub async fn library_books_by_tag(
    state: State<'_, AppState>,
    tag: String,
) -> Result<Vec<LibraryBook>, String> {
    let root = require_root(&state)?;
    Ok(state
        .with_active_db(|db, _| books::list_books_by_tag(db, &root, &tag))?
        .unwrap_or_default())
}

/// library:rated —— 评分页：rating=null 取全部有评分的书（最多 100 本）
#[tauri::command]
pub async fn library_rated(
    state: State<'_, AppState>,
    rating: Option<i64>,
) -> Result<Vec<LibraryBook>, String> {
    let root = require_root(&state)?;
    Ok(state
        .with_active_db(|db, _| books::list_rated(db, &root, rating))?
        .unwrap_or_default())
}

/// library:setTagRating —— 标签评分：只写库，不写正文（0 分也落一行）
#[tauri::command]
pub async fn library_set_tag_rating(
    state: State<'_, AppState>,
    tag: String,
    rating: i64,
) -> Result<i64, String> {
    state
        .with_active_db(|db, _| books::set_tag_rating(db, &tag, rating))?
        .ok_or_else(|| "尚未打开书库".to_string())
}

/// library:markRead —— 打开/激活标签写 last_read_at（返回写入时间戳，0 = 不在书库）
#[tauri::command]
pub async fn library_mark_read(state: State<'_, AppState>, path: String) -> Result<i64, String> {
    if path.is_empty() {
        return Ok(0);
    }
    let root = require_root(&state)?;
    Ok(state
        .with_active_db(|db, _| books::mark_read(db, &root, &path))?
        .unwrap_or(0))
}

/// library:bookByPath —— 元数据栏读取当前书的库记录；不在活动书库内返回 null
#[tauri::command]
pub async fn library_book_by_path(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<LibraryBook>, String> {
    let root = state.active_root();
    if root.is_empty() || path.is_empty() {
        return Ok(None);
    }
    let Some(relative) = books::relative_in_library(&root, &path) else {
        return Ok(None);
    };
    Ok(state
        .with_active_db(|db, _| books::find_book_by_relative_path(db, &root, &relative))?
        .unwrap_or(None))
}

/// library:setBookRating —— 书籍评分：库内评分一起写；
/// Finder 星级 xattr 由 P3 finder 服务补齐（此处仅写库）
#[tauri::command]
pub async fn library_set_book_rating(
    state: State<'_, AppState>,
    id: i64,
    rating: i64,
) -> Result<i64, String> {
    let (value, relative) = state
        .with_active_db(|db, _| books::set_book_rating(db, id, rating))?
        .ok_or_else(|| "尚未打开书库".to_string())?;
    // 路径由库内 relative_path 拼出；xattr 失败静默，不影响库内评分（对齐原版）
    if let Some(relative) = relative {
        let root = state.active_root();
        let absolute = format!("{root}/{relative}");
        crate::services::finder::write_rating(&absolute, value);
    }
    Ok(value)
}

/// library:syncMetadata —— 保存后按当前正文重解析书名/作者/标签，只更新这一本；
/// 另存为到书库根内的新文件因此无需全库扫描即可出现在书架与左栏。
#[tauri::command]
pub async fn library_sync_metadata(
    state: State<'_, AppState>,
    path: String,
) -> Result<LibrarySyncResult, String> {
    let skipped = LibrarySyncResult {
        updated: false,
        added: false,
        book: None,
    };
    if path.is_empty() {
        return Ok(skipped);
    }
    let root = require_root(&state)?;
    let ingested = state
        .with_active_db(|db, _| {
            scanner::ingest_file(std::path::Path::new(&root), std::path::Path::new(&path), db)
        })?
        .unwrap_or(None);
    let Some(ingested) = ingested else {
        return Ok(skipped);
    };
    let book = state
        .with_active_db(|db, _| {
            books::find_book_by_relative_path(db, &root, &ingested.relative_path)
        })?
        .unwrap_or(None);
    Ok(LibrarySyncResult {
        updated: true,
        added: ingested.inserted,
        book,
    })
}

// ---------- 章节与书签 ----------

/// library:chapters —— 当前书章节（读文件并按同口径正则提取）；
/// 章节属于当前打开的书，不要求文件在书库内
#[tauri::command]
pub async fn library_chapters(path: String) -> Result<Vec<ChapterInfo>, String> {
    if path.is_empty() {
        return Ok(vec![]);
    }
    let outcome = crate::services::files::read_text(std::path::Path::new(&path))?;
    Ok(crate::services::text::parse_chapters(&outcome.text))
}

/// library:bookmarks —— 当前书书签；文件不在活动书库内时返回空列表
#[tauri::command]
pub async fn library_bookmarks(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<BookmarkInfo>, String> {
    let root = state.active_root();
    if root.is_empty() || path.is_empty() {
        return Ok(vec![]);
    }
    let Some(relative) = books::relative_in_library(&root, &path) else {
        return Ok(vec![]);
    };
    Ok(state
        .with_active_db(|db, _| bookmarks::list_bookmarks(db, &relative))?
        .unwrap_or_default())
}

/// library:addBookmark —— 添加书签：仅对活动书库内的书开放，行号 1-based，摘要截 40 字
#[tauri::command]
pub async fn library_add_bookmark(
    state: State<'_, AppState>,
    path: String,
    line: i64,
    note: String,
) -> Result<Vec<BookmarkInfo>, String> {
    let root = require_root(&state)?;
    let relative = books::relative_in_library(&root, &path)
        .ok_or("这本书不在当前书库中，无法添加书签")?;
    if line < 1 {
        return Err("书签行号不合法".into());
    }
    let filename = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let note: String = note.chars().take(40).collect();
    state
        .with_active_db(|db, _| bookmarks::add_bookmark(db, &relative, &filename, line, &note))?
        .ok_or_else(|| "尚未打开书库".to_string())
}

/// library:removeBookmark —— 删除书签（同行唯一）
#[tauri::command]
pub async fn library_remove_bookmark(
    state: State<'_, AppState>,
    path: String,
    line: i64,
) -> Result<Vec<BookmarkInfo>, String> {
    let root = require_root(&state)?;
    let Some(relative) = books::relative_in_library(&root, &path) else {
        return Ok(vec![]);
    };
    Ok(state
        .with_active_db(|db, _| bookmarks::remove_bookmark(db, &relative, line))?
        .unwrap_or_default())
}

/// library:allBookmarks —— 全库书签按书分组；未打开书库返回空列表
#[tauri::command]
pub async fn library_all_bookmarks(
    state: State<'_, AppState>,
) -> Result<Vec<LibraryBookmarkGroup>, String> {
    let root = state.active_root();
    if root.is_empty() {
        return Ok(vec![]);
    }
    let groups = state
        .with_active_db(|db, _| bookmarks::list_library_bookmarks(db))?
        .unwrap_or_default();
    Ok(groups
        .into_iter()
        .map(|group| LibraryBookmarkGroup {
            path: format!("{root}/{}", group.relative_path),
            title: group.title,
            bookmarks: group.bookmarks,
        })
        .collect())
}

/// library:replaceBookmarks —— 编辑行号漂移后整体回写某本书的书签
#[tauri::command]
pub async fn library_replace_bookmarks(
    state: State<'_, AppState>,
    path: String,
    bookmarks_input: Vec<BookmarkInfo>,
) -> Result<Vec<BookmarkInfo>, String> {
    let root = require_root(&state)?;
    let relative =
        books::relative_in_library(&root, &path).ok_or("这本书不在当前书库中，无法更新书签")?;
    let filename = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    state
        .with_active_db(|db, _| {
            bookmarks::replace_bookmarks(db, &relative, &filename, &bookmarks_input)
        })?
        .ok_or_else(|| "尚未打开书库".to_string())
}
