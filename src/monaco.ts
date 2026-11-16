import * as monaco from 'monaco-editor/editor/editor.api'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { DARK_COLORS, LIGHT_COLORS, READING } from './styles/theme'

// 铁律：worker 只走这一条路径（Vite 原生 ?worker），
// 不配 getWorkerUrl、不用 AMD loader；纯文本场景只需 editor.worker
self.MonacoEnvironment = {
  getWorker(): Worker {
    return new EditorWorker()
  }
}

/** 大文件阅读向编辑器配置（方案 §三 0.2） */
export const READER_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  // 大文件性能：关闭一切装饰性渲染
  minimap: { enabled: false },
  codeLens: false,
  hover: { enabled: 'off' },
  occurrencesHighlight: 'off',
  selectionHighlight: false,
  renderLineHighlight: 'none',
  renderWhitespace: 'none',
  guides: { indentation: false, bracketPairs: false },
  bracketPairColorization: { enabled: false },
  unicodeHighlight: {
    ambiguousCharacters: false,
    invisibleCharacters: false,
    nonBasicASCII: false // 中文文本全是 non-ASCII，必须关
  },
  stickyScroll: { enabled: false },
  // 阅读体验（字号/行高 token 见 styles/theme.ts）
  fontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  fontSize: READING.fontSize,
  lineHeight: READING.lineHeight,
  wrappingStrategy: 'simple', // 大文件折行必须用 simple，viewport 性能关键
  wordWrap: 'on',
  scrollBeyondLastLine: true,
  smoothScrolling: false,
  // 中文输入法
  automaticLayout: true,
  contextmenu: true,
  mouseWheelZoom: false,
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  acceptSuggestionOnEnter: 'off',
  tabCompletion: 'off',
  parameterHints: { enabled: false },
  snippetSuggestions: 'none'
}

/** 编辑器主题：颜色取自同一套 token，保证深色下编辑器与窗框不脱节（方案 §1.10） */
monaco.editor.defineTheme('yueduo-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': LIGHT_COLORS['bg-3'],
    'editor.foreground': LIGHT_COLORS['text-1'],
    'editorCursor.foreground': LIGHT_COLORS.cursor,
    'editor.selectionBackground': LIGHT_COLORS.selection,
    'editorLineNumber.foreground': LIGHT_COLORS['text-3'],
    'editorLineNumber.activeForeground': LIGHT_COLORS['text-2'],
    'editorWidget.background': LIGHT_COLORS['bg-2'],
    'editorWidget.border': LIGHT_COLORS['border-1'],
    'input.background': LIGHT_COLORS['bg-1'],
    'input.border': LIGHT_COLORS['border-1']
  }
})

monaco.editor.defineTheme('yueduo-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': DARK_COLORS['bg-3'],
    'editor.foreground': DARK_COLORS['text-1'],
    'editorCursor.foreground': DARK_COLORS.cursor,
    'editor.selectionBackground': DARK_COLORS.selection,
    'editorLineNumber.foreground': DARK_COLORS['text-3'],
    'editorLineNumber.activeForeground': DARK_COLORS['text-2'],
    'editorWidget.background': DARK_COLORS['bg-2'],
    'editorWidget.border': DARK_COLORS['border-1'],
    'input.background': DARK_COLORS['bg-1'],
    'input.border': DARK_COLORS['border-1']
  }
})

/** 切 Monaco 主题（DOM token 由 styles/theme.ts 的 applyTheme 负责） */
export function applyMonacoTheme(dark: boolean): void {
  monaco.editor.setTheme(dark ? 'yueduo-dark' : 'yueduo-light')
}

export { monaco }
export default monaco
