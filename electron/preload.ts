import { contextBridge, ipcRenderer } from 'electron'
import type { AppMenuPayload, IpcResult, LibraryScanProgress, ThemeChanged } from '../shared/types'

/** preload 与主进程保持一致的域前缀白名单 */
const DOMAINS = [
  'app:',
  'file:',
  'library:',
  'session:',
  'meta:',
  'finder:',
  'convert:',
  'dialog:',
  'native:',
  'settings:'
]

function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  if (!DOMAINS.some((d) => channel.startsWith(d))) {
    return Promise.resolve({ ok: false, error: `IPC 通道前缀不合法: ${channel}` })
  }
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>
}

/** 主题推送订阅：固定通道名（不走 invoke 白名单），返回取消订阅 */
function onThemeUpdated(callback: (payload: ThemeChanged) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: ThemeChanged): void =>
    callback(payload)
  ipcRenderer.on('theme:updated', listener)
  return (): void => {
    ipcRenderer.removeListener('theme:updated', listener)
  }
}

/** 退出/关窗前落盘请求：固定通道名，渲染层保存完再回 session:flushDone */
function onSessionFlush(callback: () => void): () => void {
  const listener = (): void => callback()
  ipcRenderer.on('session:flush', listener)
  return (): void => {
    ipcRenderer.removeListener('session:flush', listener)
  }
}

/** 书库扫描进度：固定通道名，enrich 每 10 个文件推送一次 */
function onLibraryScanProgress(callback: (payload: LibraryScanProgress) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: LibraryScanProgress): void =>
    callback(payload)
  ipcRenderer.on('library:scanProgress', listener)
  return (): void => {
    ipcRenderer.removeListener('library:scanProgress', listener)
  }
}

/** 顶部应用菜单命令：保存/关闭类与标签右键菜单复用同一套渲染层动作 */
function onAppMenuCommand(callback: (payload: AppMenuPayload) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: AppMenuPayload): void =>
    callback(payload)
  ipcRenderer.on('app:menuCommand', listener)
  return (): void => {
    ipcRenderer.removeListener('app:menuCommand', listener)
  }
}

contextBridge.exposeInMainWorld('yue', {
  invoke,
  onThemeUpdated,
  onSessionFlush,
  onLibraryScanProgress,
  onAppMenuCommand
})
