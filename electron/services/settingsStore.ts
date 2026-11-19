import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  DEFAULT_SETTINGS,
  PRELOAD_MAX_COUNT,
  PRELOAD_MIN_COUNT,
  READER_FONTS,
  READER_FONT_SIZES,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH
} from '../../shared/types'
import type { AppSettings, ReaderFont, ThemeMode } from '../../shared/types'

/**
 * 设置持久化 —— userData/settings.json（方案 §1.9）
 * 纯 Node 实现（AGENTS.md：services 不 import Electron），目录由调用方注入，便于单测隔离
 * 规则表不进设置文件（方案 §3.2）：唯一规则源是 shared/findRules.ts，旧文件的 rules 字段读取时忽略
 */
const FILE_NAME = 'settings.json'
const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

function settingsPath(dir: string): string {
  return join(dir, FILE_NAME)
}

/** 数值字段统一夹在合法区间（脏数据/手工编辑都不该让界面错位） */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 逐字段校验：白名单外/缺字段/类型不对一律回落默认值。
 * 只做字段级回落而非整体重置——旧版本 settings.json 升级时其余字段仍然保留。
 */
function normalize(raw: unknown): AppSettings {
  const value: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    appearance: THEME_MODES.includes(value.appearance as ThemeMode)
      ? (value.appearance as ThemeMode)
      : DEFAULT_SETTINGS.appearance,
    sidebarWidth: clampInt(
      value.sidebarWidth,
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH,
      DEFAULT_SETTINGS.sidebarWidth
    ),
    libraryRoot:
      typeof value.libraryRoot === 'string' ? value.libraryRoot : DEFAULT_SETTINGS.libraryRoot,
    preloadCount: clampInt(
      value.preloadCount,
      PRELOAD_MIN_COUNT,
      PRELOAD_MAX_COUNT,
      DEFAULT_SETTINGS.preloadCount
    ),
    closeButtonAlwaysVisible:
      typeof value.closeButtonAlwaysVisible === 'boolean'
        ? value.closeButtonAlwaysVisible
        : DEFAULT_SETTINGS.closeButtonAlwaysVisible,
    // 字体与字号是固定单选：白名单外的值（旧文件/手工编辑）一律回落默认，不做区间夹取
    readerFont: READER_FONTS.some((font) => font.key === value.readerFont)
      ? (value.readerFont as ReaderFont)
      : DEFAULT_SETTINGS.readerFont,
    readerFontSize:
      typeof value.readerFontSize === 'number' &&
      (READER_FONT_SIZES as readonly number[]).includes(value.readerFontSize)
        ? value.readerFontSize
        : DEFAULT_SETTINGS.readerFontSize
  }
}

/** settings:get —— 文件缺失或 JSON 损坏都回落默认值，不让坏配置阻断启动 */
export function readSettings(dir: string): AppSettings {
  try {
    return normalize(JSON.parse(readFileSync(settingsPath(dir), 'utf8')))
  } catch {
    return { ...DEFAULT_SETTINGS }
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
