import { fileClearDraft, fileWriteText } from '@/ipc/bridge'
import { useTabsStore } from '@/stores/tabs'
import { useLibraryStore } from '@/stores/library'
import { getTabModel, isDirty, resetBaseline, setStatCache } from './useTabLifecycle'
import { refreshChaptersForPath } from './useChapters'

/** 保存当前标签：全文只在保存瞬间取自 model（方案：全文不进 reactive store） */
export function useEditorCommands(): {
  saveActive: (editor?: import('monaco-editor').editor.IStandaloneCodeEditor) => Promise<boolean>
} {
  const store = useTabsStore()
  const library = useLibraryStore()

  async function saveActive(
    editor?: import('monaco-editor').editor.IStandaloneCodeEditor
  ): Promise<boolean> {
    const tab = store.activeTab
    // 空白标签无保存路径（另存为流程在 closeTab/dialog:saveFile 侧处理）
    if (!tab || !tab.path) return false
    const entry = getTabModel(tab.id)
    if (!entry) return false

    const text = editor ? editor.getValue() : entry.model.getValue()
    const { stat } = await fileWriteText(tab.path, text)
    // 保存后重置版本基线、清 dirty 与草稿（方案 §1.4）；rename 替换后 inode 已变，stat 缓存同步刷新
    resetBaseline(tab.id)
    // 保存统一转工作编码 UTF-16LE（AGENTS.md 文本约定），状态栏随之更新
    store.patchTab(tab.id, { dirty: false, encoding: 'UTF-16LE' })
    setStatCache(tab.id, stat)
    await fileClearDraft(tab.id)
    // 保存即按新正文重解析书名/作者/标签并刷新左栏；不做全库重扫
    void library.syncMetadata(tab.path)
    // 右栏章节同样以落盘后的正文为准（方案 §2.6：保存后重提）
    refreshChaptersForPath(tab.path)
    return true
  }

  return { saveActive }
}

export { isDirty }

/* 合并段落：删除光标前面的内容+换行 */
export function deleteToLineStart(
  editor: import('monaco-editor').editor.IStandaloneCodeEditor
): void {
  const model = editor.getModel()
  const pos = editor.getPosition()
  if (!model || !pos) return
  if (pos.lineNumber === 1 && pos.column === 1) return

  // 第一行只有「行首到光标」；其余行从上一行行尾起，顺带吃掉换行
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
