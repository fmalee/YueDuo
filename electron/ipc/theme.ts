import { app, BrowserWindow, nativeTheme } from 'electron'
import { readSettings } from '../services/settingsStore'
import type { ThemeMode } from '../../shared/types'

/**
 * 主题主进程侧（方案 §1.10）：
 * nativeTheme.themeSource 是唯一判定口径 —— system 时跟随 OS，light/dark 时锁定，
 * 变化（OS 切换或 themeSource 改动）统一经 'updated' 事件推给渲染层，避免两侧各算一套
 */
export function applyThemeSource(appearance: ThemeMode): void {
  nativeTheme.themeSource = appearance
}

/** 启动时应用已保存外观并注册监听（须在窗口创建前调用） */
export function initTheme(): void {
  applyThemeSource(readSettings(app.getPath('userData')).appearance)
  nativeTheme.on('updated', () => {
    const payload = { dark: nativeTheme.shouldUseDarkColors }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('theme:updated', payload)
    }
  })
}
