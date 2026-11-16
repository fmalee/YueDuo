import { contextBridge, ipcRenderer } from 'electron'
import type { IpcResult, ThemeChanged } from '../shared/types'

/** preload 与主进程保持一致的域前缀白名单 */
const DOMAINS = [
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

contextBridge.exposeInMainWorld('yue', { invoke, onThemeUpdated })
