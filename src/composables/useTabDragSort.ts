import { onBeforeUnmount, ref, type Ref } from 'vue'

/** 与 VS Code 同口径：小幅抖动仍视为点击，不进入拖动 */
const DRAG_THRESHOLD = 4
/** 拖到视口左右边缘该像素内自动横向滚动，便于把标签拖到视口外 */
const DRAG_AUTOSCROLL_ZONE = 24
const DRAG_AUTOSCROLL_STEP = 10

export interface UseTabDragSortOptions {
  scrollRef: Ref<HTMLDivElement | undefined>
  onMove: (tabId: string, toIndex: number) => void
  onMiddleClose: (tabId: string) => void
  onActivate: (tabId: string) => void
}

/**
 * 标签横向拖动排序（方案 §3.4）：
 * 按下越过阈值进入拖动、边缘自动横向滚动、松手按落点插入，并拦截拖动后的尾随 click。
 */
export function useTabDragSort(options: UseTabDragSortOptions) {
  const draggingTab = ref(false)
  const dragId = ref<string | null>(null)
  const dropIndex = ref<number | null>(null)
  const dropLeft = ref(0)

  let pendingDragId: string | null = null
  let dragStartX = 0
  let dragPointerX = 0
  let suppressClick = false
  let autoScrollFrame: number | null = null

  function clearAutoScroll(): void {
    if (autoScrollFrame !== null) {
      cancelAnimationFrame(autoScrollFrame)
      autoScrollFrame = null
    }
  }

  function updateDrop(clientX: number): void {
    const container = options.scrollRef.value
    if (!container || !dragId.value) return
    const rects: DOMRect[] = []
    for (const el of container.querySelectorAll<HTMLElement>('.tab')) {
      if (el.dataset.tabId === dragId.value) continue
      rects.push(el.getBoundingClientRect())
    }
    let index = rects.length
    for (let i = 0; i < rects.length; i++) {
      if (clientX < rects[i].left + rects[i].width / 2) {
        index = i
        break
      }
    }
    dropIndex.value = index
    if (rects.length === 0) {
      dropLeft.value = 0
      return
    }
    const edge = index < rects.length ? rects[index].left : rects[rects.length - 1].right
    dropLeft.value = edge - container.getBoundingClientRect().left + container.scrollLeft
  }

  function stepAutoScroll(): void {
    autoScrollFrame = null
    if (!draggingTab.value) return
    const el = options.scrollRef.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    let delta = 0
    if (dragPointerX < rect.left + DRAG_AUTOSCROLL_ZONE) delta = -DRAG_AUTOSCROLL_STEP
    else if (dragPointerX > rect.right - DRAG_AUTOSCROLL_ZONE) delta = DRAG_AUTOSCROLL_STEP
    if (delta === 0) return
    const max = el.scrollWidth - el.clientWidth
    const next = Math.max(0, Math.min(max, el.scrollLeft + delta))
    if (next === el.scrollLeft) return
    el.scrollLeft = next
    updateDrop(dragPointerX)
    autoScrollFrame = requestAnimationFrame(stepAutoScroll)
  }

  function startAutoScroll(): void {
    if (autoScrollFrame === null) autoScrollFrame = requestAnimationFrame(stepAutoScroll)
  }

  function onTabPointerMove(e: PointerEvent): void {
    dragPointerX = e.clientX
    if (!draggingTab.value) {
      if (!pendingDragId || Math.abs(e.clientX - dragStartX) < DRAG_THRESHOLD) return
      draggingTab.value = true
      dragId.value = pendingDragId
      updateDrop(e.clientX)
      startAutoScroll()
      return
    }
    updateDrop(e.clientX)
    startAutoScroll()
  }

  function onTabPointerEnd(): void {
    const moved = draggingTab.value
    const id = dragId.value
    const target = dropIndex.value
    window.removeEventListener('pointermove', onTabPointerMove)
    window.removeEventListener('pointerup', onTabPointerEnd)
    window.removeEventListener('pointercancel', onTabPointerEnd)
    clearAutoScroll()
    pendingDragId = null
    draggingTab.value = false
    dragId.value = null
    dropIndex.value = null
    if (!moved || !id || target === null) return
    suppressClick = true
    setTimeout(() => {
      suppressClick = false
    }, 0)
    options.onMove(id, target)
  }

  function onTabPointerDown(e: PointerEvent, tabId: string): void {
    // 中键直接关闭（浏览器习惯）：任何标签免激活即关
    if (e.button === 1) {
      e.preventDefault()
      options.onMiddleClose(tabId)
      return
    }
    if (e.button !== 0) return
    // 关闭按钮优先响应点击，不参与拖动
    if (e.target instanceof Element && e.target.closest('.tab-close')) return
    pendingDragId = tabId
    dragStartX = e.clientX
    dragPointerX = e.clientX
    window.addEventListener('pointermove', onTabPointerMove)
    window.addEventListener('pointerup', onTabPointerEnd)
    window.addEventListener('pointercancel', onTabPointerEnd)
  }

  function onTabClick(tabId: string): void {
    if (suppressClick) return
    options.onActivate(tabId)
  }

  onBeforeUnmount(() => {
    clearAutoScroll()
    window.removeEventListener('pointermove', onTabPointerMove)
    window.removeEventListener('pointerup', onTabPointerEnd)
    window.removeEventListener('pointercancel', onTabPointerEnd)
  })

  return {
    draggingTab,
    dragId,
    dropIndex,
    dropLeft,
    onTabPointerDown,
    onTabClick
  }
}
