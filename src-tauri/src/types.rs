//! 跨进程契约（`shared/types.ts` 的 Rust 镜像）。
//! serde camelCase 对齐 TS 侧字段名；两侧字段与语义保持一致，改动必须同步两处。
//! 本文件只放已实现 command 实际用到的类型，避免死代码；后续阶段随命令落地逐步补齐。

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// 外观三态白名单（shared/types.ts ThemeMode）
pub const THEME_MODES: [&str; 3] = ["light", "dark", "system"];
/// 正文字体（key + 菜单中文名）：settings 校验用 key，shell.rs 菜单构建用整表
pub const READER_FONTS: [(&str, &str); 5] = [
    ("pingfang", "苹方 PingFang SC"),
    ("songti", "宋体 Songti SC"),
    ("kaiti", "楷体 Kaiti SC"),
    ("yuanti", "圆体 Yuanti SC"),
    ("hiragino", "冬青黑 Hiragino Sans GB"),
];
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

/// 编译期嵌入，与 TS 侧 import 同一份文件（单一来源的保证）
pub const DEFAULT_SETTINGS_JSON: &str = include_str!("../../shared/defaultSettings.json");

/// 设置默认值：读 shared/defaultSettings.json（单一源，避免两侧漂移）。
/// 解析失败属代码/资源错误，panic 快速暴露。
pub fn default_settings() -> AppSettings {
    static DEFAULTS: OnceLock<AppSettings> = OnceLock::new();
    DEFAULTS
        .get_or_init(|| {
            serde_json::from_str(DEFAULT_SETTINGS_JSON)
                .expect("shared/defaultSettings.json 必须是合法默认设置")
        })
        .clone()
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

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextMenuPredefinedRole {
    Cut,
    Copy,
    Paste,
    SelectAll,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ContextMenuItem {
    Item {
        id: String,
        label: String,
        #[serde(default = "default_true")]
        enabled: bool,
    },
    Predefined {
        role: ContextMenuPredefinedRole,
        label: Option<String>,
    },
    Separator,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuAction {
    pub request_id: String,
    pub item_id: String,
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

/// convert 域结果（shared/types.ts 镜像）：kept = 一字多义保留原字的位置数，keptWords = 保护词命中数
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertResult {
    pub text: String,
    pub kept: i64,
    pub kept_words: i64,
}

/// 行级编辑：替换原文 [start_line, end_line]（1 起、含两端）**含 end_line 的行尾换行符**。
/// text 以 "\n" 结尾（保持段后内容仍在新行）；纯删除（整块行消失）text 为空串；
/// end_line 是文档最后一行时无换行可吃，退化为内容替换（text 不带 \n）。
/// 行号对齐 Monaco 的行号口径（getValue 的 \n 切分行）；前端范围取 (end_line+1, 1)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TidyEdit {
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
}

/// 一键整理结果：只下发变更行的编辑列表（patience 行级 diff），避免全文 JSON 往返；
/// 转换计数供状态栏提示
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TidyResult {
    pub edits: Vec<TidyEdit>,
    pub convert_kept: i64,
    pub convert_kept_words: i64,
}

/// meta 域（shared/types.ts 镜像）：可写回的元数据字段
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetadataField {
    Title,
    Author,
    Tags,
}

/// 元数据写回的最小替换区间：UTF-16 码元偏移，由编辑器一次 executeEdits 应用（方案 §2.8）
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataTextEdit {
    pub start: usize,
    pub end: usize,
    pub replacement: String,
}

/// meta:applyEdit 返回：edit=None 表示正文无需改动；updated=是否同步到书库
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataEditResult {
    pub edit: Option<MetadataTextEdit>,
    pub updated: bool,
    /// 按写回后的正文重新解析的元数据（供元数据栏刷新）
    pub metadata: ParsedMetadata,
}

/// meta:readRating 返回：inLibrary 决定来源（库内 books.rating / 库外文件 Finder 星级）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RatingReadResult {
    pub rating: i64,
    pub in_library: bool,
}

/// meta:applyRating 返回：库内写 books + 文件星级；库外只写文件 Finder 星级。
/// persisted=false 表示星级没写进去（非 macOS / xattr 失败），渲染层需回退。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RatingWriteResult {
    pub rating: i64,
    pub in_library: bool,
    pub persisted: bool,
}
