import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { AppSettings, ThemeMode } from '../../shared/types'

/**
 * 设置持久化 —— userData/settings.json（方案 §1.9，最小切片只落外观三态）
 * 纯 Node 实现（AGENTS.md：services 不 import Electron），目录由调用方注入，便于单测隔离
 */
const FILE_NAME = 'settings.json'
const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']
const DEFAULTS: AppSettings = { appearance: 'system' }

function settingsPath(dir: string): string {
  return join(dir, FILE_NAME)
}

/** 只接受白名单内的外观值，其余（缺字段/旧值/脏数据）一律回落「跟随系统」 */
function normalize(raw: unknown): AppSettings {
  const value =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>).appearance
      : undefined
  return {
    appearance: THEME_MODES.includes(value as ThemeMode)
      ? (value as ThemeMode)
      : DEFAULTS.appearance
  }
}

/** settings:get —— 文件缺失或 JSON 损坏都回落默认值，不让坏配置阻断启动 */
export function readSettings(dir: string): AppSettings {
  try {
    return normalize(JSON.parse(readFileSync(settingsPath(dir), 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

/** settings:set —— 临时文件 + rename 原子替换（与文本保存同款，中断不留半截 JSON） */
export function writeSettings(dir: string, settings: AppSettings): AppSettings {
  mkdirSync(dir, { recursive: true })
  const next = normalize(settings)
  const tmpPath = join(dir, `.${randomUUID()}.settings-tmp`)
  writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmpPath, settingsPath(dir))
  return next
}
