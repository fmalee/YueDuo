<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useTabsStore } from '@/stores/tabs'
import { useLibraryStore } from '@/stores/library'
import { useSettingsStore } from '@/stores/settings'
import { useChapters } from '@/composables/useChapters'
import { useBookmarks } from '@/composables/useBookmarks'
import { useLibraryBookmarks } from '@/composables/useLibraryBookmarks'
import { onBookmarksFlushed } from '@/composables/useBookmarkDrift'
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../shared/types'
import ChapterPage from './right/ChapterPage.vue'
import LibraryBookmarkPage from './right/LibraryBookmarkPage.vue'
import SidebarBookList from './sidebar/SidebarBookList.vue'

/**
 * 右栏（方案 §2.6/§2.7）：章节 / 书签 / 历史三页，跟随当前标签的书。
 * 章节页含当前书书签；「书签」页是全库书签按书分组（Python LibraryBookmarkPanel 口径）。
 * 历史复用左栏书库列表的最近阅读倒序。宽度与左栏同宽，拖拽夹 160–640，松手落盘。
 */
type PageId = 'chapters' | 'bookmarks' | 'history'

const store = useTabsStore()
const library = useLibraryStore()
const settings = useSettingsStore()
const { chapters, loadChapters } = useChapters()
const { bookmarks, loadBookmarks } = useBookmarks()
const { total: libraryBookmarkTotal, loadLibraryBookmarks } = useLibraryBookmarks()

const page = ref<PageId>('chapters')
const activePath = computed(() => store.activeTab?.path ?? '')

watch(
  [() => store.activeTabId, activePath],
  ([tabId, path]) => {
    void loadChapters(tabId ?? '', path)
    void loadBookmarks(path)
  },
  { immediate: true }
)

// 右栏书签页是全库口径：即使停在章节页也先读一次，标签上的数量才准
void loadLibraryBookmarks()

// 进入页面时重取：阅读/评分/添加书签都会改库，列表不能只靠 init 时那一份
watch(page, (next) => {
  if (next === 'history') void library.loadHistory()
  else if (next === 'bookmarks') void loadLibraryBookmarks()
})

// 编辑导致的行号漂移落库后，当前书列表与全库分组一起刷新
const unsubscribeFlush = onBookmarksFlushed((path) => {
  if (path === activePath.value) void loadBookmarks(path)
  void loadLibraryBookmarks()
})

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
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeEnd)
  window.addEventListener('pointercancel', onResizeEnd)
}

function onResizeMove(e: PointerEvent): void {
  if (!dragging.value) return
  const next = Math.round(dragStartWidth - (e.clientX - dragStartX))
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

function refreshHistory(): void {
  void library.loadHistory()
}

onBeforeUnmount(() => {
  unsubscribeFlush()
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeEnd)
  window.removeEventListener('pointercancel', onResizeEnd)
})
</script>

<template>
  <aside class="right-panel" :class="{ resizing: dragging }" :style="{ width: `${width}px` }">
    <nav class="panel-tabs">
      <button class="panel-tab" :class="{ active: page === 'chapters' }" @click="page = 'chapters'">
        章节<span v-if="chapters.length" class="tab-count">{{ chapters.length }}</span>
      </button>
      <button
        class="panel-tab"
        :class="{ active: page === 'bookmarks' }"
        @click="page = 'bookmarks'"
      >
        书签<span v-if="libraryBookmarkTotal" class="tab-count">{{ libraryBookmarkTotal }}</span>
      </button>
      <button class="panel-tab" :class="{ active: page === 'history' }" @click="page = 'history'">
        历史
      </button>
    </nav>

    <div class="panel-pages">
      <ChapterPage v-if="page === 'chapters'" :bookmarks="bookmarks" :path="activePath" />
      <div v-else-if="page === 'bookmarks'" class="bookmarks-page">
        <LibraryBookmarkPage />
      </div>
      <SidebarBookList
        v-else
        :books="library.history"
        empty-text="还没有阅读记录"
        @refresh="refreshHistory"
      />
    </div>

    <!-- 拖拽条压住左边框，命中区 5px（与左栏同款） -->
    <div class="resize-handle" @pointerdown="onResizeStart"></div>
  </aside>
</template>

<style scoped>
.right-panel {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  min-width: 0;
  border-left: 1px solid var(--yd-border-1);
  background: var(--yd-bg-2);
}
.right-panel.resizing {
  user-select: none;
}
.resize-handle {
  position: absolute;
  top: 0;
  left: -3px;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
  z-index: 5;
}
.resize-handle:hover,
.right-panel.resizing .resize-handle {
  background: var(--yd-active-1);
}
.panel-tabs {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 2px;
  padding: 4px var(--yd-panel-padding);
  border-bottom: 1px solid var(--yd-border-1);
}
.panel-tab {
  padding: var(--yd-sidebar-tab-padding-y) var(--yd-sidebar-tab-padding-x);
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--yd-text-3);
  font-size: var(--yd-sidebar-tab-font-size);
  white-space: nowrap;
}
.panel-tab:hover {
  background: var(--yd-hover-1);
  color: var(--yd-text-2);
}
.panel-tab.active {
  background: var(--yd-active-1);
  color: var(--yd-text-1);
}
.tab-count {
  margin-left: 2px;
  color: var(--yd-text-3);
  font-size: var(--yd-library-small-font-size);
}
.panel-pages {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.bookmarks-page {
  display: flex;
  flex: 1;
  min-height: 0;
}
</style>
