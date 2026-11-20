//! 跨进程契约（`shared/types.ts` 的 Rust 镜像）。
//! serde camelCase 对齐 TS 侧字段名；两侧字段与语义保持一致，改动必须同步两处。
//! 本文件只放已实现 command 实际用到的类型，避免死代码；后续阶段随命令落地逐步补齐。

use serde::{Deserialize, Serialize};

/// 外观三态白名单（shared/types.ts ThemeMode）
pub const THEME_MODES: [&str; 3] = ["light", "dark", "system"];
/// 正文字体白名单（shared/types.ts READER_FONTS 的 key）
pub const READER_FONTS: [&str; 5] = ["pingfang", "songti", "kaiti", "yuanti", "hiragino"];
/// 字号档位（shared/types.ts READER_FONT_SIZES）
pub const READER_FONT_SIZES: [i64; 9] = [13, 14, 15, 16, 17, 18, 20, 22, 24];

/// 侧栏宽度约束（AGENTS.md 界面约定：拖拽夹 160–640）
pub const SIDEBAR_MIN_WIDTH: i64 = 160;
pub const SIDEBAR_MAX_WIDTH: i64 = 640;
/// 预载数量约束（0–20，接 LRU 驻留集合）
pub const PRELOAD_MIN_COUNT: i64 = 0;
pub const PRELOAD_MAX_COUNT: i64 = 20;

/// 设置文件（app_data_dir/settings.json，方案 §1.9）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// 外观三态
    pub appearance: String,
    /// 左栏宽度（px）
    pub sidebar_width: i64,
    /// 书库根目录；'' = 尚未接入
    pub library_root: String,
    /// 除当前标签外的预载数量
    pub preload_count: i64,
    /// 标签关闭按钮是否常驻
    pub close_button_always_visible: bool,
    /// 正文字体 key
    pub reader_font: String,
    /// 正文字号
    pub reader_font_size: i64,
}

/// 设置默认值（与 shared/types.ts DEFAULT_SETTINGS 同一份，避免两侧漂移）。
/// String 字段不能进 const，用函数构造。
pub fn default_settings() -> AppSettings {
    AppSettings {
        appearance: "system".into(),
        sidebar_width: 240,
        library_root: String::new(),
        preload_count: 10,
        close_button_always_visible: true,
        reader_font: "pingfang".into(),
        reader_font_size: 15,
    }
}

/// library:current 返回：启动时按设置打开的活动书库
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCurrentState {
    pub root: String,
    /// 启动时打开失败的原因（空 = 正常）
    pub error: String,
    /// 活动库是否回落到 app_data_dir
    pub fallback: bool,
}

/// app:syncMenuState 入参：渲染层侧栏显隐回写菜单勾选
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMenuState {
    pub sidebar_visible: bool,
    pub right_panel_visible: bool,
}

/// 文件身份（同文件去重依据：dev+ino 优先，realPath 兜底；shared/types.ts FileStat）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub dev: i64,
    pub ino: i64,
    pub size: i64,
    pub mtime_ms: i64,
    pub real_path: String,
}

/// file:readText 二进制帧的头部（不直接暴露给渲染层）：
/// [u32 header_len][header JSON][UTF-16LE 正文]，前端 bridge 负责拆帧。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReadMeta {
    pub encoding: String,
    pub stat: FileStat,
}

/// file:writeText 返回（shared/types.ts 同形状）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub stat: FileStat,
}

// ---------- P2：书库 / 会话 / 文件域契约（shared/types.ts 镜像） ----------

/// 书库书籍记录（path 已拼成绝对路径便于直接打开）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBook {
    pub id: i64,
    /// 相对书库根、POSIX 分隔
    pub relative_path: String,
    /// 绝对路径 = 书库根 + relativePath
    pub path: String,
    pub filename: String,
    pub title: String,
    pub author: String,
    pub tags: Vec<String>,
    pub rating: i64,
    pub word_count: i64,
    pub progress_line: i64,
    /// 最近阅读时间（ms；0 = 未读）
    pub last_read_at: i64,
}

/// 标签页一行：名称 / 书目数量 / 标签评分
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTagSummary {
    pub name: String,
    pub count: i64,
    pub rating: i64,
}

/// 书架目录树的一层条目（library:fastScan：只读文件名，目录在前、TXT 在后）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub name: String,
    /// 相对书库根、POSIX 分隔、不含根目录名
    pub relative_path: String,
    pub is_dir: bool,
}

/// library:enrich 进度（每 10 个文件一次）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScanProgress {
    pub scanned: i64,
    pub path: String,
}

/// 一次扫描命中的书目（对账输入，不经 IPC 暴露给渲染层）
#[derive(Debug, Clone)]
pub struct ScannedBook {
    pub relative_path: String,
    pub filename: String,
    pub title: String,
    pub word_count: i64,
    pub size_bytes: i64,
    /// true = 本次扫描新插入的行（移动识别的候选）
    pub inserted: bool,
}

/// 扫描汇总（仅内部流转 + 扫描线程回传，不直接暴露给渲染层）
#[derive(Debug, Clone)]
pub struct LibraryScanResult {
    pub total: i64,
    pub skipped: i64,
    pub books: Vec<ScannedBook>,
}

/// library:enrich 结果：扫描 + 对账摘要
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEnrichResult {
    pub total: i64,
    pub skipped: i64,
    pub moved: i64,
    pub pending: i64,
    pub deleted: i64,
}

/// library:activate 返回
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryActivateResult {
    pub root: String,
}

/// library:open 返回：switched=true 时新库已建好并读出会话，旧库保持活动直到 activate
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryOpenResult {
    pub root: String,
    pub switched: bool,
    pub session: Option<SessionRestore>,
    pub fallback: bool,
}

/// 保存后单文件入库结果（库外跳过时三项均为 false/null）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySyncResult {
    pub updated: bool,
    pub added: bool,
    pub book: Option<LibraryBook>,
}

/// 元数据解析结果（主进程解析、渲染层展示共用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedMetadata {
    pub title: String,
    pub author: String,
    pub tags: Vec<String>,
    pub word_count: i64,
}

/// 章节条目（标题行与行号，点击按行号跳转）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterInfo {
    pub title: String,
    /// 1-based 行号
    pub line: i64,
}

/// 书签条目（按行号排序，note 为添加时截取的正文摘要）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkInfo {
    /// 1-based 行号
    pub line: i64,
    pub note: String,
}

/// 全库书签分组（path 已拼绝对路径）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBookmarkGroup {
    pub path: String,
    pub title: String,
    pub bookmarks: Vec<BookmarkInfo>,
}

/// 会话快照中的标签（session:persist；draft/view_state 不在这里，persist 不覆盖两列）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTabInput {
    pub id: String,
    pub path: String,
    pub title: String,
    /// 视口顶部行（恢复时滚到该行并顶部对齐）
    pub progress_line: i64,
    /// 光标行（1-based，0 = 旧库无此字段）
    pub cursor_line: i64,
    /// 光标列（1-based）
    pub cursor_column: i64,
    pub dirty: bool,
    pub last_focused_at: i64,
}

/// session:persist 入参：标签顺序即数组顺序
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub active_tab_id: Option<String>,
    pub tabs: Vec<SessionTabInput>,
}

/// session:restore 返回的标签行（按 position 升序）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTabRecord {
    pub id: String,
    pub position: i64,
    pub path: String,
    pub title: String,
    pub progress_line: i64,
    pub cursor_line: i64,
    pub cursor_column: i64,
    pub dirty: bool,
    pub last_focused_at: i64,
    /// 是否有 draft/view_state（脏标签恢复时据此读草稿）
    pub has_draft: bool,
    /// 库内标签的书目 id；库外/空白标签为 null
    pub book_id: Option<i64>,
    /// 恢复时文件不存在：标签保留并标记缺失，对账扫完按 bookId 重试一次
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRestore {
    pub active_tab_id: Option<String>,
    pub tabs: Vec<SessionTabRecord>,
}

/// session:relocate 返回的一条重连结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRelocation {
    pub tab_id: String,
    pub path: String,
}

/// file:writeDraft 附带的最小标签元信息（persist 未落盘就被卸载时补齐草稿行）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftTabMeta {
    pub path: String,
    pub title: String,
    pub progress_line: i64,
    pub last_focused_at: i64,
}

/// file:readDraft 返回：text=null 表示卸载时非 dirty（重载走 file:readText）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftEntry {
    pub text: Option<String>,
    pub view_state: serde_json::Value,
}

/// file:rename 返回：新路径、标签标题（文件名）与改名后的文件身份
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRenameResult {
    pub path: String,
    pub title: String,
    pub stat: FileStat,
}

/// file:trash 返回：库内记录是否真的删掉了
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTrashResult {
    pub removed_book: bool,
}
