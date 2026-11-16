import { app } from 'electron'
import { readSettings, writeSettings } from '../services/settingsStore'
import type { AppSettings } from '../../shared/types'

/** settings:get —— 读设置（userData/settings.json；1.10 启动时据此定主题） */
export function settingsGet(): AppSettings {
  return readSettings(app.getPath('userData'))
}

/** settings:set —— 写回设置并返回实际落盘值（1.10 切换外观时调用） */
export function settingsSet(settings: AppSettings): AppSettings {
  return writeSettings(app.getPath('userData'), settings)
}
