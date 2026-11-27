/**
 * CodeMirror 6 单视图多状态核心工厂
 *
 * 全局唯一 EditorView 实例，切换标签通过 view.setState(state) 完成。
 * 视图级事件监听通过模块级 WeakMap 绑定到 EditorView，确保 setState 后不丢失。
 */
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  Compartment,
  EditorState,
  StateField,
  Transaction,
  type Extension
} from '@codemirror/state'
import {
  EditorView,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  scrollPastEnd,
  type ViewUpdate
} from '@codemirror/view'
import type { ReaderFont } from '../../shared/types'
import { READING, readingLineHeight } from '../styles/theme'
import { dirtyTrackingExtension } from './dirtyState'
import { findDecorationsExtension } from './findDecorations'

export const tabIdField: StateField<string | null> = StateField.define<string | null>({
  create: () => null,
  update: (value) => value
})

export interface ReaderEditorConfig {
  dark: boolean
  font: ReaderFont
  fontSize: number
  locked: boolean
}

export interface Cm6ViewState {
  engine: 'cm6'
  scrollTop: number
  anchor: number
  head: number
}

export interface EditorViewListeners {
  onUpdate?: (update: ViewUpdate) => void
  onScroll?: (view: EditorView) => void
  onContextMenu?: (event: MouseEvent, view: EditorView) => void
}

interface ViewListenerRecord {
  listeners: EditorViewListeners
  disposeScroll: () => void
}

const viewListeners = new WeakMap<EditorView, ViewListenerRecord>()

const themeCompartment = new Compartment()
const typographyCompartment = new Compartment()
const readOnlyCompartment = new Compartment()

function buildThemeExtension(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'var(--yd-bg-3)',
        color: 'var(--yd-text-1)'
      },
      '&.cm-focused': {
        outline: 'none'
      },
      '.cm-scroller': {
        overflow: 'auto'
      },
      '.cm-content': {
        padding: '8px 20px',
        caretColor: 'var(--yd-cursor)'
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--yd-cursor)'
      },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        {
          backgroundColor: 'var(--yd-selection)'
        },
      '.cm-gutters': {
        backgroundColor: 'var(--yd-bg-3)',
        borderRight: 'none',
        color: 'var(--yd-text-3)'
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--yd-text-2)'
      }
    },
    { dark }
  )
}

function buildTypographyExtension(font: ReaderFont, fontSize: number): Extension {
  return EditorView.theme({
    '&': {
      fontSize: `${fontSize}px`
    },
    '.cm-content, .cm-gutter': {
      fontFamily: READING.fontFamilies[font],
      lineHeight: `${readingLineHeight(fontSize)}px`
    }
  })
}

/** 只读锁定仅使用 EditorState.readOnly（严禁 EditorView.editable.of(false)） */
function buildReadOnlyExtension(locked: boolean): Extension {
  return EditorState.readOnly.of(locked)
}

const baseExtensions: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  history({ minDepth: 500 }),
  dirtyTrackingExtension,
  findDecorationsExtension,
  EditorView.lineWrapping,
  scrollPastEnd(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  EditorView.updateListener.of((update) => {
    viewListeners.get(update.view)?.listeners.onUpdate?.(update)
  }),
  EditorView.domEventHandlers({
    contextmenu: (event, view) => {
      viewListeners.get(view)?.listeners.onContextMenu?.(event, view)
      return false
    }
  })
]

function buildStateExtensions(tabId: string | null, config: ReaderEditorConfig): Extension[] {
  return [
    baseExtensions,
    tabIdField.init(() => tabId),
    themeCompartment.of(buildThemeExtension(config.dark)),
    typographyCompartment.of(buildTypographyExtension(config.font, config.fontSize)),
    readOnlyCompartment.of(buildReadOnlyExtension(config.locked))
  ]
}

export function isCm6ViewState(value: unknown): value is Cm6ViewState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.engine === 'cm6' &&
    typeof v.scrollTop === 'number' &&
    Number.isFinite(v.scrollTop) &&
    typeof v.anchor === 'number' &&
    Number.isFinite(v.anchor) &&
    typeof v.head === 'number' &&
    Number.isFinite(v.head)
  )
}

export function createEmptyState(config: ReaderEditorConfig): EditorState {
  return EditorState.create({
    doc: '',
    // 空占位态（无标签/重载/缺失）恒定只读，禁止写入空状态
    extensions: buildStateExtensions(null, { ...config, locked: true })
  })
}

export function createTabState(
  tabId: string,
  text: string,
  config: ReaderEditorConfig
): EditorState {
  return EditorState.create({
    doc: text,
    extensions: buildStateExtensions(tabId, config)
  })
}

export function createReaderView(
  parent: HTMLElement,
  initialState: EditorState,
  listeners: EditorViewListeners
): EditorView {
  const view = new EditorView({
    state: initialState,
    parent
  })
  const handleScroll = (): void => {
    viewListeners.get(view)?.listeners.onScroll?.(view)
  }
  view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })
  viewListeners.set(view, {
    listeners,
    disposeScroll: () => view.scrollDOM.removeEventListener('scroll', handleScroll)
  })
  return view
}

export function destroyReaderView(view: EditorView): void {
  const record = viewListeners.get(view)
  if (record) {
    record.disposeScroll()
    viewListeners.delete(view)
  }
  view.destroy()
}

export function syncStateCompartments(
  state: EditorState,
  config: ReaderEditorConfig
): EditorState {
  return state.update({
    effects: [
      themeCompartment.reconfigure(buildThemeExtension(config.dark)),
      typographyCompartment.reconfigure(buildTypographyExtension(config.font, config.fontSize)),
      readOnlyCompartment.reconfigure(buildReadOnlyExtension(config.locked))
    ],
    annotations: Transaction.addToHistory.of(false)
  }).state
}

export function updateViewTheme(view: EditorView, dark: boolean): void {
  view.dispatch({
    effects: themeCompartment.reconfigure(buildThemeExtension(dark)),
    annotations: Transaction.addToHistory.of(false)
  })
}

export function updateViewTypography(view: EditorView, font: ReaderFont, fontSize: number): void {
  view.dispatch({
    effects: typographyCompartment.reconfigure(buildTypographyExtension(font, fontSize)),
    annotations: Transaction.addToHistory.of(false)
  })
}

export function updateViewReadOnly(view: EditorView, locked: boolean): void {
  view.dispatch({
    effects: readOnlyCompartment.reconfigure(buildReadOnlyExtension(locked)),
    annotations: Transaction.addToHistory.of(false)
  })
}

export function getTopVisibleLine(view: EditorView): number {
  const topHeight = Math.max(0, view.scrollDOM.scrollTop)
  const block = view.lineBlockAtHeight(topHeight)
  return view.state.doc.lineAt(block.from).number
}

export function getVisibleLineRange(view: EditorView): { top: number; bottom: number } | null {
  const { scrollTop, clientHeight } = view.scrollDOM
  if (clientHeight <= 0) return null
  const topBlock = view.lineBlockAtHeight(Math.max(0, scrollTop))
  const bottomBlock = view.lineBlockAtHeight(Math.max(0, scrollTop + clientHeight))
  return {
    top: view.state.doc.lineAt(topBlock.from).number,
    bottom: view.state.doc.lineAt(bottomBlock.from).number
  }
}

export function scrollToTopLineImmediate(view: EditorView, lineNumber: number): void {
  const doc = view.state.doc
  const clamped = Math.max(1, Math.min(doc.lines, Math.trunc(lineNumber)))
  const pos = doc.line(clamped).from
  view.dispatch({
    effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 0 })
  })
}

export function revealLineCentered(view: EditorView, lineNumber: number): void {
  const doc = view.state.doc
  const clamped = Math.max(1, Math.min(doc.lines, Math.trunc(lineNumber)))
  const pos = doc.line(clamped).from
  view.dispatch({
    effects: EditorView.scrollIntoView(pos, { y: 'center' })
  })
}

export function revealPosNearest(view: EditorView, pos: number): void {
  const clamped = Math.max(0, Math.min(view.state.doc.length, Math.trunc(pos)))
  view.dispatch({
    effects: EditorView.scrollIntoView(clamped, { y: 'nearest' })
  })
}
