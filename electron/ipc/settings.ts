import { app } from 'electron'
import { readSettings, writeSettings } from '../services/settingsStore'
import { applyThemeSource } from './theme'
import { defaultLibraryRoot } from '../devEnv'
import type { AppSettings } from '../../shared/types'

/** settings:get —— 读设置（userData/settings.json；1.10 启动时据此定主题） */
export function settingsGet(): AppSettings {
  const settings = readSettings(app.getPath('userData'))
  // 开发态未设置书库时对外就报测试库，渲染层再落盘也不会把它写空
  return { ...settings, libraryRoot: defaultLibraryRoot(settings.libraryRoot) }
}

/** settings:set —— 写回设置并返回实际落盘值；外观变化同时切 nativeTheme.themeSource */
export function settingsSet(settings: AppSettings): AppSettings {
  const dir = app.getPath('userData')
  // 与旧值合并：调用方只带部分字段时，不能把其他设置悄悄重置为默认
  const saved = writeSettings(dir, { ...readSettings(dir), ...settings })
  applyThemeSource(saved.appearance)
  return saved
}
