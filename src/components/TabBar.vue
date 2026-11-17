<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useTabsStore } from '@/stores/tabs'
import { useTabs } from '@/composables/useTabs'
import { useSettingsStore } from '@/stores/settings'
import { METRICS } from '@/styles/theme'

const store = useTabsStore()
const settings = useSettingsStore()
const { activateTab, closeTab } = useTabs()
const scrollRef = ref<HTMLDivElement>()
/** 当前标签外展圆弧 8px：滚动时留同宽余量，避免弧脚被滚动容器裁掉 */
const SCROLL_PADDING = 8

// 原生横向滚动条在底部且过粗，会压住标签标题；改为置顶 3px 自绘条。
// 不滚动时自动隐藏：滚动/拖拽/悬停才显示，淡出不影响标签栏高度与标签位置。
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

/** 滚动/拖拽结束后延时淡出；悬停或仍处于拖拽时不隐藏 */
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

/**
 * 标签栏自动横向滚动到当前标签（方案 §1.5：溢出横向滚动）。
 * 左栏「编辑」页可点到标签栏视口外的条目，此时只换 active 而不滚动，
 * 看起来就像标签栏没跟着切；这里按可见区间做最小幅度滚动。
 */
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
    // 标签比视口还宽时优先露出标题开头，不再为右缘余量把开头滚出去
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
    // 点轨道：先把滑块中心对齐指针，再进入拖动
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

function onScrollbarPointerMove(e: PointerEvent): void {
  const el = scrollRef.value
  if (!el || !draggingScrollbar.value) return
  const maxThumbLeft = scrollbarTrackWidth - thumbWidth.value
  if (maxThumbLeft <= 0) return
  const maxScroll = el.scrollWidth - el.clientWidth
  const next = scrollbarStartLeft + ((e.clientX - scrollbarStartX) / maxThumbLeft) * maxScroll
  el.scrollLeft = Math.max(0, Math.min(maxScroll, next))
}

/** 滚动时同步滑块并短暂显示滚动条，停手后淡出 */
function onTabsScroll(): void {
  syncScrollbar()
  revealScrollbar()
}

function onScrollbarPointerEnd(): void {
  draggingScrollbar.value = false
  window.removeEventListener('pointermove', onScrollbarPointerMove)
  window.removeEventListener('pointerup', onScrollbarPointerEnd)
  window.removeEventListener('pointercancel', onScrollbarPointerEnd)
  syncScrollbar()
  scheduleScrollbarHide()
}

watch([() => store.activeTabId, () => store.tabs.length], () => {
  void nextTick(() => {
    ensureActiveVisible()
    syncScrollbar()
  })
})

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
</script>

<template>
  <!-- Chrome 风圆弧标签栏：当前标签底边外展圆弧（Python FlaredTabBar 同款，flare=8px 贝塞尔） -->
  <div
    class="tab-bar"
    :class="{
      'close-always': settings.closeButtonAlwaysVisible,
      'scrollbar-dragging': draggingScrollbar
    }"
    @pointerenter="onBarEnter"
    @pointerleave="onBarLeave"
  >
    <div ref="scrollRef" class="tabs-scroll" @scroll="onTabsScroll">
      <div
        v-for="(tab, i) in store.tabs"
        :key="tab.id"
        class="tab"
        :class="{
          active: tab.id === store.activeTabId,
          first: i === 0,
          last: i === store.tabs.length - 1
        }"
        @click="activateTab(tab.id)"
      >
        <!-- 左外展圆弧（8×8 月牙填充 + 1px 弧描边） -->
        <svg
          v-if="tab.id === store.activeTabId"
          class="flare left"
          width="8"
          height="8"
          viewBox="0 0 8 8"
        >
          <path class="flare-fill" d="M8,0 L8,8 L0,8 C4.42,8 8,4.42 8,0 Z" />
          <path class="flare-stroke" d="M8,0 C8,4.42 4.42,8 0,8" fill="none" />
        </svg>
        <span v-if="tab.dirty" class="tab-dirty" title="未保存"></span>
        <span class="tab-title">{{ tab.title }}</span>
        <span class="tab-close" @click.stop="closeTab(tab.id)">×</span>
        <!-- 右外展圆弧 -->
        <svg
          v-if="tab.id === store.activeTabId"
          class="flare right"
          width="8"
          height="8"
          viewBox="0 0 8 8"
        >
          <path class="flare-fill" d="M0,0 L0,8 L8,8 C3.58,8 0,4.42 0,0 Z" />
          <path class="flare-stroke" d="M0,0 C0,4.42 3.58,8 8,8" fill="none" />
        </svg>
      </div>
    </div>
    <!-- 置顶细滚动条：占标签上方 3px 留白，不遮标题；不滚动时淡出 -->
    <div
      v-show="overflowing"
      class="tab-scrollbar"
      :class="{
        dragging: draggingScrollbar,
        visible: hovering || draggingScrollbar || scrollbarVisible
      }"
      @pointerdown="onScrollbarPointerDown"
    >
      <div
        class="tab-scrollbar-thumb"
        :style="{ width: `${thumbWidth}px`, left: `${thumbLeft}px` }"
      ></div>
    </div>
  </div>
</template>

<style scoped>
.tab-bar {
  position: relative;
  min-height: 34px;
  border-bottom: 1px solid var(--yd-border-1);
  background: var(--yd-bg-2);
}
.tabs-scroll {
  display: flex;
  align-items: flex-end;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.tabs-scroll::-webkit-scrollbar {
  display: none;
}
.tab-scrollbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--yd-tab-scrollbar-height);
  z-index: 3;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 160ms ease;
}
.tab-scrollbar.visible {
  opacity: 1;
  pointer-events: auto;
}
.tab-scrollbar-thumb {
  position: absolute;
  top: 0;
  height: 100%;
  min-width: var(--yd-tab-scrollbar-min-thumb-width);
  border-radius: calc(var(--yd-tab-scrollbar-height) / 2);
  background: var(--yd-text-3);
}
.tab-scrollbar-thumb:hover,
.tab-scrollbar.dragging .tab-scrollbar-thumb {
  background: var(--yd-text-2);
}
.tab-bar.scrollbar-dragging,
.tab-bar.scrollbar-dragging .tab-scrollbar-thumb {
  cursor: grabbing;
}
.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: content-box;
  height: 28px;
  padding: 0 10px;
  margin-top: 3px;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  color: var(--yd-text-3);
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
}
.tab.first {
  margin-left: 8px; /* 首标签留圆弧落点（Python 同款） */
}
.tab.last {
  margin-right: 8px;
}
.tab:hover:not(.active) {
  background: var(--yd-hover-1);
  color: var(--yd-text-2);
}
.tab.active {
  background: var(--yd-bg-3);
  border-color: var(--yd-border-1);
  color: var(--yd-text-2);
  /* 盖过标签栏底边 1px，弧脚与其连成一体 */
  height: 30px;
  margin-bottom: -1px;
  z-index: 1;
}
.flare {
  position: absolute;
  bottom: 0;
  pointer-events: none;
}
.flare.left {
  left: -8px;
}
.flare.right {
  right: -8px;
}
.flare-fill {
  fill: var(--yd-bg-3);
}
.flare-stroke {
  stroke: var(--yd-border-1);
  stroke-width: 1;
}
.tab-dirty {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--yd-text-1);
}
.tab-title {
  /* 完整小说名称不裁切：无 max-width/省略号，标签随内容自适应，溢出滚动 */
  overflow: visible;
}
.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 18px;
  font-size: 14px;
  line-height: 1;
  border-radius: 4px;
  color: var(--yd-text-3);
  /* 关闭按钮常驻由设置决定（方案 §1.9）；非常驻时仅 hover / 当前标签显示 */
  opacity: 0;
}
.tab:hover .tab-close,
.tab.active .tab-close,
.tab-bar.close-always .tab-close {
  opacity: 1;
}
.tab-close:hover {
  background: var(--yd-active-1);
  color: var(--yd-text-1);
}
</style>
