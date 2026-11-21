<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useCommandPalette } from '@/composables/useCommandPalette'
import { formatDateTime } from '@/utils/format'

/**
 * Cmd+P 命令面板（方案 §2.12）：只负责浮层展示与键位，过滤与打开由
 * useCommandPalette 编排。空输入显示最近阅读，回车打开、Esc 关闭。
 */
const { visible, query, results, selectedIndex, close, moveSelection, activate } =
  useCommandPalette()
const inputRef = ref<HTMLInputElement>()

function focusInput(): void {
  void nextTick(() => inputRef.value?.focus())
}

watch(visible, (value) => {
  if (value) focusInput()
})

function formatWordCount(count: number): string {
  return count.toLocaleString()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="palette-overlay" @mousedown.self="close">
      <div class="palette-panel" role="dialog" aria-label="快速检索">
        <input
          ref="inputRef"
          v-model="query"
          class="palette-input"
          type="text"
          placeholder="输入书名、作者或标签…"
          autocomplete="off"
          spellcheck="false"
          @keydown.down.prevent="moveSelection(1)"
          @keydown.up.prevent="moveSelection(-1)"
          @keydown.enter.prevent="activate()"
          @keydown.esc.prevent="close"
        />
        <ul v-if="results.length" class="palette-list">
          <li
            v-for="(entry, index) in results"
            :key="entry.path"
            class="palette-row"
            :class="{ selected: index === selectedIndex }"
            @mousedown.prevent="selectedIndex = index"
            @click="activate(index)"
          >
            <span class="palette-title">{{ entry.title || entry.path }}</span>
            <span class="palette-meta">
              {{ entry.author || '佚名' }}
              <template v-if="entry.wordCount">
                · {{ formatWordCount(entry.wordCount) }} 字</template
              >
              <template v-if="entry.lastReadAt">
                · 最近 {{ formatDateTime(entry.lastReadAt) }}
              </template>
            </span>
          </li>
        </ul>
        <div v-else class="palette-empty">没有匹配的书</div>
        <div class="palette-hint">
          <span><kbd>↑↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.palette-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: var(--yd-palette-top-offset);
  background: var(--yd-overlay);
}
.palette-panel {
  display: flex;
  flex-direction: column;
  width: var(--yd-palette-width);
  max-height: var(--yd-palette-max-height);
  overflow: hidden;
  border: 1px solid var(--yd-border-1);
  border-radius: var(--yd-palette-radius);
  background: var(--yd-bg-1);
  box-shadow: 0 8px 24px var(--yd-shadow);
}
.palette-input {
  flex: none;
  padding: var(--yd-palette-input-padding-y) var(--yd-palette-input-padding-x);
  border: none;
  border-bottom: 1px solid var(--yd-border-1);
  outline: none;
  background: var(--yd-bg-1);
  color: var(--yd-text-1);
  font-size: var(--yd-palette-input-font-size);
  font-family: inherit;
}
.palette-input::placeholder {
  color: var(--yd-text-3);
}
.palette-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.palette-row {
  display: flex;
  align-items: baseline;
  gap: var(--yd-palette-row-gap);
  padding: var(--yd-palette-row-padding-y) var(--yd-palette-row-padding-x);
  font-size: var(--yd-palette-font-size);
  cursor: pointer;
}
.palette-row:hover {
  background: var(--yd-hover-1);
}
.palette-row.selected {
  background: var(--yd-active-1);
}
.palette-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--yd-text-1);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.palette-meta {
  flex: none;
  max-width: 60%;
  overflow: hidden;
  color: var(--yd-text-3);
  font-size: var(--yd-palette-meta-font-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.palette-empty {
  padding: var(--yd-palette-row-padding-y) var(--yd-palette-row-padding-x);
  color: var(--yd-text-3);
  font-size: var(--yd-palette-font-size);
  text-align: center;
}
.palette-hint {
  display: flex;
  flex: none;
  gap: var(--yd-palette-row-gap);
  padding: var(--yd-palette-row-padding-y) var(--yd-palette-row-padding-x);
  border-top: 1px solid var(--yd-border-1);
  background: var(--yd-bg-2);
  color: var(--yd-text-3);
  font-size: var(--yd-palette-hint-font-size);
}
.palette-hint kbd {
  padding: 0 var(--yd-palette-key-padding-x);
  border-radius: var(--yd-palette-key-radius);
  background: var(--yd-hover-1);
  font-family: monospace;
}
</style>
