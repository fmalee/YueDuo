import { defineStore } from 'pinia'
import {
  libraryBooksByTag,
  libraryEnrich,
  libraryFollowing,
  libraryHistory,
  libraryMarkRead,
  libraryOpen,
  libraryRated,
  librarySetBookRating,
  librarySetTagRating,
  librarySyncMetadata,
  libraryTags,
  onLibraryScanProgress,
  chooseLibrary
} from '@/ipc/bridge'
import { useSettingsStore } from '@/stores/settings'
import type { LibraryBook, LibraryEnrichResult, LibraryTagSummary } from '../../shared/types'

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
    rated: [] as LibraryBook[]
  }),
  actions: {
    /** 启动时按设置里的书库根打开；未设置则保持空书架 */
    async init(): Promise<void> {
      if (this.initialized) return
      this.initialized = true
      if (!progressSubscribed) {
        progressSubscribed = true
        onLibraryScanProgress((progress) => {
          this.scanned = progress.scanned
        })
      }
      const settings = useSettingsStore()
      if (!settings.libraryRoot) return
      await this.open(settings.libraryRoot)
    },

    /** 选择目录并切换书库（设置持久化 + 打开） */
    async chooseAndOpen(): Promise<void> {
      try {
        const root = await chooseLibrary()
        if (!root) return
        const settings = useSettingsStore()
        await settings.setLibraryRoot(root)
        await this.open(root)
      } catch (e) {
        this.error = message(e)
      }
    },

    /**
     * 打开书库：realpath 归一 → 重读四类列表 → 后台 enrich。
     * 失败时保留原来的书库与列表（切换失败不丢当前状态）
     */
    async open(root: string): Promise<void> {
      try {
        const result = await libraryOpen(root)
        this.root = result.root
        this.error = ''
        this.activeTag = null
        this.tagBooks = []
        this.ratingFilter = null
        this.scanned = 0
        await this.refreshLists()
        void this.enrich()
      } catch (e) {
        this.error = message(e)
      }
    },

    /** 后台补元数据 + 对账；完成后刷新列表（书架目录树不走库） */
    async enrich(): Promise<void> {
      if (!this.root || this.scanning) return
      this.scanning = true
      this.scanned = 0
      try {
        this.lastEnrich = await libraryEnrich()
        await this.refreshLists()
      } catch (e) {
        this.error = message(e)
      } finally {
        this.scanning = false
      }
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

    /** 书籍评分：库内评分与 Finder 星级同写，随后按新评分刷新评分页 */
    async setBookRating(id: number, rating: number): Promise<void> {
      try {
        const value = await librarySetBookRating(id, rating)
        for (const list of [this.history, this.following, this.tagBooks, this.rated]) {
          for (const book of list) if (book.id === id) book.rating = value
        }
        await this.loadRated()
      } catch (e) {
        this.error = message(e)
      }
    },

    /** 保存后同步当前文件元数据，命中库内记录才刷新左栏（不做全库重扫） */
    async syncMetadata(path: string): Promise<void> {
      if (!this.root || !path) return
      try {
        const result = await librarySyncMetadata(path)
        if (result.updated) await this.refreshLists()
      } catch (e) {
        this.error = message(e)
      }
    }
  }
})
