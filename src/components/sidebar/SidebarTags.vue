<script setup lang="ts">
import { useLibraryStore } from '@/stores/library'
import { resolveRatingClick } from '@/composables/useRatingGesture'
import SidebarBookList from './SidebarBookList.vue'
import StarRating from './StarRating.vue'
import type { LibraryTagSummary } from '../../../shared/types'

/**
 * 标签页（方案 §2.5）：名称/数量/标签评分三列。
 * 点标签列进入该标签下的书；点星改标签评分（只写库），再点同分取消。
 */
const library = useLibraryStore()

function selectTag(name: string): void {
  void library.selectTag(name)
}

function refreshTags(): void {
  void library.loadTags()
}

function refreshTagBooks(): void {
  void library.loadTagBooks()
}

function rateTag(tag: LibraryTagSummary, clicked: number): void {
  const next = resolveRatingClick(`tag:${tag.name}`, tag.rating, clicked)
  void library.setTagRating(tag.name, next)
}
</script>

<template>
  <div class="yd-panel">
    <template v-if="library.activeTag">
      <div class="tag-books-header">
        <button class="yd-text-button back" title="回到标签列表" @click="library.clearTag()">
          ← 标签
        </button>
        <span class="tag-books-label">「{{ library.activeTag }}」下的书</span>
      </div>
      <SidebarBookList
        :books="library.tagBooks"
        empty-text="该标签下还没有书"
        @refresh="refreshTagBooks"
      />
    </template>

    <template v-else>
      <div class="tag-header">
        <span class="col-name">名称</span>
        <span class="col-count">数量</span>
        <span class="col-rating">评分</span>
      </div>
      <div class="yd-panel-scroll">
        <div
          v-for="tag in library.tags"
          :key="tag.name"
          class="tag-row"
          :title="`查看「${tag.name}」下的书`"
          @click="selectTag(tag.name)"
        >
          <span class="tag-name">{{ tag.name }}</span>
          <span class="tag-count">{{ tag.count }}</span>
          <StarRating :value="tag.rating" @select="rateTag(tag, $event)" />
        </div>
        <div v-if="!library.tags.length" class="yd-sidebar-empty">
          {{ library.root ? '还没有标签' : '尚未选择书架目录' }}
        </div>
      </div>
      <footer class="yd-panel-footer">
        <span>{{ library.tags.length ? `共 ${library.tags.length} 个标签` : '' }}</span>
        <button class="yd-text-button" title="从数据库重新读取标签" @click="refreshTags">
          刷新
        </button>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.tag-books-header {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--yd-panel-gap);
  padding: 3px var(--yd-panel-padding);
  border-bottom: 1px solid var(--yd-border-1);
}
.back {
  padding-left: 0;
}
.tag-books-label {
  min-width: 0;
  overflow: hidden;
  color: var(--yd-text-3);
  font-size: var(--yd-library-small-font-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-header {
  display: flex;
  flex: none;
  align-items: center;
  padding: 3px var(--yd-panel-padding);
  border-bottom: 1px solid var(--yd-border-1);
  color: var(--yd-text-3);
  font-size: var(--yd-library-small-font-size);
}
.tag-header .col-name {
  flex: 1;
}
.tag-header .col-count {
  width: var(--yd-library-count-width);
  text-align: right;
}
.tag-header .col-rating {
  width: calc(var(--yd-star-size) * 5 + 4px);
  text-align: center;
}
.tag-row {
  display: flex;
  align-items: center;
  gap: var(--yd-panel-gap);
  min-height: var(--yd-sidebar-item-height);
  padding: 1px var(--yd-panel-padding);
  cursor: pointer;
}
.tag-row:hover {
  background: var(--yd-hover-1);
}
.tag-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--yd-text-1);
  font-size: var(--yd-sidebar-font-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-count {
  flex: none;
  width: var(--yd-library-count-width);
  color: var(--yd-text-3);
  font-size: var(--yd-library-small-font-size);
  text-align: right;
}
</style>
