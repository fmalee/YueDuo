/**
 * 纯 CodeMirror 6 编辑动作与文档工具
 *
 * 所有用户编辑动作均携带 isolateHistory.of('full') 隔离撤销组，
 * 且在 view.state.readOnly 时直接返回。
 */
import { isolateHistory } from '@codemirror/commands'
import type { ChangeSet, ChangeSpec, Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { BookmarkInfo, TidyEdit } from '../../shared/types'
import { getVisibleLineRange } from './codemirror'

export const INDENT_RE = /^[ \t\u3000]+/

export function docHeadText(doc: Text, maxLines: number): string {
  if (maxLines <= 0) return ''
  const endLine = Math.min(doc.lines, Math.trunc(maxLines))
  return doc.sliceString(0, doc.line(endLine).to)
}

/** 仅当变更区间触及文档前 N 行（含旧/新文档边界）时才需要重算头部元数据 */
export function changesTouchHeadLines(
  oldDoc: Text,
  newDoc: Text,
  changes: ChangeSet,
  headLines: number
): boolean {
  const oldLimit = oldDoc.line(Math.min(headLines, oldDoc.lines)).to
  const newLimit = newDoc.line(Math.min(headLines, newDoc.lines)).to
  let touched = false
  changes.iterChangedRanges((fromA, _toA, fromB) => {
    if (fromA <= oldLimit || fromB <= newLimit) touched = true
  })
  return touched
}

/** 按原 1-based 行号与 0-based 列偏移夹取恢复光标位置（不触发滚动） */
export function restoreCaret(view: EditorView, lineNumber: number, colOffset: number): void {
  const doc = view.state.doc
  const clampedLine = Math.max(1, Math.min(doc.lines, lineNumber))
  const line = doc.line(clampedLine)
  const pos = Math.min(line.to, line.from + Math.max(0, colOffset))
  view.dispatch({ selection: { anchor: pos } })
}

export function insertNewlineCmd(view: EditorView, withIndent: boolean): void {
  if (view.state.readOnly) return
  const sel = view.state.selection.main
  let insert = '\n'
  if (withIndent) {
    const line = view.state.doc.lineAt(sel.from)
    const match = INDENT_RE.exec(line.text)
    const indent = match ? match[0] : '\u3000\u3000'
    insert = `\n${indent}`
  }
  const cursor = sel.from + insert.length
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: cursor },
    scrollIntoView: true,
    annotations: isolateHistory.of('full')
  })
}

export function insertLineBelowCmd(view: EditorView, withIndent: boolean): void {
  if (view.state.readOnly) return
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  let indent = ''
  if (withIndent) {
    const match = INDENT_RE.exec(line.text)
    indent = match ? match[0] : '\u3000\u3000'
  }
  const insert = `\n${indent}`
  const cursor = line.to + insert.length
  view.dispatch({
    changes: { from: line.to, to: line.to, insert },
    selection: { anchor: cursor },
    scrollIntoView: true,
    annotations: isolateHistory.of('full')
  })
}

export function deleteToLineStartCmd(view: EditorView): void {
  if (view.state.readOnly) return
  const head = view.state.selection.main.head
  if (head === 0) return
  const doc = view.state.doc
  const line = doc.lineAt(head)
  const from = line.number === 1 ? 0 : doc.line(line.number - 1).to
  view.dispatch({
    changes: { from, to: head, insert: '' },
    selection: { anchor: from },
    scrollIntoView: true,
    annotations: isolateHistory.of('full')
  })
  view.focus()
}

export function pageByCmd(view: EditorView, direction: 1 | -1): number | null {
  const range = getVisibleLineRange(view)
  if (!range) return null
  const doc = view.state.doc
  const pageLines = Math.max(1, range.bottom - range.top)
  const target = Math.max(1, Math.min(doc.lines, range.top + direction * pageLines))
  const pos = doc.line(target).from
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 0 })
  })
  return target
}

export function applyTidyEdits(view: EditorView, edits: readonly TidyEdit[]): void {
  if (view.state.readOnly || edits.length === 0) return
  const doc = view.state.doc

  const head = view.state.selection.main.head
  const curLine = doc.lineAt(head)
  const savedLine = curLine.number
  const savedCol = head - curLine.from

  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine)
  const changes: ChangeSpec[] = sorted.map((e) => {
    const startLine = Math.max(1, Math.min(doc.lines, e.startLine))
    const endLine = Math.max(startLine, Math.min(doc.lines, e.endLine))
    const from = doc.line(startLine).from
    const isAtDocEnd = endLine >= doc.lines
    const to = isAtDocEnd ? doc.line(doc.lines).to : doc.line(endLine + 1).from
    // Rust services/convert.rs 生成的 TidyEdit.text 在非末行已自带尾换行，纯删除为空串，末行无尾换行；直接透传
    return { from, to, insert: e.text }
  })

  view.dispatch({
    changes,
    annotations: isolateHistory.of('full')
  })

  restoreCaret(view, savedLine, savedCol)
}

export function mapBookmarksByChanges(
  bookmarks: readonly BookmarkInfo[],
  oldDoc: Text,
  newDoc: Text,
  changes: ChangeSet
): BookmarkInfo[] {
  if (bookmarks.length === 0) return []

  const deletedRanges: Array<{ from: number; to: number }> = []
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (inserted.length === 0 && toA > fromA) {
      deletedRanges.push({ from: fromA, to: toA })
    }
  })

  const mapped: BookmarkInfo[] = []
  for (const bm of bookmarks) {
    if (bm.line < 1 || bm.line > oldDoc.lines) continue
    const oldLine = oldDoc.line(bm.line)
    const deletedWholeLine = deletedRanges.some(
      (r) =>
        r.from <= oldLine.from && r.to >= oldLine.to && (r.from < oldLine.from || r.to > oldLine.to)
    )
    if (deletedWholeLine) continue

    const newPos = Math.max(0, Math.min(newDoc.length, changes.mapPos(oldLine.from, 1)))
    const newLine = newDoc.lineAt(newPos).number
    mapped.push({ line: newLine, note: bm.note })
  }

  mapped.sort((a, b) => a.line - b.line)

  const deduped: BookmarkInfo[] = []
  for (const bm of mapped) {
    if (deduped.length === 0 || deduped[deduped.length - 1].line !== bm.line) {
      deduped.push(bm)
    }
  }
  return deduped
}
