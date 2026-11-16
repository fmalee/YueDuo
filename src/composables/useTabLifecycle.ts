import { monaco } from '@/monaco'

/**
 * model 注册表 —— 非 reactive（全文/视图状态绝不进 Vue 响应式）
 * 方案 §1.7：Map<tabId, {model, viewState?, loadedAt}>
 * LRU 卸载（当前 + 最近 10 个驻留）在阶段 1.7 扩展到本注册表
 */
export interface ModelEntry {
  model: monaco.editor.ITextModel
  viewState: monaco.editor.ICodeEditorViewState | null
  loadedAt: number
  /** 载入时的基线版本号，dirty = getAlternativeVersionId() !== baseline */
  baselineVersionId: number
}

const registry = new Map<string, ModelEntry>()

export function createTabModel(tabId: string, text: string): ModelEntry {
  disposeTabModel(tabId)
  const model = monaco.editor.createModel(text, 'plaintext')
  const entry: ModelEntry = {
    model,
    viewState: null,
    loadedAt: Date.now(),
    baselineVersionId: model.getAlternativeVersionId()
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

/** 离开标签前存视图状态（光标/滚动），切回时恢复 —— 焦点/IME 永不丢失的根基 */
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
