import { fileWriteText } from '@/ipc/bridge'
import { useTabsStore } from '@/stores/tabs'
import { getTabModel, isDirty, resetBaseline } from './useTabLifecycle'

/** 保存当前标签：全文只在保存瞬间取自 model（方案：全文不进 reactive store） */
export function useEditorCommands(): {
  saveActive: (editor?: import('monaco-editor').editor.IStandaloneCodeEditor) => Promise<boolean>
} {
  const store = useTabsStore()

  async function saveActive(
    editor?: import('monaco-editor').editor.IStandaloneCodeEditor
  ): Promise<boolean> {
    const tab = store.activeTab
    if (!tab) return false
    const entry = getTabModel(tab.id)
    if (!entry) return false

    const text = editor ? editor.getValue() : entry.model.getValue()
    await fileWriteText(tab.path, text)
    // 保存后重置版本基线、清 dirty（方案 §1.4）
    resetBaseline(tab.id)
    store.patchTab(tab.id, { dirty: false })
    return true
  }

  return { saveActive }
}

export { isDirty }
