<script setup lang="ts">
import { useChapters } from '@/composables/useChapters'
import { jumpToLine } from '@/composables/useSession'
import BookmarkList from './BookmarkList.vue'
import type { BookmarkInfo } from '../../../shared/types'

/**
 * 右栏「章节」页（方案 §2.6）：上方章节列表占 2/3，下方本书书签占 1/3。
 * 章节由主进程在后台提取，保存后由 useEditorCommands 触发重提；点击条目按行号跳转。
 */
const props = defineProps<{
  bookmarks: BookmarkInfo[]
  path: string
}>()

const { chapters, loading, error } = useChapters()

function jump(line: number): void {
  jumpToLine(line)
}
</script>

<template>
  <div class="chapter-page">
    <section class="chapter-section">
      <div class="section-title">
        <span>章节</span>
        <span v-if="chapters.length" class="section-count">{{ chapters.length }}</span>
      </div>
      <div class="yd-panel-scroll">
        <div
          v-for="chapter in chapters"
          :key="`${chapter.line}:${chapter.title}`"
          class="chapter-row"
          :title="`第 ${chapter.line} 行`"
          @click="jump(chapter.line)"
        >
          {{ chapter.title }}
        </div>
        <div v-if="loading" class="yd-sidebar-empty">正在提取章节…</div>
        <div v-else-if="error" class="yd-sidebar-empty">章节提取失败：{{ error }}</div>
        <div v-else-if="!chapters.length" class="yd-sidebar-empty">尚未提取章节</div>
      </div>
    </section>

    <section class="bookmark-section">
      <div class="section-title">
        <span>书签</span>
        <span v-if="props.bookmarks.length" class="section-count">
          {{ props.bookmarks.length }}
        </span>
      </div>
      <BookmarkList :bookmarks="props.bookmarks" :path="props.path" empty-text="暂无书签" />
    </section>
  </div>
</template>

<style scoped>
.chapter-page {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
/* 章节占 2/3、书签占 1/3（方案 §2.6，与 Python 章节页布局一致） */
.chapter-section {
  display: flex;
  flex: 2;
  flex-direction: column;
  min-height: 0;
}
.bookmark-section {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--yd-border-1);
}
.section-title {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--yd-panel-gap);
  padding: 3px var(--yd-panel-padding);
  color: var(--yd-text-3);
  font-size: var(--yd-library-small-font-size);
  font-weight: 600;
}
/* 下方书签标题与分割线留出间距，避免贴边（用户实测反馈） */
.bookmark-section > .section-title {
  padding-top: var(--yd-panel-padding);
}
.section-count {
  font-weight: 400;
}
.chapter-row {
  min-height: var(--yd-sidebar-item-height);
  padding: 2px var(--yd-panel-padding);
  overflow: hidden;
  color: var(--yd-text-1);
  font-size: var(--yd-sidebar-font-size);
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.chapter-row:hover {
  background: var(--yd-hover-1);
}
</style>
