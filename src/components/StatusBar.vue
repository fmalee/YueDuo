<script setup lang="ts">
import { computed } from 'vue'
import { useTabsStore } from '@/stores/tabs'
import { statusMetrics } from '@/composables/useStatusMetrics'

/** 状态栏（方案 §1.10）：文件名 / 完整路径（中间省略，tooltip 全路径）/ 编码 / 字数 / 行 x / y */
const store = useTabsStore()
const tab = computed(() => store.activeTab)

/** 路径拆成目录 + 文件名：目录部分可收缩省略，文件名始终完整（即视觉上的中间省略） */
const pathParts = computed(() => {
  const path = tab.value?.path ?? ''
  if (!path) return null
  const index = path.lastIndexOf('/')
  return { dir: path.slice(0, index + 1), base: path.slice(index + 1), full: path }
})

const encoding = computed(() => tab.value?.encoding.toUpperCase() || '—')
</script>

<template>
  <footer class="status-bar">
    <div class="left">
      <span class="name">{{ tab?.title ?? '未打开文件' }}</span>
      <span v-if="pathParts" class="path" :title="pathParts.full">
        <span class="path-dir">{{ pathParts.dir }}</span>
        <span class="path-base">{{ pathParts.base }}</span>
      </span>
    </div>
    <div class="right">
      <span>{{ encoding }}</span>
      <span>字数 {{ statusMetrics.charCount.toLocaleString() }}</span>
      <span>行 {{ statusMetrics.cursorLine }} / {{ statusMetrics.lineCount }}</span>
    </div>
  </footer>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--yd-statusbar-gap);
  flex: none;
  height: var(--yd-statusbar-height);
  padding: 0 var(--yd-statusbar-padding-x);
  border-top: 1px solid var(--yd-border-1);
  background: var(--yd-bg-2);
  color: var(--yd-text-3);
  font-size: var(--yd-statusbar-font-size);
  white-space: nowrap;
}
.left {
  display: flex;
  align-items: center;
  gap: var(--yd-statusbar-gap);
  min-width: 0;
}
.name {
  color: var(--yd-text-2);
  flex: none;
}
.path {
  display: flex;
  min-width: 0;
  /* 目录先省略，文件名不动 = 路径中间省略 */
  max-width: 60vw;
}
.path-dir {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path-base {
  flex: none;
}
.right {
  display: flex;
  align-items: center;
  gap: var(--yd-statusbar-gap);
  flex: none;
}
</style>
