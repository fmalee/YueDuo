<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { monaco, READER_EDITOR_OPTIONS } from '@/monaco'
import { useTabsStore } from '@/stores/tabs'
import {
  getTabModel,
  restoreViewState,
  saveViewState,
  isDirty,
  disposeTabModel,
  computeResidentSet,
  setPreloadCount,
  unloadModel,
  reloadModel,
  waitUnloadSettled
} from '@/composables/useTabLifecycle'
import { useEditorCommands } from '@/composables/useEditorCommands'
import { useSettingsStore } from '@/stores/settings'
import { refreshStatusMetrics, setCursorLine } from '@/composables/useStatusMetrics'
import {
  applyRestoredView,
  applyPendingLineJump,
  attachSessionEditor,
  captureProgress,
  focusEditor,
  schedulePersist
} from '@/composables/useSession'
import { useBookmarks } from '@/composables/useBookmarks'
import {
  handleBookmarkDrift,
  flushBookmarkDrift,
  trackBookmarkTab
} from '@/composables/useBookmarkDrift'
import { showStatusMessage } from '@/composables/useStatusMessage'

const container = ref<HTMLDivElement>()
// 单 Monaco 实例 + 每标签一个 model + setModel 切换（VS Code 同款，方案 §二根因教训 1）
// 绝不用 :key 重建实例 —— 那是旧项目焦点/IME bug 的根源
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>()
// 已卸载标签重载期间的加载态（方案 §1.7：无 model 时容器显示加载态）
const loading = ref(false)

const store = useTabsStore()
const settings = useSettingsStore()
const { saveActive } = useEditorCommands()
const { addBookmarkAtCaret } = useBookmarks()

// 预载数量（方案 §1.9）：启动先注入设置值，变化时立即按新上限收敛驻留集合
setPreloadCount(settings.preloadCount)
watch(
  () => settings.preloadCount,
  (count) => {
    setPreloadCount(count)
    scheduleEviction()
  }
)

/** 激活代际：重载在途时用户再切标签，旧流程作废（最后完成者校验，方案 §1.7 铁律） */
let activateSeq = 0
/** LRU 兜底检查周期（方案 §1.7：切换标签时同步计算 + 每 5 分钟定时） */
const EVICT_INTERVAL_MS = 5 * 60_000
let evictTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  if (!container.value) return
  editor.value = monaco.editor.create(container.value, {
    ...READER_EDITOR_OPTIONS,
    value: ''
  })

  // dirty 追踪：内容变化后以版本号对比（O(1)，方案 §1.3）
  editor.value.onDidChangeModelContent((e) => {
    const id = store.activeTabId
    if (id) store.patchTab(id, { dirty: isDirty(id) })
    // 状态栏字数/行数（getValueLength/getLineCount 均为增量维护，O(1)）
    refreshStatusMetrics(editor.value?.getModel() ?? null)
    // 书签行号漂移跟随（方案 §2.7）：按行数差量平移，800ms 防抖回写
    const model = editor.value?.getModel()
    const tab = id ? store.tabs.find((t) => t.id === id) : undefined
    if (id && model && tab?.path) {
      handleBookmarkDrift(id, tab.path, e.changes, model.getLineCount())
    }
  })

  // 状态栏「行 x / y」：光标移动只更新行号
  editor.value.onDidChangeCursorPosition((e) => setCursorLine(e.position.lineNumber))

  // 会话进度：记录视口顶部行（方案 §1.8），滚动停止 2 秒后落盘
  editor.value.onDidScrollChange(() => {
    const id = store.activeTabId
    if (!id) return
    captureProgress(id)
    schedulePersist()
  })
  attachSessionEditor(editor.value)

  // 右键「添加书签」（方案 §2.7，同 Python contextMenuEvent）：复用同一套添加逻辑
  editor.value.addAction({
    id: 'yueduo.addBookmark',
    label: '添加书签',
    contextMenuGroupId: 'bookmarks',
    contextMenuOrder: 1,
    precondition: '!editorReadonly',
    run: () => {
      void addBookmarkAtCaret()
        .then((message) => showStatusMessage(message))
        .catch((e) => showStatusMessage(e instanceof Error ? e.message : String(e)))
    }
  })

  // Cmd+S 保存（编辑器焦点内；命令随 editor 实例生命周期销毁）
  editor.value.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    void saveActive(editor.value)
  })

  // 窗口级兜底（焦点在编辑器外时）
  window.addEventListener('keydown', onWindowKeydown)

  evictTimer = setInterval(scheduleEviction, EVICT_INTERVAL_MS)
  // 重挂载（HMR）时 activeTab 的 model 可能已被卸载 → 走重载路径恢复
  void activateEditorFor(store.activeTabId)
})

function onWindowKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void saveActive(editor.value)
  }
}

// activeTabId 变化 → setModel + restoreViewState（model 缺失时走 LRU 重载）
watch(
  () => store.activeTabId,
  (newId, oldId) => {
    if (newId === oldId) return
    if (oldId && editor.value) {
      // 切走前先抓旧标签的视口顶部行，再存 viewState
      captureProgress(oldId)
      saveViewState(oldId, editor.value)
      // 书签漂移是防抖写库的，切标签时先落盘（同 Python currentChanged → flush）
      void flushBookmarkDrift()
    }
    void activateEditorFor(newId)
    scheduleEviction()
  }
)

/**
 * 激活标签的编辑器视图：
 * 1. 目标签卸载在途 → 等卸载分晓（model 被保留或草稿已落定）
 * 2. model 已驻留 → 直接 setModel + restoreViewState
 * 3. 已被 LRU 卸载 → 加载态 → 重载 → 完成者校验通过才 setModel（防重入竞态）：
 *    重载期间用户再点其他标签则直接切换目标，本流程的 setModel 作废
 */
async function activateEditorFor(tabId: string | null): Promise<void> {
  const seq = ++activateSeq
  if (!editor.value) return
  if (!tabId) {
    editor.value.setModel(null)
    loading.value = false
    syncStatus(null)
    return
  }
  await waitUnloadSettled(tabId)
  if (seq !== activateSeq || !editor.value || store.activeTabId !== tabId) return
  const entry = getTabModel(tabId)
  if (entry) {
    loading.value = false
    editor.value.setModel(entry.model)
    trackBookmarkTab(tabId, entry.model.getLineCount())
    applyStoredView(tabId)
    syncStatus(entry.model)
    restoreEditorFocus()
    applyPendingLineJump(tabId)
    return
  }
  loading.value = true
  editor.value.setModel(null)
  syncStatus(null)
  try {
    const tab = store.tabs.find((t) => t.id === tabId)
    await reloadModel(tabId, tab?.path ?? '')
  } catch (e) {
    console.error('[LRU] reload failed:', e)
  } finally {
    if (seq === activateSeq) loading.value = false
  }
  if (seq !== activateSeq || !editor.value || store.activeTabId !== tabId) return
  const reloaded = getTabModel(tabId)
  if (reloaded) {
    editor.value.setModel(reloaded.model)
    trackBookmarkTab(tabId, reloaded.model.getLineCount())
    applyStoredView(tabId)
    syncStatus(reloaded.model)
    // 会话恢复的标签按需重读后补上源编码（状态栏展示，方案 §1.10）
    if (reloaded.encoding) store.patchTab(tabId, { encoding: reloaded.encoding })
    restoreEditorFocus()
    applyPendingLineJump(tabId)
  }
}

/**
 * 激活完成后把焦点交还正文（方案 §1.12 焦点验收）：
 * 点击标签/左栏（普通 div）会把焦点掉到 body；LRU 重载期间 setModel(null) 也会让 textarea 失焦。
 * 用户正在路径框/设置项等其他输入控件里时不抢焦点，避免慢重载打断正在输入的内容。
 */
function restoreEditorFocus(): void {
  const active = document.activeElement
  const tag = active?.tagName
  if (tag === 'INPUT' || tag === 'SELECT') return
  if (tag === 'TEXTAREA' && active?.closest('.monaco-editor')) return
  focusEditor()
}

/**
 * 恢复视图：会话恢复的 topLine+光标优先（滚到顶部行、光标回原位、屏外才拉回），
 * 进程内切换仍走内存 viewState（保留原滚动/选区体验）
 */
function applyStoredView(tabId: string): void {
  if (!editor.value) return
  if (applyRestoredView(tabId)) return
  restoreViewState(tabId, editor.value)
}

/** 状态栏数据跟随当前模型（行数/字数全量刷新一次，光标行取编辑器当前位置） */
function syncStatus(model: monaco.editor.ITextModel | null): void {
  refreshStatusMetrics(model)
  setCursorLine(editor.value?.getPosition()?.lineNumber ?? 1)
}

/** 卸载非驻留标签（fire-and-forget；unloadModel 内部自带「切回则保留」竞态防护） */
function scheduleEviction(): void {
  const resident = computeResidentSet(store.tabs, store.activeTabId)
  for (const t of store.tabs) {
    if (resident.has(t.id)) continue
    if (!getTabModel(t.id)) continue
    void unloadModel(
      t.id,
      () => store.tabs,
      () => store.activeTabId
    ).catch((e) => console.error('[LRU] unload failed:', e))
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  if (evictTimer) clearInterval(evictTimer)
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
