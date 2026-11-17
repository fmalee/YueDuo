<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import TabBar from '@/components/TabBar.vue'
import Sidebar from '@/components/Sidebar.vue'
import EditorHost from '@/components/EditorHost.vue'
import MetadataBar from '@/components/MetadataBar.vue'
import RightPanel from '@/components/RightPanel.vue'
import StatusBar from '@/components/StatusBar.vue'
import { useTabs } from '@/composables/useTabs'
import { useEditorCommands } from '@/composables/useEditorCommands'
import { fileReadDraft, fileReadText, nativeSanity, chooseLibrary } from '@/ipc/bridge'
import { getTabModel, residentModelCount } from '@/composables/useTabLifecycle'
import { statusMetrics } from '@/composables/useStatusMetrics'
import {
  caretSnapshot,
  initSession,
  injectDraftWriteFailure,
  persistSessionNow,
  progressSnapshot,
  restoreSession,
  scrollSessionTo,
  setCaretForTest
} from '@/composables/useSession'
import { useTabsStore } from '@/stores/tabs'
import { useSettingsStore } from '@/stores/settings'
import { useLibraryStore } from '@/stores/library'
import type { ThemeMode } from '../shared/types'

// 阶段 1.2-1.7 验收页：readText → model → setModel 切换 → dirty → 保存 → 标签视觉 → LRU 驻留闭环
const { openFile, newBlankTab, activateTab } = useTabs()
const { saveActive } = useEditorCommands()
const store = useTabsStore()
const settings = useSettingsStore()
const library = useLibraryStore()
const status = ref('未打开')
const pathInput = ref('/Users/Joey/Sites/Projects/小说/重生之心动.txt')

// Cmd+N 新建空白标签（方案 §1.5：不弹保存框）
function onWindowKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault()
    newBlankTab()
  }
}

/** 外观切换入口（方案 §1.10；正式设置界面后续阶段接管） */
function onAppearanceChange(e: Event): void {
  void settings.setAppearance((e.target as HTMLSelectElement).value as ThemeMode)
}

/** 书库根目录（方案 §1.9）：选择后持久化，并立即作为活动书库打开（§2.5） */
async function pickLibrary(): Promise<void> {
  try {
    const root = await chooseLibrary()
    if (!root) return
    await settings.setLibraryRoot(root)
    await library.open(root)
    status.value = `书库根目录：${root}`
  } catch (e) {
    status.value = `选择书库失败：${String(e)}`
  }
}

function onPreloadChange(e: Event): void {
  const count = Number((e.target as HTMLInputElement).value)
  void settings.setPreloadCount(Number.isFinite(count) ? count : 10)
}

function onCloseButtonChange(e: Event): void {
  void settings.setCloseButtonAlwaysVisible((e.target as HTMLInputElement).checked)
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

onMounted(async () => {
  window.addEventListener('keydown', onWindowKeydown)
  // 会话恢复先于任何打开动作：先挂退出握手，再按库还原标签顺序/active/进度
  initSession()
  try {
    await restoreSession()
  } catch (e) {
    console.error('[session] 恢复会话失败:', e)
  }
  // 书库（方案 §2.5）：按设置里的根打开，列表秒读库、元数据后台补
  try {
    await library.init()
  } catch (e) {
    console.error('[library] 打开书库失败:', e)
  }
  // 恢复出来的 active 标签不会经过 openFile/activateTab，这里补一次最近阅读时间
  if (store.activeTab?.path) void library.markRead(store.activeTab.path)
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
            encoding: t.encoding,
            dirty: t.dirty
          })),
          active: store.activeTab?.title ?? null
        }),
        // 主题验收通道（方案 §1.10）
        themeState: () => ({
          appearance: settings.appearance,
          dark: settings.dark,
          statusBar: { ...statusMetrics }
        }),
        // 会话验收通道（方案 §1.8）：进度取视口顶部行，落盘走真实链路
        sessionProgress: () => progressSnapshot(),
        scrollToLine: (line: number) => scrollSessionTo(line),
        // 光标恢复验收（方案 §1.12）：读光标/视口，或只放光标不滚动
        caretState: () => caretSnapshot(),
        setCaret: (line: number, column: number) => setCaretForTest(line, column),
        flushSession: () => persistSessionNow(),
        failDraftWriteOnce: () => injectDraftWriteFailure(),
        // 设置验收通道（方案 §1.9）：读当前值 / 走真实落盘链路改值
        settingsState: () => settings.snapshot(),
        setLibraryRoot: (root: string) => settings.setLibraryRoot(root),
        setPreloadCount: (count: number) => settings.setPreloadCount(count),
        setSidebarWidth: (width: number) => settings.setSidebarWidth(width),
        // 书库验收通道（方案 §2.5）：四类列表 + 标签下钻 + 评分筛选状态
        libraryState: () => ({
          root: library.root,
          scanning: library.scanning,
          scanned: library.scanned,
          lastEnrich: library.lastEnrich,
          error: library.error,
          history: library.history.map((b) => b.title),
          following: library.following.map((b) => b.title),
          tags: library.tags.map((t) => `${t.name}:${t.count}:${t.rating}`),
          activeTag: library.activeTag,
          tagBooks: library.tagBooks.map((b) => b.title),
          ratingFilter: library.ratingFilter,
          rated: library.rated.map((b) => b.title)
        }),
        openLibraryRoot: (root: string) => library.open(root),
        libraryRefresh: () => library.refreshLists(),
        libraryEnrich: () => library.enrich()
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

// HMR 会重挂载根组件：不清理会让 window 上的 Cmd+N 监听器逐次叠加（一次按键新建多个标签）
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
})
</script>

<template>
  <div class="app">
    <header class="bar">
      <input v-model="pathInput" class="path-input" />
      <button @click="open">打开</button>
      <button @click="save">保存 (Cmd+S)</button>
      <button @click="testIpc">IPC</button>
      <select :value="settings.appearance" @change="onAppearanceChange">
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
      <button
        class="lib-btn"
        :title="settings.libraryRoot || '尚未设置书库根目录'"
        @click="pickLibrary"
      >
        书库
      </button>
      <span class="library-path" :title="settings.libraryRoot">
        {{ settings.libraryRoot || '未设置书库' }}
      </span>
      <label class="opt">
        预载
        <input
          class="preload-input"
          type="number"
          min="0"
          max="20"
          :value="settings.preloadCount"
          @change="onPreloadChange"
        />
      </label>
      <label class="opt">
        <input
          type="checkbox"
          :checked="settings.closeButtonAlwaysVisible"
          @change="onCloseButtonChange"
        />
        × 常驻
      </label>
      <span class="hint">{{ status }}</span>
    </header>
    <div class="workspace">
      <Sidebar />
      <div class="editor-column">
        <TabBar />
        <main class="main">
          <EditorHost />
        </main>
        <!-- 元数据栏（方案 §2.9）：编辑器下方、状态栏上方 -->
        <MetadataBar />
      </div>
      <RightPanel />
    </div>
    <StatusBar />
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
  border-bottom: 1px solid var(--yd-border-1);
  background: var(--yd-bg-2);
}
.path-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 3px 6px;
  border: 1px solid var(--yd-border-1);
  background: var(--yd-bg-1);
  color: var(--yd-text-1);
}
.workspace {
  display: flex;
  flex: 1;
  min-height: 0;
}
.editor-column {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.main {
  flex: 1;
  min-height: 0;
}
.hint {
  font-size: 12px;
  color: var(--yd-text-3);
  white-space: nowrap;
}
.library-path {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--yd-text-3);
}
.opt {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: var(--yd-text-2);
  white-space: nowrap;
}
.preload-input {
  width: 48px;
  padding: 2px 4px;
  border: 1px solid var(--yd-border-1);
  background: var(--yd-bg-1);
  color: var(--yd-text-1);
  font-size: 12px;
}
</style>
