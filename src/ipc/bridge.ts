import type {
  AppSettings,
  DraftEntry,
  DraftTabMeta,
  FileReadResult,
  FileStat,
  IpcResult,
  LibraryBook,
  LibraryEnrichResult,
  LibraryEntry,
  LibraryOpenResult,
  LibraryScanProgress,
  LibraryTagSummary,
  NativeSanity,
  SessionRestore,
  SessionSnapshot,
  ThemeChanged
} from '../../shared/types'

declare global {
  interface Window {
    yue: {
      invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<IpcResult<T>>
      onThemeUpdated(callback: (payload: ThemeChanged) => void): () => void
      onSessionFlush(callback: () => void): () => void
      onLibraryScanProgress(callback: (payload: LibraryScanProgress) => void): () => void
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

/** library:open —— 打开/切换书库根（realpath 归一，方案 §2.5） */
export function libraryOpen(root: string): Promise<LibraryOpenResult> {
  return ipcInvoke<LibraryOpenResult>('library:open', root)
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

/** 订阅书库扫描进度 */
export function onLibraryScanProgress(
  callback: (payload: LibraryScanProgress) => void
): () => void {
  return window.yue.onLibraryScanProgress(callback)
}
