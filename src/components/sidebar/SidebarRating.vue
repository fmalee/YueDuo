<script setup lang="ts">
import { computed } from 'vue'
import { useLibraryStore } from '@/stores/library'
import { resolveRatingClick } from '@/composables/useRatingGesture'
import SidebarBookList from './SidebarBookList.vue'
import StarRating from './StarRating.vue'

/**
 * 评分页（方案 §2.5）：点星星只看该分数，隔一会儿再点同一分数取消筛选；
 * 未筛选时列全部有评分的书（最多 100 本，由主进程限流）。
 */
const library = useLibraryStore()

const hint = computed(() =>
  library.ratingFilter ? `仅显示 ${library.ratingFilter} 星` : '全部有评分（最多 100 本）'
)

function clickStar(clicked: number): void {
  const next = resolveRatingClick('rating-filter', library.ratingFilter ?? 0, clicked)
  void library.setRatingFilter(next || null)
}

function refreshRated(): void {
  void library.loadRated()
}
</script>

<template>
  <SidebarBookList :books="library.rated" empty-text="还没有评分的书" @refresh="refreshRated">
    <template #header>
      <div class="rating-header">
        <StarRating :value="library.ratingFilter ?? 0" @select="clickStar" />
        <span class="hint">{{ hint }}</span>
      </div>
    </template>
  </SidebarBookList>
</template>

<style scoped>
.rating-header {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--yd-panel-gap);
  padding: 3px var(--yd-panel-padding);
  border-bottom: 1px solid var(--yd-border-1);
}
.hint {
  min-width: 0;
  overflow: hidden;
  color: var(--yd-text-3);
  font-size: var(--yd-library-small-font-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
