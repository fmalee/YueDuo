import { fileReadText } from '@/ipc/bridge'
import { useTabsStore } from '@/stores/tabs'
import { createTabModel, getTabModel, isDirty } from './useTabLifecycle'

let seq = 0
const newTabId = (): string => `tab-${Date.now().toString(36)}-${seq++}`

/** 标签打开/切换/关闭业务（渲染层编排，全文经 IPC 后直接进 model） */
export function useTabs(): {
  openFile: (path: string) => Promise<string>
  closeTab: (id: string) => void
  activateTab: (id: string) => void
} {
  const store = useTabsStore()

  /** 同文件去重：已打开则直接激活（1.6 升级为 inode 优先 + realpath 兜底） */
  async function openFile(path: string): Promise<string> {
    const normalized = path.replace(/\/+$/, '')
    const existing = store.tabs.find((t) => t.path === normalized)
    if (existing) {
      store.setActive(existing.id)
      return existing.id
    }

    const { text, encoding } = await fileReadText(normalized)
    const id = newTabId()
    const title = decodeURIComponent(normalized.split('/').pop() ?? '未命名')

    createTabModel(id, text)
    store.upsertTab({
      id,
      path: normalized,
      title: `${title} [${encoding}]`,
      dirty: false,
      lastFocusedAt: Date.now()
    })
    store.setActive(id)
    return id
  }

  function closeTab(id: string): void {
    // model 的卸载由 useTabLifecycle 负责（dirty 草稿持久化在 1.7/1.8 扩展）
    store.removeTab(id)
  }

  function activateTab(id: string): void {
    store.setActive(id)
  }

  return { openFile, closeTab, activateTab }
}

export { getTabModel, isDirty }
