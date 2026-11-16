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
}
