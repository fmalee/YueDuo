<script setup lang="ts">
import { computed, watch } from 'vue'
import { useTabsStore } from '@/stores/tabs'
import { useReaderStore } from '@/stores/reader'
import { statusMetrics } from '@/composables/useStatusMetrics'
import { showStatusMessage, statusMessage } from '@/composables/useStatusMessage'

/** 状态栏（方案 §1.10）：文件名 / 完整路径（中间省略，tooltip 全路径）/ 编码 / 字数 / 行 x / y */
const store = useTabsStore()
const reader = useReaderStore()
const tab = computed(() => store.activeTab)

/** 锁定阅读（方案 §3.3）：文案与 Python 一致；状态变化只在这里提示一次 */
watch(
  () => reader.locked,
  (locked) =>
    showStatusMessage(
      locked ? '已锁定，空格向下翻页，Shift+空格向上翻页' : '已解锁，可继续编辑',
      4000
    )
)

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
      <span v-if="statusMessage" class="message">{{ statusMessage }}</span>
      <span>{{ encoding }}</span>
      <span>字数 {{ statusMetrics.charCount.toLocaleString() }}</span>
      <span>行 {{ statusMetrics.cursorLine }} / {{ statusMetrics.lineCount }}</span>
      <span v-if="reader.locked" class="lock-hint">已锁定 · 空格翻页</span>
      <button
        class="lock-button"
        :class="{ checked: reader.locked }"
        :aria-pressed="reader.locked"
        title="锁定后只能翻页：空格向下、Shift+空格向上；Cmd+L 是同一开关"
        @click="reader.toggle()"
      >
        锁定阅读
      </button>
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
.message {
  color: var(--yd-accent);
}
.lock-hint {
  color: var(--yd-accent);
  flex: none;
}
.lock-button {
  flex: none;
  height: var(--yd-status-lock-height);
  padding: 0 var(--yd-status-lock-padding-x);
  border: 1px solid var(--yd-border-1);
  border-radius: var(--yd-status-lock-radius);
  background: transparent;
  box-shadow: 0 1px 2px var(--yd-shadow);
  color: var(--yd-text-2);
  font: inherit;
  line-height: 1;
  cursor: pointer;
}
.lock-button:hover {
  background: var(--yd-hover-1);
}
.lock-button.checked {
  background: var(--yd-active-1);
  color: var(--yd-text-1);
}
</style>
