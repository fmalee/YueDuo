import { ipcMain } from 'electron'
import Database from 'better-sqlite3'
import type { IpcResult } from '../../shared/types'

type Handler = (...args: unknown[]) => unknown | Promise<unknown>

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

/**
 * 统一注册器：handler 内抛出的任何异常都收敛为 {ok:false,error}，
 * 绝不让裸异常跨 IPC（structured clone 失败会变成不可读的 reject，方案 §七.7）
 */
function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (...args: unknown[]): Promise<IpcResult> => {
    try {
      const data = await fn(...args)
      return { ok: true, data }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

/** native:sanity —— 阶段 0 验收：主进程 bundle 里 external 的 better-sqlite3 真实可用 */
handle('native:sanity', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE t (a INTEGER)')
  db.prepare('INSERT INTO t VALUES (?)').run(42)
  const ok = db.prepare('SELECT a FROM t').get() as { a: number }
  db.close()
  if (ok.a !== 42) throw new Error('better-sqlite3 sanity 查询结果异常')
  return {
    betterSqlite3: '13.2.0 加载执行正常',
    electron: process.versions.electron,
    nodeAbi: process.versions.modules
  }
})

export function registerIpcHandlers(): void {
  // 各域 handler 在各自模块内调用 handle() 注册；本函数保证模块被加载。
  // 随阶段推进拆分为 electron/ipc/{file,library,...}.ts 并在此汇聚。
}
