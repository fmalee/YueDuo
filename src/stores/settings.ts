import { defineStore } from 'pinia'
import type { ThemeMode } from '../../shared/types'
import { onThemeUpdated, settingsGet, settingsSet } from '@/ipc/bridge'
import { applyTheme } from '@/styles/theme'
import { applyMonacoTheme } from '@/monaco'

/** 订阅只挂一次（HMR 重挂载不重复注册，preload 侧监听器不泄漏） */
let themeSubscribed = false

/**
 * 外观状态（方案 §1.9 持久化 + §1.10 三态切换）
 * 生效主题以主进程 nativeTheme 推送为准：外观=system 时由 OS 决定，light/dark 时锁定
 */
export const useSettingsStore = defineStore('settings', {
  state: () => ({
    appearance: 'system' as ThemeMode,
    dark: false
  }),
  actions: {
    /** 首帧前初始化：读设置 → 注入 token → 订阅 nativeTheme 推送 */
    async init(): Promise<void> {
      try {
        this.appearance = (await settingsGet()).appearance
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

    /** 切换外观：先本地立即生效（避免一帧闪白），主进程 themeSource 更新后会推送权威值 */
    async setAppearance(appearance: ThemeMode): Promise<void> {
      this.appearance = appearance
      this.dark =
        appearance === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
          : appearance === 'dark'
      this.apply()
      try {
        const saved = await settingsSet({ appearance })
        this.appearance = saved.appearance
      } catch (e) {
        console.error('[theme] 保存外观失败:', e)
      }
    },

    /** DOM token + Monaco 主题同步切换 */
    apply(): void {
      applyTheme(this.dark)
      applyMonacoTheme(this.dark)
    }
  }
})
