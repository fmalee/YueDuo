/**
 * 渲染层唯一 IPC 出口：typed invoke（按域 snake_case command）+ 事件订阅。
 * 与 Rust 侧 `src-tauri/src/commands/` 一一对应：command 名 = Rust fn 名；
 * 参数 key 用 camelCase，Tauri 自动映射到 Rust snake_case 形参。
 * 错误契约：Rust 侧 Result<T, String> 的 Err 经 invoke reject 传回，这里包装成异常
 * （message 前缀 command 名），上层 composable 的 catch 行为与 Electron 版一致。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type {
  AppMenuPayload,
  AppMenuState,
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
  ParsedMetadata,
  RatingReadResult,
  RatingWriteResult,
  SessionRelocation,
  SessionRestore,
  SessionSnapshot,
  ThemeChanged,
  TidyResult
} from '../../shared/types'

/** invoke 包装：统一错误形状 `[command] message`，成功直接返回 data */
async function ipcInvoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (e) {
    const message = typeof e === 'string' ? e : String(e)
    throw new Error(`[${command}] ${message}`)
  }
}

/** 事件订阅包装：固定事件名，返回同步取消订阅（listen 异步注册完成前取消也安全） */
function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null
  let disposed = false
  void listen<T>(event, (e) => callback(e.payload)).then((fn) => {
    if (disposed) fn()
    else unlisten = fn
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

// ---------- settings 域 ----------

/** settings:get —— 读设置（缺失/损坏由主进程回落默认值） */
export function settingsGet(): Promise<AppSettings> {
  return ipcInvoke<AppSettings>('settings_get')
}

/** settings:set —— 写回设置（临时文件 + rename 原子替换） */
export function settingsSet(settings: AppSettings): Promise<AppSettings> {
  return ipcInvoke<AppSettings>('settings_set', { settings })
}

// ---------- app 域 ----------

/** app:syncMenuState —— 侧栏显隐变化后回写菜单勾选，让键盘切换与菜单状态一致 */
export function appSyncMenuState(state: AppMenuState): Promise<null> {
  return ipcInvoke<null>('app_sync_menu_state', { state })
}

/** 订阅顶部应用菜单命令（保存/关闭类与标签右键菜单共用动作） */
export function onAppMenuCommand(callback: (payload: AppMenuPayload) => void): () => void {
  return subscribe<AppMenuPayload>('app:menuCommand', callback)
}

// ---------- file 域 ----------

/** file:readText —— 读文本（主进程 codec 探测+转换+换行归一）。
 * 二进制帧协议（tauri::ipc::Response）：[u32 headerLen LE][header JSON utf-8][UTF-16LE 正文]，
 * 绕开 JSON 序列化大文本（省掉两侧 parse/serialize 与全量拷贝），WKWebView 侧用
 * TextDecoder 原生解码，大书恢复显著提速。 */
/** 单发读取：file_read_text 的二进制帧解析（[u32 headerLen][header][UTF-16LE 正文]） */
async function readTextSingle(path: string): Promise<FileReadResult> {
  const raw = await invoke<ArrayBuffer>('file_read_text', { path })
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
  const header = JSON.parse(
    new TextDecoder('utf-8').decode(bytes.subarray(4, 4 + headerLen))
  ) as { encoding: string; stat: FileStat }
  const text = new TextDecoder('utf-16le').decode(bytes.subarray(4 + headerLen))
  return { text, encoding: header.encoding, stat: header.stat }
}

/**
 * file:readText —— 读文本。主路径：并行分块 + gzip 压缩（等效吞吐 ~26MB/s，
 * 单发 ~13MB/s 但分块并行度受 WebKit 串行编组限制，两法实测打平 ~450ms/6.5M 字；
 * 压缩收益体现在多标签恢复的总字节减半）。原始字节前端 TextDecoder 解码
 * （TextDecoder 默认剥 BOM），换行归一（CRLF/CR→LF）与主进程解码链对齐。
 * 分块失败（utf-16be 等不支持编码/异常）回落单发二进制通道。
 */
export async function fileReadText(path: string): Promise<FileReadResult> {
  const CHUNK = 4 * 1024 * 1024
  let chunked: FileReadResult | null = null
  try {
    const stat = await fileStat(path)
    const n = Math.max(1, Math.ceil(stat.size / CHUNK))
    const raws = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        invoke<ArrayBuffer>('file_read_chunk', { path, offset: i * CHUNK, len: CHUNK })
      )
    )
    const parts = raws.map((r) => (r instanceof Uint8Array ? r : new Uint8Array(r)))
    // 帧格式对每块统一：[u32 LE 头长][头 JSON][gzip 数据]。chunk 0 的头含 encoding/size/compressed。
    // DecompressionStream 不接受拼接 gzip 成员（读完首个成员即报 Extra bytes），逐块独立解压后拼接
    const pieces = await Promise.all(
      parts.map(async (p) => {
        const dl = new DataView(p.buffer, p.byteOffset, 4)
        const hl = dl.getUint32(0, true)
        const h = JSON.parse(new TextDecoder('utf-8').decode(p.subarray(4, 4 + hl))) as {
          encoding?: string
          compressed?: boolean
        }
        const gz = p.subarray(4 + hl)
        const raw = h.compressed
          ? new Uint8Array(
              await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
            )
          : gz
        return { raw, encoding: h.encoding }
      })
    )
    const header0 = pieces[0]
    if (!header0.encoding) {
      throw new Error('chunk0 缺少 encoding')
    }
    const total = pieces.reduce((s, p) => s + p.raw.length, 0)
    const all = new Uint8Array(total)
    let pos = 0
    for (const piece of pieces) {
      all.set(piece.raw, pos)
      pos += piece.raw.length
    }
    // utf-16be 浏览器 TextDecoder 不支持 → 抛错走单发回落
    const text0 = new TextDecoder(header0.encoding).decode(all)
    // 与主进程解码链对齐：CRLF/CR → LF（无 \r 时跳过扫描之外的开销）
    const text = all.includes(13)
      ? text0.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      : text0
    chunked = { text, encoding: header0.encoding, stat }
  } catch {
    // 解压/解码异常回落单发二进制通道
    chunked = null
  }
  return chunked ?? (await readTextSingle(path))
}

/** file:stat —— 同文件去重（inode） */
export function fileStat(path: string): Promise<FileStat> {
  return ipcInvoke<FileStat>('file_stat', { path })
}

/** file:writeText —— 保存（UTF-16LE、临时文件原子替换） */
export function fileWriteText(path: string, text: string): Promise<{ stat: FileStat }> {
  return ipcInvoke<{ stat: FileStat }>('file_write_text', { path, text })
}

/** file:writeDraft —— LRU 卸载：dirty 全文 + viewState 落库（方案 §1.7） */
export function fileWriteDraft(
  tabId: string,
  text: string | null,
  viewState: unknown,
  meta?: DraftTabMeta
): Promise<void> {
  return ipcInvoke<void>('file_write_draft', {
    tabId,
    text,
    viewState,
    meta: meta ?? null
  })
}

/** file:readDraft —— 重载已卸载标签：null = 无草稿（重载走 file:readText） */
export function fileReadDraft(tabId: string): Promise<DraftEntry | null> {
  return ipcInvoke<DraftEntry | null>('file_read_draft', { tabId })
}

/** file:clearDraft —— 保存/关闭后清草稿（方案 §1.4） */
export function fileClearDraft(tabId: string): Promise<void> {
  return ipcInvoke<void>('file_clear_draft', { tabId })
}

/** file:rename —— 重命名标签文件并同步库身份（方案 §3.5） */
export function fileRename(path: string, newName: string): Promise<FileRenameResult> {
  return ipcInvoke<FileRenameResult>('file_rename', { path, newName })
}

/** file:move —— 移动标签文件到书库内其它目录并同步库身份（方案 §3.5） */
export function fileMove(path: string, destDir: string): Promise<FileRenameResult> {
  return ipcInvoke<FileRenameResult>('file_move', { path, destDir })
}

/** file:trash —— 移到系统废纸篓并清理库记录（方案 §3.5） */
export function fileTrash(path: string): Promise<FileTrashResult> {
  return ipcInvoke<FileTrashResult>('file_trash', { path })
}

/** file:reveal —— 在 Finder 中显示文件（方案 §3.5） */
export function fileReveal(path: string): Promise<null> {
  return ipcInvoke<null>('file_reveal', { path })
}

// ---------- dialog 域 ----------

/** dialog:confirmClose —— 关闭未保存标签三选一（save/discard/cancel；P3 起由前端自绘浮层接管） */
export function confirmClose(title: string): Promise<'save' | 'discard' | 'cancel'> {
  return ipcInvoke<'save' | 'discard' | 'cancel'>('dialog_confirm_close', { title })
}

/** dialog:openFile —— 「文件 → 打开…」选择文件（返回 null = 取消） */
export function chooseOpenFile(): Promise<string | null> {
  return ipcInvoke<string | null>('dialog_open_file')
}

/** dialog:saveFile —— 「另存为」选择目标（返回 null = 取消） */
export function chooseSaveFile(name: string): Promise<string | null> {
  return ipcInvoke<string | null>('dialog_save_file', { name })
}

/** dialog:confirmTrash —— 删除文件前的确认框（默认取消） */
export function confirmTrash(title: string, dirty: boolean): Promise<boolean> {
  return ipcInvoke<boolean>('dialog_confirm_trash', { title, dirty })
}

/** dialog:showError —— 文件操作失败的可见提示 */
export function showError(title: string, message: string): Promise<null> {
  return ipcInvoke<null>('dialog_show_error', { title, message })
}

/** dialog:chooseLibrary —— 选择书库根目录（返回 null = 取消） */
export function chooseLibrary(): Promise<string | null> {
  return ipcInvoke<string | null>('dialog_choose_library')
}

/** dialog:pickFolderIn —— 从指定目录选择子目录，移动文本用（返回 null = 取消） */
export function chooseFolderIn(dir: string): Promise<string | null> {
  return ipcInvoke<string | null>('dialog_pick_folder_in', { dir })
}

// ---------- session 域 ----------

/** session:persist —— 全量写会话（2 秒防抖 + 关窗立即调用） */
export function sessionPersist(snapshot: SessionSnapshot): Promise<void> {
  return ipcInvoke<void>('session_persist', { snapshot })
}

/** session:restore —— 启动时读会话（标签顺序/active/进度） */
export function sessionRestore(): Promise<SessionRestore> {
  return ipcInvoke<SessionRestore>('session_restore')
}

/** session:relocate —— 对账扫完后按 book_id 重连缺失标签；只返回重新找到文件的标签 */
export function sessionRelocate(tabIds: string[]): Promise<SessionRelocation[]> {
  return ipcInvoke<SessionRelocation[]>('session_relocate', { tabIds })
}

/** session:flushDone —— 退出握手回执：落盘完成，主进程可继续退出 */
export function sessionFlushDone(): Promise<null> {
  return ipcInvoke<null>('session_flush_done')
}

/** 订阅退出/关窗前落盘请求（主进程 ExitRequested / 关窗时发） */
export function onSessionFlush(callback: () => void): () => void {
  return subscribe('session:flush', callback)
}

// ---------- library 域 ----------

/** library:current —— 主进程启动时按设置打开的活动书库（方案 §2.13） */
export function libraryCurrent(): Promise<LibraryCurrentState> {
  return ipcInvoke<LibraryCurrentState>('library_current')
}

/** library:open —— 换库第一步：建新库 + 停扫描 + 读新会话（旧库仍活动）；同一书库 switched=false */
export function libraryOpen(root: string): Promise<LibraryOpenResult> {
  return ipcInvoke<LibraryOpenResult>('library_open', { root })
}

/** library:activate —— 换库提交：关闭旧库连接并激活新库（方案 §2.13） */
export function libraryActivate(): Promise<{ root: string }> {
  return ipcInvoke<{ root: string }>('library_activate')
}

/** library:abort —— 放弃待切换的新库，原库保持可用（方案 §2.13） */
export function libraryAbort(): Promise<null> {
  return ipcInvoke<null>('library_abort')
}

/** library:fastScan —— 书架惰性树的一层目录（目录在前、TXT 在后） */
export function libraryFastScan(relativeDir = ''): Promise<LibraryEntry[]> {
  return ipcInvoke<LibraryEntry[]>('library_fast_scan', { relativeDir })
}

/** library:enrich —— 后台补元数据 + 对账，完成前进度经 onLibraryScanProgress 推送 */
export function libraryEnrich(): Promise<LibraryEnrichResult> {
  return ipcInvoke<LibraryEnrichResult>('library_enrich')
}

/** 历史：last_read_at 倒序（方案 §2.5） */
export function libraryHistory(): Promise<LibraryBook[]> {
  return ipcInvoke<LibraryBook[]>('library_history')
}

/** 快速检索快照（方案 §2.12）：全量书目；未打开书库返回空列表 */
export function libraryAllBooks(): Promise<LibraryBook[]> {
  return ipcInvoke<LibraryBook[]>('library_all_books')
}

/** 追更：标签精确匹配「追更」 */
export function libraryFollowing(): Promise<LibraryBook[]> {
  return ipcInvoke<LibraryBook[]>('library_following')
}

/** 标签：名称/数量/标签评分三列 */
export function libraryTags(): Promise<LibraryTagSummary[]> {
  return ipcInvoke<LibraryTagSummary[]>('library_tags')
}

/** 某个标签下的书（精确匹配） */
export function libraryBooksByTag(tag: string): Promise<LibraryBook[]> {
  return ipcInvoke<LibraryBook[]>('library_books_by_tag', { tag })
}

/** 评分页：rating=null 取全部有评分的书（最多 100 本） */
export function libraryRated(rating: number | null): Promise<LibraryBook[]> {
  return ipcInvoke<LibraryBook[]>('library_rated', { rating })
}

/** 标签评分：只写库，不写正文（0 分也落一行） */
export function librarySetTagRating(tag: string, rating: number): Promise<number> {
  return ipcInvoke<number>('library_set_tag_rating', { tag, rating })
}

/** library:markRead —— 打开/激活标签写 last_read_at（返回写入时间戳，0 = 不在书库） */
export function libraryMarkRead(path: string): Promise<number> {
  return ipcInvoke<number>('library_mark_read', { path })
}

/** library:bookByPath —— 元数据栏读取当前书的库记录（书名/作者/标签/评分与 id） */
export function libraryBookByPath(path: string): Promise<LibraryBook | null> {
  return ipcInvoke<LibraryBook | null>('library_book_by_path', { path })
}

/** library:setBookRating —— 书籍评分：库内评分 + Finder 星级（xattr）一起写 */
export function librarySetBookRating(id: number, rating: number): Promise<number> {
  return ipcInvoke<number>('library_set_book_rating', { id, rating })
}

/** library:syncMetadata —— 保存后按当前正文重解析书名/作者/标签，只更新这一本 */
export function librarySyncMetadata(path: string): Promise<LibrarySyncResult> {
  return ipcInvoke<LibrarySyncResult>('library_sync_metadata', { path })
}

/** library:chapters —— 当前书章节（主进程读文件并按同口径正则提取） */
export function libraryChapters(path: string): Promise<ChapterInfo[]> {
  return ipcInvoke<ChapterInfo[]>('library_chapters', { path })
}

/** library:bookmarks —— 当前书书签（按行号升序） */
export function libraryBookmarks(path: string): Promise<BookmarkInfo[]> {
  return ipcInvoke<BookmarkInfo[]>('library_bookmarks', { path })
}

/** library:addBookmark —— 添加书签；同行重复时更新摘要 */
export function libraryAddBookmark(
  path: string,
  line: number,
  note: string
): Promise<BookmarkInfo[]> {
  return ipcInvoke<BookmarkInfo[]>('library_add_bookmark', { path, line, note })
}

/** library:removeBookmark —— 删除书签（同行唯一） */
export function libraryRemoveBookmark(path: string, line: number): Promise<BookmarkInfo[]> {
  return ipcInvoke<BookmarkInfo[]>('library_remove_bookmark', { path, line })
}

/** library:allBookmarks —— 全库书签按书分组（方案 §2.7） */
export function libraryAllBookmarks(): Promise<LibraryBookmarkGroup[]> {
  return ipcInvoke<LibraryBookmarkGroup[]>('library_all_bookmarks')
}

/** library:replaceBookmarks —— 编辑行号漂移后整体回写某本书的书签 */
export function libraryReplaceBookmarks(
  path: string,
  bookmarks: BookmarkInfo[]
): Promise<BookmarkInfo[]> {
  return ipcInvoke<BookmarkInfo[]>('library_replace_bookmarks', { path, bookmarks })
}

/** 订阅书库扫描进度（enrich 每 10 个文件推送一次） */
export function onLibraryScanProgress(
  callback: (payload: LibraryScanProgress) => void
): () => void {
  return subscribe<LibraryScanProgress>('library:scanProgress', callback)
}

// ---------- meta 域 ----------

/** meta:applyEdit —— 元数据写回：传编辑器当前正文，主进程返回最小替换区间并同步 books */
export function metaApplyEdit(
  path: string,
  text: string,
  field: MetadataField,
  value: string
): Promise<MetadataEditResult> {
  return ipcInvoke<MetadataEditResult>('meta_apply_edit', { path, text, field, value })
}

/** meta:read —— 元数据栏首屏：库外文件按磁盘正文解析书名/作者/标签 */
export function metaReadMetadata(path: string): Promise<ParsedMetadata> {
  return ipcInvoke<ParsedMetadata>('meta_read', { path })
}

/** meta:readRating —— 评分读回：库内取 books，库外取文件 Finder 星级 */
export function metaReadRating(path: string): Promise<RatingReadResult> {
  return ipcInvoke<RatingReadResult>('meta_read_rating', { path })
}

/** meta:applyRating —— 评分写回：库内写库 + 文件星级，库外只写文件星级（persisted=false 需回退） */
export function metaApplyRating(path: string, rating: number): Promise<RatingWriteResult> {
  return ipcInvoke<RatingWriteResult>('meta_apply_rating', { path, rating })
}

// ---------- convert 域 ----------

/** convert:toHalfwidth —— 全角字母/数字/加减号转半角（选区优先由调用方切范围） */
export function convertToHalfwidth(text: string): Promise<ConvertResult> {
  return ipcInvoke<ConvertResult>('convert_to_halfwidth', { text })
}

/** convert:toTraditional —— 简转繁（标准字形，保护词与多义字策略在主进程） */
export function convertToTraditional(text: string): Promise<ConvertResult> {
  return ipcInvoke<ConvertResult>('convert_to_traditional', { text })
}

/** convert:toSimplified —— 繁转简（标准字形） */
export function convertToSimplified(text: string): Promise<ConvertResult> {
  return ipcInvoke<ConvertResult>('convert_to_simplified', { text })
}

/** convert:tidy —— 一键整理全文（固定顺序，返回转换保留项计数供状态栏提示） */
export function convertTidy(text: string): Promise<TidyResult> {
  return ipcInvoke<TidyResult>('convert_tidy', { text })
}

// ---------- 主题推送 ----------

/** 订阅主题变化推送（系统主题/设置切换 → 渲染层切 token） */
export function onThemeUpdated(callback: (payload: ThemeChanged) => void): () => void {
  return subscribe<ThemeChanged>('theme:updated', callback)
}

// ---------- 窗口 ----------

/** 显示主窗口：tauri.conf.json 里 visible=false，主题注入首帧后由渲染层拉起（消除启动闪白） */
export function windowShow(): Promise<void> {
  return getCurrentWindow().show()
}

// ---------- 性能日志 ----------

/** 前端关键耗时回传 Rust 打 stderr（[perf:fe] 前缀，打包版从终端启动可见） */
export function appPerfLog(message: string): Promise<void> {
  return invoke('app_perf_log', { message })
}
