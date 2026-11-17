<script setup lang="ts">
import { computed } from 'vue'

/**
 * 五星评分控件（方案 §2.5 标签评分 / 评分页筛选 / 书籍行展示）。
 * 只负责发光标点击的星数，取消手势由调用方用 useRatingGesture 判定（与 Python 同口径）。
 */
const props = withDefaults(
  defineProps<{
    value: number
    readonly?: boolean
  }>(),
  { readonly: false }
)

const emit = defineEmits<{ select: [value: number] }>()

const stars = computed(() => [1, 2, 3, 4, 5])
const active = computed(() => Math.max(0, Math.min(5, props.value)))

function onClick(star: number): void {
  if (!props.readonly) emit('select', star)
}
</script>

<template>
  <span
    class="stars"
    :class="{ readonly }"
    :title="readonly ? undefined : '点第几颗星就是几分；隔一会儿再点同一分数可取消'"
  >
    <span
      v-for="star in stars"
      :key="star"
      class="star"
      :class="{ filled: star <= active }"
      @click.stop="onClick(star)"
    >
      {{ star <= active ? '★' : '☆' }}
    </span>
  </span>
</template>

<style scoped>
.stars {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 1px;
  font-size: var(--yd-star-size);
  line-height: 1;
  white-space: nowrap;
}
.star {
  color: var(--yd-text-3);
  cursor: pointer;
}
.star.filled {
  color: var(--yd-accent);
}
.stars.readonly {
  cursor: default;
}
.stars.readonly .star {
  cursor: default;
}
</style>
