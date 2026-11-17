import { dialog } from 'electron'
import type { ConfirmChoice } from '../../shared/types'

/** dialog:confirmClose —— dirty 标签关闭前三选一（原生对话框） */
export function confirmClose(title: string): ConfirmChoice {
  const result = dialog.showMessageBoxSync({
    type: 'question',
    title: '未保存的更改',
    message: `「${title}」有未保存的更改`,
    detail: '关闭前是否保存？',
    buttons: ['保存', '放弃更改', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  })
  return (['save', 'discard', 'cancel'] as const)[result] ?? 'cancel'
}

/** dialog:saveFile —— 空白标签首次保存时选择落盘路径 */
export function chooseSaveFile(defaultName: string): string | null {
  const rs = dialog.showSaveDialogSync({
    title: '保存为',
    defaultPath: defaultName.endsWith('.txt') ? defaultName : `${defaultName}.txt`,
    filters: [{ name: '文本文件', extensions: ['txt'] }]
  })
  return rs ?? null
}

/** dialog:confirmTrash —— 删除标签文件前确认（方案 §3.5；默认按钮是取消，防误删） */
export function confirmTrash(title: string, dirty: boolean): boolean {
  // 自动化验收：YUE_TEST 下窗口不可见，模态框会把主进程卡死，直接放行（同 main.ts 的测试分支）
  if (process.env['YUE_TEST']) return true
  const result = dialog.showMessageBoxSync({
    type: 'warning',
    title: '移到废纸篓',
    message: `将「${title}」移到废纸篓？`,
    detail: dirty ? '未保存的修改也会一并丢弃。' : '文件会移到废纸篓，库内记录与书签一并删除。',
    buttons: ['移到废纸篓', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  })
  return result === 0
}

/** dialog:showError —— 文件操作失败的可见提示（rename 走浮层内联，trash/reveal 走这里） */
export function showError(title: string, message: string): null {
  dialog.showMessageBoxSync({
    type: 'error',
    title,
    message: title,
    detail: message,
    buttons: ['好'],
    defaultId: 0,
    noLink: true
  })
  return null
}

/** dialog:chooseLibrary —— 选择书库根目录（阶段 2 接管，先占位保证域完整） */
export function chooseLibrary(): string | null {
  const rs = dialog.showOpenDialogSync({ properties: ['openDirectory'] })
  return rs?.[0] ?? null
}
