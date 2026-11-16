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

/** dialog:chooseLibrary —— 选择书库根目录（阶段 2 接管，先占位保证域完整） */
export function chooseLibrary(): string | null {
  const rs = dialog.showOpenDialogSync({ properties: ['openDirectory'] })
  return rs?.[0] ?? null
}
