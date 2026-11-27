import { ref, type Ref, type ShallowRef } from 'vue'
import type { Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  createEmptyState,
  syncStateCompartments,
  type ReaderEditorConfig
} from '@/editor/codemirror'
import { useTabsStore } from '@/stores/tabs'
import { useSettingsStore } from '@/stores/settings'
import { useReaderStore } from '@/stores/reader'
import {
  computeResidentSet,
  emitEditorStateSwitch,
  getTabModel,
  reloadModel,
  restoreViewState,
  saveViewState,
  syncTabState,
  unloadModel,
  waitUnloadSettled
} from './useTabLifecycle'
import { refreshStatusMetrics, setCursorLine } from './useStatusMetrics'
import { applyPendingLineJump, applyRestoredView, captureProgress, focusEditor } from './useSession'

/** LRU 兜底检查周期（方案 §1.7：切换标签时同步计算 + 每 5 分钟定时） */
const EVICT_INTERVAL_MS = 5 * 60_000

/**
 * 编辑器视图状态与 LRU 协作（方案 §1.7 / §1.8 / §1.12）
 * - 切标签：先抓旧标签视口行/光标、存 viewState，再激活新标签
 * - 激活：驻留直接 syncStateCompartments + setState；已卸载 → 加载态 → 单飞重载 → 代际校验后 setState
 * - 视图恢复：会话恢复的顶部行+光标优先，进程内切换走内存 viewState
 * - 驻留收敛：非驻留状态写草稿后移除（定时器 + 每次切换）
 */
export function useEditorViewState(editor: ShallowRef<EditorView | undefined>): {
  loading: Ref<boolean>
  missing: Ref<boolean>
  activateFor: (tabId: string | null) => Promise<void>
  saveViewStateFor: (tabId: string) => void
  scheduleEviction: () => void
  startEvictionTimer: () => void
  stopEvictionTimer: () => void
} {
  const store = useTabsStore()
  const settings = useSettingsStore()
  const reader = useReaderStore()

  // 已卸载标签重载期间的加载态（方案 §1.7：无状态时容器显示加载态）
  const loading = ref(false)
  // 恢复时文件缺失：保留标签不丢，等对账扫完按 book_id 重连（主进程 session:relocate）
  const missing = ref(false)
  /** 激活代际：重载在途时用户再切标签，旧流程作废（最后完成者校验，方案 §1.7 铁律） */
  let activateSeq = 0
  let evictTimer: ReturnType<typeof setInterval> | null = null

  function currentConfig(): ReaderEditorConfig {
    return {
      dark: settings.dark,
      font: settings.readerFont,
      fontSize: settings.readerFontSize,
      locked: reader.locked
    }
  }

  function switchToEmpty(view: EditorView): void {
    view.setState(createEmptyState(currentConfig()))
    emitEditorStateSwitch(null)
  }

  function mountTabState(view: EditorView, tabId: string): boolean {
    const entry = getTabModel(tabId)
    if (!entry) return false
    const synced = syncStateCompartments(entry.state, currentConfig())
    syncTabState(tabId, synced)
    view.setState(synced)
    emitEditorStateSwitch(tabId)
    applyStoredView(tabId)
    syncStatus(view.state.doc)
    restoreEditorFocus()
    applyPendingLineJump(tabId)
    return true
  }

  /**
   * 激活标签的编辑器视图：
   * 1. 目标签卸载在途 → 等卸载分晓（state 被保留或草稿已落定）
   * 2. state 已驻留 → 同步 Compartment 后 setState + restoreViewState
   * 3. 已被 LRU 卸载 → 加载态 → 重载 → 完成者校验通过才 setState（防重入竞态）：
   *    重载期间用户再点其他标签则直接切换目标，本流程的 setState 作废
   */
  async function activateFor(tabId: string | null): Promise<void> {
    const seq = ++activateSeq
    if (!editor.value) return
    if (!tabId) {
      switchToEmpty(editor.value)
      loading.value = false
      missing.value = false
      syncStatus(null)
      return
    }
    await waitUnloadSettled(tabId)
    if (seq !== activateSeq || !editor.value || store.activeTabId !== tabId) return
    if (getTabModel(tabId)) {
      loading.value = false
      missing.value = false
      mountTabState(editor.value, tabId)
      return
    }
    loading.value = true
    missing.value = false
    switchToEmpty(editor.value)
    syncStatus(null)
    const tab = store.tabs.find((t) => t.id === tabId)
    try {
      await reloadModel(tabId, tab?.path ?? '')
    } catch (e) {
      // 恢复时文件缺失属于预期状态（等对账重连），不当作错误刷日志
      if (!tab?.missing) console.error('[LRU] reload failed:', e)
    } finally {
      if (seq === activateSeq) loading.value = false
    }
    if (seq !== activateSeq || !editor.value || store.activeTabId !== tabId) return
    const reloaded = getTabModel(tabId)
    if (reloaded) {
      mountTabState(editor.value, tabId)
      // 会话恢复的标签按需重读后补上源编码（状态栏展示，方案 §1.10）
      if (reloaded.encoding) store.patchTab(tabId, { encoding: reloaded.encoding })
      return
    }
    // 无草稿且文件不存在：保留空白编辑器并给出缺失提示，标签本身不从会话里删掉
    missing.value = tab?.missing === true
  }

  /** 切走前保存：先抓旧标签视口顶部行，再存 viewState（方案 §1.8） */
  function saveViewStateFor(tabId: string): void {
    if (!editor.value) return
    captureProgress(tabId)
    saveViewState(tabId, editor.value)
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

  /** 状态栏数据跟随当前文档（行数/字数 O(1) 刷新，光标行取编辑器当前位置） */
  function syncStatus(doc: Text | null): void {
    refreshStatusMetrics(doc)
    if (doc && editor.value) {
      setCursorLine(editor.value.state.doc.lineAt(editor.value.state.selection.main.head).number)
    } else {
      setCursorLine(1)
    }
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

  function startEvictionTimer(): void {
    if (evictTimer) return
    evictTimer = setInterval(scheduleEviction, EVICT_INTERVAL_MS)
  }

  function stopEvictionTimer(): void {
    if (evictTimer) clearInterval(evictTimer)
    evictTimer = null
  }

  return {
    loading,
    missing,
    activateFor,
    saveViewStateFor,
    scheduleEviction,
    startEvictionTimer,
    stopEvictionTimer
  }
}

/**
 * 激活完成后把焦点交还正文（方案 §1.12 焦点验收）：
 * 点击标签/左栏（普通 div）会把焦点掉到 body；用户正在路径框/设置项等其他输入控件里时不抢焦点。
 */
function restoreEditorFocus(): void {
  const active = document.activeElement
  if (!active) {
    focusEditor()
    return
  }
  if (active.closest('.cm-editor')) return
  const tag = active.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
  focusEditor()
}
