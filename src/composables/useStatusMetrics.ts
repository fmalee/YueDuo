import { reactive } from 'vue'
import { monaco } from '@/monaco'

/**
 * 状态栏数据（方案 §1.10）：光标行 / 总行数 / 字数
 * 只存数字，全文始终留在 Monaco model（AGENTS.md：全文字符串不进 Vue 响应式）
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

/** 切换模型 / 内容变化后刷新行数与字数（getValueLength 由 Monaco 增量维护，O(1)） */
export function refreshStatusMetrics(model: monaco.editor.ITextModel | null): void {
  if (!model) {
    statusMetrics.cursorLine = 1
    statusMetrics.lineCount = 0
    statusMetrics.charCount = 0
    return
  }
  statusMetrics.lineCount = model.getLineCount()
  statusMetrics.charCount = model.getValueLength()
}
