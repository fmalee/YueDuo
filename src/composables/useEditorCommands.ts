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
      showStatusMessage(`转换失败：${e instanceof Error ? e.message : String(e)}`, 5000)
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

  /** 一键整理（方案 §3.2）：固定三段顺序在主进程完成，整篇一次替换、可撤销 */
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
      showStatusMessage(`整理失败：${e instanceof Error ? e.message : String(e)}`, 5000)
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
    if (result.text === original) {
      showStatusMessage('文本无需整理')
      return
    }
    const position = editor.getPosition()
    editor.pushUndoStop()
    editor.executeEdits('tidy', [{ range: model.getFullModelRange(), text: result.text }])
    editor.pushUndoStop()
    if (position) editor.setPosition(position)
    showStatusMessage('已整理完成，可用撤销恢复', 5000)
  }

  return { saveActive, convertSelection, tidyDocument }
}

/** 右键「简繁/全角」转换动作（一键整理单独走 tidyDocument，返回结构不同） */
export type ConvertCommand = 'toHalfwidth' | 'toTraditional' | 'toSimplified'

/** 命令名 → 主进程转换实现（右键菜单与菜单栏事件共用一份映射） */
export function convertInvoker(command: ConvertCommand): (text: string) => Promise<ConvertResult> {
  if (command === 'toTraditional') return convertToTraditional
  if (command === 'toSimplified') return convertToSimplified
  return convertToHalfwidth
}
