import type { Database } from 'better-sqlite3'
import type { SessionRestore, SessionSnapshot } from '../../shared/types'

/**
 * 会话持久化（方案 §1.8）：session_tabs 按 position 还原标签顺序，session_state 存 active
 * draft/view_state 两列归 file:writeDraft 维护，persist 只更新其余字段，绝不覆盖草稿
 * 纯 Node 实现（AGENTS.md：services 不 import Electron），连接由调用方注入
 */
interface SessionStateRow {
  active_tab_id: string | null
}

interface SessionTabRow {
  id: string
  position: number
  path: string
  title: string
  progress_line: number
  dirty: number
  has_draft: number
  last_focused_at: number
}

interface NextPositionRow {
  next: number
}

/** 占位行的默认位置用：表格已空时从 0 开始 */
export function nextPosition(db: Database): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM session_tabs')
    .get() as NextPositionRow | undefined
  return row?.next ?? 0
}

/**
 * 全量落盘（单事务）：
 * - 快照内标签按数组顺序写 position（INSERT 或 UPDATE，draft/view_state 不在更新列表里）
 * - 快照外的行删除（关掉的标签不残留；其草稿随行一起消失）
 * - session_state 恒一行，保存 active
 */
export function persistSession(db: Database, snapshot: SessionSnapshot): void {
  const upsertTab = db.prepare(`
    INSERT INTO session_tabs
      (id, position, path, title, progress_line, dirty, last_focused_at)
    VALUES
      (@id, @position, @path, @title, @progressLine, @dirty, @lastFocusedAt)
    ON CONFLICT(id) DO UPDATE SET
      position = excluded.position,
      path = excluded.path,
      title = excluded.title,
      progress_line = excluded.progress_line,
      dirty = excluded.dirty,
      last_focused_at = excluded.last_focused_at
  `)
  const setState = db.prepare(`
    INSERT INTO session_state (id, active_tab_id) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET active_tab_id = excluded.active_tab_id
  `)
  const ids = snapshot.tabs.map((t) => t.id)
  const deleteOthers =
    ids.length > 0
      ? db.prepare(`DELETE FROM session_tabs WHERE id NOT IN (${ids.map(() => '?').join(',')})`)
      : db.prepare('DELETE FROM session_tabs')

  db.transaction(() => {
    snapshot.tabs.forEach((tab, position) => {
      upsertTab.run({
        id: tab.id,
        position,
        path: tab.path,
        title: tab.title,
        progressLine: tab.progressLine,
        dirty: tab.dirty ? 1 : 0,
        lastFocusedAt: tab.lastFocusedAt
      })
    })
    deleteOthers.run(...ids)
    setState.run(snapshot.activeTabId)
  })()
}

/**
 * 读取会话：按 position 升序。
 * title 为空的是 file:writeDraft 在 persist 之前建的占位行（标签还没来得及落盘），
 * 不参与恢复；真正的空白标签 title 恒为「未命名」，不会被误过滤。
 */
export function loadSession(db: Database): SessionRestore {
  const rows = db
    .prepare(
      `SELECT id, position, path, title, progress_line, dirty, last_focused_at,
              (draft IS NOT NULL OR view_state IS NOT NULL) AS has_draft
         FROM session_tabs
        WHERE title <> ''
        ORDER BY position`
    )
    .all() as SessionTabRow[]
  const state = db.prepare('SELECT active_tab_id FROM session_state WHERE id = 1').get() as
    SessionStateRow | undefined

  const tabs = rows.map((row) => ({
    id: row.id,
    position: row.position,
    path: row.path,
    title: row.title,
    progressLine: row.progress_line,
    // 无草稿的 dirty 行只可能来自异常退出，恢复后按干净处理（文件内容与内存不一致）
    dirty: row.dirty === 1 && row.has_draft === 1,
    lastFocusedAt: row.last_focused_at,
    hasDraft: row.has_draft === 1
  }))
  const storedActive = state?.active_tab_id ?? null
  const activeTabId =
    storedActive && tabs.some((t) => t.id === storedActive) ? storedActive : (tabs[0]?.id ?? null)
  return { activeTabId, tabs }
}
