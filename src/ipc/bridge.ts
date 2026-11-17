import type {
  AppMenuCommand,
  AppSettings,
  BookmarkInfo,
  ChapterInfo,
  ConvertResult,
  DraftEntry,
  DraftTabMeta,
  FileReadResult,
  FileRenameResult,
  FileStat,
  FileTrashResult,
  IpcResult,
  LibraryBook,
  LibraryBookmarkGroup,
  LibraryCurrentState,
  LibraryEnrichResult,
  LibraryEntry,
  LibraryOpenResult,
  LibraryScanProgress,
  LibrarySyncResult,
  LibraryTagSummary,
  MetadataEditResult,
  MetadataField,
  NativeSanity,
  ParsedMetadata,
  SessionRestore,
  SessionSnapshot,
  ThemeChanged,
  TidyResult
} from '../../shared/types'

declare global {
  interface Window {
    yue: {
      invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<IpcResult<T>>
      onThemeUpdated(callback: (payload: ThemeChanged) => void): () => void
      onSessionFlush(callback: () => void): () => void
      onLibraryScanProgress(callback: (payload: LibraryScanProgress) => void): () => void
      onAppMenuCommand(callback: (command: AppMenuCommand) => void): () => void
    }
  }
}

/** 渲染层唯一 IPC 出口（方案 §三：渲染进程禁止 import Node 模块，一切走 bridge） */
export async function ipcInvoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await window.yue.invoke<T>(channel, ...args)
  if (!result.ok) {
    throw new Error(`[${channel}] ${result.error}`)
  }
  return result.data
}

/** native 验收通道 */
export function nativeSanity(): Promise<NativeSanity> {
  return ipcInvoke<NativeSanity>('native:sanity')
}

/** file:readText —— 读文本（主进程 textCodec 探测+转换+换行归一） */
export function fileReadText(path: string): Promise<FileReadResult> {
  return ipcInvoke<FileReadResult>('file:readText', path)
}

/** file:stat —— 同文件去重（inode） */
export function fileStat(path: string): Promise<FileStat> {
  return ipcInvoke<FileStat>('file:stat', path)
}

/** file:writeText —— 保存（UTF-16LE、临时文件原子替换） */
export function fileWriteText(path: string, text: string): Promise<{ stat: FileStat }> {
  return ipcInvoke<{ stat: FileStat }>('file:writeText', path, text)
}

/** file:writeDraft —— LRU 卸载：dirty 全文 + viewState 落主进程草稿（方案 §1.7） */
export function fileWriteDraft(
  tabId: string,
  text: string | null,
  viewState: unknown,
  meta?: DraftTabMeta
): Promise<void> {
  return ipcInvoke<void>('file:writeDraft', tabId, text, viewState, meta ?? null)
}

/** file:readDraft —— 重载已卸载标签：null = 无草稿（重载走 file:readText） */
export function fileReadDraft(tabId: string): Promise<DraftEntry | null> {
  return ipcInvoke<DraftEntry | null>('file:readDraft', tabId)
}

/** file:clearDraft —— 保存/关闭后清草稿（方案 §1.4） */
export function fileClearDraft(tabId: string): Promise<void> {
  return ipcInvoke<void>('file:clearDraft', tabId)
}

/** file:rename —— 重命名标签文件并同步库身份（方案 §3.5） */
export function fileRename(path: string, newName: string): Promise<FileRenameResult> {
  return ipcInvoke<FileRenameResult>('file:rename', path, newName)
}

/** file:trash —— 移到系统废纸篓并清理库记录（方案 §3.5） */
export function fileTrash(path: string): Promise<FileTrashResult> {
  return ipcInvoke<FileTrashResult>('file:trash', path)
}

/** file:reveal —— 在 Finder 中显示文件（方案 §3.5） */
export function fileReveal(path: string): Promise<null> {
  return ipcInvoke<null>('file:reveal', path)
}

/** dialog:confirmTrash —— 删除文件前的确认框（默认取消） */
export function confirmTrash(title: string, dirty: boolean): Promise<boolean> {
  return ipcInvoke<boolean>('dialog:confirmTrash', title, dirty)
}

/** dialog:showError —— 文件操作失败的可见提示 */
export function showError(title: string, message: string): Promise<null> {
  return ipcInvoke<null>('dialog:showError', title, message)
}

/** settings:get —— 读设置（方案 §1.9；缺失/损坏由主进程回落默认值） */
export function settingsGet(): Promise<AppSettings> {
  return ipcInvoke<AppSettings>('settings:get')
}

/** settings:set —— 写回设置（方案 §1.9，1.10 切换外观时调用） */
export function settingsSet(settings: AppSettings): Promise<AppSettings> {
  return ipcInvoke<AppSettings>('settings:set', settings)
}

/** dialog:chooseLibrary —— 选择书库根目录（方案 §1.9；阶段 2 起作为书库根，返回 null = 取消） */
export function chooseLibrary(): Promise<string | null> {
  return ipcInvoke<string | null>('dialog:chooseLibrary')
}

/** 订阅主题变化推送（方案 §1.10：nativeTheme 'updated' → 渲染层切 token） */
export function onThemeUpdated(callback: (payload: ThemeChanged) => void): () => void {
  return window.yue.onThemeUpdated(callback)
}

/** session:persist —— 全量写会话（方案 §1.8；2 秒防抖 + 关窗立即调用） */
export function sessionPersist(snapshot: SessionSnapshot): Promise<void> {
  return ipcInvoke<void>('session:persist', snapshot)
}

/** session:restore —— 启动时读会话（标签顺序/active/进度） */
export function sessionRestore(): Promise<SessionRestore> {
  return ipcInvoke<SessionRestore>('session:restore')
}

/** session:flushDone —— 退出握手回执：落盘完成，主进程可继续退出 */
export function sessionFlushDone(): Promise<null> {
  return ipcInvoke<null>('session:flushDone')
}

/** 订阅退出/关窗前落盘请求（主进程 before-quit / 关窗时发） */
export function onSessionFlush(callback: () => void): () => void {
  return window.yue.onSessionFlush(callback)
}

/** 订阅顶部「文件」菜单命令（保存/关闭类与标签右键菜单共用动作） */
export function onAppMenuCommand(callback: (command: AppMenuCommand) => void): () => void {
  return window.yue.onAppMenuCommand(callback)
}

/** library:current —— 主进程启动时按设置打开的活动书库（方案 §2.13） */
export function libraryCurrent(): Promise<LibraryCurrentState> {
  return ipcInvoke<LibraryCurrentState>('library:current')
}

/**
 * library:open —— 换库第一步：建新库 + 停扫描 + 读新会话（旧库仍活动）；
 * 同一书库返回 switched=false。方案 §2.13
 */
export function libraryOpen(root: string): Promise<LibraryOpenResult> {
  return ipcInvoke<LibraryOpenResult>('library:open', root)
}

/** library:activate —— 换库提交：关闭旧库连接并激活新库（方案 §2.13） */
export function libraryActivate(): Promise<{ root: string }> {
  return ipcInvoke<{ root: string }>('library:activate')
}

/** library:abort —— 放弃待切换的新库，原库保持可用（方案 §2.13） */
export function libraryAbort(): Promise<null> {
  return ipcInvoke<null>('library:abort')
}

/** library:fastScan —— 书架惰性树的一层目录（目录在前、TXT 在后） */
export function libraryFastScan(relativeDir = ''): Promise<LibraryEntry[]> {
  return ipcInvoke<LibraryEntry[]>('library:fastScan', relativeDir)
}

/** library:enrich —— 后台补元数据 + 对账，完成前进度经 onLibraryScanProgress 推送 */
export function libraryEnrich(): Promise<LibraryEnrichResult> {
  return ipcInvoke<LibraryEnrichResult>('library:enrich')
}

/** 历史：last_read_at 倒序（方案 §2.5） */
export function libraryHistory(): Promise<LibraryBook[]> {
  return ipcInvoke<LibraryBook[]>('library:history')
}

/** 快速检索快照（方案 §2.12）：全量书目，最近阅读优先；未打开书库返回空列表 */
export function libraryAllBooks(): Promise<LibraryBook[]> {
  return ipcInvoke<LibraryBook[]>('library:allBooks')
}

/** 追更：标签精确匹配「追更」 */
export function libraryFollowing(): Promise<LibraryBook[]> {
  return ipcInvoke<LibraryBook[]>('library:following')
}

/** 标签：名称/数量/标签评分三列 */
export function libraryTags(): Promise<LibraryTagSummary[]> {
  return ipcInvoke<LibraryTagSummary[]>('library:tags')
}

/** 某个标签下的书（精确匹配） */
export function libraryBooksByTag(tag: string): Promise<LibraryBook[]> {
  return ipcInvoke<LibraryBook[]>('library:booksByTag', tag)
}

/** 评分页：rating=null 取全部有评分的书（最多 100 本） */
export function libraryRated(rating: number | null): Promise<LibraryBook[]> {
  return ipcInvoke<LibraryBook[]>('library:rated', rating)
}

/** 标签评分：只写库，不写正文（0 分也落一行） */
export function librarySetTagRating(tag: string, rating: number): Promise<number> {
  return ipcInvoke<number>('library:setTagRating', tag, rating)
}

/** library:markRead —— 打开/激活标签写 last_read_at（返回写入时间戳，0 = 不在书库） */
export function libraryMarkRead(path: string): Promise<number> {
  return ipcInvoke<number>('library:markRead', path)
}

/** library:bookByPath —— 元数据栏读取当前书的库记录（书名/作者/标签/评分与 id） */
export function libraryBookByPath(path: string): Promise<LibraryBook | null> {
  return ipcInvoke<LibraryBook | null>('library:bookByPath', path)
}

/** library:setBookRating —— 书籍评分：库内评分 + Finder 星级（xattr）一起写 */
export function librarySetBookRating(id: number, rating: number): Promise<number> {
  return ipcInvoke<number>('library:setBookRating', id, rating)
}

/** library:syncMetadata —— 保存后按当前正文重解析书名/作者/标签，只更新这一本 */
export function librarySyncMetadata(path: string): Promise<LibrarySyncResult> {
  return ipcInvoke<LibrarySyncResult>('library:syncMetadata', path)
}

/**
 * meta:applyEdit —— 元数据写回（方案 §2.8）：传编辑器当前正文（可含未保存修改），
 * 主进程返回最小替换区间，并按写回后的正文同步 books。
 */
export function metaApplyEdit(
  path: string,
  text: string,
  field: MetadataField,
  value: string
): Promise<MetadataEditResult> {
  return ipcInvoke<MetadataEditResult>('meta:applyEdit', path, text, field, value)
}

/** meta:read —— 元数据栏首屏：库外文件按磁盘正文解析书名/作者/标签 */
export function metaReadMetadata(path: string): Promise<ParsedMetadata> {
  return ipcInvoke<ParsedMetadata>('meta:read', path)
}

/** library:chapters —— 当前书章节（主进程读文件并按 Python 同口径正则提取） */ export function libraryChapters(
  path: string
): Promise<ChapterInfo[]> {
  return ipcInvoke<ChapterInfo[]>('library:chapters', path)
}

/** library:bookmarks —— 当前书书签（按行号升序） */
export function libraryBookmarks(path: string): Promise<BookmarkInfo[]> {
  return ipcInvoke<BookmarkInfo[]>('library:bookmarks', path)
}

/** library:addBookmark —— 添加书签；同行重复时更新摘要 */
export function libraryAddBookmark(
  path: string,
  line: number,
  note: string
): Promise<BookmarkInfo[]> {
  return ipcInvoke<BookmarkInfo[]>('library:addBookmark', path, line, note)
}

/** library:removeBookmark —— 删除书签 */
export function libraryRemoveBookmark(path: string, line: number): Promise<BookmarkInfo[]> {
  return ipcInvoke<BookmarkInfo[]>('library:removeBookmark', path, line)
}

/** library:allBookmarks —— 全库书签按书分组（方案 §2.7） */
export function libraryAllBookmarks(): Promise<LibraryBookmarkGroup[]> {
  return ipcInvoke<LibraryBookmarkGroup[]>('library:allBookmarks')
}

/** library:replaceBookmarks —— 编辑行号漂移后整体回写某本书的书签 */
export function libraryReplaceBookmarks(
  path: string,
  bookmarks: BookmarkInfo[]
): Promise<BookmarkInfo[]> {
  return ipcInvoke<BookmarkInfo[]>('library:replaceBookmarks', path, bookmarks)
}

/** 订阅书库扫描进度 */
export function onLibraryScanProgress(
  callback: (payload: LibraryScanProgress) => void
): () => void {
  return window.yue.onLibraryScanProgress(callback)
}

/** convert:toHalfwidth —— 全角字母/数字/加减号转半角（方案 §3.2，选区优先由调用方切范围） */
export function convertToHalfwidth(text: string): Promise<ConvertResult> {
  return ipcInvoke<ConvertResult>('convert:toHalfwidth', text)
}

/** convert:toTraditional —— 简转繁（标准字形，保护词与多义字策略在主进程） */
export function convertToTraditional(text: string): Promise<ConvertResult> {
  return ipcInvoke<ConvertResult>('convert:toTraditional', text)
}

/** convert:toSimplified —— 繁转简（标准字形） */
export function convertToSimplified(text: string): Promise<ConvertResult> {
  return ipcInvoke<ConvertResult>('convert:toSimplified', text)
}

/** convert:tidy —— 一键整理全文（固定五步顺序，返回转换保留项计数供状态栏提示） */
export function convertTidy(text: string): Promise<TidyResult> {
  return ipcInvoke<TidyResult>('convert:tidy', text)
}
