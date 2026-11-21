<script setup lang="ts">
import { ref, watch } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { usePanelResize } from '@/composables/usePanelResize'
import SidebarEdit from './sidebar/SidebarEdit.vue'
import SidebarShelf from './sidebar/SidebarShelf.vue'
import SidebarBookList from './sidebar/SidebarBookList.vue'
import SidebarTags from './sidebar/SidebarTags.vue'
import SidebarRating from './sidebar/SidebarRating.vue'

/**
 * 左栏壳（方案 §1.11 + §2.5）：五页共用同一个位置，用顶部小标签切换。
 * 编辑页列打开中的标签；书架/追更/标签/评分共用书库打开流程。
 * 历史只在右栏保留（用户实测去重，避免左右两处重复）。
 * 宽度可拖拽（方案 §1.9，夹 160–640），松手写入设置。
 */
type PageId = 'edit' | 'shelf' | 'following' | 'tags' | 'rating'

const pages: { id: PageId; label: string }[] = [
  { id: 'edit', label: '编辑' },
  { id: 'shelf', label: '书架' },
  { id: 'following', label: '追更' },
  { id: 'tags', label: '标签' },
  { id: 'rating', label: '评分' }
]

const library = useLibraryStore()
const activePage = ref<PageId>('edit')

const { width, dragging, onResizeStart } = usePanelResize(1)

/** 追更空态：查询语义不变，只把「怎么让书出现在这里」讲清楚 */
const followingEmpty =
  '没有带「追更」标签的书\n正文前十行写「主题：追更」，或放进名为「追更」的目录后重新扫描'

// 进入页面时重取：阅读/评分/保存都会改库，列表不能只靠 init 时那一份
watch(activePage, (page) => {
  if (page === 'rating') void library.loadRated()
  else if (page === 'tags') {
    void library.loadTags()
    if (library.activeTag) void library.loadTagBooks()
  }
})

function refreshFollowing(): void {
  void library.loadFollowing()
}
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
        v-else-if="activePage === 'following'"
        :books="library.following"
        :empty-text="followingEmpty"
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
  align-items: center;
  gap: 2px;
  box-sizing: border-box;
  /* 与标签栏基准线严格同高：34px 行 + 1px 底边，线落在 [33,34)，与 tabs-scroll inset 线像素级重合；
     padding-top 4px 让文字中心落在 18.5px，与标签栏文字垂直对齐；窄栏换行时行高增长、线下移 */
  min-height: var(--yd-tab-bar-height);
  padding: 4px var(--yd-panel-padding) 0;
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
