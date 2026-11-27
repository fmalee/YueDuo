import { reactive } from 'vue'
import type { Text } from '@codemirror/state'

/**
 * 状态栏数据（方案 §1.10）：光标行 / 总行数 / 字数
 * 只存数字，全文始终留在 CM6 EditorState.doc（AGENTS.md：全文字符串不进 Vue 响应式）
 */
export const statusMetrics = reactive({
  cursorLine: 1,
  lineCount: 0,
  charCount: 0
})

/** 光标移动只更新当前行（高频事件，不做全文扫描） */
export function setCursorLine(line: number): void {
  statusMetrics.cursorLine = line
}

/** 切换状态 / 内容变化后刷新行数与字数（Text.lines / Text.length 为 B-tree 根属性，O(1)） */
export function refreshStatusMetrics(doc: Text | null): void {
  if (!doc) {
    statusMetrics.cursorLine = 1
    statusMetrics.lineCount = 0
    statusMetrics.charCount = 0
    return
  }
  statusMetrics.lineCount = doc.lines
  statusMetrics.charCount = doc.length
}
