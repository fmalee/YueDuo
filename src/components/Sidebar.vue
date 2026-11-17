<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useLibraryStore } from '@/stores/library'
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../shared/types'
import SidebarEdit from './sidebar/SidebarEdit.vue'
import SidebarShelf from './sidebar/SidebarShelf.vue'
import SidebarBookList from './sidebar/SidebarBookList.vue'
import SidebarTags from './sidebar/SidebarTags.vue'
import SidebarRating from './sidebar/SidebarRating.vue'

/**
 * 左栏壳（方案 §1.11 + §2.5）：六页共用同一个位置，用顶部小标签切换。
 * 编辑页列打开中的标签；书架/历史/追更/标签/评分共用书库打开流程。
 * 宽度可拖拽（方案 §1.9，夹 160–640），松手写入设置。
 */
type PageId = 'edit' | 'shelf' | 'history' | 'following' | 'tags' | 'rating'

const pages: { id: PageId; label: string }[] = [
  { id: 'edit', label: '编辑' },
  { id: 'shelf', label: '书架' },
  { id: 'history', label: '历史' },
  { id: 'following', label: '追更' },
  { id: 'tags', label: '标签' },
  { id: 'rating', label: '评分' }
]

const settings = useSettingsStore()
const library = useLibraryStore()
const activePage = ref<PageId>('edit')

const width = ref(settings.sidebarWidth)
watch(
  () => settings.sidebarWidth,
  (value) => {
    if (!dragging.value) width.value = value
  }
)

const dragging = ref(false)
let dragStartX = 0
let dragStartWidth = 0

function onResizeStart(e: PointerEvent): void {
  e.preventDefault()
  dragging.value = true
  dragStartX = e.clientX
  dragStartWidth = width.value
  // 监听挂 window：指针移出 5px 拖拽条也不会断，卸载时统一清理
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeEnd)
  window.addEventListener('pointercancel', onResizeEnd)
}

function onResizeMove(e: PointerEvent): void {
  if (!dragging.value) return
  const next = Math.round(dragStartWidth + e.clientX - dragStartX)
  width.value = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, next))
}

function onResizeEnd(): void {
  if (!dragging.value) return
  dragging.value = false
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
  window.removeEventListener('pointercancel', onResizeEnd)
  // 拖拽结束才落盘，避免每帧写文件
  void settings.setSidebarWidth(width.value)
}

function refreshHistory(): void {
  void library.loadHistory()
}

function refreshFollowing(): void {
  void library.loadFollowing()
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
  window.removeEventListener('pointercancel', onResizeEnd)
})
</script>

<template>
  <aside class="sidebar" :class="{ resizing: dragging }" :style="{ width: `${width}px` }">
    <nav class="sidebar-tabs">
      <button
        v-for="page in pages"
        :key="page.id"
        class="sidebar-tab"
        :class="{ active: activePage === page.id }"
        @click="activePage = page.id"
      >
        {{ page.label }}
      </button>
    </nav>

    <div class="sidebar-pages">
      <SidebarEdit v-if="activePage === 'edit'" />
      <SidebarShelf v-else-if="activePage === 'shelf'" />
      <SidebarBookList
        v-else-if="activePage === 'history'"
        :books="library.history"
        empty-text="还没有阅读记录"
        @refresh="refreshHistory"
      />
      <SidebarBookList
        v-else-if="activePage === 'following'"
        :books="library.following"
        empty-text="没有带「追更」标签的书"
        @refresh="refreshFollowing"
      />
      <SidebarTags v-else-if="activePage === 'tags'" />
      <SidebarRating v-else />
    </div>

    <!-- 拖拽条压住右边框，命中区 5px（方案 §1.9） -->
    <div class="resize-handle" @pointerdown="onResizeStart"></div>
  </aside>
</template>

<style scoped>
.sidebar {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: none;
  width: var(--yd-sidebar-width);
  min-width: 0;
  border-right: 1px solid var(--yd-border-1);
  background: var(--yd-bg-2);
}
/* 拖拽中禁止选中正文，避免拖动变成划词 */
.sidebar.resizing {
  user-select: none;
}
.resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: 5;
}
.resize-handle:hover,
.sidebar.resizing .resize-handle {
  background: var(--yd-active-1);
}
.sidebar-tabs {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 2px;
  padding: 4px var(--yd-panel-padding);
  border-bottom: 1px solid var(--yd-border-1);
}
.sidebar-tab {
  padding: var(--yd-sidebar-tab-padding-y) var(--yd-sidebar-tab-padding-x);
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--yd-text-3);
  font-size: var(--yd-sidebar-tab-font-size);
  white-space: nowrap;
}
.sidebar-tab:hover {
  background: var(--yd-hover-1);
  color: var(--yd-text-2);
}
.sidebar-tab.active {
  background: var(--yd-active-1);
  color: var(--yd-text-1);
}
.sidebar-pages {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
</style>
