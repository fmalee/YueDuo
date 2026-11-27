import { isolateHistory } from '@codemirror/commands'
import type { EditorState, Text } from '@codemirror/state'
import type { EditorView, ViewUpdate } from '@codemirror/view'
import {
  createTabState,
  isCm6ViewState,
  tabIdField,
  type Cm6ViewState,
  type ReaderEditorConfig
} from '@/editor/codemirror'
import {
  currentDocVersion,
  isolateAndCaptureBaseline,
  isolateStateBaseline
} from '@/editor/dirtyState'
import { fileReadDraft, fileReadText, fileWriteDraft } from '@/ipc/bridge'
import { DEFAULT_SETTINGS, PRELOAD_MAX_COUNT, PRELOAD_MIN_COUNT } from '../../shared/types'
import type { FileStat, TabMeta } from '../../shared/types'

/**
 * 状态注册表 —— 非 reactive（全文/视图状态绝不进 Vue 响应式）
 * 方案 §1.7：Map<tabId, {state, viewState?, loadedAt}> + LRU 驻留
 * 驻留集合 = 当前标签 + lastFocusedAt 最新的 preloadCount 个，其余卸载（§1.9 由设置注入）
 * 卸载 = dirty 全文与 viewState 经 IPC 存草稿 + 从注册表移除 state（tab 元信息保留）
 */
export interface ModelEntry {
  state: EditorState
  viewState: Cm6ViewState | null
  loadedAt: number
  /** 保存基线版本号（-1 表示脏草稿重载哨兵，保存前恒脏） */
  baselineVersion: number
  /** 保存基线的不可变 Text 引用（零拷贝持久化 B-tree，用于 IME 空历史项撤销兜底） */
  baselineDoc: Text | null
  /** 载入时的源编码（会话恢复后状态栏展示；草稿重载为空） */
  encoding: string
}

export type TabStateEntry = ModelEntry

const DEFAULT_EDITOR_CONFIG: ReaderEditorConfig = {
  dark: false,
  font: DEFAULT_SETTINGS.readerFont,
  fontSize: DEFAULT_SETTINGS.readerFontSize,
  locked: false
}

const registry = new Map<string, ModelEntry>()

/** 当前挂载的全局唯一 EditorView（用于优先读取实时 state 与直接派发编辑） */
let activeView: EditorView | null = null

export function setLifecycleView(view: EditorView | null): void {
  activeView = view
}

/** 视图事件订阅桥（供 MetadataBar 与 FindReplaceBar 使用） */
const viewUpdateListeners = new Set<(update: ViewUpdate) => void>()
const stateSwitchListeners = new Set<(tabId: string | null) => void>()

export function onEditorViewUpdate(listener: (update: ViewUpdate) => void): () => void {
  viewUpdateListeners.add(listener)
  return () => {
    viewUpdateListeners.delete(listener)
  }
}

export function emitEditorViewUpdate(update: ViewUpdate): void {
  for (const listener of viewUpdateListeners) {
    listener(update)
  }
}

export function onEditorStateSwitch(listener: (tabId: string | null) => void): () => void {
  stateSwitchListeners.add(listener)
  return () => {
    stateSwitchListeners.delete(listener)
  }
}

export function emitEditorStateSwitch(tabId: string | null): void {
  for (const listener of stateSwitchListeners) {
    listener(tabId)
  }
}

/** 除当前标签外按 lastFocusedAt 驻留的数量（方案 §1.7；1.9 由设置注入，0–20） */
let preloadCount = DEFAULT_SETTINGS.preloadCount

/** 设置页/LRU 共用：预载数量只影响驻留资格，已驻留状态由下一次 scheduleEviction 收敛 */
export function setPreloadCount(value: number): void {
  if (!Number.isFinite(value)) return
  preloadCount = Math.min(PRELOAD_MAX_COUNT, Math.max(PRELOAD_MIN_COUNT, Math.round(value)))
}

/** 卸载在途标记（竞态防护）：重载/关闭/切回需等卸载完成，draft 读写才有确定顺序 */
const unloadInFlight = new Map<string, Promise<void>>()

/** 重载单飞（竞态防护）：并发重载同一标签共享一次读取，避免重复 IPC 与状态抖动 */
const reloadInFlight = new Map<string, Promise<void>>()

/**
 * 换库代际（方案 §2.13）：切库时整体清空状态注册表并自增，
 * 之前发出的异步重载/卸载发现代际变了就直接放弃，避免把旧库内容写进新库。
 */
let epoch = 0

/**
 * 文件身份缓存 —— 独立于状态生命周期（state 可被 LRU 卸载，stat 必须常驻）
 * 供同文件去重（inode 优先 realPath 兜底）
 */
const statCache = new Map<string, FileStat>()

export function setStatCache(tabId: string, stat: FileStat): void {
  statCache.set(tabId, stat)
}

export function getStatCache(tabId: string): FileStat | null {
  return statCache.get(tabId) ?? null
}

export function removeStatCache(tabId: string): void {
  statCache.delete(tabId)
}

export function createTabModel(tabId: string, text: string, encoding = ''): ModelEntry {
  disposeTabModel(tabId)
  const state = createTabState(tabId, text, DEFAULT_EDITOR_CONFIG)
  const entry: ModelEntry = {
    state,
    viewState: null,
    loadedAt: Date.now(),
    baselineVersion: currentDocVersion(state),
    baselineDoc: state.doc,
    encoding
  }
  registry.set(tabId, entry)
  return entry
}

export function getTabModel(tabId: string): ModelEntry | undefined {
  return registry.get(tabId)
}

/** 优先读实时挂载视图的 state，未挂载时读注册表缓存 */
export function getTabState(tabId: string): EditorState | null {
  if (activeView && activeView.state.field(tabIdField) === tabId) {
    return activeView.state
  }
  return registry.get(tabId)?.state ?? null
}

/** 将最新不可变 EditorState 同步回注册表（防过期快照） */
export function syncTabState(tabId: string, state: EditorState): void {
  const entry = registry.get(tabId)
  if (entry) entry.state = state
}

/** 同步当前激活视图的 state 到注册表 */
export function syncActiveTabState(view: EditorView): void {
  const tabId = view.state.field(tabIdField)
  if (tabId) syncTabState(tabId, view.state)
}

/** 非激活标签离线更新 state 后写回注册表 */
export function updateTabStateOffline(tabId: string, state: EditorState): void {
  syncTabState(tabId, state)
}

/**
 * 对指定标签应用一次区间编辑（元数据写回与 __yueTest 共用）：
 * 若为当前激活视图直接 dispatch，否则离线 state.update 并写回注册表。
 */
export function applyTabEdit(
  tabId: string,
  from: number,
  to: number,
  insert: string,
  isolate = true
): boolean {
  const entry = registry.get(tabId)
  if (!entry) return false
  const annotations = isolate ? isolateHistory.of('full') : undefined
  if (activeView && activeView.state.field(tabIdField) === tabId) {
    activeView.dispatch({
      changes: { from, to, insert },
      ...(annotations ? { annotations } : {})
    })
    entry.state = activeView.state
    return true
  }
  const tr = entry.state.update({
    changes: { from, to, insert },
    ...(annotations ? { annotations } : {})
  })
  entry.state = tr.state
  return true
}

export function disposeTabModel(tabId: string): void {
  registry.delete(tabId)
}

export function saveViewState(tabId: string, view: EditorView): void {
  const entry = registry.get(tabId)
  if (!entry) return
  if (view.state.field(tabIdField) !== tabId) return
  entry.state = view.state
  const main = view.state.selection.main
  entry.viewState = {
    engine: 'cm6',
    scrollTop: view.scrollDOM.scrollTop,
    anchor: main.anchor,
    head: main.head
  }
  entry.loadedAt = Date.now()
}

export function restoreViewState(tabId: string, view: EditorView): void {
  const entry = registry.get(tabId)
  if (!entry || !isCm6ViewState(entry.viewState)) return
  if (view.state.field(tabIdField) !== tabId) return
  const vs = entry.viewState
  const maxPos = view.state.doc.length
  const anchor = Math.max(0, Math.min(maxPos, Math.trunc(vs.anchor)))
  const head = Math.max(0, Math.min(maxPos, Math.trunc(vs.head)))
  view.dispatch({ selection: { anchor, head } })
  view.scrollDOM.scrollTop = vs.scrollTop
  requestAnimationFrame(() => {
    if (view.state.field(tabIdField) === tabId) {
      view.scrollDOM.scrollTop = vs.scrollTop
    }
  })
}

/** 重置保存基线（保存后调用） */
export function resetBaseline(tabId: string, view?: EditorView): void {
  const entry = registry.get(tabId)
  if (!entry) return
  const targetView = view ?? activeView
  if (targetView && targetView.state.field(tabIdField) === tabId) {
    entry.baselineVersion = isolateAndCaptureBaseline(targetView)
    entry.state = targetView.state
    entry.baselineDoc = targetView.state.doc
    return
  }
  const { state, baseline } = isolateStateBaseline(entry.state)
  entry.state = state
  entry.baselineVersion = baseline
  entry.baselineDoc = state.doc
}

/** dirty 判定：O(1) 版本号对比，长度与行数均回到基线时用持久化 B-tree Text.eq 兜底 IME 抵消场景 */
export function isDirty(tabId: string): boolean {
  const entry = registry.get(tabId)
  if (!entry) return false
  if (entry.baselineVersion === -1) return true
  const state = getTabState(tabId) ?? entry.state
  if (currentDocVersion(state) === entry.baselineVersion) return false
  const base = entry.baselineDoc
  if (base && state.doc.length === base.length && state.doc.lines === base.lines) {
    return !state.doc.eq(base)
  }
  return true
}

/** 当前驻留状态数（验收/诊断出口） */
export function residentModelCount(): number {
  return registry.size
}

/**
 * 换库时整体重置（方案 §2.13）：清空所有状态、身份缓存与在途标记，并自增代际。
 * 调用方需先把编辑器切到空占位态（useSession 负责）。
 */
export function resetTabLifecycle(): void {
  epoch++
  registry.clear()
  statCache.clear()
  unloadInFlight.clear()
  reloadInFlight.clear()
}

/** 等待某标签的在途卸载完成（无在途则立即返回；永不 reject） */
export function waitUnloadSettled(tabId: string): Promise<void> {
  return unloadInFlight.get(tabId) ?? Promise.resolve()
}

/**
 * 驻留集合 = 当前标签 + 其余按 lastFocusedAt 降序前 preloadCount 个（方案 §1.7）
 */
export function computeResidentSet(tabs: TabMeta[], activeTabId: string | null): Set<string> {
  const resident = new Set<string>()
  if (activeTabId) resident.add(activeTabId)
  const others = tabs
    .filter((t) => t.id !== activeTabId)
    .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)
    .slice(0, preloadCount)
  for (const t of others) resident.add(t.id)
  return resident
}

/**
 * 卸载单个标签的状态（方案 §1.7 卸载动作）：
 * - dirty → 全文经 IPC 存草稿；无论 dirty 与否都存 viewState（阅读进度不丢）
 * - tab 元信息与 stat 缓存保留，仅移除内存 state
 * - writeDraft 完成后复查驻留集合：IPC 在途期间用户切回该标签则放弃卸载（竞态防护）
 * 失败时 state 原样保留，下轮卸载检查重试。
 */
export function unloadModel(
  tabId: string,
  getTabs: () => TabMeta[],
  getActiveTabId: () => string | null
): Promise<void> {
  const myEpoch = epoch
  const run = (async () => {
    const entry = registry.get(tabId)
    if (!entry) return
    const state = getTabState(tabId) ?? entry.state
    const text = isDirty(tabId) ? state.doc.toString() : null
    // 带上标签元信息：persist 尚未落盘时草稿行也能带着 path/title 恢复，标签不会凭空消失
    const tab = getTabs().find((t) => t.id === tabId)
    await fileWriteDraft(
      tabId,
      text,
      entry.viewState,
      tab
        ? {
            path: tab.path,
            title: tab.title,
            progressLine: 0,
            lastFocusedAt: tab.lastFocusedAt
          }
        : undefined
    )
    // 换库已发生：这次卸载属于旧库，绝不能再动新库的注册表
    if (myEpoch !== epoch) return
    if (computeResidentSet(getTabs(), getActiveTabId()).has(tabId)) return
    disposeTabModel(tabId)
  })()
  // 在途标记存「已吞异常」的分身：等待者（重载/关闭/切回）不受卸载失败牵连
  const settled = run.catch(() => undefined)
  unloadInFlight.set(tabId, settled)
  void settled.finally(() => {
    if (unloadInFlight.get(tabId) === settled) unloadInFlight.delete(tabId)
  })
  return run
}

/**
 * 重载已卸载标签（方案 §1.7 重载路径）：
 * - 有草稿全文（卸载时 dirty）→ 以草稿为内容，基线置哨兵 -1 → isDirty 恒真直到保存
 * - 无草稿全文 → file:readText 重读（stat 缓存同步刷新，外部修改场景）；空白标签重载为空文本
 * - viewState 仅在符合 Cm6ViewState 结构时恢复，旧 Monaco viewState 自动忽略并退回 SQLite 进度
 */
export function reloadModel(tabId: string, path: string): Promise<void> {
  const existing = reloadInFlight.get(tabId)
  if (existing) return existing
  const myEpoch = epoch
  const run = (async () => {
    await waitUnloadSettled(tabId) // 卸载在途：等 draft 落定再读
    if (myEpoch !== epoch || registry.has(tabId)) return
    const draft = await fileReadDraft(tabId)
    if (myEpoch !== epoch || registry.has(tabId)) return
    let text: string
    let encoding = ''
    if (draft && draft.text != null) {
      text = draft.text
    } else if (path) {
      const r = await fileReadText(path)
      text = r.text
      encoding = r.encoding
      if (myEpoch !== epoch) return
      setStatCache(tabId, r.stat)
    } else {
      text = '' // 空白标签
    }
    if (myEpoch !== epoch || registry.has(tabId)) return // 读取在途时被并发处理/换库
    const entry = createTabModel(tabId, text, encoding)
    if (draft && isCm6ViewState(draft.viewState)) {
      entry.viewState = draft.viewState
    } else {
      entry.viewState = null
    }
    if (draft && draft.text != null) {
      entry.baselineVersion = -1
      entry.baselineDoc = null
    }
  })()
  reloadInFlight.set(tabId, run)
  void run
    .catch(() => undefined)
    .finally(() => {
      if (reloadInFlight.get(tabId) === run) reloadInFlight.delete(tabId)
    })
  return run
}
