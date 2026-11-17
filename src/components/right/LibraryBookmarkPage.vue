<script setup lang="ts">
import { ref } from 'vue'
import { useLibraryBookmarks } from '@/composables/useLibraryBookmarks'
import { useTabs } from '@/composables/useTabs'
import { requestLineJump } from '@/composables/useSession'
import type { LibraryBookmarkGroup } from '../../../shared/types'

/**
 * 右栏「书签」页（方案 §2.7，照 Python LibraryBookmarkPanel）：
 * 全库书签按书分组，组标题「书名（N）」默认展开；点组只切换展开，点条目打开该书并跳行。
 * 组内条目「第 N 行 · 摘要」，摘要最多 18 字。
 */
const SUMMARY_MAX_CHARS = 18

const { groups, loading, error, total } = useLibraryBookmarks()
const { openFile, activateTab } = useTabs()
const collapsed = ref<Set<string>>(new Set())
const status = ref('')

function toggle(path: string): void {
  const next = new Set(collapsed.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  collapsed.value = next
}

function childText(line: number, note: string): string {
  const text = note.trim()
  const summary = text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}…` : text
  return summary ? `第 ${line} 行 · ${summary}` : `第 ${line} 行`
}

/** 跨书跳转：书未打开时先打开标签，再排队等 model 挂上后定位（同 Python pending jumps） */
async function openAt(group: LibraryBookmarkGroup, line: number): Promise<void> {
  status.value = ''
  try {
    const id = await openFile(group.path)
    activateTab(id)
    requestLineJump(id, line)
  } catch (e) {
    status.value = `打开失败：${e instanceof Error ? e.message : String(e)}`
  }
}
</script>

<template>
  <div class="yd-panel">
    <div class="yd-panel-scroll">
      <div v-for="group in groups" :key="group.path" class="bookmark-group">
        <div class="group-header" :title="group.path" @click="toggle(group.path)">
          <span class="group-caret">{{ collapsed.has(group.path) ? '▸' : '▾' }}</span>
          <span class="group-title">{{ group.title }}（{{ group.bookmarks.length }}）</span>
        </div>
        <template v-if="!collapsed.has(group.path)">
          <div
            v-for="bookmark in group.bookmarks"
            :key="bookmark.line"
            class="group-item"
            :title="`${group.title} · 第 ${bookmark.line} 行`"
            @click="openAt(group, bookmark.line)"
          >
            {{ childText(bookmark.line, bookmark.note) }}
          </div>
        </template>
      </div>
      <div v-if="loading" class="yd-sidebar-empty">正在读取书签…</div>
      <div v-else-if="error" class="yd-sidebar-empty">书签读取失败：{{ error }}</div>
      <div v-else-if="!groups.length" class="yd-sidebar-empty">暂无书签</div>
    </div>
    <footer class="yd-panel-footer">
      <span class="status">{{ status || (total ? `共 ${total} 条书签` : '') }}</span>
    </footer>
  </div>
</template>

<style scoped>
.bookmark-group {
  padding: 2px 0;
}
.group-header {
  display: flex;
  align-items: center;
  gap: var(--yd-panel-gap);
  min-height: var(--yd-sidebar-item-height);
  padding: 2px var(--yd-panel-padding);
  color: var(--yd-text-1);
  font-size: var(--yd-sidebar-font-size);
  font-weight: 600;
  cursor: pointer;
}
.group-header:hover {
  background: var(--yd-hover-1);
}
.group-caret {
  flex: none;
  width: var(--yd-library-indent);
  color: var(--yd-text-3);
  font-weight: 400;
  text-align: center;
}
.group-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-item {
  min-height: var(--yd-sidebar-item-height);
  padding: 2px var(--yd-panel-padding) 2px
    calc(var(--yd-panel-padding) + var(--yd-library-indent) + var(--yd-panel-gap));
  overflow: hidden;
  color: var(--yd-text-2);
  font-size: var(--yd-sidebar-font-size);
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.group-item:hover {
  background: var(--yd-hover-1);
}
.status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
