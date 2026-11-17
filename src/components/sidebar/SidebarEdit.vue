<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useTabsStore } from '@/stores/tabs'
import { useTabs } from '@/composables/useTabs'
import { focusEditor, schedulePersist } from '@/composables/useSession'

/**
 * 左栏「编辑」页（方案 §1.11，VS Code 资源管理器逻辑）：
 * 顺序与标签页一致，点击切换，dirty 圆点 + 完整名称，右键关闭 / 关闭其他；
 * 条目可纵向拖动排序，与标签栏共用 moveTab，拖动过程不激活标签。
 */
const store = useTabsStore()
const { activateTab, closeTab } = useTabs()

const scrollRef = ref<HTMLDivElement>()

interface MenuState {
  x: number
  y: number
  tabId: string
}

const menu = ref<MenuState | null>(null)

// 菜单尺寸用于贴边收敛，避免超出窗口
const MENU_WIDTH = 140
const MENU_HEIGHT = 72

function openMenu(e: MouseEvent, tabId: string): void {
  e.preventDefault()
  // 右键只弹菜单，不切活动标签；菜单动作按 tabId 作用于被右击的那一项
  menu.value = {
    x: Math.min(e.clientX, window.innerWidth - MENU_WIDTH),
    y: Math.min(e.clientY, window.innerHeight - MENU_HEIGHT),
    tabId
  }
}

function dismiss(): void {
  menu.value = null
}

// —— 纵向拖动排序（与标签栏同口径：越过阈值才算拖动，落点去掉被拖项后再插入） ——
const DRAG_THRESHOLD = 4
const draggingId = ref<string | null>(null)
/** 插入落点：去掉被拖条目后的下标（0..length），null = 尚未算出 */
const dropIndex = ref<number | null>(null)
/** 落点指示线在滚动内容坐标系中的 top */
const dropY = ref(0)
let pendingId: string | null = null
let dragStartY = 0
let suppressClick = false

/** 按指针 Y 与其余条目的中点比较算插入下标，被拖条目自身不参与 */
function updateDrop(clientY: number): void {
  const container = scrollRef.value
  if (!container || !draggingId.value) return
  const rects: DOMRect[] = []
  for (const el of container.querySelectorAll<HTMLElement>('.sidebar-item')) {
    if (el.dataset.tabId === draggingId.value) continue
    rects.push(el.getBoundingClientRect())
  }
  let index = rects.length
  for (let i = 0; i < rects.length; i++) {
    if (clientY < rects[i].top + rects[i].height / 2) {
      index = i
      break
    }
  }
  dropIndex.value = index
  if (rects.length === 0) {
    dropY.value = 0
    return
  }
  const edge = index < rects.length ? rects[index].top : rects[rects.length - 1].bottom
  dropY.value = edge - container.getBoundingClientRect().top + container.scrollTop
}

function onItemPointerDown(e: PointerEvent, tabId: string): void {
  if (e.button !== 0) return
  pendingId = tabId
  dragStartY = e.clientY
  window.addEventListener('pointermove', onItemPointerMove)
  window.addEventListener('pointerup', onItemPointerEnd)
  window.addEventListener('pointercancel', onItemPointerEnd)
}

function onItemPointerMove(e: PointerEvent): void {
  if (!draggingId.value) {
    if (!pendingId || Math.abs(e.clientY - dragStartY) < DRAG_THRESHOLD) return
    draggingId.value = pendingId
    // 拖动开始时收起可能开着的右键菜单
    dismiss()
    updateDrop(e.clientY)
    return
  }
  updateDrop(e.clientY)
}

function onItemPointerEnd(): void {
  const moved = draggingId.value !== null
  const id = draggingId.value
  const target = dropIndex.value
  window.removeEventListener('pointermove', onItemPointerMove)
  window.removeEventListener('pointerup', onItemPointerEnd)
  window.removeEventListener('pointercancel', onItemPointerEnd)
  pendingId = null
  draggingId.value = null
  dropIndex.value = null
  if (!moved || !id || target === null) return
  // 拖动结束后的 click 不能激活标签；宏任务复位，确保 click 先被拦下
  suppressClick = true
  setTimeout(() => {
    suppressClick = false
  }, 0)
  store.moveTab(id, target)
  schedulePersist()
  // 条目是普通 div，拖动后焦点掉到 body；还给正文，但不改变活动标签
  focusEditor()
}

function onItemClick(tabId: string): void {
  if (suppressClick) return
  activateTab(tabId)
}

async function closeCurrent(): Promise<void> {
  const id = menu.value?.tabId
  dismiss()
  if (id) await closeTab(id)
}

/** 关闭其他：逐个走 closeTab，dirty 的仍会正常弹确认 */
async function closeOthers(): Promise<void> {
  const id = menu.value?.tabId
  dismiss()
  if (!id) return
  const others = store.tabs.filter((t) => t.id !== id).map((t) => t.id)
  for (const other of others) await closeTab(other)
}

function onWindowPointerDown(e: PointerEvent): void {
  const target = e.target as HTMLElement | null
  if (target?.closest('.context-menu')) return
  dismiss()
}

function onWindowKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') dismiss()
}

onMounted(() => {
  window.addEventListener('pointerdown', onWindowPointerDown, true)
  window.addEventListener('keydown', onWindowKeydown)
  window.addEventListener('blur', dismiss)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown, true)
  window.removeEventListener('keydown', onWindowKeydown)
  window.removeEventListener('blur', dismiss)
  window.removeEventListener('pointermove', onItemPointerMove)
  window.removeEventListener('pointerup', onItemPointerEnd)
  window.removeEventListener('pointercancel', onItemPointerEnd)
})
</script>

<template>
  <div class="yd-panel">
    <div
      ref="scrollRef"
      class="yd-panel-scroll"
      :class="{ dragging: draggingId !== null }"
      @scroll="dismiss"
    >
      <div
        v-for="tab in store.tabs"
        :key="tab.id"
        class="sidebar-item"
        :class="{ active: tab.id === store.activeTabId, dragging: tab.id === draggingId }"
        :data-tab-id="tab.id"
        :title="tab.title"
        @pointerdown="onItemPointerDown($event, tab.id)"
        @click="onItemClick(tab.id)"
        @contextmenu="openMenu($event, tab.id)"
      >
        <span v-if="tab.dirty" class="dirty-dot" title="未保存"></span>
        <span v-else class="dirty-placeholder"></span>
        <span class="item-title">{{ tab.title }}</span>
      </div>
      <!-- 拖动落点指示线：画在滚动内容坐标系里，随列表一起纵向滚动 -->
      <div
        v-if="draggingId && dropIndex !== null"
        class="item-drop-line"
        :style="{ top: `${dropY}px` }"
      ></div>
      <div v-if="store.tabs.length === 0" class="yd-sidebar-empty">无打开的文件</div>
    </div>

    <Teleport to="body">
      <div
        v-if="menu"
        class="context-menu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        @pointerdown.stop
      >
        <button class="menu-item" @click="closeCurrent">关闭</button>
        <button class="menu-item" @click="closeOthers">关闭其他</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 落点指示线用绝对定位画在滚动容器里，需要建立定位上下文 */
.yd-panel-scroll {
  position: relative;
}
.sidebar-item {
  display: flex;
  align-items: center;
  gap: calc(var(--yd-sidebar-gap) / 2);
  height: var(--yd-sidebar-item-height);
  padding: 0 var(--yd-sidebar-padding-x);
  color: var(--yd-text-3);
  font-size: var(--yd-sidebar-font-size);
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.sidebar-item.dragging {
  opacity: 0.55;
}
.yd-panel-scroll.dragging .sidebar-item {
  cursor: grabbing;
}
/* 拖动插入落点：2px 横线，与强调色一致，不参与布局 */
.item-drop-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  margin-top: -1px;
  border-radius: 1px;
  background: var(--yd-accent);
  pointer-events: none;
}
.sidebar-item:hover {
  background: var(--yd-hover-1);
  color: var(--yd-text-2);
}
.sidebar-item.active {
  background: var(--yd-active-1);
  color: var(--yd-text-1);
}
.dirty-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--yd-text-1);
}
/* 无脏标记时占位，保证所有条目文字左对齐 */
.dirty-placeholder {
  flex: none;
  width: 8px;
  height: 8px;
}
.item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.context-menu {
  position: fixed;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  min-width: 120px;
  padding: 4px 0;
  border: 1px solid var(--yd-border-1);
  border-radius: 6px;
  background: var(--yd-bg-2);
  box-shadow: 0 6px 18px rgb(0 0 0 / 18%);
}
.menu-item {
  padding: 5px 14px;
  border: none;
  background: transparent;
  color: var(--yd-text-1);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.menu-item:hover {
  background: var(--yd-hover-1);
}
</style>
