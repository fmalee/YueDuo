import { ref } from 'vue'

/**
 * 状态栏临时提示（方案 §2.7：右键「添加书签」的成功/失败反馈，同 Python statusBar.showMessage）。
 * 文案与计时器放模块级，任何组件都能触发，状态栏统一展示。
 */
export const statusMessage = ref('')
let timer: ReturnType<typeof setTimeout> | null = null

export function showStatusMessage(text: string, duration = 3000): void {
  if (timer) clearTimeout(timer)
  timer = null
  statusMessage.value = text
  if (!text) return
  timer = setTimeout(() => {
    statusMessage.value = ''
    timer = null
  }, duration)
}
