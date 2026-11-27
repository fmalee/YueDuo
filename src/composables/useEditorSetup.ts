import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import {
  createEmptyState,
  createReaderView,
  tabIdField,
  updateViewReadOnly,
  updateViewTheme,
  updateViewTypography,
  type EditorViewListeners,
  type ReaderEditorConfig
} from '@/editor/codemirror'
import { popupContextMenu } from './useContextMenu'
import type { ContextMenuItem, ReaderFont } from '../../shared/types'
import type { ConvertCommand } from './useEditorCommands'

/**
 * 编辑器实例创建与配置更新（薄封装 src/editor/codemirror.ts）
 * 单 EditorView 实例 + 每标签 EditorState，切换标签通过 view.setState 完成。
 */
export function createReaderEditor(
  host: HTMLElement,
  config: ReaderEditorConfig,
  listeners: EditorViewListeners
): EditorView {
  const initialState = createEmptyState(config)
  return createReaderView(host, initialState, listeners)
}

/** 正文字体/字号切换：Compartment 动态重配，不动文档与光标 */
export function applyReaderTypography(view: EditorView, font: ReaderFont, fontSize: number): void {
  updateViewTypography(view, font, fontSize)
}

/** 锁定阅读切换：只关输入（EditorState.readOnly），锁定时焦点交还正文，空格才能翻页 */
export function applyReadOnly(view: EditorView, locked: boolean): void {
  updateViewReadOnly(view, locked)
  if (locked) view.focus()
}

/** 主题深浅切换：Compartment 动态重配 */
export function applyEditorTheme(view: EditorView, dark: boolean): void {
  updateViewTheme(view, dark)
}

export interface EditorActionHandlers {
  /** 右键「添加书签」（提示文案在调用方给状态栏） */
  addBookmark: () => void
  /** 右键「转换」组（全角转半角 / 简转繁 / 繁转简） */
  convert: (command: ConvertCommand) => void
  /** 右键「转换为小写/大写」，只作用于选区 */
  transformCase: (mode: 'lower' | 'upper') => void
  /** 右键「一键整理」 */
  tidy: () => void
}

/**
 * 正文原生右键菜单（混合策略）：
 * - 剪切/复制/粘贴/全选在可用时走系统 PredefinedMenuItem（免剪贴板权限弹窗）
 * - 不可用态（锁定或无选区）降级为置灰普通项，避免误触发
 * - 撤销/恢复与自定义书签/转换动作走应用回执分发
 */
export function openEditorContextMenu(
  event: MouseEvent,
  view: EditorView,
  locked: boolean,
  handlers: EditorActionHandlers
): void {
  event.preventDefault()
  if (view.state.field(tabIdField) === null) return

  const hasSelection = !view.state.selection.main.empty
  const canUndo = !locked && undoDepth(view.state) > 0
  const canRedo = !locked && redoDepth(view.state) > 0

  const items: ContextMenuItem[] = [
    { kind: 'item', id: 'undo', label: '撤销', enabled: canUndo },
    { kind: 'item', id: 'redo', label: '恢复', enabled: canRedo },
    { kind: 'separator' },
    !locked && hasSelection
      ? { kind: 'predefined', role: 'cut', label: '剪切' }
      : { kind: 'item', id: '__cut', label: '剪切', enabled: false },
    hasSelection
      ? { kind: 'predefined', role: 'copy', label: '复制' }
      : { kind: 'item', id: '__copy', label: '复制', enabled: false },
    !locked
      ? { kind: 'predefined', role: 'paste', label: '粘贴' }
      : { kind: 'item', id: '__paste', label: '粘贴', enabled: false },
    { kind: 'separator' },
    { kind: 'item', id: 'addBookmark', label: '添加书签', enabled: !locked },
    { kind: 'separator' },
    { kind: 'item', id: 'toHalfwidth', label: '全角转半角', enabled: !locked },
    { kind: 'item', id: 'toLower', label: '转换为小写', enabled: !locked && hasSelection },
    { kind: 'item', id: 'toUpper', label: '转换为大写', enabled: !locked && hasSelection },
    { kind: 'item', id: 'toTraditional', label: '简转繁', enabled: !locked },
    { kind: 'item', id: 'toSimplified', label: '繁转简', enabled: !locked },
    { kind: 'item', id: 'tidy', label: '一键整理', enabled: !locked },
    { kind: 'separator' },
    { kind: 'predefined', role: 'selectAll', label: '全选' }
  ]

  void popupContextMenu(items, (itemId) => {
    switch (itemId) {
      case 'undo':
        if (!locked) undo(view)
        break
      case 'redo':
        if (!locked) redo(view)
        break
      case 'addBookmark':
        if (!locked) handlers.addBookmark()
        break
      case 'toHalfwidth':
      case 'toTraditional':
      case 'toSimplified':
        if (!locked) handlers.convert(itemId)
        break
      case 'toLower':
        if (!locked) handlers.transformCase('lower')
        break
      case 'toUpper':
        if (!locked) handlers.transformCase('upper')
        break
      case 'tidy':
        if (!locked) handlers.tidy()
        break
    }
  }).catch((e) => console.error('[contextMenu] 弹出正文右键菜单失败:', e))
}
