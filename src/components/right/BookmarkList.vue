<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useTabsStore } from '@/stores/tabs'
import { getTabModel } from '@/composables/useTabLifecycle'
import { useBookmarks } from '@/composables/useBookmarks'
import { caretSnapshot, focusEditor, jumpToLine } from '@/composables/useSession'
import type { BookmarkInfo } from '../../../shared/types'

/**
 * 当前书的书签列表（方案 §2.6）：两行条目（行号 + 摘要），摘要最多 15 字。
 * 添加书签沿用 Python 口径：光标在空行时顺延到下一个有文字的行；同行不重复。
 * 点击条目跳转，悬停显示删除图标。
 */
const props = withDefaults(
  defineProps<{
    bookmarks: BookmarkInfo[]
    path: string
    emptyText?: string
  }>(),
  { emptyText: '暂无书签' }
)

const SUMMARY_MAX_CHARS = 15
const NOTE_MAX_CHARS = 40
const INDENT = /^[ \t\u3000]+/

const store = useTabsStore()
const { addBookmark, removeBookmark } = useBookmarks()
const status = ref('')

const entry = computed(() => {
  const id = store.activeTabId
  return id ? getTabModel(id) : undefined
})

function shortSummary(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= SUMMARY_MAX_CHARS ? trimmed : `${trimmed.slice(0, SUMMARY_MAX_CHARS)}…`
}

/** 优先取当前正文该行文字（可能已编辑漂移），model 不在时退回入库时的摘要 */
function lineText(line: number): string {
  const model = entry.value?.model
  if (!model || line < 1 || line > model.getLineCount()) return ''
  return model.getLineContent(line).replace(INDENT, '').trim()
}

function summaryOf(bookmark: BookmarkInfo): string {
  return shortSummary(lineText(bookmark.line) || bookmark.note)
}

function jump(line: number): void {
  jumpToLine(line)
}

/** 添加：从光标行向下找第一个非空行；文末全空则放弃（同 Python add_bookmark） */
async function add(): Promise<void> {
  const path = props.path
  const model = entry.value?.model
  if (!path || !model) {
    status.value = '当前标签没有可收录的内容'
    return
  }
  let line = caretSnapshot()?.line ?? 1
  let text = ''
  while (line <= model.getLineCount()) {
    text = lineText(line)
    if (text) break
    line++
  }
  if (!text) {
    status.value = '光标以下没有可收录的内容'
    return
  }
  if (props.bookmarks.some((bookmark) => bookmark.line === line)) {
    status.value = '该行已有书签'
    return
  }
  try {
    await addBookmark(path, line, text.slice(0, NOTE_MAX_CHARS))
    status.value = `已添加第 ${line} 行书签`
    focusEditor()
  } catch (e) {
    status.value = e instanceof Error ? e.message : String(e)
  }
}

async function remove(bookmark: BookmarkInfo): Promise<void> {
  try {
    await removeBookmark(props.path, bookmark.line)
    status.value = `已删除第 ${bookmark.line} 行书签`
  } catch (e) {
    status.value = e instanceof Error ? e.message : String(e)
  }
}

watch(
  () => props.path,
  () => {
    status.value = ''
  }
)
</script>

<template>
  <div class="yd-panel">
    <div class="yd-panel-scroll">
      <div
        v-for="bookmark in props.bookmarks"
        :key="bookmark.line"
        class="bookmark-row"
        :title="`第 ${bookmark.line} 行\n${summaryOf(bookmark) || '（空行）'}`"
        @click="jump(bookmark.line)"
      >
        <div class="bookmark-line">第 {{ bookmark.line }} 行</div>
        <div class="bookmark-body">
          <span class="bookmark-summary">{{ summaryOf(bookmark) || '（空行）' }}</span>
          <button class="bookmark-remove" title="删除书签" @click.stop="remove(bookmark)">✕</button>
        </div>
      </div>
      <div v-if="!props.bookmarks.length" class="yd-sidebar-empty">{{ props.emptyText }}</div>
    </div>
    <footer class="yd-panel-footer">
      <span class="status">{{ status }}</span>
      <button class="yd-text-button" :disabled="!path" title="从光标行添加书签" @click="add">
        添加书签
      </button>
    </footer>
  </div>
</template>

<style scoped>
.bookmark-row {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: var(--yd-bookmark-row-height);
  padding: 2px var(--yd-panel-padding);
  cursor: pointer;
}
.bookmark-row:hover {
  background: var(--yd-hover-1);
}
.bookmark-line {
  color: var(--yd-text-3);
  font-size: var(--yd-library-small-font-size);
  line-height: 1.4;
}
.bookmark-body {
  display: flex;
  align-items: center;
  gap: var(--yd-panel-gap);
}
.bookmark-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--yd-text-1);
  font-size: var(--yd-sidebar-font-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bookmark-remove {
  flex: none;
  padding: 0 2px;
  border: none;
  background: transparent;
  color: var(--yd-text-3);
  font-size: var(--yd-library-small-font-size);
  opacity: 0;
}
.bookmark-row:hover .bookmark-remove {
  opacity: 1;
}
.bookmark-remove:hover {
  color: var(--yd-text-1);
}
.status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.yd-text-button:disabled {
  cursor: default;
  opacity: 0.4;
}
</style>
