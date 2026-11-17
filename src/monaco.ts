// 界面文案中文化：Monaco 的 ESM 入口用数字消息 ID + 全局 NLS 表，
// 必须在任何 editor 模块求值前先注入 zh-cn 消息表；英文原文是各调用点的兜底，无需单独语言文件。
import 'monaco-editor/nls/lang/zh-cn'
import * as monaco from 'monaco-editor/editor/editor.api'
// editor.api 是精简入口，不含右键菜单实现；单独引入 contextmenu 贡献（方案 §2.7 右键添加书签）
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu'
// 富文本右键菜单的内置组：撤销/重做、剪切/复制/粘贴、全选、命令面板。
// 精简入口只在 SimpleEditorContext 注册撤销/重做/全选，这里把等价菜单项补进 EditorContext。
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess'
import { localize } from 'monaco-editor/nls'
import { MenuId, MenuRegistry } from 'monaco-editor/platform/actions/common/actions'
import {
  ContextKeyExpr,
  type ContextKeyExpression
} from 'monaco-editor/platform/contextkey/common/contextkey'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { DARK_COLORS, LIGHT_COLORS, READING } from './styles/theme'

// 剪贴板贡献只给剪切/粘贴设了 when（只读时隐藏），没有按选区置灰；
// 菜单项对象由 MenuRegistry 持有，这里补 precondition，让菜单按当前选区/只读状态置灰。
const CLIPBOARD_PRECONDITIONS: Record<string, ContextKeyExpression> = {
  'editor.action.clipboardCutAction': ContextKeyExpr.and(
    ContextKeyExpr.has('editorHasSelection'),
    ContextKeyExpr.not('editorReadonly')
  ),
  'editor.action.clipboardCopyAction': ContextKeyExpr.has('editorHasSelection'),
  'editor.action.clipboardPasteAction': ContextKeyExpr.not('editorReadonly')
}
for (const item of MenuRegistry.getMenuItems(MenuId.EditorContext)) {
  if ('command' in item) {
    const precondition = CLIPBOARD_PRECONDITIONS[item.command.id]
    if (precondition) item.command.precondition = precondition
  }
}

// 精简入口只在 SimpleEditorContext 注册撤销/重做/全选，右键菜单里没有；
// 补到 EditorContext，并用上下文键让不可用的项置灰（剪贴板项由贡献自带 when/precondition）。
MenuRegistry.appendMenuItems([
  {
    id: MenuId.EditorContext,
    item: {
      command: {
        id: 'undo',
        title: localize(75, 'Undo'),
        precondition: ContextKeyExpr.has('canUndo')
      },
      group: '1_do',
      order: 1
    }
  },
  {
    id: MenuId.EditorContext,
    item: {
      command: {
        id: 'redo',
        title: localize(78, 'Redo'),
        precondition: ContextKeyExpr.has('canRedo')
      },
      group: '1_do',
      order: 2
    }
  },
  {
    id: MenuId.EditorContext,
    item: {
      command: { id: 'editor.action.selectAll', title: localize(81, 'Select All') },
      group: '9_select',
      order: 1
    }
  }
])

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
