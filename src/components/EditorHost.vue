<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { ChangeSet, Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { destroyReaderView, tabIdField } from '@/editor/codemirror'
import { currentDocVersion } from '@/editor/dirtyState'
import { useTabsStore } from '@/stores/tabs'
import { useSettingsStore } from '@/stores/settings'
import { useLibraryStore } from '@/stores/library'
import { useReaderStore } from '@/stores/reader'
import {
  disposeTabModel,
  emitEditorViewUpdate,
  getTabState,
  isDirty,
  setPreloadCount,
  syncTabState
} from '@/composables/useTabLifecycle'
import {
  convertInvoker,
  useEditorCommands,
  type ConvertCommand
} from '@/composables/useEditorCommands'
import { useEditorViewState } from '@/composables/useEditorViewState'
import {
  applyEditorTheme,
  applyReadOnly,
  applyReaderTypography,
  createReaderEditor,
  openEditorContextMenu
} from '@/composables/useEditorSetup'
import { refreshStatusMetrics, setCursorLine } from '@/composables/useStatusMetrics'
import { attachSessionEditor, captureProgress, schedulePersist } from '@/composables/useSession'
import { useBookmarks } from '@/composables/useBookmarks'
import { flushBookmarkDrift, handleBookmarkDrift } from '@/composables/useBookmarkDrift'
import { showStatusMessage } from '@/composables/useStatusMessage'
import FindReplaceBar from './FindReplaceBar.vue'
import { docHeadText, formatError, titleFromMetadata } from '@/utils/format'

const container = ref<HTMLDivElement>()
// 单 EditorView 实例 + 每标签一个 EditorState + view.setState 切换
// 绝不用 :key 重建实例 —— 避免焦点/IME 异常
const editor = shallowRef<EditorView>()

const store = useTabsStore()
const settings = useSettingsStore()
const library = useLibraryStore()
const reader = useReaderStore()
const { convertSelection, transformCaseSelection, tidyDocument } = useEditorCommands()
const { addBookmarkAtCaret } = useBookmarks()
const {
  loading,
  missing,
  activateFor,
  saveViewStateFor,
  scheduleEviction,
  startEvictionTimer,
  stopEvictionTimer
} = useEditorViewState(editor)

// 预载数量（方案 §1.9）：启动先注入设置值，变化时立即按新上限收敛驻留集合
setPreloadCount(settings.preloadCount)
watch(
  () => settings.preloadCount,
  (count) => {
    setPreloadCount(count)
    scheduleEviction()
  }
)

/** 当前标签路径（空白标签为空串）：最近阅读防抖只对书库内的书有意义 */
function activePath(): string {
  return store.tabs.find((t) => t.id === store.activeTabId)?.path ?? ''
}

/** 元数据只在前 10 行（与主进程扫描、元数据栏同口径） */
const METADATA_HEAD_LINES = 10
/** 滚动进度抓取节流：避免大文件滚动时每帧查询高度树抢占视口渲染 */
const SCROLL_THROTTLE_MS = 150
/** 编辑态状态栏刷新节流：避免中文 IME 组字与连续打字时每键触发底栏重排 */
const METRICS_THROTTLE_MS = 100

let scrollTimer = 0
let metricsTimer = 0

function clearScrollTimer(): void {
  if (scrollTimer) {
    clearTimeout(scrollTimer)
    scrollTimer = 0
  }
}

function clearMetricsTimer(): void {
  if (metricsTimer) {
    clearTimeout(metricsTimer)
    metricsTimer = 0
  }
}

/** 仅当变更区间触及文档前 N 行（含旧/新文档边界）时才需要重算头部元数据 */
function changesTouchHeadLines(
  oldDoc: Text,
  newDoc: Text,
  changes: ChangeSet,
  headLines: number
): boolean {
  const oldLimit = oldDoc.line(Math.min(headLines, oldDoc.lines)).to
  const newLimit = newDoc.line(Math.min(headLines, newDoc.lines)).to
  let touched = false
  changes.iterChangedRanges((fromA, _toA, fromB) => {
    if (fromA <= oldLimit || fromB <= newLimit) touched = true
  })
  return touched
}

function scheduleMetricsRefresh(view: EditorView): void {
  if (metricsTimer) return
  metricsTimer = window.setTimeout(() => {
    metricsTimer = 0
    if (view.state.field(tabIdField) === null) return
    refreshStatusMetrics(view.state.doc)
    setCursorLine(view.state.doc.lineAt(view.state.selection.main.head).number)
  }, METRICS_THROTTLE_MS)
}

/** 正文前 10 行 → 书名：标签标题随正文变更跟随，不读全文 */
function bookTitleFromDoc(doc: Text, path: string): string {
  return titleFromMetadata(docHeadText(doc, METADATA_HEAD_LINES), path)
}

/** 空白标签标题跟随正文首行（方案 §1.5）：节流回写，避免每个按键都触发标签重排 */
const BLANK_TITLE_THROTTLE_MS = 200
let blankTitleTimer = 0
let pendingBlankTitleTabId: string | null = null

/** 首行去空白后作为标题；空白则回到「未命名」 */
function blankTitleOf(doc: Text): string {
  return doc.line(1).text.trim() || '未命名'
}

function scheduleBlankTitle(tabId: string): void {
  pendingBlankTitleTabId = tabId
  if (blankTitleTimer) return
  blankTitleTimer = window.setTimeout(() => {
    blankTitleTimer = 0
    const tabIdToUpdate = pendingBlankTitleTabId
    pendingBlankTitleTabId = null
    if (!tabIdToUpdate) return
    const state = getTabState(tabIdToUpdate)
    if (!state) return
    const tab = store.tabs.find((t) => t.id === tabIdToUpdate)
    // 已另存为/关闭的标签回到文件标签口径，不再覆盖
    if (!tab || tab.path) return
    const title = blankTitleOf(state.doc)
    if (title !== tab.title) store.patchTab(tabIdToUpdate, { title })
  }, BLANK_TITLE_THROTTLE_MS)
}

onMounted(() => {
  window.addEventListener('yueduo:convert', onConvertCommand)
  window.addEventListener('yueduo:tabRelocated', onTabRelocated)
  if (!container.value) return
  const instance = createReaderEditor(
    container.value,
    {
      dark: settings.dark,
      font: settings.readerFont,
      fontSize: settings.readerFontSize,
      locked: reader.locked
    },
    {
      onUpdate: (update) => {
        const tabId = update.state.field(tabIdField)
        if (update.state !== update.startState && tabId) {
          syncTabState(tabId, update.state)
        }
        emitEditorViewUpdate(update)

        if (!tabId) return
        const tab = store.tabs.find((t) => t.id === tabId)
        const versionChanged =
          currentDocVersion(update.state) !== currentDocVersion(update.startState)
        if (tab && (update.docChanged || versionChanged)) {
          const nextDirty = isDirty(tabId)
          if (nextDirty !== tab.dirty) {
            store.patchTab(tabId, { dirty: nextDirty })
          }
        }
        if (update.docChanged) {
          scheduleMetricsRefresh(update.view)
          if (tab?.path) {
            if (
              changesTouchHeadLines(
                update.startState.doc,
                update.state.doc,
                update.changes,
                METADATA_HEAD_LINES
              )
            ) {
              const title = bookTitleFromDoc(update.state.doc, tab.path)
              if (title && title !== tab.title) store.patchTab(tabId, { title })
            }
            handleBookmarkDrift(
              tabId,
              tab.path,
              update.startState.doc,
              update.state.doc,
              update.changes
            )
          } else if (tab) {
            scheduleBlankTitle(tabId)
          }
        }
        if (update.selectionSet) {
          if (!update.docChanged && !update.view.composing) {
            setCursorLine(update.state.doc.lineAt(update.state.selection.main.head).number)
          }
          const path = activePath()
          if (path) library.scheduleReadStamp(path)
        }
      },
      onScroll: () => {
        if (scrollTimer) return
        scrollTimer = window.setTimeout(() => {
          scrollTimer = 0
          const id = store.activeTabId
          if (!id) return
          captureProgress(id)
          schedulePersist()
          const path = activePath()
          if (path) library.scheduleReadStamp(path)
        }, SCROLL_THROTTLE_MS)
      },
      onContextMenu: (event, view) => {
        openEditorContextMenu(event, view, reader.locked, {
          addBookmark: () => {
            void addBookmarkAtCaret()
              .then((message) => showStatusMessage(message))
              .catch((e) => showStatusMessage(formatError(e)))
          },
          convert: (command) => void convertSelection(view, convertInvoker(command)),
          transformCase: (mode) => transformCaseSelection(view, mode),
          tidy: () => void tidyDocument(view)
        })
      }
    }
  )
  editor.value = instance
  attachSessionEditor(instance)

  startEvictionTimer()
  // 重挂载（HMR）时 activeTab 的 state 可能已被卸载 → 走重载路径恢复
  void activateFor(store.activeTabId)
})

// 主题深浅切换：Compartment 动态重配
watch(
  () => settings.dark,
  (dark) => {
    if (editor.value) applyEditorTheme(editor.value, dark)
  }
)

// 锁定阅读（方案 §3.3）：只关闭输入，保留光标与滚动；锁定时焦点交还正文，空格才能翻页
watch(
  () => reader.locked,
  (locked) => {
    if (editor.value) applyReadOnly(editor.value, locked)
  }
)

// 正文字体/字号（「显示」菜单）：Compartment 即时生效，行高按字号比例重算
watch([() => settings.readerFont, () => settings.readerFontSize], ([font, size]) => {
  if (editor.value) applyReaderTypography(editor.value, font, size)
})

// activeTabId 变化 → setState + restoreViewState（state 缺失时走 LRU 重载）
watch(
  () => store.activeTabId,
  (newId, oldId) => {
    if (newId === oldId) return
    clearScrollTimer()
    clearMetricsTimer()
    if (oldId) {
      // 切走前先抓旧标签的视口顶部行并存 viewState
      saveViewStateFor(oldId)
      // 书签漂移是防抖写库的，切标签时先落盘（同 Python currentChanged → flush）
      void flushBookmarkDrift()
    }
    void activateFor(newId)
    scheduleEviction()
  }
)

/** 菜单「编辑」/右键转换共用的意图入口（菜单与快捷键都只转交意图） */
function onConvertCommand(e: Event): void {
  const command = (e as CustomEvent<string>).detail
  if (command === 'tidy') {
    if (editor.value) void tidyDocument(editor.value)
    return
  }
  if (command === 'toHalfwidth' || command === 'toTraditional' || command === 'toSimplified') {
    if (editor.value) void convertSelection(editor.value, convertInvoker(command as ConvertCommand))
  }
}

/** 对账扫完重连成功：当前标签的文件路径已更新，清掉缺失态并重新加载正文 */
function onTabRelocated(e: Event): void {
  const tabId = (e as CustomEvent<string>).detail
  if (!tabId || store.activeTabId !== tabId) return
  missing.value = false
  void activateFor(tabId)
}

onBeforeUnmount(() => {
  clearScrollTimer()
  clearMetricsTimer()
  if (blankTitleTimer) clearTimeout(blankTitleTimer)
  blankTitleTimer = 0
  pendingBlankTitleTabId = null
  window.removeEventListener('yueduo:convert', onConvertCommand)
  window.removeEventListener('yueduo:tabRelocated', onTabRelocated)
  stopEvictionTimer()
  // 卸载前把未落库的书签漂移写掉（HMR 重挂载也不丢）
  void flushBookmarkDrift()
  attachSessionEditor(null)
  for (const t of store.tabs) disposeTabModel(t.id)
  if (editor.value) destroyReaderView(editor.value)
})
</script>

<template>
  <div class="editor-wrap">
    <div ref="container" class="cm-container"></div>
    <div v-if="loading" class="loading-overlay">正在加载…</div>
    <div v-else-if="missing" class="loading-overlay">文件暂不可用，等待书库对账后自动重连</div>
    <FindReplaceBar :editor="editor" :loading="loading" />
  </div>
</template>

<style scoped>
.editor-wrap {
  position: relative;
  width: 100%;
  height: 100%;
}
.cm-container {
  width: 100%;
  height: 100%;
}
.cm-container :deep(.cm-editor) {
  height: 100%;
}
.loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--yd-bg-3);
  color: var(--yd-text-3);
  font-size: var(--yd-sidebar-font-size);
  letter-spacing: 3px;
}
</style>
