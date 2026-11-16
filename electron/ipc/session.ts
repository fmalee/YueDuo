import { BrowserWindow } from 'electron'
import { getDatabase } from '../services/database'
import { loadSession, persistSession } from '../services/sessionStore'
import type { SessionRestore, SessionSnapshot } from '../../shared/types'

/** 退出握手兜底：渲染层异常/未加载时最多等这么久，不能卡住退出 */
const FLUSH_TIMEOUT_MS = 1500

let resolveFlush: (() => void) | null = null

/** session:persist —— 全量写会话（标签顺序/active/进度/dirty/聚焦时间） */
export function sessionPersist(snapshot: unknown): void {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    !Array.isArray((snapshot as SessionSnapshot).tabs)
  ) {
    throw new Error('会话快照格式无效')
  }
  persistSession(getDatabase(), snapshot as SessionSnapshot)
}

/** session:restore —— 启动时读会话（按 position 排序） */
export function sessionRestore(): SessionRestore {
  return loadSession(getDatabase())
}

/** session:flushDone —— 渲染层已落盘，结束 before-quit 的等待 */
export function sessionFlushDone(): null {
  const done = resolveFlush
  resolveFlush = null
  done?.()
  return null
}

/**
 * before-quit / 关窗握手（方案 §1.8）：
 * 主进程发 session:flush → 渲染层立即 session:persist → 回 session:flushDone → 调用方继续退出
 */
export function requestRendererFlush(): Promise<void> {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.webContents.isDestroyed()) return Promise.resolve()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (): void => {
      if (timer) clearTimeout(timer)
      if (resolveFlush === done) resolveFlush = null
      resolve()
    }
    resolveFlush = done
    timer = setTimeout(done, FLUSH_TIMEOUT_MS)
    win.webContents.send('session:flush')
  })
}
