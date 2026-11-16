import { handle } from './registry'
import { nativeSanity } from './native'
import { fileReadText, fileStat } from './file'

/** 各域 handler 汇聚注册（新增域在此追加） */
export function registerIpcHandlers(): void {
  handle('native:sanity', () => nativeSanity())
  handle('file:readText', (path: unknown) => fileReadText(String(path)))
  handle('file:stat', (path: unknown) => fileStat(String(path)))
}
