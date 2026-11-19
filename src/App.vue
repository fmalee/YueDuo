<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TabBar from '@/components/TabBar.vue'
import Sidebar from '@/components/Sidebar.vue'
import EditorHost from '@/components/EditorHost.vue'
import MetadataBar from '@/components/MetadataBar.vue'
import RightPanel from '@/components/RightPanel.vue'
import StatusBar from '@/components/StatusBar.vue'
import CommandPalette from '@/components/CommandPalette.vue'
import { useTabs } from '@/composables/useTabs'
import { useEditorCommands } from '@/composables/useEditorCommands'
import { useEditorKeybindings } from '@/composables/useEditorKeybindings'
import { useCommandPalette } from '@/composables/useCommandPalette'
import { switchLibrary } from '@/composables/useLibrarySwitch'
import {
  appSyncMenuState,
  fileReadDraft,
  fileReadText,
  chooseOpenFile,
  chooseLibrary,
  onAppMenuCommand
} from '@/ipc/bridge'
import { getTabModel, residentModelCount } from '@/composables/useTabLifecycle'
import { statusMetrics } from '@/composables/useStatusMetrics'
import {
  caretSnapshot,
  initSession,
  injectDraftWriteFailure,
  persistSessionNow,
  progressSnapshot,
  restoreSession,
  retryMissingTabs,
  scrollSessionTo,
  setCaretForTest
} from '@/composables/useSession'
import { useTabsStore } from '@/stores/tabs'
import { useSettingsStore } from '@/stores/settings'
import { useLibraryStore } from '@/stores/library'
import { useReaderStore } from '@/stores/reader'
import { showStatusMessage } from '@/composables/useStatusMessage'
import type { AppMenuPayload, ThemeMode } from '../shared/types'

// 阶段 1.2-1.7 验收页：readText → model → setModel 切换 → dirty → 保存 → 标签视觉 → LRU 驻留闭环
const {
  openFile,
  newBlankTab,
  activateTab,
  cycleTab,
  closeTab,
  closeOtherTabs,
  closeAllTabs,
  saveTab,
  renameTab,
  deleteTabFile,
  revealTabFile
} = useTabs()
const { saveActive } = useEditorCommands()
const palette = useCommandPalette()
const store = useTabsStore()
const settings = useSettingsStore()
const library = useLibraryStore()
const reader = useReaderStore()

/**
 * 对账扫完（启动后台 enrich / 手动刷新）后，把恢复时缺失的标签按 book_id 重连一次：
 * 书籍移动由 books.relative_path 保留 id 自动跟随，这里只更新标签的绝对路径并重新加载
 */
watch(
  () => library.scanning,
  (scanning) => {
    if (!scanning) {
      void retryMissingTabs().catch((e) => console.error('[session] 缺失标签重连失败:', e))
    }
  }
)

/** 左右侧栏显隐：窗口菜单勾选项驱动，会话内有效 */
const leftVisible = ref(true)
const rightVisible = ref(true)

/** 查找/替换与文本转换由编辑器侧组件响应，菜单/快捷键只转交意图 */
function dispatchEditorCommand(
  event: 'yueduo:findReplace' | 'yueduo:convert',
  detail: string
): void {
  window.dispatchEvent(new CustomEvent(event, { detail }))
}

// Cmd+N / Cmd+P / Cmd+L / Cmd+S / Cmd+B / Shift+Cmd+B 统一由 useEditorKeybindings 分发，
// 编辑器内外同一行为（方案：快捷键收口）；侧栏显隐由键盘直接翻转当前状态
const { install: installKeybindings } = useEditorKeybindings({
  toggleSidebar: () => {
    leftVisible.value = !leftVisible.value
  },
  toggleRightPanel: () => {
    rightVisible.value = !rightVisible.value
  }
})
let disposeKeybindings: (() => void) | null = null

/**
 * 侧栏显隐变化回写应用菜单勾选：菜单点选时 Electron 自己改 checked，
 * 键盘切换不经过菜单，得由应用状态推一次，否则「显示/窗口」里的勾选会掉队。
 * 同步失败只影响菜单勾选，不影响界面状态。
 */
watch(
  [leftVisible, rightVisible],
  ([sidebarVisible, rightPanelVisible]) => {
    void appSyncMenuState({ sidebarVisible, rightPanelVisible }).catch(() => undefined)
  },
  { immediate: true }
)

/**
 * 顶部应用菜单命令（方案 §3.5）：保存/关闭类动作与标签右键菜单共用 useTabs 实现，
 * 这里只按当前 active 标签分发；打开/书库/外观/预载/关闭按钮走各自既有链路。
 */
function runMenuCommand(payload: AppMenuPayload): void {
  const id = store.activeTabId
  switch (payload.command) {
    case 'open':
      void openFromDialog()
      break
    case 'chooseLibrary':
      void pickLibrary()
      break
    case 'appearance':
      void settings.setAppearance(payload.value as ThemeMode)
      break
    case 'toggleCloseButton':
      void settings.setCloseButtonAlwaysVisible(payload.value === true)
      break
    case 'preloadCount':
      void settings.setPreloadCount(Number(payload.value))
      break
    case 'save':
      if (id) {
        void saveTab(id).catch((e) => showStatusMessage(`保存失败：${String(e)}`, 5000))
      }
      break
    case 'closeTab':
      if (id) void closeTab(id)
      break
    case 'closeOthers':
      if (id) void closeOtherTabs(id)
      break
    case 'closeAll':
      void closeAllTabs()
      break
    case 'newTab':
      newBlankTab()
      break
    case 'quickSearch':
      palette.toggle()
      break
    case 'find':
      dispatchEditorCommand('yueduo:findReplace', 'find')
      break
    case 'replace':
      dispatchEditorCommand('yueduo:findReplace', 'replace')
      break
    case 'tidy':
      dispatchEditorCommand('yueduo:convert', 'tidy')
      break
    case 'toSimplified':
      dispatchEditorCommand('yueduo:convert', 'toSimplified')
      break
    case 'toTraditional':
      dispatchEditorCommand('yueduo:convert', 'toTraditional')
      break
    case 'toHalfwidth':
      dispatchEditorCommand('yueduo:convert', 'toHalfwidth')
      break
    case 'toggleLock':
      reader.toggle()
      break
    case 'toggleSidebar':
      leftVisible.value = payload.value !== false
      break
    case 'toggleRightPanel':
      rightVisible.value = payload.value !== false
      break
    case 'nextTab':
      cycleTab(1)
      break
    case 'prevTab':
      cycleTab(-1)
      break
  }
}

let unsubscribeMenu: (() => void) | null = null

/** 「文件 → 打开…」：选文件后走既有 openFile（去重/会话/最近阅读一并生效） */
async function openFromDialog(): Promise<void> {
  try {
    const path = await chooseOpenFile()
    if (path) await openFile(path)
  } catch (e) {
    showStatusMessage(`打开失败：${String(e)}`, 5000)
  }
}

/** 书库根目录（方案 §1.9 / §2.13）：选择后走换库事务，成功才持久化新根 */
async function pickLibrary(): Promise<void> {
  try {
    const root = await chooseLibrary()
    if (!root) return
    const ok = await switchLibrary(root)
    showStatusMessage(ok ? `书库根目录：${root}` : `换库失败：${library.error}`, 5000)
  } catch (e) {
    showStatusMessage(`选择书库失败：${String(e)}`, 5000)
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

onMounted(async () => {
  // 捕获阶段统一分发快捷键：Monaco 的编辑器会先收到按键，冒泡阶段拦截不稳
  disposeKeybindings = installKeybindings()
  unsubscribeMenu = onAppMenuCommand(runMenuCommand)
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
        // 菜单命令验收通道（方案 §3.5）：与顶部菜单共用同一套动作
        menuCommand: (command: AppMenuPayload['command'], value?: AppMenuPayload['value']) =>
          runMenuCommand(value === undefined ? { command } : { command, value }),
        saveTab,
        renameTab,
        deleteTabFile,
        revealTabFile,
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
          fallback: library.fallback,
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
        openLibraryRoot: (root: string) => switchLibrary(root),
        libraryRefresh: () => library.refreshLists(),
        libraryEnrich: () => library.enrich(),
        // 快速检索验收通道（方案 §2.12）：走真实快照 + 120ms 防抖链路
        paletteState: () => ({
          visible: palette.visible.value,
          query: palette.query.value,
          results: palette.results.value.map((entry) => entry.title),
          selected: palette.selectedIndex.value
        }),
        openPalette: () => palette.open(),
        closePalette: () => palette.close(),
        setPaletteQuery: (value: string) => {
          palette.query.value = value
        }
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
  }
})

// HMR 会重挂载根组件：不清理会让 window 上的快捷键监听器逐次叠加（一次按键新建多个标签）
onBeforeUnmount(() => {
  disposeKeybindings?.()
  unsubscribeMenu?.()
})
</script>

<template>
  <div class="app">
    <div class="workspace">
      <Sidebar v-show="leftVisible" />
      <div class="editor-column">
        <TabBar />
        <main class="main">
          <EditorHost />
        </main>
        <!-- 元数据栏（方案 §2.9）：编辑器下方、状态栏上方 -->
        <MetadataBar />
      </div>
      <RightPanel v-show="rightVisible" />
    </div>
    <StatusBar />
    <!-- 命令面板（方案 §2.12）：Cmd+P 唤出，Teleport 到 body -->
    <CommandPalette />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
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
</style>
