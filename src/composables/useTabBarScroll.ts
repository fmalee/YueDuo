import { nextTick, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { METRICS } from '@/styles/theme'

/** 当前标签外展圆弧 8px：滚动时留同宽余量，避免弧脚被滚动容器裁掉 */
const SCROLL_PADDING = 8

/**
 * 标签栏自绘置顶 3px 横向滚动条 + 活动标签自动可见（方案 §1.5）：
 * 不滚动时自动淡出，悬停/滚动/拖拽滑块时显示。
 */
export function useTabBarScroll(scrollRef: Ref<HTMLDivElement | undefined>) {
  const overflowing = ref(false)
  const scrollbarVisible = ref(false)
  const hovering = ref(false)
  const thumbWidth = ref(0)
  const thumbLeft = ref(0)
  const draggingScrollbar = ref(false)

  let scrollbarTrackWidth = 0
  let scrollbarStartX = 0
  let scrollbarStartLeft = 0
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let resizeObserver: ResizeObserver | undefined

  function scheduleScrollbarHide(): void {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      hideTimer = undefined
      if (!hovering.value && !draggingScrollbar.value) scrollbarVisible.value = false
    }, 900)
  }

  function revealScrollbar(): void {
    scrollbarVisible.value = true
    scheduleScrollbarHide()
  }

  function onBarEnter(): void {
    hovering.value = true
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = undefined
    }
  }

  function onBarLeave(): void {
    hovering.value = false
    scheduleScrollbarHide()
  }

  /** 将当前活动标签按最小幅度滚入视口 */
  function ensureActiveVisible(): void {
    const container = scrollRef.value
    if (!container) return
    const active = container.querySelector<HTMLElement>('.tab.active')
    if (!active) return
    const viewRect = container.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()
    const leftOverflow = activeRect.left - viewRect.left
    const rightOverflow = activeRect.right - viewRect.right
    if (leftOverflow < SCROLL_PADDING) {
      container.scrollLeft += leftOverflow - SCROLL_PADDING
    } else if (
      rightOverflow > -SCROLL_PADDING &&
      activeRect.width <= viewRect.width - SCROLL_PADDING * 2
    ) {
      container.scrollLeft += rightOverflow + SCROLL_PADDING
    }
  }

  /** 同步置顶滚动条：宽度按可视比例，位置按 scrollLeft 比例 */
  function syncScrollbar(): void {
    const el = scrollRef.value
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    overflowing.value = max > 1
    if (max <= 1) {
      thumbWidth.value = 0
      thumbLeft.value = 0
      return
    }
    const width = Math.min(
      el.clientWidth,
      Math.max(
        METRICS.tabScrollbarMinThumbWidth,
        Math.round((el.clientWidth / el.scrollWidth) * el.clientWidth)
      )
    )
    thumbWidth.value = width
    thumbLeft.value = Math.round((el.scrollLeft / max) * (el.clientWidth - width))
  }

  function onScrollbarPointerMove(e: PointerEvent): void {
    const el = scrollRef.value
    if (!el || !draggingScrollbar.value) return
    const maxThumbLeft = scrollbarTrackWidth - thumbWidth.value
    if (maxThumbLeft <= 0) return
    const maxScroll = el.scrollWidth - el.clientWidth
    const next = scrollbarStartLeft + ((e.clientX - scrollbarStartX) / maxThumbLeft) * maxScroll
    el.scrollLeft = Math.max(0, Math.min(maxScroll, next))
  }

  function onScrollbarPointerEnd(): void {
    draggingScrollbar.value = false
    window.removeEventListener('pointermove', onScrollbarPointerMove)
    window.removeEventListener('pointerup', onScrollbarPointerEnd)
    window.removeEventListener('pointercancel', onScrollbarPointerEnd)
    syncScrollbar()
    scheduleScrollbarHide()
  }

  function onScrollbarPointerDown(e: PointerEvent): void {
    const el = scrollRef.value
    if (!el || e.button !== 0 || el.scrollWidth <= el.clientWidth) return
    const track = e.currentTarget as HTMLElement
    scrollbarTrackWidth = track.clientWidth
    const maxThumbLeft = scrollbarTrackWidth - thumbWidth.value
    if (maxThumbLeft <= 0) return
    e.preventDefault()
    const onThumb =
      e.target instanceof HTMLElement && e.target.classList.contains('tab-scrollbar-thumb')
    if (!onThumb) {
      const left = Math.min(
        maxThumbLeft,
        Math.max(0, e.clientX - track.getBoundingClientRect().left - thumbWidth.value / 2)
      )
      el.scrollLeft = (left / maxThumbLeft) * (el.scrollWidth - el.clientWidth)
      thumbLeft.value = left
    }
    draggingScrollbar.value = true
    scrollbarStartX = e.clientX
    scrollbarStartLeft = el.scrollLeft
    window.addEventListener('pointermove', onScrollbarPointerMove)
    window.addEventListener('pointerup', onScrollbarPointerEnd)
    window.addEventListener('pointercancel', onScrollbarPointerEnd)
  }

  function onTabsScroll(): void {
    syncScrollbar()
    revealScrollbar()
  }

  onMounted(() => {
    ensureActiveVisible()
    void nextTick(syncScrollbar)
    if (scrollRef.value) {
      resizeObserver = new ResizeObserver(syncScrollbar)
      resizeObserver.observe(scrollRef.value)
    }
  })

  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    if (hideTimer) clearTimeout(hideTimer)
    window.removeEventListener('pointermove', onScrollbarPointerMove)
    window.removeEventListener('pointerup', onScrollbarPointerEnd)
    window.removeEventListener('pointercancel', onScrollbarPointerEnd)
  })

  return {
    overflowing,
    scrollbarVisible,
    hovering,
    thumbWidth,
    thumbLeft,
    draggingScrollbar,
    onBarEnter,
    onBarLeave,
    onTabsScroll,
    onScrollbarPointerDown,
    ensureActiveVisible,
    syncScrollbar
  }
}
