<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useTabsStore } from '@/stores/tabs'
import { useReaderStore } from '@/stores/reader'
import { useMetadataEdit } from '@/composables/useMetadataEdit'
import { resolveRatingClick } from '@/composables/useRatingGesture'
import { getTabModel } from '@/composables/useTabLifecycle'
import { statusMetrics } from '@/composables/useStatusMetrics'
import { metaReadMetadata, metaReadRating } from '@/ipc/bridge'
import { monaco } from '@/monaco'
import { parseMetadata } from '../../shared/metadataParser'
import StarRating from './sidebar/StarRating.vue'
import type { MetadataField, ParsedMetadata } from '../../shared/types'

/**
 * 元数据栏（方案 §2.9）：编辑器下方、状态栏上方，编辑名称/作者/标签/评分四项。
 * 文本三项只走 useMetadataEdit（§2.8 写回链路：最小可撤销编辑、保留光标与 dirty）；
 * 评分与文本三项同一入口、同一判定：只要有路径就能编辑，库内写库 + Finder 星级，
 * 库外只写文件 Finder 星级（评分不在正文里，读写都由 meta:readRating/applyRating 分流）。
 * 双向同步（§2.9/§2.10 补正）：正文前 10 行是基准，直接用 shared/metadataParser
 * 在渲染层本地解析（与主进程同一份正则），只在头部真的变化时刷新；正在栏内编辑的
 * 那一项以栏内草稿为准，刷新不触碰焦点。
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
/** 与主进程扫描同一切法：元数据只在前 10 行，不复制全文 */
const HEAD_LINES = 10

const store = useTabsStore()
const reader = useReaderStore()
const { applyMetadataField, applyRating } = useMetadataEdit()

const title = ref('')
const author = ref('')
const tags = ref('')
const rating = ref(0)

const editing = ref<EditableField | null>(null)
const draft = ref('')
const barEl = ref<HTMLElement | null>(null)

/** 标签页切换/连续提交时丢弃过期结果 */
let loadGeneration = 0
/** 评分写回代际：连续点击或切走标签时只认最新一次，避免旧结果回退新值 */
let ratingWriteGeneration = 0

/** 当前挂上监听的 model 与上次头部文本（相同则不刷新栏位） */
let attachedModel: monaco.editor.ITextModel | null = null
let detachModel: monaco.IDisposable | null = null
let lastHead = ''

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
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function dirName(path: string): string {
  const parent = path.slice(0, path.lastIndexOf('/'))
  return parent.slice(parent.lastIndexOf('/') + 1)
}

/** 正文前 10 行 → 本地解析；正在编辑的那一项保留栏内草稿（以栏内为准） */
function applyTextMetadata(head: string): void {
  const path = store.activeTab?.path
  if (!path) return
  const meta = parseMetadata(head, fileName(path), dirName(path))
  if (editing.value !== 'title') title.value = meta.title
  if (editing.value !== 'author') author.value = meta.author
  if (editing.value !== 'tags') tags.value = meta.tags.join(' ')
}

function headText(model: monaco.editor.ITextModel): string {
  const count = Math.min(HEAD_LINES, model.getLineCount())
  const lines: string[] = []
  for (let i = 1; i <= count; i++) lines.push(model.getLineContent(i))
  return lines.join('\n')
}

/**
 * 挂当前标签的 model 监听：切换/重载后 model 变了就重挂。
 * 返回 false 表示暂时没有 model（调用方回退读盘解析）。
 */
function attachToActiveModel(): boolean {
  const tab = store.activeTab
  const model = tab?.path ? (getTabModel(tab.id)?.model ?? null) : null
  if (model === attachedModel) return model !== null

  detachModel?.dispose()
  detachModel = null
  attachedModel = model
  if (!model) return false

  lastHead = headText(model)
  applyTextMetadata(lastHead)
  detachModel = model.onDidChangeContent(() => {
    if (attachedModel !== model) return
    const head = headText(model)
    if (head === lastHead) return
    lastHead = head
    applyTextMetadata(head)
  })
  return true
}

function detachActiveModel(): void {
  detachModel?.dispose()
  detachModel = null
  attachedModel = null
  lastHead = ''
}

/**
 * 首屏：文本三项以编辑器正文为准（有 model 就在本地解析，不读盘也不走 IPC）；
 * 评分不在正文里，与书名/标签同一判定——有路径就能读（库内 books，库外文件星级）。
 */
async function load(): Promise<void> {
  const gen = ++loadGeneration
  editing.value = null
  const path = store.activeTab?.path ?? ''
  if (!path) {
    clear()
    detachActiveModel()
    return
  }

  if (!attachToActiveModel()) {
    try {
      const meta = await metaReadMetadata(path)
      if (gen === loadGeneration) assignMetadata(meta)
    } catch {
      if (gen === loadGeneration) assignMetadata({ title: '', author: '', tags: [] })
    }
  }

  const info = await metaReadRating(path).catch(() => null)
  if (gen !== loadGeneration || !info) return
  rating.value = info.rating
}

/** 标签切换 / 另存为改变路径时重读：评分入口只看路径，与文本三项同步就绪 */
watch([() => store.activeTabId, () => store.activeTab?.path], () => void load(), {
  immediate: true
})

// 标签从 LRU 重载回来时 model 才驻留：状态栏指标随 setModel 刷新，借此补挂监听
watch(
  () => [statusMetrics.lineCount, statusMetrics.charCount],
  () => void attachToActiveModel()
)

onBeforeUnmount(() => detachActiveModel())

// 锁定阅读（方案 §3.3，同 Python metadata_bar.set_locked）：正文只读时元数据也不可编辑
watch(
  () => reader.locked,
  (locked) => {
    if (locked) editing.value = null
  }
)

function display(field: EditableField): string {
  if (field === 'title') return title.value
  if (field === 'author') return author.value
  return tags.value
}

function startEdit(field: EditableField): void {
  if (reader.locked) return
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

/**
 * 评分：与文本三项同一入口（useMetadataEdit.applyRating），只要求有路径；
 * 库内写库 + 文件星级，库外只写文件 Finder 星级，写不进去就回退，不假装成功。
 */
async function clickStar(star: number): Promise<void> {
  const path = store.activeTab?.path
  if (!path || reader.locked) return
  const previous = rating.value
  const next = resolveRatingClick(`metadata-bar:${path}`, previous, star)
  rating.value = next
  const gen = ++ratingWriteGeneration
  const result = await applyRating(next).catch(() => null)
  // 写回途中切走标签 / 又点了别的分数：以最新一次为准
  if (gen !== ratingWriteGeneration || store.activeTab?.path !== path) return
  if (!result || !result.persisted) {
    rating.value = previous
    if (result && !result.persisted) console.warn('[metadata] 文件星级写入失败：', path)
    return
  }
  rating.value = result.rating
}
</script>

<template>
  <div
    v-if="store.activeTab?.path"
    ref="barEl"
    class="metadata-bar"
    :class="{ locked: reader.locked }"
  >
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
      :class="{ disabled: reader.locked }"
      :title="
        reader.locked
          ? '已锁定，解锁后可编辑'
          : '点第几颗星就是几分；隔一会儿再点同一分数可取消。库外文件的评分保存在文件星级（Finder 评分）里'
      "
    >
      <span class="meta-label">评分</span>
      <StarRating :value="rating" :readonly="reader.locked" @select="clickStar" />
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
.metadata-bar.locked .meta-value {
  color: var(--yd-text-3);
  cursor: default;
}
.metadata-bar.locked .meta-value:hover {
  background: transparent;
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
