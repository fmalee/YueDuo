import type { Database } from 'better-sqlite3'
import type { DraftEntry, DraftTabMeta } from '../../shared/types'
import { nextPosition } from './sessionStore'

/**
 * 标签草稿存储 —— LRU 卸载的 dirty 全文与 viewState 落点（方案 §1.7 / §1.8）
 * 1.8 起从内存 Map 迁到 SQLite session_tabs.draft/view_state（IPC 契约不变）
 * 只写 draft/view_state 两列，其余列归 session:persist，互不覆盖
 *
 * 全文只经 IPC 进出本存储，绝不进渲染进程 Vue 响应式（方案 §二根因教训 2）
 */
interface DraftRow {
  draft: Buffer | string | null
  view_state: string | null
}

/** file:writeDraft —— 卸载时写入（text=null 表示非 dirty 卸载，只存进度） */
export function writeDraft(
  db: Database,
  tabId: string,
  text: string | null,
  viewState: unknown,
  meta?: DraftTabMeta | null
): void {
  const blob = text == null ? null : Buffer.from(text, 'utf8')
  const view = viewState == null ? null : JSON.stringify(viewState)
  const exists = db.prepare('SELECT 1 FROM session_tabs WHERE id = ?').get(tabId)
  if (!exists) {
    // persist 尚未来得及落盘就被卸载：用调用方给的元信息建行，
    // 不再依赖恢复时按空 title 过滤（那样标签会整个消失）
    db.prepare(
      `INSERT INTO session_tabs
         (id, position, path, title, progress_line, dirty, draft, view_state, last_focused_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tabId,
      nextPosition(db),
      meta?.path ?? '',
      meta?.title ?? '未命名',
      meta?.progressLine ?? 0,
      text == null ? 0 : 1,
      blob,
      view,
      meta?.lastFocusedAt ?? Date.now()
    )
    return
  }
  db.prepare('UPDATE session_tabs SET draft = ?, view_state = ? WHERE id = ?').run(
    blob,
    view,
    tabId
  )
}

/** file:readDraft —— 重载时读取；null = 该标签无草稿（从未被卸载） */
export function readDraft(db: Database, tabId: string): DraftEntry | null {
  const row = db.prepare('SELECT draft, view_state FROM session_tabs WHERE id = ?').get(tabId) as
    DraftRow | undefined
  if (!row || (row.draft == null && row.view_state == null)) return null

  const text =
    row.draft == null
      ? null
      : Buffer.isBuffer(row.draft)
        ? row.draft.toString('utf8')
        : String(row.draft)
  let viewState: unknown = null
  if (row.view_state != null) {
    try {
      viewState = JSON.parse(row.view_state)
    } catch {
      viewState = null // 视图状态损坏只影响滚动位置，不牵连正文
    }
  }
  return { text, viewState }
}

/** file:clearDraft —— 保存/关闭后清理，防泄漏（方案 §1.4：保存后清 draft） */
export function clearDraft(db: Database, tabId: string): void {
  db.prepare('UPDATE session_tabs SET draft = NULL, view_state = NULL WHERE id = ?').run(tabId)
}
