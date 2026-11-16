import type { DraftEntry } from '../../shared/types'

/**
 * 标签草稿存储 —— LRU 卸载的 dirty 全文与 viewState 落点（方案 §1.7）
 * 阶段 1.7 为内存级实现；1.8 会话持久化时迁 SQLite session_tabs.draft/view_state
 * （IPC 契约不变，渲染层无感切换）
 *
 * 全文只经 IPC 进出本存储，绝不进渲染进程 Vue 响应式（方案 §二根因教训 2）
 */
const drafts = new Map<string, DraftEntry>()

/** file:writeDraft —— 卸载时写入（text=null 表示非 dirty 卸载，只存进度） */
export function writeDraft(tabId: string, text: string | null, viewState: unknown): void {
  drafts.set(tabId, { text, viewState })
}

/** file:readDraft —— 重载时读取；null = 该标签无草稿（从未被卸载） */
export function readDraft(tabId: string): DraftEntry | null {
  return drafts.get(tabId) ?? null
}

/** file:clearDraft —— 保存/关闭后清理，防泄漏（方案 §1.4：保存后清 draft） */
export function clearDraft(tabId: string): void {
  drafts.delete(tabId)
}
