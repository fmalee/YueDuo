import { monaco } from '@/monaco'
import { fileReadDraft, fileReadText, fileWriteDraft } from '@/ipc/bridge'
import { DEFAULT_SETTINGS, PRELOAD_MAX_COUNT, PRELOAD_MIN_COUNT } from '../../shared/types'
import type { FileStat, TabMeta } from '../../shared/types'

/**
 * model 注册表 —— 非 reactive（全文/视图状态绝不进 Vue 响应式）
 * 方案 §1.7：Map<tabId, {model, viewState?, loadedAt}> + LRU 驻留
 * 驻留集合 = 当前标签 + lastFocusedAt 最新的 preloadCount 个，其余卸载（§1.9 由设置注入）
 * 卸载 = dirty 全文与 viewState 经 IPC 存草稿 + model.dispose()（tab 元信息保留）
 */
export interface ModelEntry {
  model: monaco.editor.ITextModel
  viewState: monaco.editor.ICodeEditorViewState | null
  loadedAt: number
  /** 载入时的基线版本号，dirty = getAlternativeVersionId() !== baseline */
  baselineVersionId: number
  /** 载入时的源编码（会话恢复后状态栏展示；草稿重载为空） */
  encoding: string
}

const registry = new Map<string, ModelEntry>()

/** 除当前标签外按 lastFocusedAt 驻留的数量（方案 §1.7；1.9 由设置注入，0–20） */
let preloadCount = DEFAULT_SETTINGS.preloadCount

/** 设置页/LRU 共用：预载数量只影响驻留资格，已驻留 model 由下一次 scheduleEviction 收敛 */
export function setPreloadCount(value: number): void {
  if (!Number.isFinite(value)) return
  preloadCount = Math.min(PRELOAD_MAX_COUNT, Math.max(PRELOAD_MIN_COUNT, Math.round(value)))
}

export function getPreloadCount(): number {
  return preloadCount
}

/** 卸载在途标记（竞态防护）：重载/关闭/切回需等卸载完成，draft 读写才有确定顺序 */
const unloadInFlight = new Map<string, Promise<void>>()

/** 重载单飞（竞态防护）：并发重载同一标签共享一次读取，避免重复 IPC 与 model 抖动 */
const reloadInFlight = new Map<string, Promise<void>>()

/**
 * 文件身份缓存 —— 独立于 model 生命周期（model 可被 LRU 卸载，stat 必须常驻）
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
  const model = monaco.editor.createModel(text, 'plaintext')
  const entry: ModelEntry = {
    model,
    viewState: null,
    loadedAt: Date.now(),
    baselineVersionId: model.getAlternativeVersionId(),
    encoding
  }
  registry.set(tabId, entry)
  return entry
}

export function getTabModel(tabId: string): ModelEntry | undefined {
  return registry.get(tabId)
}

export function disposeTabModel(tabId: string): void {
  const entry = registry.get(tabId)
  if (entry) {
    entry.model.dispose()
    registry.delete(tabId)
  }
}
export function saveViewState(tabId: string, editor: monaco.editor.IStandaloneCodeEditor): void {
  const entry = registry.get(tabId)
  if (entry) {
    entry.viewState = editor.saveViewState()
    entry.loadedAt = Date.now()
  }
}

export function restoreViewState(tabId: string, editor: monaco.editor.IStandaloneCodeEditor): void {
  const entry = registry.get(tabId)
  if (entry?.viewState) {
    editor.restoreViewState(entry.viewState)
  }
}

/** 重置保存基线（保存后调用） */
export function resetBaseline(tabId: string): void {
  const entry = registry.get(tabId)
  if (entry) entry.baselineVersionId = entry.model.getAlternativeVersionId()
}

/** dirty 判定：版本号对比（方案 §1.3） */
export function isDirty(tabId: string): boolean {
  const entry = registry.get(tabId)
  if (!entry) return false
  return entry.model.getAlternativeVersionId() !== entry.baselineVersionId
}

/** 当前驻留 model 数（验收/诊断出口） */
export function residentModelCount(): number {
  return registry.size
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
 * 卸载单个标签的 model（方案 §1.7 卸载动作）：
 * - dirty → 全文经 IPC 存草稿；无论 dirty 与否都存 viewState（阅读进度不丢）
 * - tab 元信息与 stat 缓存保留，仅释放 model
 * - writeDraft 完成后复查驻留集合：IPC 在途期间用户切回该标签则放弃卸载（竞态防护）
 * 失败时 model 原样保留，下轮卸载检查重试。
 */
export function unloadModel(
  tabId: string,
  getTabs: () => TabMeta[],
  getActiveTabId: () => string | null
): Promise<void> {
  const run = (async () => {
    const entry = registry.get(tabId)
    if (!entry) return
    const text = isDirty(tabId) ? entry.model.getValue() : null
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
 *   （重载的 model undo 栈为空，不存在撤销回基线的路径，哨兵安全）
 * - 无草稿全文 → file:readText 重读（stat 缓存同步刷新，外部修改场景）；空白标签重载为空文本
 * - viewState 一律从草稿恢复（阅读进度）
 */
export function reloadModel(tabId: string, path: string): Promise<void> {
  const existing = reloadInFlight.get(tabId)
  if (existing) return existing
  const run = (async () => {
    await waitUnloadSettled(tabId) // 卸载在途：等 draft 落定再读
    if (registry.has(tabId)) return
    const draft = await fileReadDraft(tabId)
    if (registry.has(tabId)) return
    let text: string
    let encoding = ''
    if (draft && draft.text != null) {
      text = draft.text
    } else if (path) {
      const r = await fileReadText(path)
      text = r.text
      encoding = r.encoding
      setStatCache(tabId, r.stat)
    } else {
      text = '' // 空白标签
    }
    if (registry.has(tabId)) return // 读取在途时被并发处理
    const entry = createTabModel(tabId, text, encoding)
    if (draft && draft.viewState != null) {
      entry.viewState = draft.viewState as monaco.editor.ICodeEditorViewState
    }
    if (draft && draft.text != null) {
      entry.baselineVersionId = -1
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
