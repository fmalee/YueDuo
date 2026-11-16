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
import { settingsGet, settingsSet } from './settings'
import { sessionPersist, sessionRestore, sessionFlushDone } from './session'
import type { AppSettings } from '../../shared/types'

/** 各域 handler 汇聚注册（新增域在此追加） */
export function registerIpcHandlers(): void {
  handle('native:sanity', () => nativeSanity())
  handle('file:readText', (path: unknown) => fileReadText(String(path)))
  handle('file:stat', (path: unknown) => fileStat(String(path)))
  handle('file:writeText', (path: unknown, text: unknown) =>
    fileWriteText(String(path), String(text))
  )
  handle('file:writeDraft', (tabId: unknown, text: unknown, viewState: unknown) =>
    fileWriteDraft(String(tabId), text === null ? null : String(text), viewState ?? null)
  )
  handle('file:readDraft', (tabId: unknown) => fileReadDraft(String(tabId)))
  handle('file:clearDraft', (tabId: unknown) => fileClearDraft(String(tabId)))
  handle('dialog:confirmClose', (title: unknown) => confirmClose(String(title)))
  handle('dialog:saveFile', (name: unknown) => chooseSaveFile(String(name)))
  handle('dialog:chooseLibrary', () => chooseLibrary())
  handle('settings:get', () => settingsGet())
  handle('settings:set', (settings: unknown) => settingsSet(settings as AppSettings))
  // 会话持久化（方案 §1.8）：persist/restore 读写 session_tabs/session_state；
  // flushDone 是退出握手回执，渲染层落盘后调用
  handle('session:persist', (snapshot: unknown) => sessionPersist(snapshot))
  handle('session:restore', () => sessionRestore())
  handle('session:flushDone', () => sessionFlushDone())
}
