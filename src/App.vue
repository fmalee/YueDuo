<script setup lang="ts">
import { onMounted, ref } from 'vue'
import TabBar from '@/components/TabBar.vue'
import EditorHost from '@/components/EditorHost.vue'
import { useTabs } from '@/composables/useTabs'
import { useEditorCommands } from '@/composables/useEditorCommands'
import { fileReadDraft, fileReadText, nativeSanity } from '@/ipc/bridge'
import { getTabModel, residentModelCount } from '@/composables/useTabLifecycle'
import { useTabsStore } from '@/stores/tabs'

// 阶段 1.2-1.7 验收页：readText → model → setModel 切换 → dirty → 保存 → 标签视觉 → LRU 驻留闭环
const { openFile, newBlankTab, activateTab } = useTabs()
const { saveActive } = useEditorCommands()
const store = useTabsStore()
const status = ref('未打开')
const pathInput = ref('/Users/Joey/Sites/Projects/小说/重生之心动.txt')

// Cmd+N 新建空白标签（方案 §1.5：不弹保存框）
function onWindowKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault()
    newBlankTab()
  }
}

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

// 自动化验收通道（auto=1 时暴露；CDP 调用，非产品路径）
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
  window.addEventListener('keydown', onWindowKeydown)
  if (new URLSearchParams(location.search).get('auto') === '1') {
    Object.assign(globalThis, {
      __yueTest: {
        openFile,
        newBlankTab,
        activateTab,
        editAndSave,
        saveActive,
        // LRU 验收通道（方案 §1.7）
        residentCount: () => residentModelCount(),
        getModelText: (tabId: string) => getTabModel(tabId)?.model.getValue() ?? null,
        readDraft: (tabId: string) => fileReadDraft(tabId),
        applyEdit: (tabId: string, insertText: string) => {
          const entry = getTabModel(tabId)
          if (!entry) return false
          entry.model.applyEdits([
            {
              range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
              text: insertText
            }
          ])
          return true
        },
        tabsState: () => ({
          count: store.tabs.length,
          tabs: store.tabs.map((t) => ({
            id: t.id,
            title: t.title,
            path: t.path,
            dirty: t.dirty
          })),
          active: store.activeTab?.title ?? null
        })
      }
    })
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
