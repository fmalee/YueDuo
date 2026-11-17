import { handle } from './registry'
import { nativeSanity } from './native'
import {
  fileReadText,
  fileStat,
  fileWriteText,
  fileWriteDraft,
  fileReadDraft,
  fileClearDraft
} from './file'
import { confirmClose, chooseLibrary, chooseSaveFile } from './dialog'
import {
  addBookBookmark,
  bookBookmarks,
  bookChapters,
  enrichLibrary,
  fastScanLibrary,
  libraryBooksByTag,
  libraryFollowing,
  libraryHistory,
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
import { sessionPersist, sessionRestore, sessionFlushDone } from './session'
import { applyMetadataEdit } from './meta'
import type { AppSettings, DraftTabMeta } from '../../shared/types'

/** 各域 handler 汇聚注册（新增域在此追加） */
export function registerIpcHandlers(): void {
  handle('native:sanity', () => nativeSanity())
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
  handle('dialog:confirmClose', (title: unknown) => confirmClose(String(title)))
  handle('dialog:saveFile', (name: unknown) => chooseSaveFile(String(name)))
  handle('dialog:chooseLibrary', () => chooseLibrary())
  // 书库（方案 §2.5）：打开/惰性目录树/后台补元数据/四类列表查询
  handle('library:open', (root: unknown) => openLibrary(root))
  handle('library:fastScan', (relativeDir: unknown) => fastScanLibrary(relativeDir))
  handle('library:enrich', () => enrichLibrary())
  handle('library:history', () => libraryHistory())
  handle('library:following', () => libraryFollowing())
  handle('library:tags', () => libraryTags())
  handle('library:booksByTag', (tag: unknown) => libraryBooksByTag(tag))
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
  handle('settings:get', () => settingsGet())
  handle('settings:set', (settings: unknown) => settingsSet(settings as AppSettings))
  // 会话持久化（方案 §1.8）：persist/restore 读写 session_tabs/session_state；
  // flushDone 是退出握手回执，渲染层落盘后调用
  handle('session:persist', (snapshot: unknown) => sessionPersist(snapshot))
  handle('session:restore', () => sessionRestore())
  handle('session:flushDone', () => sessionFlushDone())
}
