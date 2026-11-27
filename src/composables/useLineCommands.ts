import type { EditorView } from '@codemirror/view'
import {
  INDENT_RE,
  deleteToLineStartCmd,
  insertLineBelowCmd,
  insertNewlineCmd,
  pageByCmd
} from '@/editor/textEdits'
import { showStatusMessage } from './useStatusMessage'

/** 缩进剥离（书签摘要等场景共用同一字符集） */
export { INDENT_RE }

/**
 * 纯文本编辑动作（模块级导出，不依赖组件生命周期）
 * 键位注册在 useEditorKeybindings，这里薄封装 src/editor/textEdits.ts。
 */

/** 回车换行（方案 §3.3）：普通回车沿用当前行行首缩进（无缩进补两全角空格）；Shift+回车只换行 */
export function insertNewline(view: EditorView, withIndent: boolean): void {
  insertNewlineCmd(view, withIndent)
}

/** 在当前行下方插入新行（Cmd+Enter / Shift+Cmd+Enter）：不拆分当前行 */
export function insertLineBelow(view: EditorView, withIndent: boolean): void {
  insertLineBelowCmd(view, withIndent)
}

/** 合并段落（Shift+Backspace / Shift+Option+Backspace）：删除光标前到上一行行尾 */
export function deleteToLineStart(view: EditorView): void {
  deleteToLineStartCmd(view)
}

/** 翻页（方案 §3.3）：按当前视口可见行数整页滚动，目标行置于顶部并把光标带过去 */
export function pageBy(view: EditorView, direction: 1 | -1): void {
  const target = pageByCmd(view, direction)
  if (target !== null) {
    showStatusMessage(`阅读到第 ${target} 行`, 2000)
  }
}
