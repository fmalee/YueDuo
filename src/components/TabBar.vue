<script setup lang="ts">
import { useTabsStore } from '@/stores/tabs'
import { useTabs } from '@/composables/useTabs'

const store = useTabsStore()
const { activateTab, closeTab } = useTabs()

/** 关闭按钮（1.5 做 Chrome 圆弧视觉与确认流程，此处先闭环） */
function onClose(id: string): void {
  closeTab(id)
}
</script>

<template>
  <div class="tab-bar">
    <div
      v-for="tab in store.tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === store.activeTabId }"
      @click="activateTab(tab.id)"
    >
      <span v-if="tab.dirty" class="tab-dirty"></span>
      <span class="tab-title">{{ tab.title }}</span>
      <span class="tab-close" @click.stop="onClose(tab.id)">×</span>
    </div>
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  overflow-x: auto;
  height: 36px;
  border-bottom: 1px solid #ddd;
  background: #f5f5f5;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  border-right: 1px solid #e0e0e0;
}
.tab.active {
  background: #fff;
  border-top: 2px solid #3282ce;
}
.tab-title {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab-dirty {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #333;
}
.tab-close {
  display: inline-block;
  width: 16px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  border-radius: 3px;
}
.tab-close:hover {
  background: #ddd;
}
</style>
