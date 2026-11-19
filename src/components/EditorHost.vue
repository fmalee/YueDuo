<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { monaco } from '@/monaco'
import { useTabsStore } from '@/stores/tabs'
import { useSettingsStore } from '@/stores/settings'
import { useLibraryStore } from '@/stores/library'
import { useReaderStore } from '@/stores/reader'
import { disposeTabModel, isDirty, setPreloadCount } from '@/composables/useTabLifecycle'
import {
  convertInvoker,
  useEditorCommands,
  type ConvertCommand
} from '@/composables/useEditorCommands'
import { useEditorViewState } from '@/composables/useEditorViewState'
import {
  applyReadOnly,
  createReaderEditor,
  registerEditorActions
} from '@/composables/useEditorSetup'
import { refreshStatusMetrics, setCursorLine } from '@/composables/useStatusMetrics'
import { attachSessionEditor, captureProgress, schedulePersist } from '@/composables/useSession'
import { useBookmarks } from '@/composables/useBookmarks'
import { flushBookmarkDrift, handleBookmarkDrift } from '@/composables/useBookmarkDrift'
import { showStatusMessage } from '@/composables/useStatusMessage'
import FindReplaceBar from './FindReplaceBar.vue'
import { parseMetadata } from '../../shared/metadataParser'

const container = ref<HTMLDivElement>()
// 单 Monaco 实例 + 每标签一个 model + setModel 切换（VS Code 同款，方案 §二根因教训 1）
// 绝不用 :key 重建实例 —— 那是旧项目焦点/IME bug 的根源
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>()

const store = useTabsStore()
const settings = useSettingsStore()
const library = useLibraryStore()
const reader = useReaderStore()
const { convertSelection, tidyDocument } = useEditorCommands()
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

/** 正文前 10 行 → 书名：标签标题随正文变更跟随，不读全文 */
function bookTitleFromModel(model: monaco.editor.ITextModel, path: string): string {
  const count = Math.min(METADATA_HEAD_LINES, model.getLineCount())
  const lines: string[] = []
  for (let i = 1; i <= count; i++) lines.push(model.getLineContent(i))
  const fileName = path.slice(path.lastIndexOf('/') + 1)
  const parent = path.slice(0, path.lastIndexOf('/'))
  return parseMetadata(lines.join('\n'), fileName, parent.slice(parent.lastIndexOf('/') + 1)).title
}

/** 空白标签标题跟随正文首行（方案 §1.5）：节流回写，避免每个按键都触发标签重排 */
const BLANK_TITLE_THROTTLE_MS = 200
let blankTitleTimer = 0
let pendingBlankTitle: { tabId: string; model: monaco.editor.ITextModel } | null = null

/** 首行去空白后作为标题；空白则回到「未命名」 */
function blankTitleOf(model: monaco.editor.ITextModel): string {
  return model.getLineContent(1).trim() || '未命名'
}

function scheduleBlankTitle(tabId: string, model: monaco.editor.ITextModel): void {
  pendingBlankTitle = { tabId, model }
  if (blankTitleTimer) return
  blankTitleTimer = window.setTimeout(() => {
    blankTitleTimer = 0
    const pending = pendingBlankTitle
    pendingBlankTitle = null
    if (!pending || pending.model.isDisposed()) return
    const tab = store.tabs.find((t) => t.id === pending.tabId)
    // 已另存为/关闭的标签回到文件标签口径，不再覆盖
    if (!tab || tab.path) return
    const title = blankTitleOf(pending.model)
    if (title !== tab.title) store.patchTab(pending.tabId, { title })
  }, BLANK_TITLE_THROTTLE_MS)
}

onMounted(() => {
  window.addEventListener('yueduo:convert', onConvertCommand)
  window.addEventListener('yueduo:tabRelocated', onTabRelocated)
  if (!container.value) return
  const instance = createReaderEditor(container.value, reader.locked)
  editor.value = instance

  // dirty 追踪：内容变化后以版本号对比（O(1)，方案 §1.3）
  instance.onDidChangeModelContent((e) => {
    const id = store.activeTabId
    if (id) store.patchTab(id, { dirty: isDirty(id) })
    // 状态栏字数/行数（getValueLength/getLineCount 均为增量维护，O(1)）
    refreshStatusMetrics(instance.getModel())
    // 书签行号漂移跟随（方案 §2.7）：按行数差量平移，800ms 防抖回写
    const model = instance.getModel()
    const tab = id ? store.tabs.find((t) => t.id === id) : undefined
    if (id && model && tab?.path) {
      // 头部书名变了就同步标签标题（方案 §1.5：与元数据栏同一解析口径）
      const title = bookTitleFromModel(model, tab.path)
      if (title && title !== tab.title) store.patchTab(id, { title })
      handleBookmarkDrift(id, tab.path, e.changes, model.getLineCount())
    } else if (id && model && tab) {
      // 空白标签：标题跟正文首行，节流回写
      scheduleBlankTitle(id, model)
    }
  })

  // 状态栏「行 x / y」：光标移动只更新行号
  instance.onDidChangeCursorPosition((e) => {
    setCursorLine(e.position.lineNumber)
    // 最近阅读（方案 §2.11）：光标移动是阅读位置变化，停住 60 秒再写 last_read_at
    const path = activePath()
    if (path) library.scheduleReadStamp(path)
  })

  // 会话进度：记录视口顶部行（方案 §1.8），滚动停止 2 秒后落盘
  instance.onDidScrollChange(() => {
    const id = store.activeTabId
    if (!id) return
    captureProgress(id)
    schedulePersist()
    // 最近阅读（方案 §2.11）：滚动同样算阅读位置变化，与光标共用 60 秒防抖
    const path = activePath()
    if (path) library.scheduleReadStamp(path)
  })
  attachSessionEditor(instance)

  // 右键动作（方案 §2.7 / §3.2）：实现都在 useEditorCommands
  registerEditorActions(instance, {
    addBookmark: () => {
      void addBookmarkAtCaret()
        .then((message) => showStatusMessage(message))
        .catch((e) => showStatusMessage(e instanceof Error ? e.message : String(e)))
    },
    convert: (command) => void convertSelection(instance, convertInvoker(command)),
    tidy: () => void tidyDocument(instance)
  })

  startEvictionTimer()
  // 重挂载（HMR）时 activeTab 的 model 可能已被卸载 → 走重载路径恢复
  void activateFor(store.activeTabId)
})

// 锁定阅读（方案 §3.3）：只关闭输入，保留光标与滚动；锁定时焦点交还正文，空格才能翻页
watch(
  () => reader.locked,
  (locked) => {
    if (editor.value) applyReadOnly(editor.value, locked)
  }
)

// activeTabId 变化 → setModel + restoreViewState（model 缺失时走 LRU 重载）
watch(
  () => store.activeTabId,
  (newId, oldId) => {
    if (newId === oldId) return
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
  if (blankTitleTimer) clearTimeout(blankTitleTimer)
  blankTitleTimer = 0
  window.removeEventListener('yueduo:convert', onConvertCommand)
  window.removeEventListener('yueduo:tabRelocated', onTabRelocated)
  stopEvictionTimer()
  // 卸载前把未落库的书签漂移写掉（HMR 重挂载也不丢）
  void flushBookmarkDrift()
  attachSessionEditor(null)
  for (const t of store.tabs) disposeTabModel(t.id)
  editor.value?.dispose()
})
</script>

<template>
  <div class="editor-wrap">
    <div ref="container" class="monaco-container"></div>
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
.monaco-container {
  width: 100%;
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
  font-size: 13px;
  letter-spacing: 3px;
}
</style>
