import { fileClearDraft, fileReadText, ipcInvoke } from '@/ipc/bridge'
import { useTabsStore } from '@/stores/tabs'
import {
  createTabModel,
  getTabModel,
  isDirty,
  disposeTabModel,
  setStatCache,
  getStatCache,
  removeStatCache,
  waitUnloadSettled
} from './useTabLifecycle'
import { useEditorCommands } from './useEditorCommands'
import type { ConfirmChoice, FileStat } from '../../shared/types'

let seq = 0
const newTabId = (): string => `tab-${Date.now().toString(36)}-${seq++}`

/** 标签打开/切换/关闭/新建业务（渲染层编排，全文经 IPC 后直接进 model） */
export function useTabs(): {
  openFile: (path: string) => Promise<string>
  newBlankTab: () => string
  closeTab: (id: string) => Promise<void>
  activateTab: (id: string) => void
} {
  const store = useTabsStore()
  const { saveActive } = useEditorCommands()

  /**
   * 同文件去重（方案 §1.6）：inode 优先，realPath 兜底。
   * stat 缓存独立于 model 生命周期（model 可被 LRU 卸载，去重判定不受影响）。
   */
  function findSameFile(stat: FileStat): string | null {
    for (const t of store.tabs) {
      const s = getStatCache(t.id)
      if (!s) continue
      if (s.ino === stat.ino || s.realPath === stat.realPath) return t.id
    }
    return null
  }

  async function openFile(path: string): Promise<string> {
    const normalized = path.replace(/\/+$/, '')
    // 第一层：path 快查（已打开则免读一次大文件）
    const byPath = store.tabs.find((t) => t.path === normalized)
    if (byPath) {
      store.setActive(byPath.id)
      return byPath.id
    }

    const { text, stat } = await fileReadText(normalized)

    // 第二层：stat 复查（软链/别名等不同路径指向同一文件）
    const dup = findSameFile(stat)
    if (dup) {
      store.setActive(dup)
      return dup
    }

    const id = newTabId()
    const title = decodeURIComponent(normalized.split('/').pop() ?? '未命名')

    createTabModel(id, text)
    setStatCache(id, stat)
    store.upsertTab({
      id,
      path: normalized,
      title, // 标签显示完整小说名称，不裁切（VS Code 逻辑）
      dirty: false,
      lastFocusedAt: Date.now()
    })
    store.setActive(id)
    return id
  }

  /** Cmd+N 新建空白标签（方案 §1.5：不弹保存框） */
  function newBlankTab(): string {
    const id = newTabId()
    createTabModel(id, '')
    store.upsertTab({ id, path: '', title: '未命名', dirty: false, lastFocusedAt: Date.now() })
    store.setActive(id)
    return id
  }

  /** 关闭：dirty 才弹确认（保存/放弃/取消，原生对话框） */
  async function closeTab(id: string): Promise<void> {
    const tab = store.tabs.find((t) => t.id === id)
    if (!tab) return
    // LRU 卸载在途：等 draft 落定再走关闭逻辑（save 读内容、discard 清草稿都依赖）
    await waitUnloadSettled(id)
    if (isDirty(id)) {
      store.setActive(id)
      const choice: ConfirmChoice = await ipcInvoke<ConfirmChoice>('dialog:confirmClose', tab.title)
      if (choice === 'cancel') return
      if (choice === 'save') {
        let path = tab.path
        // 空白标签没有落盘路径：走「保存为」，取消则中止关闭
        if (!path) {
          const chosen = await ipcInvoke<string | null>('dialog:saveFile', tab.title)
          if (!chosen) return
          path = chosen
          store.patchTab(id, { path, title: chosen.split('/').pop() ?? '未命名' })
        }
        store.setActive(id)
        await saveActive()
      }
    }
    disposeTabModel(id)
    removeStatCache(id)
    // 关闭即清理草稿（save 路径 saveActive 内已清，幂等）
    void fileClearDraft(id)
    store.removeTab(id)
  }

  function activateTab(id: string): void {
    store.setActive(id)
  }

  return { openFile, newBlankTab, closeTab, activateTab }
}

export { getTabModel, isDirty }
