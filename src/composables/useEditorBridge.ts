import type { EditorView, ViewUpdate } from '@codemirror/view'

/**
 * 编辑器视图桥接层：集中持有全局唯一 EditorView 引用，并提供轻量的视图更新与状态切换订阅。
 * 与标签状态注册表/LRU（useTabLifecycle）解耦，避免组件（MetadataBar / FindReplaceBar）反向依赖生命周期模块。
 */
let activeView: EditorView | null = null

const viewUpdateListeners = new Set<(update: ViewUpdate) => void>()
const stateSwitchListeners = new Set<(tabId: string | null) => void>()

export function setActiveEditorView(view: EditorView | null): void {
  activeView = view
}

export function getActiveEditorView(): EditorView | null {
  return activeView
}

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
