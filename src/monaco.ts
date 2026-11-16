import * as monaco from 'monaco-editor/editor/editor.api'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

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
  // 阅读体验
  fontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  fontSize: 15,
  lineHeight: 22,
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

export { monaco }
export default monaco
