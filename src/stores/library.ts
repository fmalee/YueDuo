import { defineStore } from 'pinia'
import {
  libraryBooksByTag,
  libraryEnrich,
  libraryFollowing,
  libraryHistory,
  libraryOpen,
  libraryRated,
  librarySetTagRating,
  libraryTags,
  onLibraryScanProgress,
  chooseLibrary
} from '@/ipc/bridge'
import { useSettingsStore } from '@/stores/settings'
import type { LibraryBook, LibraryEnrichResult, LibraryTagSummary } from '../../shared/types'

/** 订阅只挂一次（HMR 重挂载不重复注册） */
let progressSubscribed = false

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
    }
  }
})
