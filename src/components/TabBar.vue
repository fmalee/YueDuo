<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { useTabsStore } from '@/stores/tabs'
import { useTabs } from '@/composables/useTabs'
import { useSettingsStore } from '@/stores/settings'

const store = useTabsStore()
const settings = useSettingsStore()
const { activateTab, closeTab } = useTabs()
const scrollRef = ref<HTMLDivElement>()
/** 当前标签外展圆弧 8px：滚动时留同宽余量，避免弧脚被滚动容器裁掉 */
const SCROLL_PADDING = 8

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

watch([() => store.activeTabId, () => store.tabs.length], () => {
  void nextTick(ensureActiveVisible)
})

onMounted(ensureActiveVisible)
</script>

<template>
  <!-- Chrome 风圆弧标签栏：当前标签底边外展圆弧（Python FlaredTabBar 同款，flare=8px 贝塞尔） -->
  <div class="tab-bar" :class="{ 'close-always': settings.closeButtonAlwaysVisible }">
    <div ref="scrollRef" class="tabs-scroll">
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
  </div>
</template>

<style scoped>
.tab-bar {
  min-height: 34px;
  border-bottom: 1px solid var(--yd-border-1);
  background: var(--yd-bg-2);
}
.tabs-scroll {
  display: flex;
  align-items: flex-end;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
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
