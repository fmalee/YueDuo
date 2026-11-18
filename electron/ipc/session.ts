import { BrowserWindow } from 'electron'
import { getDatabase } from '../services/database'
import { loadSession, persistSession, relocateSessionTabs } from '../services/sessionStore'
import type { SessionRelocation, SessionRestore, SessionSnapshot } from '../../shared/types'
import { activeLibraryRoot } from './library'

/**
 * 退出握手兜底：渲染层异常/未加载时最多等这么久，不能卡住退出。
 * 快照在草稿之前写（毫秒级），所以即便超时也只损失未写完的草稿；
 * 3 秒是给「多本大文件脏标签并行写草稿」留的窗口（实测 11 本约 147MB 可在此内完成）。
 */
const FLUSH_TIMEOUT_MS = 3000

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
  persistSession(getDatabase(), snapshot as SessionSnapshot, activeLibraryRoot())
}

/** session:restore —— 启动时读会话（按 position 排序）；库内相对路径按当前书库根还原 */
export function sessionRestore(): SessionRestore {
  return loadSession(getDatabase(), activeLibraryRoot())
}

/**
 * session:relocate —— 对账扫完后渲染层带着缺失标签来重试：
 * 主进程按 book_id → books.relative_path 拼当前书库根，行不存在再退回会话里的相对路径。
 * 返回重新找到文件的标签，渲染层据此更新绝对路径并重新加载。
 */
export function sessionRelocate(tabIds: unknown): SessionRelocation[] {
  const ids = Array.isArray(tabIds)
    ? tabIds.filter((id): id is string => typeof id === 'string' && id !== '')
    : []
  return relocateSessionTabs(getDatabase(), activeLibraryRoot(), ids)
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
