<script setup lang="ts">
import { ref } from 'vue'
import { useTabs } from '@/composables/useTabs'
import StarRating from './StarRating.vue'
import type { LibraryBook } from '../../../shared/types'

/**
 * 书库两行列表（方案 §2.5：历史/追更/标签下钻/评分共用）：
 * 首行书名 + 星级，次行作者 · 字数 · 最近阅读；点条目走统一打开流程。
 * 2.5 只展示评分，改分入口留给 2.9 元数据栏与 2.10 Finder 同步。
 */
const props = defineProps<{
  books: LibraryBook[]
  emptyText: string
}>()

defineEmits<{ refresh: [] }>()

const { openFile, activateTab } = useTabs()
const status = ref('')

function formatWords(value: number): string {
  return value >= 10000 ? `${(value / 10000).toFixed(1)}万字` : `${value}字`
}

/** 只展示到分钟：最近阅读用于排序与粗粒度回顾，秒没有意义（同 Python） */
function formatTime(value: number): string {
  if (!value) return '未读'
  const date = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function openBook(book: LibraryBook): Promise<void> {
  status.value = ''
  try {
    // 已打开的标签走 activateTab：同标签也能把焦点交还正文（方案 §1.12 焦点修复）
    const id = await openFile(book.path)
    activateTab(id)
  } catch (e) {
    status.value = `打开失败：${e instanceof Error ? e.message : String(e)}`
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
        :title="`${book.title || book.filename}\n${book.author || '佚名'} · ${book.wordCount.toLocaleString()} 字 · ${formatTime(book.lastReadAt)}\n${book.path}`"
        @click="openBook(book)"
      >
        <div class="row-top">
          <span class="book-title">{{ book.title || book.filename }}</span>
          <StarRating :value="book.rating" readonly />
        </div>
        <div class="row-sub">
          {{ book.author || '佚名' }} · {{ formatWords(book.wordCount) }} ·
          {{ formatTime(book.lastReadAt) }}
        </div>
      </div>
    </div>
    <footer class="yd-panel-footer">
      <span class="status">{{
        status || (props.books.length ? `共 ${props.books.length} 本` : props.emptyText)
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
.status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
