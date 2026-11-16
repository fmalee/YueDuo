import { defineStore } from 'pinia'
import type { TabMeta } from '../../shared/types'

/**
 * 标签元信息 store —— 只存元信息与 UI 状态，全文内容只存在于 Monaco model
 * （方案 §二根因教训 2：全文绝不进 Pinia reactive）
 */
export const useTabsStore = defineStore('tabs', {
  state: () => ({
    tabs: [] as TabMeta[],
    activeTabId: null as string | null
  }),
  getters: {
    activeTab(state): TabMeta | null {
      return state.tabs.find((t) => t.id === state.activeTabId) ?? null
    }
  },
  actions: {
    upsertTab(meta: TabMeta): void {
      const i = this.tabs.findIndex((t) => t.id === meta.id)
      if (i === -1) this.tabs.push(meta)
      else this.tabs[i] = meta
    },
    patchTab(id: string, patch: Partial<TabMeta>): void {
      const t = this.tabs.find((x) => x.id === id)
      if (t) Object.assign(t, patch)
    },
    removeTab(id: string): void {
      const i = this.tabs.findIndex((t) => t.id === id)
      if (i === -1) return
      this.tabs.splice(i, 1)
      if (this.activeTabId === id) {
        // 切到右侧（无则左侧）标签，VS Code 逻辑
        this.activeTabId = (this.tabs[i] ?? this.tabs[i - 1])?.id ?? null
      }
    },
    setActive(id: string): void {
      this.activeTabId = id
      this.patchTab(id, { lastFocusedAt: Date.now() })
    },
    /**
     * 会话恢复（方案 §1.8）：整体替换标签与 active。
     * 不经过 setActive，避免把恢复的 lastFocusedAt 刷成当前时间（LRU 驻留顺序会失真）
     */
    hydrate(tabs: TabMeta[], activeTabId: string | null): void {
      this.tabs = tabs
      this.activeTabId =
        activeTabId && tabs.some((t) => t.id === activeTabId) ? activeTabId : (tabs[0]?.id ?? null)
    }
  }
})
