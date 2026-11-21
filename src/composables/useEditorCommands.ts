import type * as Monaco from 'monaco-editor/editor/editor.api'
import {
  convertTidy,
  convertToHalfwidth,
  convertToSimplified,
  convertToTraditional,
  fileClearDraft,
  fileWriteText
} from '@/ipc/bridge'
import { useTabsStore } from '@/stores/tabs'
import { useLibraryStore } from '@/stores/library'
import { getTabModel, resetBaseline, setStatCache } from './useTabLifecycle'
import { refreshChaptersForPath } from './useChapters'
import { persistSessionNow } from './useSession'
import { showStatusMessage } from './useStatusMessage'
import type { ConvertResult, TidyResult } from '../../shared/types'
import { formatError } from '../utils/format'

type Editor = Monaco.editor.IStandaloneCodeEditor

/** 简繁转换的保留项说明（Python ConvertResult.note 同款文案） */
function conversionNote(result: ConvertResult): string {
  const parts: string[] = []
  if (result.kept) parts.push(`保留 ${result.kept} 处多义字`)
  if (result.keptWords) parts.push(`保护词 ${result.keptWords} 处`)
  return parts.join('，')
}

/**
 * 编辑器命令（保存 + 转换/整理）：全文只在读写瞬间取自 model，结果再回到 model。
 * 键位统一由 useEditorKeybindings 分发，右键菜单由 useEditorSetup 注册，二者共用这里的实现。
 */
export function useEditorCommands(): {
  saveActive: (editor?: Editor) => Promise<boolean>
  convertSelection: (
    editor: Editor,
    convert: (text: string) => Promise<ConvertResult>
  ) => Promise<void>
  transformCaseSelection: (editor: Editor, mode: 'lower' | 'upper') => void
  tidyDocument: (editor: Editor) => Promise<void>
} {
  const store = useTabsStore()
  const library = useLibraryStore()

  /** 保存当前标签：全文只在保存瞬间取自 model（方案：全文不进 reactive store） */
  async function saveActive(editor?: Editor): Promise<boolean> {
    const tab = store.activeTab
    // 空白标签无保存路径（另存为流程在 saveTab / dialog:saveFile 侧处理）
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
    // 保存即按新正文重解析书名/作者/标签并刷新左栏，不做全库重扫；
    // 另存为到书库根内时，这一步会把新文件按扫描同口径收录进 books，并让书架/左栏立即重读
    const synced = await library.syncMetadata(tab.path)
    // 标签标题以库内 title 为准（与书架、元数据栏同一口径）
    const libraryTitle = synced?.book?.title
    if (libraryTitle && store.tabs.some((t) => t.id === tab.id && t.title !== libraryTitle)) {
      store.patchTab(tab.id, { title: libraryTitle })
    }
    // 新收录的书此刻已能换算 book_id，立即落盘会话，让 session_tabs 换成「book_id + 相对路径」
    if (synced?.added) {
      await persistSessionNow().catch((e) => console.error('[session] 保存后落盘失败:', e))
    }
    // 右栏章节同样以落盘后的正文为准（方案 §2.6：保存后重提）
    refreshChaptersForPath(tab.path)
    return true
  }

  /**
   * 转换类动作（方案 §3.2）：有选区就转选区，否则转全文；一次 executeEdits 应用，可用撤销恢复。
   * 等主进程返回期间标签可能已切换、正文可能被改，写回前必须复核 model 与原文。
   */
  async function convertSelection(
    editor: Editor,
    convert: (text: string) => Promise<ConvertResult>
  ): Promise<void> {
    const model = editor.getModel()
    if (!model) return
    const selection = editor.getSelection()
    const hasSelection = !!selection && !selection.isEmpty()
    const range = hasSelection ? selection : model.getFullModelRange()
    const original = model.getValueInRange(range)
    if (!original.trim()) {
      showStatusMessage(hasSelection ? '选区没有可转换的内容' : '全文没有可转换的内容')
      return
    }
    let result: ConvertResult
    try {
      result = await convert(original)
    } catch (e) {
      showStatusMessage(`转换失败：${formatError(e)}`, 5000)
      return
    }
    if (model.isDisposed() || editor.getModel() !== model) return
    if (model.getValueInRange(range) !== original) {
      showStatusMessage('转换期间文本已修改，结果未应用', 5000)
      return
    }
    if (result.text === original) {
      showStatusMessage(hasSelection ? '选区没有可转换的内容' : '全文没有可转换的内容')
      return
    }
    const position = editor.getPosition()
    editor.pushUndoStop()
    editor.executeEdits('convert', [{ range, text: result.text }])
    editor.pushUndoStop()
    // 全文整体替换会把光标挤到末尾，转换后按原行列放回（setPosition 自动夹到正文范围内）
    if (!hasSelection && position) editor.setPosition(position)
    const note = conversionNote(result)
    const scope = hasSelection ? '选区' : '全文'
    showStatusMessage(`已转换${scope}，可用撤销恢复${note ? `；${note}` : ''}`, 5000)
  }

  /**
   * 大小写转换（右键「转换为小写/大写」）：只改选区，一次 executeEdits 应用，可一次撤销。
   * 转换可能改变长度（如 ß → SS），替换后按新文本重新圈定选区。
   */
  function transformCaseSelection(editor: Editor, mode: 'lower' | 'upper'): void {
    const model = editor.getModel()
    if (!model) return
    const selection = editor.getSelection()
    if (!selection || selection.isEmpty()) return
    const original = model.getValueInRange(selection)
    const text = mode === 'lower' ? original.toLowerCase() : original.toUpperCase()
    if (text === original) {
      showStatusMessage('选区没有需要转换的内容')
      return
    }
    const start = selection.getStartPosition()
    const startOffset = model.getOffsetAt(start)
    editor.pushUndoStop()
    editor.executeEdits('transformCase', [{ range: selection, text }])
    editor.pushUndoStop()
    const end = model.getPositionAt(startOffset + text.length)
    editor.setSelection({
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column
    })
    showStatusMessage(`已转换为${mode === 'lower' ? '小写' : '大写'}，可用撤销恢复`, 5000)
  }

  /** 一键整理（方案 §3.2）：固定三段顺序在主进程完成，按行精确替换、可撤销 */
  async function tidyDocument(editor: Editor): Promise<void> {
    const model = editor.getModel()
    if (!model) return
    const original = model.getValue()
    if (!original.trim()) {
      showStatusMessage('当前文档为空，无需整理')
      return
    }
    showStatusMessage('正在整理…', 60_000)
    let result: TidyResult
    try {
      result = await convertTidy(original)
    } catch (e) {
      showStatusMessage(`整理失败：${formatError(e)}`, 5000)
      return
    }
    if (model.isDisposed() || editor.getModel() !== model) {
      showStatusMessage('文档已切换，整理结果未应用', 5000)
      return
    }
    if (model.getValue() !== original) {
      showStatusMessage('整理期间文本已修改，结果未应用', 5000)
      return
    }
    if (result.edits.length === 0) {
      showStatusMessage('文本无需整理')
      return
    }
    const position = editor.getPosition()
    editor.pushUndoStop()
    // 按行精确替换（Rust patience diff 只下发变更行）：Monaco 只重算被改行，撤销栈只存增量。
    // 范围 (line,1)-(endLine+1,1) 覆盖 [start..end] 行**含 end 行行尾换行**，与 Rust diff 口径一致——
    // 删除空行必须连换行一起删，否则零宽替换等于无操作（空行永远剩一行）。
    // 文档最后一行没有行尾换行可吃，退化为内容替换 (endLine,maxColumn)。
    // 不传 forceMoveMarkers（装饰走 delta 平移的廉价路径）；分批应用 + 每批让出主线程，
    // 大编辑列表不再冻结 UI。批间不插 undo stop，一次撤销恢复全部。
    const CHUNK = 400
    const lastLine = model.getLineCount() // 以应用前的原始行数判定末行编辑
    // 关键：按行号【降序】分批——每批独立 executeEdits，从文档尾部往前打，
    // 前面批次（更高行号）即使改变了行数也不影响后续批次（更低行号）的目标位置
    const sorted = [...result.edits].sort((x, y) => y.startLine - x.startLine)
    const applyChunk = (batch: typeof result.edits): void => {
      editor.executeEdits(
        'tidy',
        batch.map((e) => ({
          range:
            e.endLine >= lastLine
              ? {
                  startLineNumber: e.startLine,
                  startColumn: 1,
                  endLineNumber: e.endLine,
                  endColumn: model.getLineMaxColumn(e.endLine)
                }
              : {
                  startLineNumber: e.startLine,
                  startColumn: 1,
                  endLineNumber: e.endLine + 1,
                  endColumn: 1
                },
          text: e.text
        }))
      )
    }
    for (let i = 0; i < sorted.length; i += CHUNK) {
      const batch = sorted.slice(i, i + CHUNK)
      if (i === 0) {
        applyChunk(batch)
      } else {
        // 后续批次延后一帧：让出主线程渲染，避免长冻结
        await new Promise((resolve) => setTimeout(resolve, 0))
        applyChunk(batch)
      }
    }
    editor.pushUndoStop()
    if (position) editor.setPosition(position)
    showStatusMessage('已整理完成，可用撤销恢复', 5000)
  }

  return { saveActive, convertSelection, transformCaseSelection, tidyDocument }
}

/** 右键「简繁/全角」转换动作（一键整理单独走 tidyDocument，返回结构不同） */
export type ConvertCommand = 'toHalfwidth' | 'toTraditional' | 'toSimplified'

/** 命令名 → 主进程转换实现（右键菜单与菜单栏事件共用一份映射） */
export function convertInvoker(command: ConvertCommand): (text: string) => Promise<ConvertResult> {
  if (command === 'toTraditional') return convertToTraditional
  if (command === 'toSimplified') return convertToSimplified
  return convertToHalfwidth
}
