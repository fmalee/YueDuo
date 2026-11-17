import { defineStore } from 'pinia'

/**
 * 阅读模式状态（方案 §3.3）：锁定后正文只读，空格向下、Shift+空格向上翻页。
 * 与 Python「视图 → 锁定阅读」同一开关，不跨会话持久化（退出即解锁）。
 */
export const useReaderStore = defineStore('reader', {
  state: () => ({
    locked: false
  }),
  actions: {
    setLocked(locked: boolean): void {
      this.locked = locked
    },

    toggle(): void {
      this.locked = !this.locked
    }
  }
})
