import { metaApplyEdit } from '@/ipc/bridge'
import { useTabsStore } from '@/stores/tabs'
import { useLibraryStore } from '@/stores/library'
import { getActiveEditor } from './useSession'
import { isDirty } from './useTabLifecycle'
import type { MetadataEditResult, MetadataField, ParsedMetadata } from '../../shared/types'

export interface MetadataCommitResult {
  /** 正文是否被改写（false = 值未变化，没有产生编辑） */
  changed: boolean
  /** 是否同步到了书库（文件不在活动书库内为 false） */
  updated: boolean
  /** 按写回后的正文重新解析的元数据（供 2.9 元数据栏刷新） */
  metadata: ParsedMetadata
}

/**
 * 元数据写回（方案 §2.8）：空书名/空标签放弃提交，空作者落「佚名」（对齐 Python 控制器）。
 * 主进程按编辑器当前正文算最小替换区间（未保存修改也不会错位），这里用一次
 * executeEdits 应用：pushUndoStop 包住 → 一次撤销即可回退，内容变化自动置 dirty。
 */
export function useMetadataEdit(): {
  applyMetadataField(field: MetadataField, value: string): Promise<MetadataCommitResult | null>
} {
  const tabs = useTabsStore()
  const library = useLibraryStore()

  async function applyMetadataField(
    field: MetadataField,
    value: string
  ): Promise<MetadataCommitResult | null> {
    const editor = getActiveEditor()
    const tab = tabs.activeTab
    if (!editor || !tab?.path) return null
    const model = editor.getModel()
    if (!model) return null

    let next = value
    if (field === 'author') {
      next = value.trim() ? value : '佚名'
    } else if (!value.trim()) {
      // 空书名/空标签无法被解析规则识别，按放弃处理
      return null
    }

    const result: MetadataEditResult = await metaApplyEdit(tab.path, model.getValue(), field, next)

    let changed = false
    if (result.edit) {
      const start = model.getPositionAt(result.edit.start)
      const end = model.getPositionAt(result.edit.end)
      const range = {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column
      }
      if (editor.getModel() === model) {
        editor.pushUndoStop()
        editor.executeEdits('metadata', [{ range, text: result.edit.replacement }])
        editor.pushUndoStop()
      } else {
        // 提交在途时切走了标签：直接改对应 model，undo 栈仍属于该标签
        model.pushStackElement()
        model.pushEditOperations([], [{ range, text: result.edit.replacement }], () => null)
        model.pushStackElement()
        tabs.patchTab(tab.id, { dirty: isDirty(tab.id) })
      }
      changed = true
    }

    if (result.updated) void library.refreshLists()
    return { changed, updated: result.updated, metadata: result.metadata }
  }

  return { applyMetadataField }
}
