import { monaco } from '@/monaco'
import { showStatusMessage } from './useStatusMessage'

/**
 * 纯文本编辑动作（模块级导出，不依赖组件生命周期）
 * 键位注册在 useEditorKeybindings，这里只负责「对编辑器实例做一次可撤销的编辑」。
 * 保持模块级导出而不是组件内函数：空白标签与普通标签走同一条代码路径。
 */

/**
 * 回车换行（方案 §3.3）：普通回车沿用当前行行首缩进，没有缩进时补两个全角空格；
 * Shift+回车只换行。缩进字符与 Python `_INDENT_CHARS` 一致：半角空格 / 制表符 / 全角空格。
 */
export function insertNewline(
  editor: monaco.editor.IStandaloneCodeEditor,
  withIndent: boolean
): void {
  const model = editor.getModel()
  const selection = editor.getSelection()
  if (!model || !selection) return
  if (editor.getOption(monaco.editor.EditorOption.readOnly)) return
  let text = '\n'
  if (withIndent) {
    const lineNumber = editor.getPosition()?.lineNumber ?? selection.positionLineNumber
    const line = model.getLineContent(lineNumber)
    const indent = /^[ \t\u3000]*/.exec(line)?.[0] ?? ''
    text += indent || '\u3000\u3000'
  }
  editor.pushUndoStop()
  editor.executeEdits('yueduo.newline', [{ range: selection, text, forceMoveMarkers: true }])
  editor.pushUndoStop()
}

/**
 * 合并段落（Shift+Backspace）：删除光标所在一行的左侧内容 + 本行前面的换行。
 * 第一行只有「行首到光标」；其余行从上一行行尾起，顺带吃掉换行。
 * 光标在全文 1:1（含空白文档）时无事可做，直接返回。
 */
export function deleteToLineStart(editor: monaco.editor.IStandaloneCodeEditor): void {
  const model = editor.getModel()
  const pos = editor.getPosition()
  if (!model || !pos) return
  if (pos.lineNumber === 1 && pos.column === 1) return

  const start =
    pos.lineNumber === 1
      ? { lineNumber: 1, column: 1 }
      : { lineNumber: pos.lineNumber - 1, column: model.getLineMaxColumn(pos.lineNumber - 1) }

  editor.pushUndoStop()
  editor.executeEdits('deleteToLineStart', [
    {
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: pos.lineNumber,
        endColumn: pos.column
      },
      text: ''
    }
  ])
  editor.pushUndoStop()
  editor.focus()
}

/**
 * 翻页（方案 §3.3，同 Python `_page`）：按当前视口可见行数整页滚动，
 * 目标行置于顶部并把光标带过去；Shift+空格向上。
 */
export function pageBy(editor: monaco.editor.IStandaloneCodeEditor, direction: 1 | -1): void {
  const model = editor.getModel()
  if (!model) return
  const ranges = editor.getVisibleRanges()
  if (!ranges.length) return
  const top = ranges[0].startLineNumber
  const bottom = ranges[ranges.length - 1].endLineNumber
  const pageLines = Math.max(1, bottom - top)
  const target = Math.max(1, Math.min(model.getLineCount(), top + direction * pageLines))
  // 目标行贴顶（同 Python 把滚动条设到该行），而不是只滚到「刚好可见」
  editor.setScrollTop(editor.getTopForLineNumber(target), monaco.editor.ScrollType.Immediate)
  editor.setPosition({ lineNumber: target, column: 1 })
  showStatusMessage(`阅读到第 ${target} 行`, 2000)
}
