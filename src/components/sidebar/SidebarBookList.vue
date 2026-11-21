<script setup lang="ts">
import { ref } from 'vue'
import { useTabs } from '@/composables/useTabs'
import { useLibraryStore } from '@/stores/library'
import { resolveRatingClick } from '@/composables/useRatingGesture'
import StarRating from './StarRating.vue'
import type { LibraryBook } from '../../../shared/types'
import { formatError } from '../../utils/format'
import { formatDateTime } from '@/utils/format'

/**
 * 书库两行列表（方案 §2.5：历史/追更/标签下钻/评分共用）：
 * 首行书名 + 星级，次行作者 · 字数 · 最近阅读；点条目走统一打开流程。
 * 星级可就地改分（库内评分 + Finder 星级同写），再点同分取消。
 */
const props = defineProps<{
  books: LibraryBook[]
  emptyText: string
}>()

defineEmits<{ refresh: [] }>()

const { openFile, activateTab } = useTabs()
const library = useLibraryStore()
const status = ref('')

function formatWords(value: number): string {
  return value >= 10000 ? `${(value / 10000).toFixed(1)}万字` : `${value}字`
}

function rateBook(book: LibraryBook, clicked: number): void {
  const next = resolveRatingClick(`book:${book.id}`, book.rating, clicked)
  void library.setBookRating(book.id, next)
}

async function openBook(book: LibraryBook): Promise<void> {
  status.value = ''
  try {
    // 已打开的标签走 activateTab：同标签也能把焦点交还正文（方案 §1.12 焦点修复）
    const id = await openFile(book.path)
    activateTab(id)
  } catch (e) {
    status.value = `打开失败：${formatError(e)}`
  }
}
</script>

<template>
  <div class="yd-panel">
    <slot name="header" />
    <div class="yd-panel-scroll">
      <div
        v-for="book in props.books"
        :key="book.id"
        class="book-row"
        :title="`${book.title || book.filename}\n${book.author || '佚名'} · ${book.wordCount.toLocaleString()} 字 · ${formatDateTime(book.lastReadAt)}\n${book.path}`"
        @click="openBook(book)"
      >
        <div class="row-top">
          <span class="book-title">{{ book.title || book.filename }}</span>
          <StarRating :value="book.rating" @select="rateBook(book, $event)" />
        </div>
        <div class="row-sub">
          {{ book.author || '佚名' }} · {{ formatWords(book.wordCount) }} ·
          {{ formatDateTime(book.lastReadAt) }}
        </div>
      </div>
      <div v-if="!props.books.length" class="yd-sidebar-empty">{{ props.emptyText }}</div>
    </div>
    <footer class="yd-panel-footer">
      <span class="status">{{
        status || (props.books.length ? `共 ${props.books.length} 本` : '')
      }}</span>
      <button
        class="yd-text-button"
        title="从数据库重新读取，不重新扫描目录"
        @click="$emit('refresh')"
      >
        刷新
      </button>
    </footer>
  </div>
</template>

<style scoped>
.book-row {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: var(--yd-library-row-height);
  padding: 2px var(--yd-panel-padding);
  cursor: pointer;
}
.book-row:hover {
  background: var(--yd-hover-1);
}
.row-top {
  display: flex;
  align-items: center;
  gap: var(--yd-panel-gap);
}
.book-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--yd-text-1);
  font-size: var(--yd-sidebar-font-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-sub {
  margin-top: 1px;
  overflow: hidden;
  color: var(--yd-text-3);
  font-size: var(--yd-library-small-font-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.yd-sidebar-empty {
  /* 追更空态是多行操作提示，保留换行 */
  white-space: pre-line;
}
.status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
