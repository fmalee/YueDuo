<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useTabsStore } from '@/stores/tabs'
import { useTabs } from '@/composables/useTabs'
import { focusEditor, schedulePersist } from '@/composables/useSession'
import { useSettingsStore } from '@/stores/settings'
import { METRICS } from '@/styles/theme'

const store = useTabsStore()
const settings = useSettingsStore()
const {
  activateTab,
  closeTab,
  saveTab,
  closeOtherTabs,
  closeAllTabs,
  renameTab,
  deleteTabFile,
  revealTabFile
} = useTabs()
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

// —— 标签拖动排序（方案 §3.4）：按下后越过阈值才算拖动，松手按落点插入 ——
/** 与 VS Code 同口径：小幅抖动仍视为点击，不进入拖动 */
const DRAG_THRESHOLD = 4
/** 拖到视口左右边缘该像素内自动横向滚动，便于把标签拖到视口外 */
const DRAG_AUTOSCROLL_ZONE = 24
const DRAG_AUTOSCROLL_STEP = 10
const draggingTab = ref(false)
const dragId = ref<string | null>(null)
/** 插入落点：去掉被拖标签后的下标（0..length），null = 尚未算出 */
const dropIndex = ref<number | null>(null)
/** 落点指示线在滚动内容坐标系中的 left */
const dropLeft = ref(0)
let pendingDragId: string | null = null
let dragStartX = 0
let dragPointerX = 0
/** 拖动结束后的 click 不能再激活标签；宏任务复位，确保 click 先被拦下 */
let suppressClick = false
let autoScrollFrame: number | null = null

function clearAutoScroll(): void {
  if (autoScrollFrame !== null) {
    cancelAnimationFrame(autoScrollFrame)
    autoScrollFrame = null
  }
}

/** 按指针位置算插入下标：只比较其余标签的中点，被拖标签自身不参与 */
function updateDrop(clientX: number): void {
  const container = scrollRef.value
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
  // 插入线画在目标标签左缘；插到末尾则画在最后一个标签右缘
  const edge = index < rects.length ? rects[index].left : rects[rects.length - 1].right
  dropLeft.value = edge - container.getBoundingClientRect().left + container.scrollLeft
}

function stepAutoScroll(): void {
  autoScrollFrame = null
  if (!draggingTab.value) return
  const el = scrollRef.value
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

function onTabPointerDown(e: PointerEvent, tabId: string): void {
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
  store.moveTab(id, target)
  schedulePersist()
  // 标签是普通 div，按下后焦点掉到 body；拖动结束把焦点还给正文
  focusEditor()
}

function onTabClick(id: string): void {
  if (suppressClick) return
  activateTab(id)
}

// —— 标签右键菜单与重命名浮层（方案 §3.5）——
/** 菜单实际高度约 200px；用于贴近窗口底边时向上收，避免被裁掉 */
const MENU_WIDTH = 168
const MENU_HEIGHT = 210
const menu = ref<{ x: number; y: number; tabId: string } | null>(null)
const menuTab = computed(() =>
  menu.value ? (store.tabs.find((t) => t.id === menu.value?.tabId) ?? null) : null
)
const rename = ref<{ tabId: string; value: string; error: string } | null>(null)
const renameInput = ref<HTMLInputElement>()

function openTabMenu(e: MouseEvent, tabId: string): void {
  e.preventDefault()
  // 右键只弹菜单，不切活动标签；菜单动作按 tabId 作用于被右击的那一项
  menu.value = {
    x: Math.max(4, Math.min(e.clientX, window.innerWidth - MENU_WIDTH - 4)),
    y: Math.max(4, Math.min(e.clientY, window.innerHeight - MENU_HEIGHT - 4)),
    tabId
  }
}

function dismissMenu(): void {
  menu.value = null
}

function menuSave(): void {
  const id = menu.value?.tabId
  dismissMenu()
  if (id) void saveTab(id).catch((e) => console.error('[tab] 保存失败:', e))
}

function menuClose(): void {
  const id = menu.value?.tabId
  dismissMenu()
  if (id) void closeTab(id)
}

function menuCloseOthers(): void {
  const id = menu.value?.tabId
  dismissMenu()
  if (id) void closeOtherTabs(id)
}

function menuCloseAll(): void {
  dismissMenu()
  void closeAllTabs()
}

function menuRename(): void {
  const id = menu.value?.tabId
  dismissMenu()
  if (id) beginRename(id)
}

function menuDelete(): void {
  const id = menu.value?.tabId
  dismissMenu()
  if (id) void deleteTabFile(id).catch((e) => console.error('[tab] 删除失败:', e))
}

function menuReveal(): void {
  const id = menu.value?.tabId
  dismissMenu()
  if (id) revealTabFile(id)
}

function beginRename(id: string): void {
  const tab = store.tabs.find((t) => t.id === id)
  if (!tab?.path) return
  const base = tab.path.split('/').pop() ?? ''
  rename.value = { tabId: id, value: base.replace(/\.txt$/i, ''), error: '' }
  void nextTick(() => {
    renameInput.value?.focus()
    renameInput.value?.select()
  })
}

function cancelRename(): void {
  if (!rename.value) return
  rename.value = null
  focusEditor()
}

async function submitRename(): Promise<void> {
  const state = rename.value
  if (!state) return
  state.error = ''
  const error = await renameTab(state.tabId, state.value)
  if (error) {
    state.error = error
    return
  }
  rename.value = null
  focusEditor()
}

function onGlobalPointerDown(e: PointerEvent): void {
  if (!menu.value) return
  if (e.target instanceof Element && e.target.closest('.tab-context-menu')) return
  dismissMenu()
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (menu.value) {
    dismissMenu()
    return
  }
  if (rename.value) cancelRename()
}

function onGlobalBlur(): void {
  dismissMenu()
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
  window.addEventListener('pointerdown', onGlobalPointerDown)
  window.addEventListener('keydown', onGlobalKeydown)
  window.addEventListener('blur', onGlobalBlur)
  if (scrollRef.value) {
    resizeObserver = new ResizeObserver(syncScrollbar)
    resizeObserver.observe(scrollRef.value)
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('pointerdown', onGlobalPointerDown)
  window.removeEventListener('keydown', onGlobalKeydown)
  window.removeEventListener('blur', onGlobalBlur)
  if (hideTimer) clearTimeout(hideTimer)
  clearAutoScroll()
  window.removeEventListener('pointermove', onScrollbarPointerMove)
  window.removeEventListener('pointerup', onScrollbarPointerEnd)
  window.removeEventListener('pointercancel', onScrollbarPointerEnd)
  window.removeEventListener('pointermove', onTabPointerMove)
  window.removeEventListener('pointerup', onTabPointerEnd)
  window.removeEventListener('pointercancel', onTabPointerEnd)
})
</script>

<template>
  <!-- Chrome 风圆弧标签栏：当前标签底边外展圆弧（Python FlaredTabBar 同款，flare=8px 贝塞尔） -->
  <div
    class="tab-bar"
    :class="{
      'close-always': settings.closeButtonAlwaysVisible,
      'scrollbar-dragging': draggingScrollbar,
      'tab-dragging': draggingTab
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
          last: i === store.tabs.length - 1,
          dragging: draggingTab && tab.id === dragId,
          missing: tab.missing === true
        }"
        :title="tab.missing ? '文件缺失，等待书库对账后自动重连' : undefined"
        :data-tab-id="tab.id"
        @click="onTabClick(tab.id)"
        @pointerdown="onTabPointerDown($event, tab.id)"
        @contextmenu="openTabMenu($event, tab.id)"
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
      <!-- 拖动落点指示线：画在滚动内容坐标系里，随标签一起横向滚动 -->
      <div
        v-if="draggingTab && dropIndex !== null"
        class="tab-drop-line"
        :style="{ left: `${dropLeft}px` }"
      ></div>
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

  <!-- 标签右键菜单（方案 §3.5）：保存/关闭类与顶部「文件」菜单共用同一套动作 -->
  <Teleport to="body">
    <div
      v-if="menu"
      class="tab-context-menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @contextmenu.prevent
    >
      <button class="tab-menu-item" @click="menuSave">保存</button>
      <button class="tab-menu-item" @click="menuClose">关闭</button>
      <button class="tab-menu-item" :disabled="store.tabs.length <= 1" @click="menuCloseOthers">
        关闭其他
      </button>
      <button class="tab-menu-item" @click="menuCloseAll">关闭全部</button>
      <div class="tab-menu-sep"></div>
      <button class="tab-menu-item" :disabled="!menuTab?.path" @click="menuRename">重命名…</button>
      <button class="tab-menu-item" :disabled="!menuTab?.path" @click="menuDelete">删除…</button>
      <button class="tab-menu-item" :disabled="!menuTab?.path" @click="menuReveal">
        在 Finder 中显示
      </button>
    </div>
  </Teleport>

  <!-- 重命名浮层：Electron 无原生文本输入框，自绘轻量对话框 -->
  <Teleport to="body">
    <div v-if="rename" class="rename-overlay" @mousedown.self="cancelRename">
      <div class="rename-panel" role="dialog" aria-label="重命名">
        <div class="rename-title">重命名</div>
        <input
          ref="renameInput"
          v-model="rename.value"
          class="rename-input"
          spellcheck="false"
          @keydown.enter.prevent="submitRename"
          @keydown.esc.prevent="cancelRename"
        />
        <div v-if="rename.error" class="rename-error">{{ rename.error }}</div>
        <div class="rename-actions">
          <button class="rename-button" @click="cancelRename">取消</button>
          <button class="rename-button primary" @click="submitRename">确定</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tab-bar {
  position: relative;
  min-height: var(--yd-tab-bar-height);
  border-bottom: 1px solid var(--yd-border-1);
  background: var(--yd-bg-2);
  /* 拖动排序时不要选中标签文字 */
  user-select: none;
}
.tabs-scroll {
  position: relative;
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
.tab-bar.tab-dragging,
.tab-bar.tab-dragging .tab {
  cursor: grabbing;
}
.tab.dragging {
  opacity: 0.55;
}
/* 恢复时文件缺失：标签仍在会话里，等对账重连；置灰提示但不裁切书名 */
.tab.missing .tab-title {
  opacity: 0.55;
}
/* 拖动插入落点：2px 竖线，与强调色一致，不参与布局 */
.tab-drop-line {
  position: absolute;
  top: 4px;
  bottom: 4px;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--yd-accent);
  pointer-events: none;
  z-index: 4;
}
.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: content-box;
  height: 28px;
  padding: 0 var(--yd-tab-padding-x);
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
  /* 不占标签布局宽度：悬停浮出在右缘，允许遮挡过长的标题 */
  position: absolute;
  top: 50%;
  right: var(--yd-tab-close-inset);
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--yd-tab-close-size);
  height: var(--yd-tab-close-size);
  font-size: 14px;
  line-height: 1;
  border-radius: 4px;
  color: var(--yd-text-3);
  /* 关闭按钮常驻由设置决定（方案 §1.9）；非常驻时仅悬停标签显示 */
  opacity: 0;
  pointer-events: none;
}
.tab:hover .tab-close,
.tab-bar.close-always .tab-close {
  opacity: 1;
  pointer-events: auto;
}
.tab-close:hover {
  background: var(--yd-active-1);
  color: var(--yd-text-1);
}

/* 标签右键菜单（方案 §3.5） */
.tab-context-menu {
  position: fixed;
  z-index: 30;
  min-width: var(--yd-tab-menu-min-width);
  padding: var(--yd-tab-menu-padding-y) 0;
  background: var(--yd-bg-1);
  border: 1px solid var(--yd-border-1);
  border-radius: var(--yd-tab-menu-radius);
  box-shadow: 0 6px 20px var(--yd-shadow);
  font-size: var(--yd-tab-menu-font-size);
}
.tab-menu-item {
  display: block;
  width: 100%;
  padding: var(--yd-tab-menu-item-padding-y) var(--yd-tab-menu-item-padding-x);
  color: var(--yd-text-2);
  font: inherit;
  text-align: left;
  background: transparent;
  border: none;
  cursor: default;
}
.tab-menu-item:hover:not(:disabled) {
  background: var(--yd-hover-1);
}
.tab-menu-item:disabled {
  color: var(--yd-text-3);
  opacity: 0.6;
}
.tab-menu-sep {
  height: 1px;
  margin: var(--yd-tab-menu-padding-y) 0;
  background: var(--yd-border-1);
}

/* 重命名浮层（QInputDialog 平替） */
.rename-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: var(--yd-palette-top-offset);
  background: var(--yd-overlay);
}
.rename-panel {
  display: flex;
  flex-direction: column;
  gap: var(--yd-rename-gap);
  box-sizing: border-box;
  width: min(var(--yd-rename-width), calc(100vw - 40px));
  padding: var(--yd-rename-padding);
  background: var(--yd-bg-1);
  border: 1px solid var(--yd-border-1);
  border-radius: var(--yd-palette-radius);
  box-shadow: 0 12px 32px var(--yd-shadow);
}
.rename-title {
  color: var(--yd-text-1);
  font-size: var(--yd-palette-font-size);
}
.rename-input {
  box-sizing: border-box;
  width: 100%;
  height: var(--yd-find-input-height);
  padding: 0 var(--yd-find-input-padding-x);
  color: var(--yd-text-1);
  font-family: inherit;
  font-size: var(--yd-palette-font-size);
  background: var(--yd-bg-3);
  border: 1px solid var(--yd-border-1);
  border-radius: var(--yd-find-input-radius);
  outline: none;
}
.rename-input:focus {
  border-color: var(--yd-accent);
}
.rename-error {
  color: var(--yd-danger);
  font-size: var(--yd-palette-meta-font-size);
}
.rename-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--yd-rename-gap);
}
.rename-button {
  padding: var(--yd-rename-button-padding-y) var(--yd-rename-button-padding-x);
  color: var(--yd-text-2);
  font-family: inherit;
  font-size: var(--yd-tab-menu-font-size);
  background: transparent;
  border: 1px solid var(--yd-border-1);
  border-radius: var(--yd-palette-key-radius);
  cursor: pointer;
}
.rename-button:hover {
  background: var(--yd-hover-1);
}
.rename-button.primary {
  color: var(--yd-bg-1);
  background: var(--yd-accent);
  border-color: var(--yd-accent);
}
</style>
