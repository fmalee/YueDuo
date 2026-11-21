import { defineStore } from 'pinia'
import {
  libraryBooksByTag,
  libraryCurrent,
  libraryEnrich,
  libraryFollowing,
  libraryHistory,
  libraryMarkRead,
  libraryRated,
  librarySetBookRating,
  librarySetTagRating,
  librarySyncMetadata,
  libraryTags,
  onLibraryScanProgress
} from '@/ipc/bridge'
import type {
  LibraryBook,
  LibraryEnrichResult,
  LibraryOpenResult,
  LibrarySyncResult,
  LibraryTagSummary
} from '../../shared/types'

/** 订阅只挂一次（HMR 重挂载不重复注册） */
let progressSubscribed = false

/** 同一路径短时间去重：openFile 后紧跟 activateTab 只写一次库、查一次历史 */
const MARK_READ_DEDUPE_MS = 500
let lastMarkPath = ''
let lastMarkAt = 0

/**
 * 最近阅读写入（方案 §2.11，对齐 Python `_READ_STAMP_DELAY_MS`）：
 * 阅读位置每变化一次就重置 60 秒计时，停住 60 秒才更新一次 last_read_at；
 * 切标签/退出前立即写出，避免刚读完就关掉时丢掉这次时间戳。
 * pending 只存路径、不进 Vue 响应式（滚动是高频事件）。
 */
const READ_STAMP_DELAY_MS = 60_000
const pendingStamps = new Set<string>()
let stampTimer: ReturnType<typeof setTimeout> | null = null

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 左栏书库状态（方案 §2.5）：活动书库根 + 四类列表 + 标签下钻 + 评分筛选。
 * 只存元信息与 UI 状态，不碰正文；扫描进度由主进程推送。
 */
export const useLibraryStore = defineStore('library', {
  state: () => ({
    root: '',
    /** 活动库数据库是否回落到 userData（书库根不可写） */
    fallback: false,
    initialized: false,
    scanning: false,
    /** 本轮 enrich 已检查的文件数（进度推送） */
    scanned: 0,
    lastEnrich: null as LibraryEnrichResult | null,
    error: '',
    history: [] as LibraryBook[],
    following: [] as LibraryBook[],
    tags: [] as LibraryTagSummary[],
    activeTag: null as string | null,
    tagBooks: [] as LibraryBook[],
    ratingFilter: null as number | null,
    rated: [] as LibraryBook[],
    /** 文件增删改计数器：书架目录树是文件系统快照，靠它触发重读（数据库列表走 refreshLists） */
    fileRevision: 0
  }),
  actions: {
    /**
     * 启动：主进程已在建窗前按设置打开活动书库（每库一份数据库），
     * 这里只读取状态、刷列表并后台 enrich（方案 §2.13）。
     */
    async init(): Promise<void> {
      if (this.initialized) return
      this.initialized = true
      if (!progressSubscribed) {
        progressSubscribed = true
        onLibraryScanProgress((progress) => {
          this.scanned = progress.scanned
        })
      }
      try {
        const state = await libraryCurrent()
        this.root = state.root
        this.fallback = state.fallback
        if (state.error) this.error = state.error
        if (!this.root) return
        await this.refreshLists()
        void this.enrich()
      } catch (e) {
        this.error = message(e)
      }
    },

    /** 换库完成（或启动同库）后应用新根：重置筛选态并重读列表 + 后台 enrich */
    async applyOpened(result: LibraryOpenResult): Promise<void> {
      this.root = result.root
      this.fallback = result.fallback
      this.error = ''
      this.activeTag = null
      this.tagBooks = []
      this.ratingFilter = null
      this.scanned = 0
      await this.refreshLists()
      void this.enrich()
    },

    /**
     * 后台补元数据 + 对账；完成后刷新列表（书架目录树不走库）。
     * 返回本轮扫描是否成功，供「刷新」按钮区分完成与失败。
     */
    async enrich(): Promise<boolean> {
      if (!this.root || this.scanning) return false
      this.scanning = true
      this.scanned = 0
      this.error = ''
      try {
        this.lastEnrich = await libraryEnrich()
        await this.refreshLists()
        return true
      } catch (e) {
        this.error = message(e)
        return false
      } finally {
        this.scanning = false
      }
    },

    /**
     * 书架「刷新」（方案 §2.5）：对活动书库做一次完整重扫——
     * 新文件入库、文件移动按对账识别、达到阈值的删除出库，随后四类列表由 enrich 刷新；
     * fileRevision 再驱动书架目录树重读已加载目录（保留展开态），活动标签与会话不动。
     */
    async rescanLibrary(): Promise<boolean> {
      if (!this.root || this.scanning) return false
      const ok = await this.enrich()
      if (ok) this.fileRevision++
      return ok
    },

    /**
     * 文件被删除/改名后统一通知左栏（方案 §3.5 联动）：
     * 计数器驱动书架目录树重读（保留展开态），数据库四类列表同时刷新；
     * removedBook 为真时书架「共 N 本」同步减一，不必等下次 enrich。
     */
    async notifyFilesChanged(removedBook = false): Promise<void> {
      if (removedBook && this.lastEnrich && this.lastEnrich.total > 0) {
        this.lastEnrich = { ...this.lastEnrich, total: this.lastEnrich.total - 1 }
      }
      this.fileRevision++
      await this.refreshLists()
    },

    async refreshLists(): Promise<void> {
      if (!this.root) return
      await Promise.all([
        this.loadHistory(),
        this.loadFollowing(),
        this.loadTags(),
        this.loadRated(),
        this.activeTag ? this.loadTagBooks() : Promise.resolve()
      ])
    },

    async loadHistory(): Promise<void> {
      if (!this.root) return
      try {
        this.history = await libraryHistory()
      } catch (e) {
        this.error = message(e)
      }
    },

    async loadFollowing(): Promise<void> {
      if (!this.root) return
      try {
        this.following = await libraryFollowing()
      } catch (e) {
        this.error = message(e)
      }
    },

    async loadTags(): Promise<void> {
      if (!this.root) return
      try {
        this.tags = await libraryTags()
      } catch (e) {
        this.error = message(e)
      }
    },

    /** 标签列点击：进入该标签下的书；再点「← 标签」返回 */
    async selectTag(tag: string): Promise<void> {
      this.activeTag = tag
      await this.loadTagBooks()
    },

    clearTag(): void {
      this.activeTag = null
      this.tagBooks = []
    },

    async loadTagBooks(): Promise<void> {
      if (!this.root || !this.activeTag) return
      try {
        this.tagBooks = await libraryBooksByTag(this.activeTag)
      } catch (e) {
        this.error = message(e)
      }
    },

    /** 标签评分：写库后按新评分重排标签列表（方案 §2.5） */
    async setTagRating(tag: string, rating: number): Promise<void> {
      try {
        await librarySetTagRating(tag, rating)
        await this.loadTags()
        if (this.activeTag === tag) await this.loadTagBooks()
      } catch (e) {
        this.error = message(e)
      }
    },

    /** 评分页筛选：null = 全部有评分的书（最多 100 本） */
    async setRatingFilter(rating: number | null): Promise<void> {
      this.ratingFilter = rating
      await this.loadRated()
    },

    async loadRated(): Promise<void> {
      if (!this.root) return
      try {
        this.rated = await libraryRated(this.ratingFilter)
      } catch (e) {
        this.error = message(e)
      }
    },

    /**
     * 打开/激活标签：写 last_read_at 后刷新历史（方案 §2.5 验收补丁）。
     * 不在书库内的文件静默跳过——打开任意 txt 都不应报错。
     */
    async markRead(path: string): Promise<void> {
      if (!this.root || !path) return
      const now = Date.now()
      if (path === lastMarkPath && now - lastMarkAt < MARK_READ_DEDUPE_MS) return
      lastMarkPath = path
      lastMarkAt = now
      try {
        const timestamp = await libraryMarkRead(path)
        if (timestamp > 0) await this.loadHistory()
      } catch {
        // 书库尚未打开或路径在库外：不打扰阅读
      }
    },

    /**
     * 阅读位置变化（光标移动/滚动）：登记待写路径并重置 60 秒计时（方案 §2.11）。
     * 「打开即写」仍走 markRead，这里只负责读着读着的时间戳防抖。
     */
    scheduleReadStamp(path: string): void {
      if (!this.root || !path) return
      pendingStamps.add(path)
      if (stampTimer) clearTimeout(stampTimer)
      stampTimer = setTimeout(() => {
        stampTimer = null
        void this.flushReadStamps()
      }, READ_STAMP_DELAY_MS)
    },

    /** 立即写出待写的最近阅读时间（切标签/退出前，同 Python currentChanged/aboutToQuit） */
    async flushReadStamps(): Promise<void> {
      if (stampTimer) {
        clearTimeout(stampTimer)
        stampTimer = null
      }
      const paths = [...pendingStamps]
      pendingStamps.clear()
      for (const path of paths) await this.markRead(path)
    },

    /** 书籍评分：库内评分与 Finder 星级同写；就地改值只更新星标显示，按评分排序的列表需重读才实时重排 */
    async setBookRating(id: number, rating: number): Promise<void> {
      try {
        const value = await librarySetBookRating(id, rating)
        for (const list of [this.history, this.following, this.tagBooks, this.rated]) {
          for (const book of list) if (book.id === id) book.rating = value
        }
        // 追更/标签下钻/评分页均按 rating DESC 排序；历史按最近阅读排序，无需重读
        await Promise.all([
          this.loadFollowing(),
          this.activeTag ? this.loadTagBooks() : Promise.resolve(),
          this.loadRated()
        ])
      } catch (e) {
        this.error = message(e)
      }
    },

    /**
     * 保存后同步当前文件（不做全库重扫）：
     * 库内已有记录 → 刷新左栏；另存为到库内产生新记录 → 同时驱动书架目录树重读，
     * 新书立即出现在书架与历史/追更/评分/标签各列表。库外文件不变。
     */
    async syncMetadata(path: string): Promise<LibrarySyncResult | null> {
      if (!this.root || !path) return null
      try {
        const result = await librarySyncMetadata(path)
        if (result.added) {
          if (this.lastEnrich) {
            this.lastEnrich = { ...this.lastEnrich, total: this.lastEnrich.total + 1 }
          }
          this.fileRevision++
        }
        if (result.added || result.updated) await this.refreshLists()
        return result
      } catch (e) {
        this.error = message(e)
        return null
      }
    }
  }
})
