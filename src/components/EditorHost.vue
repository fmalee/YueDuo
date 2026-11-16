<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { monaco, READER_EDITOR_OPTIONS } from '@/monaco'
import { useTabsStore } from '@/stores/tabs'
import {
  getTabModel,
  restoreViewState,
  saveViewState
} from '@/composables/useTabLifecycle'
import { disposeTabModel } from '@/composables/useTabLifecycle'

const container = ref<HTMLDivElement>()
// 单 Monaco 实例 + 每标签一个 model + setModel 切换（VS Code 同款，方案 §二根因教训 1）
// 绝不用 :key 重建实例 —— 那是旧项目焦点/IME bug 的根源
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>()

const store = useTabsStore()

onMounted(() => {
  if (!container.value) return
  editor.value = monaco.editor.create(container.value, {
    ...READER_EDITOR_OPTIONS,
    value: ''
  })
  applyActiveTab(null)
})

// activeTabId 变化 → setModel + restoreViewState
watch(
  () => store.activeTabId,
  (newId, oldId) => {
    if (newId === oldId) return
    if (oldId && editor.value) saveViewState(oldId, editor.value)
    applyActiveTab(newId)
  }
)

function applyActiveTab(tabId: string | null): void {
  if (!editor.value) return
  const entry = tabId ? getTabModel(tabId) : undefined
  editor.value.setModel(entry?.model ?? null)
  if (tabId) restoreViewState(tabId, editor.value)
}

onBeforeUnmount(() => {
  // 逐一 dispose 所有标签 model
  for (const t of store.tabs) disposeTabModel(t.id)
  editor.value?.dispose()
})
</script>

<template>
  <div ref="container" class="monaco-container"></div>
</template>

<style scoped>
.monaco-container {
  width: 100%;
  height: 100%;
}
</style>
