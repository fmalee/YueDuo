import type { FileReadResult, FileStat, IpcResult, NativeSanity } from '../../shared/types'

declare global {
  interface Window {
    yue: {
      invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<IpcResult<T>>
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
