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
  enrichLibrary,
  fastScanLibrary,
  libraryBooksByTag,
  libraryFollowing,
  libraryHistory,
  libraryRated,
  librarySetTagRating,
  libraryTags,
  openLibrary
} from './library'
import { settingsGet, settingsSet } from './settings'
import { sessionPersist, sessionRestore, sessionFlushDone } from './session'
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
  handle('settings:get', () => settingsGet())
  handle('settings:set', (settings: unknown) => settingsSet(settings as AppSettings))
  // 会话持久化（方案 §1.8）：persist/restore 读写 session_tabs/session_state；
  // flushDone 是退出握手回执，渲染层落盘后调用
  handle('session:persist', (snapshot: unknown) => sessionPersist(snapshot))
  handle('session:restore', () => sessionRestore())
  handle('session:flushDone', () => sessionFlushDone())
}
