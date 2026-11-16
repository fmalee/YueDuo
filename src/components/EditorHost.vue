<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { monaco, READER_EDITOR_OPTIONS } from '@/monaco'
import { useTabsStore } from '@/stores/tabs'
import {
  getTabModel,
  restoreViewState,
  saveViewState,
  isDirty,
  disposeTabModel
} from '@/composables/useTabLifecycle'
import { useEditorCommands } from '@/composables/useEditorCommands'

const container = ref<HTMLDivElement>()
// 单 Monaco 实例 + 每标签一个 model + setModel 切换（VS Code 同款，方案 §二根因教训 1）
// 绝不用 :key 重建实例 —— 那是旧项目焦点/IME bug 的根源
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>()

const store = useTabsStore()
const { saveActive } = useEditorCommands()

onMounted(() => {
  if (!container.value) return
  editor.value = monaco.editor.create(container.value, {
    ...READER_EDITOR_OPTIONS,
    value: ''
  })

  // dirty 追踪：内容变化后以版本号对比（O(1)，方案 §1.3）
  editor.value.onDidChangeModelContent(() => {
    const id = store.activeTabId
    if (id) store.patchTab(id, { dirty: isDirty(id) })
  })

  // Cmd+S 保存（编辑器焦点内；命令随 editor 实例生命周期销毁）
  editor.value.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    void saveActive(editor.value)
  })

  // 窗口级兜底（焦点在编辑器外时）
  window.addEventListener('keydown', onWindowKeydown)

  applyActiveTab(null)
})

function onWindowKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void saveActive(editor.value)
  }
}

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
  window.removeEventListener('keydown', onWindowKeydown)
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
