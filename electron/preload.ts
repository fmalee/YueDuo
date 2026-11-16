import { contextBridge, ipcRenderer } from 'electron'
import type { IpcResult } from '../shared/types'

/** preload 与主进程保持一致的域前缀白名单 */
const DOMAINS = [
  'file:',
  'library:',
  'session:',
  'meta:',
  'finder:',
  'convert:',
  'dialog:',
  'native:'
]

function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  if (!DOMAINS.some((d) => channel.startsWith(d))) {
    return Promise.resolve({ ok: false, error: `IPC 通道前缀不合法: ${channel}` })
  }
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>
}

contextBridge.exposeInMainWorld('yue', { invoke })
