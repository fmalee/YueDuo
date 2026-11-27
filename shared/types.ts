/** 设置默认值单一源（TS import + Rust include_str 共用，避免两侧漂移） */
import defaultSettingsJson from './defaultSettings.json'

/** 文件身份（同文件去重依据：dev+ino 优先，realPath 兜底，方案 §1.6） */
export interface FileStat {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  realPath: string
}

/** file:readText 返回 */
export interface FileReadResult {
  text: string
  encoding: string
  stat: FileStat
}

/** file:rename 返回：新路径、标签标题（文件名）与改名后的文件身份 */
export interface FileRenameResult {
  path: string
  title: string
  stat: FileStat
}

/** file:trash 返回：库内记录是否真的删掉了（书架「共 N 本」据此减一） */
export interface FileTrashResult {
  removedBook: boolean
}

/** 顶部应用菜单下发给渲染层的命令（保存/关闭类复用同一套标签动作） */
export type AppMenuCommand =
  | 'open'
  | 'newTab'
  | 'quickSearch'
  | 'chooseLibrary'
  | 'save'
  | 'closeTab'
  | 'closeOthers'
  | 'closeAll'
  | 'appearance'
  | 'toggleCloseButton'
  | 'preloadCount'
  | 'find'
  | 'replace'
  | 'undo'
  | 'redo'
  | 'tidy'
  | 'toTraditional'
  | 'toSimplified'
  | 'toHalfwidth'
  | 'toggleLock'
  | 'toggleSidebar'
  | 'toggleRightPanel'
  | 'nextTab'
  | 'prevTab'
  | 'readerFont'
  | 'readerFontSize'

/** 菜单命令附带值：appearance=外观模式，preloadCount=预载数量，toggleCloseButton=新勾选状态 */
export interface AppMenuPayload {
  command: AppMenuCommand
  value?: ThemeMode | ReaderFont | number | boolean
}

/** app:syncMenuState —— 渲染层侧栏显隐状态回写菜单勾选（键盘切换与菜单保持一致） */
export interface AppMenuState {
  sidebarVisible: boolean
  rightPanelVisible: boolean
}

export type ContextMenuPredefinedRole = 'cut' | 'copy' | 'paste' | 'selectAll'

export type ContextMenuItem =
  | { kind: 'item'; id: string; label: string; enabled?: boolean }
  | { kind: 'predefined'; role: ContextMenuPredefinedRole; label?: string }
  | { kind: 'separator' }

export interface ContextMenuAction {
  requestId: string
  itemId: string
}

/** dialog:confirmClose 返回 */
export type ConfirmChoice = 'save' | 'discard' | 'cancel'

/**
 * LRU 卸载草稿（file:writeDraft / file:readDraft，方案 §1.7）
 * 阶段 1.7 为主进程内存级实现，1.8 会话持久化时迁 SQLite session_tabs.draft/view_state（IPC 不变）
 */
export interface DraftEntry {
  /** 卸载时的未保存全文；null = 卸载时非 dirty（重载走 file:readText） */
  text: string | null
  /** 卸载时的编辑器视图状态（滚动/选区），重载恢复阅读进度 */
  viewState: unknown
}

/**
 * file:writeDraft 附带的最小标签元信息（方案 §1.8）
 * persist 尚未落盘就被卸载时，用它补齐草稿行，避免重启后标签整个消失
 */
export interface DraftTabMeta {
  path: string
  title: string
  progressLine: number
  lastFocusedAt: number
}

/**
 * 会话快照中的标签（session:persist，方案 §1.8）
 * draft/view_state 不在这里：仍由 file:writeDraft 写入同一行，persist 不覆盖两列
 */
export interface SessionTabInput {
  id: string
  path: string
  title: string
  /** 视口顶部行（不是光标行；恢复时滚到该行并顶部对齐） */
  progressLine: number
  /** 光标行（1-based，0 = 旧库无此字段，恢复时退回草稿 view_state） */
  cursorLine: number
  /** 光标列（1-based） */
  cursorColumn: number
  dirty: boolean
  lastFocusedAt: number
}

/** session:persist 入参：标签顺序即数组顺序 */
export interface SessionSnapshot {
  activeTabId: string | null
  tabs: SessionTabInput[]
}

/** session:restore 返回的标签行（按 position 升序） */
export interface SessionTabRecord extends SessionTabInput {
  position: number
  /** 是否有 draft/view_state（脏标签恢复时据此读草稿） */
  hasDraft: boolean
  /** 库内标签的书目 id（books.id）；库外/空白标签为 null */
  bookId: number | null
  /** 恢复时文件不存在：标签保留并标记缺失，对账扫完按 bookId 重试一次 */
  missing: boolean
}

/** session:relocate 返回的一条重连结果：书库对账后按 bookId/相对路径重新接上文件 */
export interface SessionRelocation {
  tabId: string
  path: string
}

/** session:restore 返回 */
export interface SessionRestore {
  activeTabId: string | null
  tabs: SessionTabRecord[]
}

/** 标签元信息（全文内容只存在于 CM6 EditorState.doc，绝不进这里） */
export interface TabMeta {
  id: string
  path: string
  title: string
  /** 打开/保存时的源编码（状态栏展示，方案 §1.10） */
  encoding: string
  dirty: boolean
  lastFocusedAt: number
  /** 恢复时文件缺失，等待书库对账后按 book_id 重连 */
  missing?: boolean
}

/** 书架目录树的一层条目（library:fastScan，方案 §2.2：只读文件名，目录在前、TXT 在后） */
export interface LibraryEntry {
  name: string
  /** 相对书库根、POSIX 分隔、不含根目录名（方案 §四 约定） */
  relativePath: string
  isDir: boolean
}

/** library:enrich 进度（每 10 个文件一次，对齐 Python _ScanThread） */
export interface LibraryScanProgress {
  /** 已检查的第几个文件（含不可读/重复跳过项） */
  scanned: number
  path: string
}

/**
 * library:open 返回（方案 §2.13）：打开/准备切换书库。
 * switched=false 表示该根已是活动书库（启动时按设置打开，无需再切）；
 * switched=true 时主进程已建好新库并读出其会话，旧库仍保持活动直到 library:activate。
 */
export interface LibraryOpenResult {
  root: string
  switched: boolean
  /** 新库会话（switched=false 时为 null）；草稿正文仍在库里，激活后按 tabId 懒读 */
  session: SessionRestore | null
  /** true = 书库根不可写，数据库落在 userData（按库根隔离） */
  fallback: boolean
}

/** library:current 返回：主进程启动时按设置打开的活动书库 */
export interface LibraryCurrentState {
  root: string
  /** 启动时打开失败的原因（空 = 正常） */
  error: string
  /** 活动库是否回落到 userData */
  fallback: boolean
}

/** 书库书籍记录（方案 §2.5：历史/追更/标签/评分共用；path 已拼成绝对路径便于直接打开） */
export interface LibraryBook {
  id: number
  /** 相对书库根、POSIX 分隔（方案 §四） */
  relativePath: string
  /** 绝对路径 = 书库根 + relativePath */
  path: string
  filename: string
  title: string
  author: string
  tags: string[]
  rating: number
  wordCount: number
  progressLine: number
  /** 最近阅读时间（ms；0 = 未读，2.11 起写入） */
  lastReadAt: number
}

/** 章节条目（方案 §2.6：标题行与行号，点击按行号跳转） */
export interface ChapterInfo {
  /** 标题原文（已去行首缩进与行尾空白） */
  title: string
  /** 1-based 行号 */
  line: number
}

/** 书签条目（方案 §2.6：按行号排序，note 为添加时截取的正文摘要） */
export interface BookmarkInfo {
  /** 1-based 行号 */
  line: number
  note: string
}

/** 全库书签分组（方案 §2.7：按书合并，path 已拼绝对路径便于直接打开） */
export interface LibraryBookmarkGroup {
  path: string
  title: string
  bookmarks: BookmarkInfo[]
}

/** 标签页一行的三列：名称 / 书目数量 / 标签评分（方案 §2.5） */
export interface LibraryTagSummary {
  name: string
  count: number
  rating: number
}

/** library:enrich 结果：扫描 + 对账摘要（UI 状态行/日志用） */
export interface LibraryEnrichResult {
  total: number
  skipped: number
  /** 对账识别出的移动数 */
  moved: number
  /** 本轮零匹配挂起数 */
  pending: number
  /** 达到阈值删除的记录数 */
  deleted: number
}

/** library:syncMetadata 返回：保存后单文件入库结果（库外跳过时三项均为 false/null） */
export interface LibrarySyncResult {
  /** 库内文件已按扫描口径写入（更新或新插入） */
  updated: boolean
  /** 本次新收录（books 插入了一行） */
  added: boolean
  /** 写入后的完整书目；库外或文件不可读为 null */
  book: LibraryBook | null
}

/** 元数据解析结果（方案 §2.4；主进程解析、渲染层展示共用） */
export interface ParsedMetadata {
  title: string
  author: string
  tags: string[]
  wordCount: number
}

/** 元数据字段（方案 §2.8：名称/作者/标签） */
export type MetadataField = 'title' | 'author' | 'tags'

/** 元数据写回的最小替换区间：UTF-16 字符偏移，由编辑器一次 executeEdits 应用（方案 §2.8） */
export interface MetadataTextEdit {
  start: number
  end: number
  replacement: string
}

/** meta:applyEdit 返回：edit=null 表示正文无需改动；updated=是否同步到书库 */
export interface MetadataEditResult {
  edit: MetadataTextEdit | null
  updated: boolean
  /** 按写回后的正文重新解析的元数据（供 2.9 元数据栏刷新） */
  metadata: ParsedMetadata
}

/** meta:readRating 返回：inLibrary 决定来源（库内 books.rating / 库外文件 Finder 星级） */
export interface RatingReadResult {
  rating: number
  inLibrary: boolean
}

/**
 * meta:applyRating 返回：库内写 books + 文件星级；库外只写文件 Finder 星级。
 * persisted=false 表示星级没写进去（非 macOS / xattr 失败），渲染层需回退。
 */
export interface RatingWriteResult extends RatingReadResult {
  persisted: boolean
}

/** 文本转换结果（方案 §3.2：全角转半角/简转繁/繁转简共用） */
export interface ConvertResult {
  text: string
  /** 因一字多义而保留原字的位置数（宽度转换恒为 0） */
  kept: number
  /** 命中保护词而整词保留的次数 */
  keptWords: number
}

/** 行级编辑（方案 §3.2）：替换原文 [startLine, endLine]（1 起、含两端）及 endLine 行尾换行；非末行 text 自带尾 `\n`，纯删除为空串，末行无尾 `\n` */
export interface TidyEdit {
  startLine: number
  endLine: number
  text: string
}

/** 一键整理结果（方案 §3.2）：patience 行级 diff 只下发变更行，转换计数供状态栏说明 */
export interface TidyResult {
  edits: TidyEdit[]
  convertKept: number
  convertKeptWords: number
}

/** 外观三态（方案 §1.10：浅/深/跟随系统） */
export type ThemeMode = 'light' | 'dark' | 'system'

/**
 * 正文字体：只列系统自带的中文字体（固定单选，默认苹方）。
 * 字体栈的唯一来源是 styles/theme.ts 的 READING.fontFamilies，这里只给菜单用的 key 与中文名。
 */
export type ReaderFont = 'pingfang' | 'songti' | 'kaiti' | 'yuanti' | 'hiragino'

/** 设置文件（userData/settings.json，方案 §1.9） */
export interface AppSettings {
  /** 外观三态（§1.10） */
  appearance: ThemeMode
  /** 左栏宽度（px，拖拽夹 160–640） */
  sidebarWidth: number
  /** 书库根目录；'' = 尚未接入（阶段 2 起作为书库根） */
  libraryRoot: string
  /** 除当前标签外的预载数量（0–20，接 LRU 驻留集合） */
  preloadCount: number
  /** 标签关闭按钮是否常驻（false = 仅 hover / 当前标签显示） */
  closeButtonAlwaysVisible: boolean
  /** 正文字体（「显示 → 字体」） */
  readerFont: ReaderFont
  /** 正文字号（Rust 侧 types.rs READER_FONT_SIZES 白名单之一） */
  readerFontSize: number
}

/** 侧栏宽度约束（AGENTS.md 界面约定：拖拽夹 160–640） */
export const SIDEBAR_MIN_WIDTH = 160
export const SIDEBAR_MAX_WIDTH = 640

/** 预载数量约束（方案 §1.7：0–20） */
export const PRELOAD_MIN_COUNT = 0
export const PRELOAD_MAX_COUNT = 20

/** 设置默认值（主进程落盘与渲染层首帧共用同一份，单一源见 shared/defaultSettings.json；
 *  字符串字段在此断言成联合类型） */
export const DEFAULT_SETTINGS: AppSettings = {
  appearance: defaultSettingsJson.appearance as ThemeMode,
  sidebarWidth: defaultSettingsJson.sidebarWidth,
  libraryRoot: defaultSettingsJson.libraryRoot,
  preloadCount: defaultSettingsJson.preloadCount,
  closeButtonAlwaysVisible: defaultSettingsJson.closeButtonAlwaysVisible,
  readerFont: defaultSettingsJson.readerFont as ReaderFont,
  readerFontSize: defaultSettingsJson.readerFontSize
}

/** 当前生效主题（主进程判定后推给渲染层，方案 §1.10） */
export interface ThemeChanged {
  dark: boolean
}
