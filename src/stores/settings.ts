import { defineStore } from 'pinia'
import { DEFAULT_SETTINGS } from '../../shared/types'
import type { AppSettings, ReaderFont, ThemeMode } from '../../shared/types'
import { onThemeUpdated, settingsGet, settingsSet } from '@/ipc/bridge'
import { applyTheme } from '@/styles/theme'
import { applyMonacoTheme } from '@/monaco'

/** 订阅只挂一次（HMR 重挂载不重复注册，preload 侧监听器不泄漏） */
let themeSubscribed = false

/**
 * 设置状态（方案 §1.9）：外观三态（§1.10）+ 侧栏宽度 / 书库根目录 / 预载数量 / 关闭按钮常驻
 * 生效主题以主进程 nativeTheme 推送为准：外观=system 时由 OS 决定，light/dark 时锁定
 */
export const useSettingsStore = defineStore('settings', {
  state: () => ({
    appearance: DEFAULT_SETTINGS.appearance as ThemeMode,
    dark: false,
    sidebarWidth: DEFAULT_SETTINGS.sidebarWidth,
    libraryRoot: DEFAULT_SETTINGS.libraryRoot,
    preloadCount: DEFAULT_SETTINGS.preloadCount,
    closeButtonAlwaysVisible: DEFAULT_SETTINGS.closeButtonAlwaysVisible,
    readerFont: DEFAULT_SETTINGS.readerFont as ReaderFont,
    readerFontSize: DEFAULT_SETTINGS.readerFontSize
  }),
  actions: {
    /** 首帧前初始化：读设置 → 注入 token → 订阅 nativeTheme 推送 */
    async init(): Promise<void> {
      try {
        const saved = await settingsGet()
        this.appearance = saved.appearance
        this.sidebarWidth = saved.sidebarWidth
        this.libraryRoot = saved.libraryRoot
        this.preloadCount = saved.preloadCount
        this.closeButtonAlwaysVisible = saved.closeButtonAlwaysVisible
        this.readerFont = saved.readerFont
        this.readerFontSize = saved.readerFontSize
      } catch (e) {
        console.error('[theme] 读取设置失败，按默认外观启动:', e)
      }
      // 主进程已在建窗前应用 themeSource，matchMedia 反映的就是生效主题
      this.dark =
        this.appearance === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
          : this.appearance === 'dark'
      this.apply()
      if (!themeSubscribed) {
        themeSubscribed = true
        onThemeUpdated(({ dark }) => {
          this.dark = dark
          this.apply()
        })
      }
    },

    /** 当前全部设置：写回必须是完整对象，避免局部更新丢字段 */
    snapshot(): AppSettings {
      return {
        appearance: this.appearance,
        sidebarWidth: this.sidebarWidth,
        libraryRoot: this.libraryRoot,
        preloadCount: this.preloadCount,
        closeButtonAlwaysVisible: this.closeButtonAlwaysVisible,
        readerFont: this.readerFont,
        readerFontSize: this.readerFontSize
      }
    },

    /** 落盘并以主进程校验后的值为准（失败时保留内存值，不阻断操作） */
    async persist(): Promise<AppSettings> {
      try {
        const saved = await settingsSet(this.snapshot())
        this.appearance = saved.appearance
        this.sidebarWidth = saved.sidebarWidth
        this.libraryRoot = saved.libraryRoot
        this.preloadCount = saved.preloadCount
        this.closeButtonAlwaysVisible = saved.closeButtonAlwaysVisible
        this.readerFont = saved.readerFont
        this.readerFontSize = saved.readerFontSize
        return saved
      } catch (e) {
        console.error('[settings] 保存失败，本次修改仅内存生效:', e)
        return this.snapshot()
      }
    },

    /** 切换外观：先本地立即生效（避免一帧闪白），主进程 themeSource 更新后会推送权威值 */
    async setAppearance(appearance: ThemeMode): Promise<void> {
      this.appearance = appearance
      this.dark =
        appearance === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
          : appearance === 'dark'
      this.apply()
      await this.persist()
    },

    async setSidebarWidth(width: number): Promise<void> {
      this.sidebarWidth = width
      await this.persist()
    },

    async setLibraryRoot(root: string): Promise<void> {
      this.libraryRoot = root
      await this.persist()
    },

    async setPreloadCount(count: number): Promise<void> {
      this.preloadCount = count
      await this.persist()
    },

    async setCloseButtonAlwaysVisible(visible: boolean): Promise<void> {
      this.closeButtonAlwaysVisible = visible
      await this.persist()
    },

    /** 正文字体/字号：EditorHost 监听这两个值，走 editor.updateOptions 即时生效 */
    async setReaderFont(font: ReaderFont): Promise<void> {
      this.readerFont = font
      await this.persist()
    },

    async setReaderFontSize(size: number): Promise<void> {
      this.readerFontSize = size
      await this.persist()
    },

    /** DOM token + Monaco 主题同步切换 */
    apply(): void {
      applyTheme(this.dark)
      applyMonacoTheme(this.dark)
    }
  }
})
