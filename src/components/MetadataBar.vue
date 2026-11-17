<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useTabsStore } from '@/stores/tabs'
import { useLibraryStore } from '@/stores/library'
import { useMetadataEdit } from '@/composables/useMetadataEdit'
import { resolveRatingClick } from '@/composables/useRatingGesture'
import { libraryBookByPath, metaReadMetadata } from '@/ipc/bridge'
import StarRating from './sidebar/StarRating.vue'
import type { MetadataField, ParsedMetadata } from '../../shared/types'

/**
 * 元数据栏（方案 §2.9）：编辑器下方、状态栏上方，编辑名称/作者/标签/评分四项。
 * 文本三项只走 useMetadataEdit（§2.8 写回链路：最小可撤销编辑、保留光标与 dirty）；
 * 评分只走 2.5 的 library.setBookRating（库内评分 + Finder 星级），不另开写入路径。
 * 交互：点击进入编辑、回车提交上屏、失焦取消；星星沿用「再点同分清零」手势。
 */
type EditableField = MetadataField

const FIELDS: EditableField[] = ['title', 'author', 'tags']
const LABELS: Record<EditableField, string> = { title: '名称', author: '作者', tags: '标签' }
const PLACEHOLDERS: Record<EditableField, string> = {
  title: '书名',
  author: '作者',
  tags: '空格或逗号分隔'
}

const store = useTabsStore()
const library = useLibraryStore()
const { applyMetadataField } = useMetadataEdit()

const title = ref('')
const author = ref('')
const tags = ref('')
const rating = ref(0)
/** 库内 book id；null = 文件不在活动书库，评分入口禁用 */
const bookId = ref<number | null>(null)

const editing = ref<EditableField | null>(null)
const draft = ref('')
const barEl = ref<HTMLElement | null>(null)

/** 标签页切换/连续提交时丢弃过期结果 */
let loadGeneration = 0

function assignMetadata(meta: Pick<ParsedMetadata, 'title' | 'author' | 'tags'>): void {
  title.value = meta.title
  author.value = meta.author
  tags.value = meta.tags.join(' ')
}

function clear(): void {
  title.value = ''
  author.value = ''
  tags.value = ''
  rating.value = 0
  bookId.value = null
}

/** 首屏：库内记录一次拿全（含评分）；库外/未入库回退按磁盘正文解析 */
async function load(): Promise<void> {
  const gen = ++loadGeneration
  editing.value = null
  const path = store.activeTab?.path ?? ''
  if (!path) {
    clear()
    return
  }
  try {
    const book = await libraryBookByPath(path)
    if (gen !== loadGeneration) return
    if (book) {
      bookId.value = book.id
      rating.value = book.rating
      assignMetadata(book)
      return
    }
  } catch {
    // 书库尚未打开或查询失败：继续走读盘解析，不打扰阅读
  }
  if (gen !== loadGeneration) return
  bookId.value = null
  rating.value = 0
  try {
    const meta = await metaReadMetadata(path)
    if (gen !== loadGeneration) return
    assignMetadata(meta)
  } catch {
    if (gen === loadGeneration) clear()
  }
}

watch([() => store.activeTabId, () => store.activeTab?.path], () => void load(), {
  immediate: true
})

function display(field: EditableField): string {
  if (field === 'title') return title.value
  if (field === 'author') return author.value
  return tags.value
}

function startEdit(field: EditableField): void {
  draft.value = display(field)
  editing.value = field
  void nextTick(() => {
    const input = barEl.value?.querySelector<HTMLInputElement>('.meta-input')
    input?.focus()
    input?.select()
  })
}

/** 失焦/Esc 取消：丢掉草稿，保留原值 */
function cancelEdit(field: EditableField): void {
  if (editing.value === field) editing.value = null
}

/** 回车提交：先收起输入框（避免 blur 再触发取消），再走 2.8 写回链路 */
async function commitEdit(field: EditableField): Promise<void> {
  if (editing.value !== field) return
  const value = draft.value
  editing.value = null
  try {
    const result = await applyMetadataField(field, value)
    // null = 空书名/空标签放弃提交（对齐 2.8）
    if (result) assignMetadata(result.metadata)
  } catch {
    // 提交失败保留原值，状态栏/日志由主进程侧收敛
  }
}

/** 评分：同一链路写库 + Finder 星级；再点同分由 2.5 的手势判定清零 */
function clickStar(star: number): void {
  const id = bookId.value
  if (id === null) return
  const next = resolveRatingClick(`metadata-bar:${id}`, rating.value, star)
  rating.value = next
  void library.setBookRating(id, next)
}
</script>

<template>
  <div v-if="store.activeTab?.path" ref="barEl" class="metadata-bar">
    <div v-for="field in FIELDS" :key="field" class="meta-field" :class="field">
      <span class="meta-label">{{ LABELS[field] }}</span>
      <input
        v-if="editing === field"
        v-model="draft"
        class="meta-input"
        type="text"
        :placeholder="PLACEHOLDERS[field]"
        @keydown.enter.prevent="commitEdit(field)"
        @keydown.esc.prevent="cancelEdit(field)"
        @blur="cancelEdit(field)"
      />
      <span
        v-else
        class="meta-value"
        :title="display(field) || PLACEHOLDERS[field]"
        @click="startEdit(field)"
      >
        {{ display(field) || PLACEHOLDERS[field] }}
      </span>
    </div>
    <div
      class="meta-rating"
      :class="{ disabled: bookId === null }"
      :title="
        bookId === null
          ? '这本书不在当前书库中，评分只对库内书籍开放'
          : '点第几颗星就是几分；隔一会儿再点同一分数可取消'
      "
    >
      <span class="meta-label">评分</span>
      <StarRating :value="rating" :readonly="bookId === null" @select="clickStar" />
    </div>
  </div>
</template>

<style scoped>
.metadata-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--yd-metadata-gap);
  height: var(--yd-metadata-bar-height);
  padding: 0 var(--yd-metadata-padding-x);
  border-top: 1px solid var(--yd-border-1);
  background: var(--yd-bg-2);
  color: var(--yd-text-1);
  font-size: var(--yd-metadata-font-size);
}
.meta-field {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--yd-metadata-label-gap);
  min-width: 0;
}
.meta-field.title,
.meta-field.tags {
  flex: 2;
}
.meta-label {
  flex: none;
  color: var(--yd-text-3);
}
/* 展示态与输入态同尺寸，点击切换时不跳动 */
.meta-value,
.meta-input {
  flex: 1;
  min-width: 0;
  padding: var(--yd-metadata-input-padding-y) var(--yd-metadata-input-padding-x);
  border: 1px solid transparent;
  border-radius: var(--yd-metadata-radius);
  overflow: hidden;
  font-size: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta-value {
  color: var(--yd-text-1);
  cursor: text;
}
.meta-value:hover {
  background: var(--yd-hover-1);
}
.meta-input {
  border-color: var(--yd-border-1);
  outline: none;
  background: var(--yd-bg-1);
  color: var(--yd-text-1);
  font-family: inherit;
}
.meta-input:focus {
  border-color: var(--yd-accent);
}
.meta-rating {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--yd-metadata-label-gap);
  padding-left: var(--yd-metadata-padding-x);
  border-left: 1px solid var(--yd-border-1);
}
.meta-rating.disabled {
  opacity: 0.5;
}
</style>
