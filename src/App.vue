<script setup lang="ts">
import { onMounted, ref } from 'vue'
import TabBar from '@/components/TabBar.vue'
import EditorHost from '@/components/EditorHost.vue'
import { useTabs } from '@/composables/useTabs'
import { useEditorCommands } from '@/composables/useEditorCommands'
import { fileReadText, nativeSanity } from '@/ipc/bridge'
import { getTabModel } from '@/composables/useTabLifecycle'
import { useTabsStore } from '@/stores/tabs'

// 阶段 1.2-1.4 验收页：readText → model → setModel 切换 → dirty → 保存闭环
const { openFile } = useTabs()
const { saveActive } = useEditorCommands()
const store = useTabsStore()
const status = ref('未打开')
const pathInput = ref('/Users/Joey/Sites/Projects/小说/重生之心动.txt')

async function open(): Promise<void> {
  try {
    await openFile(pathInput.value)
    status.value = `已打开 ${store.tabs.length} 个标签`
  } catch (e) {
    status.value = `打开失败：${String(e)}`
  }
}

async function save(): Promise<void> {
  try {
    await saveActive()
    status.value = '已保存'
  } catch (e) {
    status.value = `保存失败：${String(e)}`
  }
}

/** 自动验收：编辑当前标签（applyEdits 单点插入）→ dirty → 保存 → 重读校验（/tmp 独立文件，不碰书库） */
async function editAndSave(): Promise<Record<string, unknown>> {
  const testPath = '/tmp/yue-save-test.txt'
  if (!store.tabs.some((t) => t.path === testPath)) {
    await openFile(testPath)
  }
  const tab = store.tabs.find((t) => t.path === testPath)
  if (!tab || !getTabModel(tab.id)) return { error: '测试标签打开失败' }
  store.setActive(tab.id)
  const mark = `【YUE_SAVE_MARK ${Date.now()}】`
  const entry = getTabModel(tab.id)!
  entry.model.applyEdits([
    { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: mark }
  ])
  const dirtyAfterEdit = store.activeTab?.dirty === true
  await saveActive()
  const dirtyAfterSave = store.activeTab?.dirty === false
  const { text, encoding } = await fileReadText(tab.path)
  return {
    dirtyAfterEdit,
    saved: dirtyAfterSave,
    rereadContainsMark: text.includes(mark),
    savedEncoding: encoding
  }
}

// 自动化验收通道（CDP 调用）
Object.assign(globalThis, { __yueEditAndSave: editAndSave })

async function testIpc(): Promise<void> {
  try {
    const r = await nativeSanity()
    status.value = `IPC OK —— better-sqlite3: ${r.betterSqlite3}，Electron ${r.electron}`
  } catch (e) {
    status.value = `IPC FAIL —— ${String(e)}`
  }
}

onMounted(() => {
  if (new URLSearchParams(location.search).get('auto') === '1') {
    openFile('/Users/Joey/Sites/Projects/小说/重生之心动.txt')
      .then(() => openFile('/Users/Joey/Sites/Projects/小说/风流小保安.txt'))
      .then(() => {
        document.title = 'YUE_TABS_OK'
      })
      .catch((e) => {
        document.title = `YUE_TABS_FAIL:${String(e).slice(0, 80)}`
      })
      .finally(testIpc)
  }
})
</script>

<template>
  <div class="app">
    <header class="bar">
      <input v-model="pathInput" class="path-input" />
      <button @click="open">打开</button>
      <button @click="save">保存 (Cmd+S)</button>
      <button @click="testIpc">IPC</button>
      <span class="hint">{{ status }}</span>
    </header>
    <TabBar />
    <main class="main">
      <EditorHost />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid #ddd;
}
.path-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 3px 6px;
}
.main {
  flex: 1;
  min-height: 0;
}
.hint {
  font-size: 12px;
  color: #888;
  white-space: nowrap;
}
</style>
