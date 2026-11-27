<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { redo, undo } from '@codemirror/commands'
import TabBar from '@/components/TabBar.vue'
import Sidebar from '@/components/Sidebar.vue'
import EditorHost from '@/components/EditorHost.vue'
import MetadataBar from '@/components/MetadataBar.vue'
import RightPanel from '@/components/RightPanel.vue'
import StatusBar from '@/components/StatusBar.vue'
import CommandPalette from '@/components/CommandPalette.vue'
import { useTabs } from '@/composables/useTabs'
import { useEditorKeybindings } from '@/composables/useEditorKeybindings'
import { useCommandPalette } from '@/composables/useCommandPalette'
import { switchLibrary } from '@/composables/useLibrarySwitch'
import { mountTestHarnessIfNeeded } from '@/composables/useTestHarness'
import { appSyncMenuState, chooseOpenFile, chooseLibrary, onAppMenuCommand } from '@/ipc/bridge'
import {
  getActiveEditor,
  initSession,
  restoreSession,
  retryMissingTabs
} from '@/composables/useSession'
import { useTabsStore } from '@/stores/tabs'
import { useSettingsStore } from '@/stores/settings'
import { useLibraryStore } from '@/stores/library'
import { useReaderStore } from '@/stores/reader'
import { showStatusMessage } from '@/composables/useStatusMessage'
import type { AppMenuPayload, ReaderFont, ThemeMode } from '../shared/types'

const { openFile, newBlankTab, cycleTab, closeTab, closeOtherTabs, closeAllTabs, saveTab } =
  useTabs()
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

/** 顶部「编辑 → 撤消 / 恢复」按焦点分流：原生输入框走 execCommand，编辑器走 CM6（锁定态跳过） */
function runUndoRedo(action: 'undo' | 'redo'): void {
  const active = document.activeElement
  const inCm = active instanceof Element && Boolean(active.closest('.cm-editor'))
  if ((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && !inCm) {
    document.execCommand(action)
    return
  }
  if (inCm) {
    if (reader.locked) return
    const view = getActiveEditor()
    if (!view) return
    if (action === 'undo') undo(view)
    else redo(view)
  }
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
    case 'readerFont':
      void settings.setReaderFont(payload.value as ReaderFont)
      break
    case 'readerFontSize':
      void settings.setReaderFontSize(Number(payload.value))
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
    case 'undo':
    case 'redo':
      runUndoRedo(payload.command)
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

onMounted(async () => {
  // 捕获阶段统一分发快捷键：编辑器会先收到按键，冒泡阶段拦截不稳
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
  mountTestHarnessIfNeeded(runMenuCommand)
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
