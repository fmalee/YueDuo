<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useTabsStore } from '@/stores/tabs'
import { useTabs } from '@/composables/useTabs'
import { popupContextMenu } from '@/composables/useContextMenu'
import { focusEditor, schedulePersist } from '@/composables/useSession'
import { showStatusMessage } from '@/composables/useStatusMessage'
import { useSettingsStore } from '@/stores/settings'
import { useTabBarScroll } from '@/composables/useTabBarScroll'
import { useTabDragSort } from '@/composables/useTabDragSort'
import TabRenameModal from './TabRenameModal.vue'

const store = useTabsStore()
const settings = useSettingsStore()
const {
  activateTab,
  closeTab,
  saveTab,
  closeOtherTabs,
  closeAllTabs,
  renameTab,
  moveTab,
  deleteTabFile,
  revealTabFile
} = useTabs()

const scrollRef = ref<HTMLDivElement>()
const renameModal = ref<InstanceType<typeof TabRenameModal>>()

const {
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
} = useTabBarScroll(scrollRef)

const { draggingTab, dragId, dropIndex, dropLeft, onTabPointerDown, onTabClick } = useTabDragSort({
  scrollRef,
  onMove: (id, target) => {
    store.moveTab(id, target)
    schedulePersist()
    focusEditor()
  },
  onMiddleClose: (tabId) => {
    void closeTab(tabId)
  },
  onActivate: (tabId) => {
    activateTab(tabId)
  }
})

/** 右键弹原生菜单：不切活动标签，动作按 tabId 作用于被右击的那一项 */
function openTabMenu(e: MouseEvent, tabId: string): void {
  e.preventDefault()
  const tab = store.tabs.find((t) => t.id === tabId)
  if (!tab) return
  const hasPath = Boolean(tab.path)
  void popupContextMenu(
    [
      { kind: 'item', id: 'save', label: '保存' },
      { kind: 'item', id: 'close', label: '关闭' },
      { kind: 'item', id: 'closeOthers', label: '关闭其他', enabled: store.tabs.length > 1 },
      { kind: 'item', id: 'closeAll', label: '关闭全部' },
      { kind: 'separator' },
      { kind: 'item', id: 'rename', label: '重命名…', enabled: hasPath },
      { kind: 'item', id: 'move', label: '移动…', enabled: hasPath },
      { kind: 'item', id: 'delete', label: '删除…', enabled: hasPath },
      { kind: 'item', id: 'reveal', label: '在 Finder 中显示', enabled: hasPath }
    ],
    (itemId) => {
      switch (itemId) {
        case 'save':
          void saveTab(tabId).catch((err) => console.error('[tab] 保存失败:', err))
          break
        case 'close':
          void closeTab(tabId)
          break
        case 'closeOthers':
          void closeOtherTabs(tabId)
          break
        case 'closeAll':
          void closeAllTabs()
          break
        case 'rename':
          beginRename(tabId)
          break
        case 'move':
          void moveTab(tabId).then((error) => {
            if (error) showStatusMessage(`移动失败：${error}`, 5000)
          })
          break
        case 'delete':
          void deleteTabFile(tabId).catch((err) => console.error('[tab] 删除失败:', err))
          break
        case 'reveal':
          revealTabFile(tabId)
          break
      }
    }
  ).catch((err) => console.error('[tab] 右键菜单弹出失败:', err))
}

function beginRename(id: string): void {
  const tab = store.tabs.find((t) => t.id === id)
  if (!tab?.path) return
  const base = tab.path.split('/').pop() ?? ''
  renameModal.value?.open(id, base.replace(/\.txt$/i, ''))
}

// 活动标签下标也要监听：左栏拖动活动标签时 active 与数量都不变，但它在标签栏里的位置变了
watch(
  [
    () => store.activeTabId,
    () => store.tabs.length,
    () => store.tabs.findIndex((t) => t.id === store.activeTabId)
  ],
  () => {
    void nextTick(() => {
      ensureActiveVisible()
      syncScrollbar()
    })
  }
)
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
        <span class="tab-title" :class="{ derived: !tab.path }">{{ tab.title }}</span>
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

  <TabRenameModal ref="renameModal" :on-submit="renameTab" />
</template>

<style scoped>
.tab-bar {
  position: relative;
  min-height: var(--yd-tab-bar-height);
  background: var(--yd-bg-2);
  /* 拖动排序时不要选中标签文字 */
  user-select: none;
}
.tabs-scroll {
  position: relative;
  display: flex;
  align-items: flex-end;
  height: var(--yd-tab-bar-height);
  padding-bottom: var(--yd-tab-border-width);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  /* 三栏共用的基准线画在滚动视口自身：不随内容横向滚动，与左右栏头部线同一高度连成一条；
     活动标签靠负 margin 盖出断口（方案 A 统一底线版） */
  box-shadow: inset 0 calc(-1 * var(--yd-tab-border-width)) 0 var(--yd-border-1);
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
/* 非活动标签之间的 14px 短竖线分隔（方案 A）：替代原贯穿底线 */
.tab:not(.active):not(.first)::before {
  content: '';
  position: absolute;
  left: 0;
  top: 7px;
  bottom: 7px;
  width: 1px;
  background: var(--yd-border-1);
}
/* 活动标签与右侧邻标签之间不画竖线：活动标签已由实底与强调条区分 */
.tab.active + .tab::before {
  display: none;
}
.tab:hover:not(.active) {
  background: var(--yd-hover-1);
  color: var(--yd-text-2);
}
.tab.active {
  background: var(--yd-bg-3);
  border-color: var(--yd-border-1);
  /* 顶部 2px 强调条（方案 A）：活动标签比非活动高 1px */
  border-top-width: 2px;
  border-top-color: var(--yd-accent);
  color: var(--yd-text-2);
  /* 伸进基准线那一像素盖出断口：标签底部与正文连成一片（Chrome 同款） */
  margin-bottom: calc(-1 * var(--yd-tab-border-width));
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
/* 空白标签标题来自正文首行，可能很长：按实际显示宽度省略，不做字数硬切 */
.tab-title.derived {
  max-width: var(--yd-tab-title-max-width);
  overflow: hidden;
  text-overflow: ellipsis;
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
  /* 关闭按钮常驻由设置决定（方案 §1.9）；非常驻时仅悬停【活动标签】显示——
     非活动标签永不出现按钮：标题完全对称、悬停切换零误触；要关未激活的标签
     先点击激活再关，或中键直关，或右键菜单关闭 */
  opacity: 0;
  pointer-events: none;
}
.tab.active:hover .tab-close,
.tab-bar.close-always .tab-close {
  opacity: 1;
  pointer-events: auto;
}
.tab-close:hover {
  background: var(--yd-active-1);
  color: var(--yd-text-1);
}
</style>
