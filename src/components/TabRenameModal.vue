<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { focusEditor } from '@/composables/useSession'

/**
 * 标签重命名浮层（方案 §3.5）：自绘轻量对话框，与整体视觉一致，不依赖原生输入框。
 */
const props = defineProps<{
  onSubmit: (tabId: string, newName: string) => Promise<string | null>
}>()

const state = ref<{ tabId: string; value: string; error: string } | null>(null)
const inputEl = ref<HTMLInputElement>()

function open(tabId: string, initialName: string): void {
  state.value = { tabId, value: initialName, error: '' }
  void nextTick(() => {
    inputEl.value?.focus()
    inputEl.value?.select()
  })
}

function cancel(): void {
  if (!state.value) return
  state.value = null
  focusEditor()
}

async function submit(): Promise<void> {
  const current = state.value
  if (!current) return
  current.error = ''
  const error = await props.onSubmit(current.tabId, current.value)
  if (error) {
    current.error = error
    return
  }
  state.value = null
  focusEditor()
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && state.value) cancel()
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
})

defineExpose({ open })
</script>

<template>
  <Teleport to="body">
    <div v-if="state" class="rename-overlay" @mousedown.self="cancel">
      <div class="rename-panel" role="dialog" aria-label="重命名">
        <div class="rename-title">重命名</div>
        <input
          ref="inputEl"
          v-model="state.value"
          class="rename-input"
          spellcheck="false"
          @keydown.enter.prevent="submit"
          @keydown.esc.prevent="cancel"
        />
        <div v-if="state.error" class="rename-error">{{ state.error }}</div>
        <div class="rename-actions">
          <button class="rename-button" @click="cancel">取消</button>
          <button class="rename-button primary" @click="submit">确定</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.rename-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: var(--yd-palette-top-offset);
  background: var(--yd-overlay);
}
.rename-panel {
  display: flex;
  flex-direction: column;
  gap: var(--yd-rename-gap);
  box-sizing: border-box;
  width: min(var(--yd-rename-width), calc(100vw - 40px));
  padding: var(--yd-rename-padding);
  background: var(--yd-bg-1);
  border: 1px solid var(--yd-border-1);
  border-radius: var(--yd-palette-radius);
  box-shadow: 0 12px 32px var(--yd-shadow);
}
.rename-title {
  color: var(--yd-text-1);
  font-size: var(--yd-palette-font-size);
}
.rename-input {
  box-sizing: border-box;
  width: 100%;
  height: var(--yd-find-input-height);
  padding: 0 var(--yd-find-input-padding-x);
  color: var(--yd-text-1);
  font-family: inherit;
  font-size: var(--yd-palette-font-size);
  background: var(--yd-bg-3);
  border: 1px solid var(--yd-border-1);
  border-radius: var(--yd-find-input-radius);
  outline: none;
}
.rename-input:focus {
  border-color: var(--yd-accent);
}
.rename-error {
  color: var(--yd-danger);
  font-size: var(--yd-palette-meta-font-size);
}
.rename-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--yd-rename-gap);
}
.rename-button {
  padding: var(--yd-rename-button-padding-y) var(--yd-rename-button-padding-x);
  color: var(--yd-text-2);
  font-family: inherit;
  font-size: var(--yd-find-font-size);
  background: transparent;
  border: 1px solid var(--yd-border-1);
  border-radius: var(--yd-palette-key-radius);
  cursor: pointer;
}
.rename-button:hover {
  background: var(--yd-hover-1);
}
.rename-button.primary {
  color: var(--yd-bg-1);
  background: var(--yd-accent);
  border-color: var(--yd-accent);
}
</style>
