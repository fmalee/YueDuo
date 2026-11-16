import { ipcMain } from 'electron'
import type { IpcResult } from '../../shared/types'

type Handler = (...args: unknown[]) => unknown | Promise<unknown>

/**
 * 统一注册器：handler 内抛出的任何异常都收敛为 {ok:false,error}，
 * 绝不让裸异常跨 IPC（structured clone 失败会变成不可读的 reject，方案 §七.7）
 */
export function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<IpcResult> => {
    try {
      const data = await fn(...args)
      return { ok: true, data }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

/** IPC 域前缀白名单：preload 侧同款校验，双保险 */
export const IPC_DOMAINS = [
  'file:',
  'library:',
  'session:',
  'meta:',
  'finder:',
  'convert:',
  'dialog:',
  'native:'
] as const
