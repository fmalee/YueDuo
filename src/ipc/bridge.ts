import type { IpcResult, NativeSanity } from '../../shared/types'

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

/** 示例：native 验收通道 */
export function nativeSanity(): Promise<NativeSanity> {
  return ipcInvoke<NativeSanity>('native:sanity')
}
