import { handle } from './registry'
import { appSyncMenuState } from './app'
import { nativeSanity } from './native'
import {
  fileReadText,
  fileStat,
  fileWriteText,
  fileWriteDraft,
  fileReadDraft,
  fileClearDraft,
  fileRename,
  fileTrash,
  fileReveal
} from './file'
import {
  confirmClose,
  chooseLibrary,
  chooseOpenFile,
  chooseSaveFile,
  confirmTrash,
  showError
} from './dialog'
import {
  addBookBookmark,
  bookBookmarks,
  bookChapters,
  activateLibrarySwitch,
  abortLibrarySwitch,
  enrichLibrary,
  fastScanLibrary,
  libraryCurrent,
  libraryBookByPath,
  libraryBooksByTag,
  libraryFollowing,
  libraryHistory,
  libraryAllBooks,
  libraryRated,
  librarySetBookRating,
  librarySetTagRating,
  libraryTags,
  libraryAllBookmarks,
  markBookRead,
  openLibrary,
  removeBookBookmark,
  replaceBookBookmarks,
  syncBookMetadata
} from './library'
import { settingsGet, settingsSet } from './settings'
import { sessionPersist, sessionRestore, sessionRelocate, sessionFlushDone } from './session'
import { applyMetadataEdit, readMetadata } from './meta'
import { convertHalfwidth, convertSimplified, convertTraditional, tidyDocument } from './convert'
import type { AppMenuState, AppSettings, DraftTabMeta } from '../../shared/types'

/** 各域 handler 汇聚注册（新增域在此追加） */
export function registerIpcHandlers(): void {
  handle('native:sanity', () => nativeSanity())
  // 菜单勾选跟随应用状态（键盘切换侧栏后回写，与菜单点击一致）
  handle('app:syncMenuState', (state: unknown) => appSyncMenuState(state as AppMenuState))
  handle('file:readText', (path: unknown) => fileReadText(String(path)))
  handle('file:stat', (path: unknown) => fileStat(String(path)))
  handle('file:writeText', (path: unknown, text: unknown) =>
    fileWriteText(String(path), String(text))
  )
  handle('file:writeDraft', (tabId: unknown, text: unknown, viewState: unknown, meta: unknown) =>
    fileWriteDraft(
      String(tabId),
      text === null ? null : String(text),
      viewState ?? null,
      (meta ?? null) as DraftTabMeta | null
    )
  )
  handle('file:readDraft', (tabId: unknown) => fileReadDraft(String(tabId)))
  handle('file:clearDraft', (tabId: unknown) => fileClearDraft(String(tabId)))
  // 标签右键菜单（方案 §3.5）：改名为磁盘 + books 身份同步；删除走系统废纸篓
  handle('file:rename', (path: unknown, newName: unknown) => fileRename(String(path), newName))
  handle('file:trash', (path: unknown) => fileTrash(String(path)))
  handle('file:reveal', (path: unknown) => fileReveal(String(path)))
  handle('dialog:confirmClose', (title: unknown) => confirmClose(String(title)))
  handle('dialog:openFile', () => chooseOpenFile())
  handle('dialog:saveFile', (name: unknown) => chooseSaveFile(String(name)))
  handle('dialog:confirmTrash', (title: unknown, dirty: unknown) =>
    confirmTrash(String(title), dirty === true)
  )
  handle('dialog:showError', (title: unknown, message: unknown) =>
    showError(String(title), String(message))
  )
  handle('dialog:chooseLibrary', () => chooseLibrary())
  // 书库（方案 §2.5 / §2.13）：启动状态、换库三步（open 准备 / activate 提交 / abort 回滚）
  handle('library:current', () => libraryCurrent())
  handle('library:open', (root: unknown) => openLibrary(root))
  handle('library:activate', () => activateLibrarySwitch())
  handle('library:abort', () => abortLibrarySwitch())
  handle('library:fastScan', (relativeDir: unknown) => fastScanLibrary(relativeDir))
  handle('library:enrich', () => enrichLibrary())
  handle('library:history', () => libraryHistory())
  // 快速检索（方案 §2.12）：唤出面板时读一遍全量快照，输入过滤在渲染层内存完成
  handle('library:allBooks', () => libraryAllBooks())
  handle('library:following', () => libraryFollowing())
  handle('library:tags', () => libraryTags())
  handle('library:booksByTag', (tag: unknown) => libraryBooksByTag(tag))
  // 元数据栏（方案 §2.9）：按当前路径取库记录（书名/作者/标签/评分）
  handle('library:bookByPath', (path: unknown) => libraryBookByPath(path))
  handle('library:rated', (rating: unknown) => libraryRated(rating))
  handle('library:setTagRating', (tag: unknown, rating: unknown) =>
    librarySetTagRating(tag, rating)
  )
  // 2.5 验收补丁：阅读时间/书籍评分（库 + Finder 星级）/保存后同步当前文件元数据
  handle('library:markRead', (path: unknown) => markBookRead(path))
  handle('library:setBookRating', (id: unknown, rating: unknown) =>
    librarySetBookRating(id, rating)
  )
  handle('library:syncMetadata', (path: unknown) => syncBookMetadata(path))
  // 右栏（方案 §2.6）：当前书章节 + 当前书书签
  handle('library:chapters', (path: unknown) => bookChapters(path))
  handle('library:bookmarks', (path: unknown) => bookBookmarks(path))
  handle('library:addBookmark', (path: unknown, line: unknown, note: unknown) =>
    addBookBookmark(path, line, note)
  )
  handle('library:removeBookmark', (path: unknown, line: unknown) => removeBookBookmark(path, line))
  // 2.7 全库书签分组 + 编辑漂移后的整体回写
  handle('library:allBookmarks', () => libraryAllBookmarks())
  handle('library:replaceBookmarks', (path: unknown, bookmarks: unknown) =>
    replaceBookBookmarks(path, bookmarks)
  )
  // 元数据写回（方案 §2.8）：按编辑器当前正文算最小替换区间，再同步 books
  handle('meta:applyEdit', (path: unknown, text: unknown, field: unknown, value: unknown) =>
    applyMetadataEdit(path, text, field, value)
  )
  // 元数据栏首屏（方案 §2.9）：库外文件按磁盘正文解析
  handle('meta:read', (path: unknown) => readMetadata(path))
  // 文本转换（方案 §3.2）：右键「转换」组与一键整理，选区/整文范围由渲染层决定
  handle('convert:toHalfwidth', (text: unknown) => convertHalfwidth(String(text ?? '')))
  handle('convert:toTraditional', (text: unknown) => convertTraditional(String(text ?? '')))
  handle('convert:toSimplified', (text: unknown) => convertSimplified(String(text ?? '')))
  handle('convert:tidy', (text: unknown) => tidyDocument(String(text ?? '')))
  handle('settings:get', () => settingsGet())
  handle('settings:set', (settings: unknown) => settingsSet(settings as AppSettings))
  // 会话持久化（方案 §1.8）：persist/restore 读写 session_tabs/session_state；
  // flushDone 是退出握手回执，渲染层落盘后调用
  handle('session:persist', (snapshot: unknown) => sessionPersist(snapshot))
  handle('session:restore', () => sessionRestore())
  // 对账扫完后按 book_id 重连缺失标签（渲染层只传标签 id，路径判定在主进程）
  handle('session:relocate', (tabIds: unknown) => sessionRelocate(tabIds))
  handle('session:flushDone', () => sessionFlushDone())
}
