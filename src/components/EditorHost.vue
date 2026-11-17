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
import { useLibraryStore } from '@/stores/library'
import { useReaderStore } from '@/stores/reader'
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
import {
  convertTidy,
  convertToHalfwidth,
  convertToSimplified,
  convertToTraditional
} from '@/ipc/bridge'
import type { ConvertResult } from '../../shared/types'

const container = ref<HTMLDivElement>()
// 单 Monaco 实例 + 每标签一个 model + setModel 切换（VS Code 同款，方案 §二根因教训 1）
// 绝不用 :key 重建实例 —— 那是旧项目焦点/IME bug 的根源
const editor = shallowRef<monaco.editor.IStandaloneCodeEditor>()
// 已卸载标签重载期间的加载态（方案 §1.7：无 model 时容器显示加载态）
const loading = ref(false)

const store = useTabsStore()
const settings = useSettingsStore()
const library = useLibraryStore()
const reader = useReaderStore()
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

/** 当前标签路径（空白标签为空串）：最近阅读防抖只对书库内的书有意义 */
function activePath(): string {
  return store.tabs.find((t) => t.id === store.activeTabId)?.path ?? ''
}

onMounted(() => {
  if (!container.value) return
  editor.value = monaco.editor.create(container.value, {
    ...READER_EDITOR_OPTIONS,
    value: '',
    readOnly: reader.locked
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
  editor.value.onDidChangeCursorPosition((e) => {
    setCursorLine(e.position.lineNumber)
    // 最近阅读（方案 §2.11）：光标移动是阅读位置变化，停住 60 秒再写 last_read_at
    const path = activePath()
    if (path) library.scheduleReadStamp(path)
  })

  // 会话进度：记录视口顶部行（方案 §1.8），滚动停止 2 秒后落盘
  editor.value.onDidScrollChange(() => {
    const id = store.activeTabId
    if (!id) return
    captureProgress(id)
    schedulePersist()
    // 最近阅读（方案 §2.11）：滚动同样算阅读位置变化，与光标共用 60 秒防抖
    const path = activePath()
    if (path) library.scheduleReadStamp(path)
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

  // 右键「转换」组（方案 §3.2，同 Python contextMenuEvent）：有选区转选区，否则转全文，全部可撤销
  editor.value.addAction({
    id: 'yueduo.toHalfwidth',
    label: '全角转半角',
    contextMenuGroupId: 'convert',
    contextMenuOrder: 1,
    precondition: '!editorReadonly',
    run: () => void runConvert(convertToHalfwidth)
  })
  editor.value.addAction({
    id: 'yueduo.toTraditional',
    label: '简转繁',
    contextMenuGroupId: 'convert',
    contextMenuOrder: 2,
    precondition: '!editorReadonly',
    run: () => void runConvert(convertToTraditional)
  })
  editor.value.addAction({
    id: 'yueduo.toSimplified',
    label: '繁转简',
    contextMenuGroupId: 'convert',
    contextMenuOrder: 3,
    precondition: '!editorReadonly',
    run: () => void runConvert(convertToSimplified)
  })
  editor.value.addAction({
    id: 'yueduo.tidy',
    label: '一键整理',
    contextMenuGroupId: 'convert',
    contextMenuOrder: 4,
    precondition: '!editorReadonly',
    run: () => void runTidy()
  })

  // Cmd+S 保存（编辑器焦点内；命令随 editor 实例生命周期销毁）
  editor.value.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    void saveActive(editor.value)
  })

  // 回车补两个全角空格（方案 §3.3）：沿用当前行缩进，无缩进时 U+3000 ×2
  editor.value.addCommand(
    monaco.KeyCode.Enter,
    () => insertNewline(true),
    'editorTextFocus && !editorReadonly && !isComposing'
  )
  // Shift+回车只换行、不缩进（写标题行等场景，同 Python）
  editor.value.addCommand(
    monaco.KeyMod.Shift | monaco.KeyCode.Enter,
    () => insertNewline(false),
    'editorTextFocus && !editorReadonly && !isComposing'
  )
  // 锁定阅读（方案 §3.3）：空格向下、Shift+空格向上翻页
  editor.value.addCommand(
    monaco.KeyCode.Space,
    () => pageBy(1),
    'editorTextFocus && editorReadonly'
  )
  editor.value.addCommand(
    monaco.KeyMod.Shift | monaco.KeyCode.Space,
    () => pageBy(-1),
    'editorTextFocus && editorReadonly'
  )

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

/** 简繁转换的保留项说明（Python ConvertResult.note 同款文案） */
function conversionNote(result: ConvertResult): string {
  const parts: string[] = []
  if (result.kept) parts.push(`保留 ${result.kept} 处多义字`)
  if (result.keptWords) parts.push(`保护词 ${result.keptWords} 处`)
  return parts.join('，')
}

/**
 * 转换类动作（方案 §3.2）：有选区就转选区，否则转全文；一次 executeEdits 应用，可用撤销恢复。
 * 等主进程返回期间标签可能已切换、正文可能被改，写回前必须复核 model 与原文。
 */
async function runConvert(convert: (text: string) => Promise<ConvertResult>): Promise<void> {
  const instance = editor.value
  const model = instance?.getModel()
  if (!instance || !model) return
  const selection = instance.getSelection()
  const hasSelection = !!selection && !selection.isEmpty()
  const range = hasSelection ? selection : model.getFullModelRange()
  const original = model.getValueInRange(range)
  if (!original.trim()) {
    showStatusMessage(hasSelection ? '选区没有可转换的内容' : '全文没有可转换的内容')
    return
  }
  let result: ConvertResult
  try {
    result = await convert(original)
  } catch (e) {
    showStatusMessage(`转换失败：${e instanceof Error ? e.message : String(e)}`, 5000)
    return
  }
  if (model.isDisposed() || instance.getModel() !== model) return
  if (model.getValueInRange(range) !== original) {
    showStatusMessage('转换期间文本已修改，结果未应用', 5000)
    return
  }
  if (result.text === original) {
    showStatusMessage(hasSelection ? '选区没有可转换的内容' : '全文没有可转换的内容')
    return
  }
  const position = instance.getPosition()
  instance.pushUndoStop()
  instance.executeEdits('convert', [{ range, text: result.text }])
  instance.pushUndoStop()
  // 全文整体替换会把光标挤到末尾，转换后按原行列放回（setPosition 自动夹到正文范围内）
  if (!hasSelection && position) instance.setPosition(position)
  const note = conversionNote(result)
  const scope = hasSelection ? '选区' : '全文'
  showStatusMessage(`已转换${scope}，可用撤销恢复${note ? `；${note}` : ''}`, 5000)
}

/** 一键整理（方案 §3.2）：固定五步顺序在主进程完成，整篇一次替换、可撤销 */
async function runTidy(): Promise<void> {
  const instance = editor.value
  const model = instance?.getModel()
  if (!instance || !model) return
  const original = model.getValue()
  if (!original.trim()) {
    showStatusMessage('当前文档为空，无需整理')
    return
  }
  showStatusMessage('正在整理…', 60_000)
  let result: Awaited<ReturnType<typeof convertTidy>>
  try {
    result = await convertTidy(original)
  } catch (e) {
    showStatusMessage(`整理失败：${e instanceof Error ? e.message : String(e)}`, 5000)
    return
  }
  if (model.isDisposed() || instance.getModel() !== model) {
    showStatusMessage('文档已切换，整理结果未应用', 5000)
    return
  }
  if (model.getValue() !== original) {
    showStatusMessage('整理期间文本已修改，结果未应用', 5000)
    return
  }
  if (result.text === original) {
    showStatusMessage('文本无需整理')
    return
  }
  const position = instance.getPosition()
  instance.pushUndoStop()
  instance.executeEdits('tidy', [{ range: model.getFullModelRange(), text: result.text }])
  instance.pushUndoStop()
  if (position) instance.setPosition(position)
  showStatusMessage('已整理完成，可用撤销恢复', 5000)
}

/**
 * 回车换行（方案 §3.3）：普通回车沿用当前行行首缩进，没有缩进时补两个全角空格；
 * Shift+回车只换行。缩进字符与 Python `_INDENT_CHARS` 一致：半角空格 / 制表符 / 全角空格。
 */
function insertNewline(withIndent: boolean): void {
  const instance = editor.value
  const model = instance?.getModel()
  const selection = instance?.getSelection()
  if (!instance || !model || !selection) return
  if (instance.getOption(monaco.editor.EditorOption.readOnly)) return
  let text = '\n'
  if (withIndent) {
    const lineNumber = instance.getPosition()?.lineNumber ?? selection.positionLineNumber
    const line = model.getLineContent(lineNumber)
    const indent = /^[ \t\u3000]*/.exec(line)?.[0] ?? ''
    text += indent || '\u3000\u3000'
  }
  instance.pushUndoStop()
  instance.executeEdits('yueduo.newline', [{ range: selection, text, forceMoveMarkers: true }])
  instance.pushUndoStop()
}

/**
 * 翻页（方案 §3.3，同 Python `_page`）：按当前视口可见行数整页滚动，
 * 目标行置于顶部并把光标带过去；Shift+空格向上。
 */
function pageBy(direction: 1 | -1): void {
  const instance = editor.value
  const model = instance?.getModel()
  if (!instance || !model) return
  const ranges = instance.getVisibleRanges()
  if (!ranges.length) return
  const top = ranges[0].startLineNumber
  const bottom = ranges[ranges.length - 1].endLineNumber
  const pageLines = Math.max(1, bottom - top)
  const target = Math.max(1, Math.min(model.getLineCount(), top + direction * pageLines))
  // 目标行贴顶（同 Python 把滚动条设到该行），而不是只滚到「刚好可见」
  instance.setScrollTop(instance.getTopForLineNumber(target), monaco.editor.ScrollType.Immediate)
  instance.setPosition({ lineNumber: target, column: 1 })
  showStatusMessage(`阅读到第 ${target} 行`, 2000)
}

// 锁定阅读（方案 §3.3）：只关闭输入，保留光标与滚动；锁定时焦点交还正文，空格才能翻页
watch(
  () => reader.locked,
  (locked) => {
    editor.value?.updateOptions({ readOnly: locked })
    if (locked) editor.value?.focus()
  }
)

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
