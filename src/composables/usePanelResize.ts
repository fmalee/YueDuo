import { onBeforeUnmount, ref, watch } from 'vue'
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../shared/types'
import { useSettingsStore } from '@/stores/settings'

/**
 * 左右两栏共用的拖拽调宽（Sidebar 与 RightPanel，方案 §1.9 同款约束 160–640）：
 * - 监听挂 window：指针移出 5px 拖拽条也不会断，卸载时统一清理；
 * - 拖拽结束才落盘，避免每帧写文件；
 * - 设置外部变更（如恢复默认）时同步，拖拽进行中不让步；
 * - direction=1 手柄在面板左缘（右拖变宽），-1 手柄在面板右缘。
 */
export function usePanelResize(direction: 1 | -1) {
  const settings = useSettingsStore()
  const width = ref(settings.sidebarWidth)
  const dragging = ref(false)
  let dragStartX = 0
  let dragStartWidth = 0

  watch(
    () => settings.sidebarWidth,
    (value) => {
      if (!dragging.value) width.value = value
    }
  )

  function onResizeMove(e: PointerEvent): void {
    if (!dragging.value) return
    const delta = direction === 1 ? e.clientX - dragStartX : dragStartX - e.clientX
    const next = Math.round(dragStartWidth + delta)
    width.value = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, next))
  }

  function onResizeEnd(): void {
    if (!dragging.value) return
    dragging.value = false
    window.removeEventListener('pointermove', onResizeMove)
    window.removeEventListener('pointerup', onResizeEnd)
    window.removeEventListener('pointercancel', onResizeEnd)
    void settings.setSidebarWidth(width.value)
  }

  function onResizeStart(e: PointerEvent): void {
    e.preventDefault()
    dragging.value = true
    dragStartX = e.clientX
    dragStartWidth = width.value
    window.addEventListener('pointermove', onResizeMove)
    window.addEventListener('pointerup', onResizeEnd)
    window.addEventListener('pointercancel', onResizeEnd)
  }

  onBeforeUnmount(() => {
    window.removeEventListener('pointermove', onResizeMove)
    window.removeEventListener('pointerup', onResizeEnd)
    window.removeEventListener('pointercancel', onResizeEnd)
  })

  return { width, dragging, onResizeStart }
}
