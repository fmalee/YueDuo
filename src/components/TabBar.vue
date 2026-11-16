<script setup lang="ts">
import { useTabsStore } from '@/stores/tabs'
import { useTabs } from '@/composables/useTabs'

const store = useTabsStore()
const { activateTab, closeTab } = useTabs()
</script>

<template>
  <!-- Chrome 风圆弧标签栏：当前标签底边外展圆弧（Python FlaredTabBar 同款，flare=8px 贝塞尔） -->
  <div class="tab-bar">
    <div class="tabs-scroll">
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
  border-bottom: 1px solid var(--yd-border, #e3dacd);
  background: var(--yd-panel, #fbf8f3);
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
  color: var(--yd-secondary, #8a7f6e);
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
  background: var(--yd-hover, #f0e9dd);
  color: var(--yd-text, #4a3f2f);
}
.tab.active {
  background: var(--yd-editor, #fdfbf7);
  border-color: var(--yd-border, #e3dacd);
  color: var(--yd-text, #4a3f2f);
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
  fill: var(--yd-editor, #fdfbf7);
}
.flare-stroke {
  stroke: var(--yd-border, #e3dacd);
  stroke-width: 1;
}
.tab-dirty {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #333;
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
  color: var(--yd-secondary, #8a7f6e);
}
.tab-close:hover {
  background: #ddd2c0;
  color: #333;
}
</style>
