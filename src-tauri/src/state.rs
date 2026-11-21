//! AppState：全局可变状态的单一持有者（对齐原 electron/services 职责分层）。
//! rusqlite::Connection 非 Sync，整体包在 Mutex 内；command 层拿锁后同步执行。
//! 子模块：settings（设置读写）/ db（迁移与打开）/ library（换库三步）/
//! books（书目仓储）/ bookmarks（书签）/ session（会话与草稿）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::types::*;

pub mod books;
pub mod bookmarks;
pub mod db;
pub mod library;
pub mod session;
pub mod settings;

use library::{open_at, resolve_library_root};
use settings::{read_settings, write_settings};

/// 单个书库运行时：一份 db 文件对应一个连接。
pub struct LibraryRuntime {
    /// 书库根（realpath 后的绝对路径；'' = 未打开书库，会话库挂在 app_data_dir）
    pub root: String,
    /// 实际库文件路径（诊断用；enrich 扫描线程据此另开独立连接，不占主锁）
    pub file: String,
    pub db: Connection,
    /// true = 书库根不可写，数据库回落到 app_data_dir/library-db
    pub fallback: bool,
}

/// enrich 扫描作业：单飞去重用（同代际的并发调用共享同一个结果槽）
pub struct EnrichJob {
    pub slot: Arc<EnrichResultSlot>,
}

/// enrich 结果槽：线程写、多个并发 command 读（Condvar 广播唤醒）
#[derive(Default)]
pub struct EnrichResultSlot {
    result: Mutex<Option<Result<LibraryEnrichResult, String>>>,
    cond: Condvar,
}

impl EnrichResultSlot {
    pub fn set(&self, result: Result<LibraryEnrichResult, String>) {
        let mut guard = self.result.lock().unwrap();
        *guard = Some(result);
        self.cond.notify_all();
    }

    /// 等待结果（Result 为 Clone，多个等待者拿到同一份）
    pub fn wait_with_timeout(
        &self,
        timeout: Duration,
    ) -> Result<LibraryEnrichResult, String> {
        let mut guard = self.result.lock().unwrap();
        let deadline = Instant::now() + timeout;
        while guard.is_none() {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err("扫描超时".into());
            };
            let (new_guard, _timed_out) = self.cond.wait_timeout(guard, remaining).unwrap();
            guard = new_guard;
        }
        guard.clone().unwrap()
    }
}

/// 退出握手槽（方案 §1.8）：发 session:flush → 渲染层 persist → session_flush_done 回执 → 放行。
/// 独立 managed state（AppState 含 rusqlite Connection 非 Sync，不能跨线程访问；
/// 握手等待在后台线程进行，FlushGate 自身 Send+Sync）。超时 3 秒（FLUSH_TIMEOUT_MS），
/// handled 标记防关窗/退出双路径二次握手。
#[derive(Default)]
pub struct FlushGate {
    done: Mutex<bool>,
    cond: Condvar,
    handled: Mutex<bool>,
}

impl FlushGate {
    pub fn reset(&self) {
        *self.done.lock().unwrap() = false;
    }

    /// 渲染层回执（session_flush_done 命令调用）
    pub fn signal(&self) {
        *self.done.lock().unwrap() = true;
        self.cond.notify_all();
    }

    /// 等待渲染层落盘回执；超时返回 false（调用方强制放行）
    pub fn wait(&self, timeout: Duration) -> bool {
        let mut guard = self.done.lock().unwrap();
        let deadline = Instant::now() + timeout;
        while !*guard {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            let (new_guard, _) = self.cond.wait_timeout(guard, remaining).unwrap();
            guard = new_guard;
        }
        true
    }

    pub fn mark_handled(&self) {
        *self.handled.lock().unwrap() = true;
    }

    pub fn handled(&self) -> bool {
        *self.handled.lock().unwrap()
    }
}

pub struct AppState {
    pub(super) inner: Mutex<StateInner>,
    pub user_data: PathBuf,
}

pub(super) struct StateInner {
    pub settings: AppSettings,
    /// 活动库（启动时按设置打开；root='' 表示尚未打开书库，仅挂 app_data_dir 会话库）
    pub active: Option<LibraryRuntime>,
    /// 待切换的新库（library:open 准备，activate 提交，abort 丢弃）
    pub pending: Option<LibraryRuntime>,
    pub startup_error: String,
    /// enrich 扫描取消标志（换库/退出时置位，扫描线程逐文件检查）
    pub scan_cancel: Arc<AtomicBool>,
    /// enrich 代际：置位取消即 +1，旧线程发现自己代际过期就不再对账
    pub enrich_generation: u64,
    /// 在跑的 enrich 作业（单飞：并发 enrich 复用同一接收端）
    pub enrich_job: Option<Arc<EnrichJob>>,
}

impl AppState {
    pub fn new(user_data: PathBuf) -> Result<Self, String> {
        let settings = read_settings(&user_data);
        let mut startup_error = String::new();
        // 启动即按设置的书库根打开对应库；失败回落 app_data_dir 会话库，不阻断启动。
        let active = if settings.library_root.is_empty() {
            Some(default_runtime(&user_data)?)
        } else {
            match resolve_library_root(&settings.library_root)
                .and_then(|root| open_at(&root, &user_data))
            {
                Ok(runtime) => Some(runtime),
                Err(e) => {
                    startup_error = e;
                    Some(default_runtime(&user_data)?)
                }
            }
        };
        Ok(AppState {
            inner: Mutex::new(StateInner {
                settings,
                active,
                pending: None,
                startup_error,
                scan_cancel: Arc::new(AtomicBool::new(false)),
                enrich_generation: 0,
                enrich_job: None,
            }),
            user_data,
        })
    }

    pub fn settings_get(&self) -> Result<AppSettings, String> {
        Ok(self.inner.lock().unwrap().settings.clone())
    }

    pub fn settings_set(&self, settings: AppSettings) -> Result<AppSettings, String> {
        let normalized = write_settings(&self.user_data, &settings)?;
        self.inner.lock().unwrap().settings = normalized.clone();
        Ok(normalized)
    }

    /// library:current —— 渲染层启动时读取已打开的活动书库状态。
    pub fn library_current(&self) -> LibraryCurrentState {
        let guard = self.inner.lock().unwrap();
        match &guard.active {
            Some(runtime) if !runtime.root.is_empty() => LibraryCurrentState {
                root: runtime.root.clone(),
                error: guard.startup_error.clone(),
                fallback: runtime.fallback,
            },
            _ => LibraryCurrentState {
                root: String::new(),
                error: guard.startup_error.clone(),
                fallback: false,
            },
        }
    }

    /// 停扫描：置位取消 + 代际 +1（旧线程发现代际过期就放弃对账，最多写完当前一本）。
    pub fn stop_scan(&self) {
        let mut guard = self.inner.lock().unwrap();
        guard.enrich_generation += 1;
        guard
            .scan_cancel
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// 取当前活动库的根（'' = 未打开书库）。
    pub fn active_root(&self) -> String {
        self.inner
            .lock()
            .unwrap()
            .active
            .as_ref()
            .map(|r| r.root.clone())
            .unwrap_or_default()
    }

    /// 在活动库连接上执行一次只读/短写操作；未打开书库时回调不执行返回 None。
    pub fn with_active_db<T>(
        &self,
        f: impl FnOnce(&Connection, &str) -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        let guard = self.inner.lock().unwrap();
        match &guard.active {
            Some(runtime) => f(&runtime.db, &runtime.root).map(Some),
            None => Ok(None),
        }
    }

    /// 按绝对路径查库内书目：realpath 换算相对路径 + 单次拿锁查询。
    /// 未打开书库或路径不在库内返回 None；打开着书库但查询失败才报错。
    pub fn find_book_by_abs_path(&self, path: &str) -> Result<Option<LibraryBook>, String> {
        let root = self.active_root();
        if root.is_empty() || path.is_empty() {
            return Ok(None);
        }
        let Some(relative) = books::relative_in_library(&root, path) else {
            return Ok(None);
        };
        self.with_active_db(|db, root| books::find_book_by_relative_path(db, root, &relative))?
            .ok_or_else(|| "尚未打开书库".to_string())
    }

    /// 退出前收尾：置位扫描取消 + 显式关闭全部库连接。
    /// SQLite 在最后一个连接关闭时自动 checkpoint 并删除 -wal/-shm；
    /// app.exit(0) 是进程级退出跑不到 Drop，必须在这里显式 close。
    /// take() 消费连接保证幂等（exit_now 与 RunEvent::Exit 双路径调用）；
    /// close 失败（如 enrich 扫描线程的独立连接还开着）只影响残留文件，不影响数据一致性。
    pub fn shutdown(&self) {
        let mut guard = self.inner.lock().unwrap();
        guard
            .scan_cancel
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(runtime) = guard.active.take() {
            if let Err((_, e)) = runtime.db.close() {
                eprintln!("[shutdown] 活动库关闭失败: {e}");
            }
        }
        if let Some(runtime) = guard.pending.take() {
            if let Err((_, e)) = runtime.db.close() {
                eprintln!("[shutdown] 待切换库关闭失败: {e}");
            }
        }
    }
}

/// 未设置书库根（或根无效）时的 app_data_dir 会话库。
fn default_runtime(user_data: &Path) -> Result<LibraryRuntime, String> {
    let file = user_data.join("yueduo.db");
    let db = db::open_database(&file)?;
    Ok(LibraryRuntime {
        root: String::new(),
        file: file.to_string_lossy().to_string(),
        db,
        fallback: false,
    })
}

// ---------- Electron userData 一次性搬家 ----------

/// Electron 版 userData 在 `~/Library/Application Support/YueDuo`，Tauri 按 identifier 落在
/// `app_data_dir`（com.yueduo.reader）。首启动把 settings.json 与 library-db 回落库搬过来
/// （存在才搬、目标缺才搬），旧目录原样保留不删；写标记文件防止二次执行。
pub fn migrate_electron_user_data(target: &Path) -> Result<(), String> {
    let legacy = std::env::var("HOME")
        .ok()
        .map(|home| PathBuf::from(home).join("Library/Application Support/YueDuo"))
        .filter(|dir| dir.is_dir());
    let Some(legacy) = legacy else {
        return Ok(());
    };
    let marker = target.join(".migrated-from-electron");
    if marker.exists() || settings::settings_path(target).exists() {
        return Ok(()); // 已迁移过，或本目录已有自己的设置
    }
    let settings_src = legacy.join("settings.json");
    if settings_src.is_file() {
        fs::create_dir_all(target).map_err(|e| format!("创建数据目录失败: {e}"))?;
        fs::copy(&settings_src, settings::settings_path(target))
            .map_err(|e| format!("迁移设置失败: {e}"))?;
    }
    let legacy_db_dir = legacy.join("library-db");
    let target_db_dir = target.join("library-db");
    if legacy_db_dir.is_dir() && !target_db_dir.exists() {
        fs::create_dir_all(&target_db_dir).map_err(|e| format!("创建回落库目录失败: {e}"))?;
        for entry in fs::read_dir(&legacy_db_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                let name = entry.file_name();
                let _ = fs::copy(entry.path(), target_db_dir.join(name));
            }
        }
    }
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    fs::write(&marker, b"electron\n").map_err(|e| format!("写入迁移标记失败: {e}"))?;
    Ok(())
}
