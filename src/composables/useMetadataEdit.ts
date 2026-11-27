import { metaApplyEdit, metaApplyRating } from '@/ipc/bridge'
import { useTabsStore } from '@/stores/tabs'
import { useLibraryStore } from '@/stores/library'
import { applyTabEdit, getTabState, isDirty } from './useTabLifecycle'
import type {
  MetadataEditResult,
  MetadataField,
  ParsedMetadata,
  RatingWriteResult
} from '../../shared/types'

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
 * 主进程按编辑器当前正文算最小替换区间（UTF-16 码元偏移，与 CM6 文档偏移一致），
 * 通过 applyTabEdit 应用并携带 isolateHistory.of('full')：一次撤销即可回退，内容变化自动置 dirty。
 */
export function useMetadataEdit(): {
  applyMetadataField(field: MetadataField, value: string): Promise<MetadataCommitResult | null>
  applyRating(value: number): Promise<RatingWriteResult | null>
} {
  const tabs = useTabsStore()
  const library = useLibraryStore()

  async function applyMetadataField(
    field: MetadataField,
    value: string
  ): Promise<MetadataCommitResult | null> {
    const tab = tabs.activeTab
    if (!tab?.path) return null
    const state = getTabState(tab.id)
    if (!state) return null

    let next = value
    if (field === 'author') {
      next = value.trim() ? value : '佚名'
    } else if (!value.trim()) {
      // 空书名/空标签无法被解析规则识别，按放弃处理
      return null
    }

    const result: MetadataEditResult = await metaApplyEdit(
      tab.path,
      state.doc.toString(),
      field,
      next
    )

    let changed = false
    if (result.edit) {
      // 激活态直接 dispatch；提交在途时切走标签则离线 state.update 写回注册表
      const applied = applyTabEdit(
        tab.id,
        result.edit.start,
        result.edit.end,
        result.edit.replacement,
        true
      )
      if (applied) {
        tabs.patchTab(tab.id, { dirty: isDirty(tab.id) })
        changed = true
      }
    }

    if (result.updated) void library.refreshLists()
    return { changed, updated: result.updated, metadata: result.metadata }
  }

  /**
   * 评分写回与文本三项同一入口、同一判定：只要有活动标签路径就能写。
   * 库内/库外由主进程按路径分流——库内 books + 文件星级，库外只有文件 Finder 星级；
   * 返回 null 表示没有路径，persisted=false 表示库外星级没写进去、调用方需回退。
   */
  async function applyRating(value: number): Promise<RatingWriteResult | null> {
    const tab = tabs.activeTab
    if (!tab?.path) return null
    const result = await metaApplyRating(tab.path, value)
    if (result.inLibrary) void library.refreshLists()
    return result
  }

  return { applyMetadataField, applyRating }
}
