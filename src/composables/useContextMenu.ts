import { appPopupMenu, onContextMenuAction } from '@/ipc/bridge'
import type { ContextMenuItem } from '../../shared/types'

interface ActiveContextMenuRequest {
  requestId: string
  onSelect: (itemId: string) => void
}

let nextRequestId = 0
let activeRequest: ActiveContextMenuRequest | null = null
let unsubscribe: (() => void) | null = null

function ensureSubscribed(): void {
  if (unsubscribe) return
  unsubscribe = onContextMenuAction((payload) => {
    if (!activeRequest || activeRequest.requestId !== payload.requestId) return
    const { onSelect } = activeRequest
    activeRequest = null
    onSelect(payload.itemId)
  })
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribe?.()
    unsubscribe = null
    activeRequest = null
  })
}

/** 弹出原生右键菜单：屏幕同时仅有一个菜单，新请求直接覆盖旧回调，取消不泄漏 */
export async function popupContextMenu(
  items: ContextMenuItem[],
  onSelect: (itemId: string) => void
): Promise<void> {
  ensureSubscribed()
  const requestId = String(++nextRequestId)
  activeRequest = { requestId, onSelect }
  try {
    await appPopupMenu(requestId, items)
  } catch (e) {
    if (activeRequest?.requestId === requestId) activeRequest = null
    throw e
  }
}
