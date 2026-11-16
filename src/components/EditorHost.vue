<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef } from 'vue'
import { monaco, READER_EDITOR_OPTIONS } from '@/monaco'

const container = ref<HTMLDivElement>()
// Monaco 实例与 model 全部 shallowRef / 裸引用，绝不进 reactive
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>()
let model: monaco.editor.ITextModel | null = null

const loadInfo = ref('')

onMounted(() => {
  if (!container.value) return
  editor.value = monaco.editor.create(container.value, {
    ...READER_EDITOR_OPTIONS,
    value: ''
  })
})

onBeforeUnmount(() => {
  model?.dispose()
  model = null
  editor.value?.dispose()
})

/** 0.2 验收：一次性 setValue 大文本，返回耗时 */
function loadText(text: string, label: string): number {
  const t0 = performance.now()
  if (!model) {
    model = monaco.editor.createModel(text, 'plaintext')
    editor.value?.setModel(model)
  } else {
    model.setValue(text)
  }
  const dt = performance.now() - t0
  loadInfo.value = `${label}：${(text.length / 1024 / 1024).toFixed(2)}M 字符，setValue + setModel 耗时 ${dt.toFixed(0)}ms`
  return Math.round(dt)
}

defineExpose({ loadText })
</script>

<template>
  <div class="editor-host">
    <div ref="container" class="monaco-container"></div>
    <div v-if="loadInfo" class="load-info">{{ loadInfo }}</div>
  </div>
</template>

<style scoped>
.editor-host {
  position: relative;
  width: 100%;
  height: 100%;
}
.monaco-container {
  width: 100%;
  height: 100%;
}
.load-info {
  position: absolute;
  right: 12px;
  bottom: 12px;
  z-index: 10;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--color-text-2, #888);
  background: var(--color-bg-1, #fff);
  border-radius: 4px;
  pointer-events: none;
}
</style>
