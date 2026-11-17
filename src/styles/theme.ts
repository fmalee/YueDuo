/**
 * 主题 token 唯一来源（AGENTS.md：颜色/间距/字号只在这里定义，经 --yd-* 注入）
 * 命名沿用 base.css 的分层习惯：bg-1/2/3 由外到内、text-1/2/3 由主到次
 */
import { DEFAULT_SETTINGS } from '../../shared/types'

export const LIGHT_COLORS = {
  'bg-1': '#ffffff', // 窗口底色
  'bg-2': '#fbf8f3', // 标签栏 / 状态栏
  'bg-3': '#fdfbf7', // 当前标签 / 编辑器
  'border-1': '#e3dacd',
  'hover-1': '#f0e9dd',
  'active-1': '#ddd2c0',
  'text-1': '#333333',
  'text-2': '#4a3f2f',
  'text-3': '#8a7f6e',
  accent: '#b07d2b', // 星级等强调色
  cursor: '#4a3f2f',
  selection: '#e6dcc9',
  overlay: 'rgba(0, 0, 0, 0.25)', // 命令面板遮罩
  shadow: 'rgba(0, 0, 0, 0.18)',
  danger: '#a33a2a' // 表单校验/文件操作失败
}

export type ThemeColors = typeof LIGHT_COLORS

/** 深色为同色系的暖暗色，避免阅读界面出现蓝灰刺眼 */
export const DARK_COLORS: ThemeColors = {
  'bg-1': '#1b1916',
  'bg-2': '#221f1a',
  'bg-3': '#26231d',
  'border-1': '#3a352c',
  'hover-1': '#2b2721',
  'active-1': '#3a352c',
  'text-1': '#d9d3c7',
  'text-2': '#e8e2d5',
  'text-3': '#9b9384',
  accent: '#d8ab55',
  cursor: '#e8e2d5',
  selection: '#4a4233',
  overlay: 'rgba(0, 0, 0, 0.45)',
  shadow: 'rgba(0, 0, 0, 0.5)',
  danger: '#e0806f'
}

/** 组件尺寸 token（CSS 变量 --yd-statusbar-height 等由 applyTheme 注入） */
export const METRICS = {
  statusBarHeight: 24,
  statusBarPaddingX: 12,
  statusBarGap: 14,
  statusBarFontSize: 12,
  // 状态栏「锁定阅读」开关（方案 §3.3）：描边小按钮，不抢阅读区注意力
  statusLockHeight: 18,
  statusLockPaddingX: 6,
  statusLockRadius: 3,
  sidebarWidth: DEFAULT_SETTINGS.sidebarWidth, // 仅作 CSS 兜底，实际宽度由设置内联覆盖
  sidebarFontSize: 13,
  sidebarItemHeight: 26,
  sidebarPaddingX: 10,
  sidebarGap: 8,
  // 左栏页签与书库列表（方案 §2.5）
  sidebarTabFontSize: 12,
  sidebarTabPaddingY: 3,
  sidebarTabPaddingX: 5,
  panelPadding: 8,
  panelGap: 6,
  libraryRowHeight: 38,
  librarySmallFontSize: 11,
  libraryIndent: 12,
  libraryCountWidth: 48,
  starSize: 13,
  // 右栏书签条目：两行（行号 + 摘要），与 Python METRICS.bookmark_row_height 同口径
  bookmarkRowHeight: 40,
  // 标签栏自绘横向滚动条：置顶细条，避开标签标题（原生滚动条在底部且过粗）
  tabScrollbarHeight: 3,
  tabScrollbarMinThumbWidth: 24,
  // 标签栏（方案 §1.5）：关闭按钮不占布局宽度，悬停浮出、允许遮挡标题
  tabPaddingX: 10,
  tabCloseSize: 18,
  tabCloseInset: 4,
  // 编辑器标签栏高度：左右侧栏页签行不再强制同高，只按此高度对齐文字基线与列表起点
  tabBarHeight: 34,
  // 侧栏页签行：自身只包住文字（上下 2.5px 呼吸），整体下移 5.5px 使文字基线与标签栏一致，列表首行落在 34px
  tabRowPaddingY: 2.5,
  tabRowOffsetTop: 5.5,
  // 元数据栏（方案 §2.9）：编辑器下方、状态栏上方的单行编辑条
  metadataBarHeight: 30,
  metadataPaddingX: 10,
  metadataGap: 8,
  metadataLabelGap: 4,
  metadataFontSize: 12,
  metadataInputPaddingY: 2,
  metadataInputPaddingX: 6,
  metadataRadius: 3,
  // 命令面板（方案 §2.12）：居中偏上的浮层，宽度与行高对齐 Python METRICS
  paletteWidth: 560,
  paletteMaxHeight: 420,
  paletteTopOffset: 88,
  paletteRadius: 6,
  paletteInputPaddingY: 9,
  paletteInputPaddingX: 12,
  paletteInputFontSize: 14,
  paletteRowPaddingY: 6,
  paletteRowPaddingX: 12,
  paletteRowGap: 10,
  paletteFontSize: 13,
  paletteMetaFontSize: 11,
  paletteHintFontSize: 11,
  paletteKeyPaddingX: 4,
  paletteKeyRadius: 3,
  // 自绘查找替换栏（方案 §3.1）：浮在编辑器右上角，宽度可拖右边缘调整
  findBarWidth: 440,
  findBarMinWidth: 280,
  findBarMaxWidth: 760,
  findBarMargin: 10,
  findBarTop: 10,
  findBarPaddingX: 6,
  findBarPaddingY: 5,
  findBarGap: 4,
  findBarRowGap: 4,
  findBarRadius: 4,
  findBarInputHeight: 24,
  findBarInputPaddingX: 6,
  findBarInputRadius: 3,
  findBarFontSize: 12,
  findBarIconSize: 14,
  findBarToggleSize: 20,
  findBarToggleRadius: 3,
  findBarToggleFontSize: 11,
  findBarRulesWidth: 380,
  findBarRulesMaxHeight: 320,
  findBarRulesPadding: 4,
  findBarRulesRowPaddingY: 5,
  findBarRulesRowPaddingX: 8,
  findBarRulesRadius: 3,
  findBarRulesGap: 2,
  findBarRulesDescriptionFontSize: 11,
  // 标签右键菜单与重命名浮层（方案 §3.5）
  tabMenuMinWidth: 148,
  tabMenuPaddingY: 4,
  tabMenuItemPaddingY: 5,
  tabMenuItemPaddingX: 12,
  tabMenuFontSize: 12,
  tabMenuRadius: 6,
  renameWidth: 360,
  renamePadding: 16,
  renameGap: 10,
  renameButtonPaddingY: 4,
  renameButtonPaddingX: 12
} as const

/** 阅读排版 token（monaco.ts 的 READER_EDITOR_OPTIONS 引用） */
export const READING = {
  fontSize: 15,
  lineHeight: 22
} as const

/** 注入当前主题：颜色 + 尺寸 + color-scheme（原生控件/滚动条跟随深浅） */
export function applyTheme(dark: boolean): void {
  const root = document.documentElement
  const colors = dark ? DARK_COLORS : LIGHT_COLORS
  for (const [name, value] of Object.entries(colors)) {
    root.style.setProperty(`--yd-${name}`, value)
  }
  root.style.setProperty('--yd-statusbar-height', `${METRICS.statusBarHeight}px`)
  root.style.setProperty('--yd-statusbar-padding-x', `${METRICS.statusBarPaddingX}px`)
  root.style.setProperty('--yd-statusbar-gap', `${METRICS.statusBarGap}px`)
  root.style.setProperty('--yd-statusbar-font-size', `${METRICS.statusBarFontSize}px`)
  root.style.setProperty('--yd-status-lock-height', `${METRICS.statusLockHeight}px`)
  root.style.setProperty('--yd-status-lock-padding-x', `${METRICS.statusLockPaddingX}px`)
  root.style.setProperty('--yd-status-lock-radius', `${METRICS.statusLockRadius}px`)
  root.style.setProperty('--yd-sidebar-width', `${METRICS.sidebarWidth}px`)
  root.style.setProperty('--yd-sidebar-font-size', `${METRICS.sidebarFontSize}px`)
  root.style.setProperty('--yd-sidebar-item-height', `${METRICS.sidebarItemHeight}px`)
  root.style.setProperty('--yd-sidebar-padding-x', `${METRICS.sidebarPaddingX}px`)
  root.style.setProperty('--yd-sidebar-gap', `${METRICS.sidebarGap}px`)
  root.style.setProperty('--yd-sidebar-tab-font-size', `${METRICS.sidebarTabFontSize}px`)
  root.style.setProperty('--yd-sidebar-tab-padding-y', `${METRICS.sidebarTabPaddingY}px`)
  root.style.setProperty('--yd-sidebar-tab-padding-x', `${METRICS.sidebarTabPaddingX}px`)
  root.style.setProperty('--yd-panel-padding', `${METRICS.panelPadding}px`)
  root.style.setProperty('--yd-panel-gap', `${METRICS.panelGap}px`)
  root.style.setProperty('--yd-library-row-height', `${METRICS.libraryRowHeight}px`)
  root.style.setProperty('--yd-library-small-font-size', `${METRICS.librarySmallFontSize}px`)
  root.style.setProperty('--yd-library-indent', `${METRICS.libraryIndent}px`)
  root.style.setProperty('--yd-library-count-width', `${METRICS.libraryCountWidth}px`)
  root.style.setProperty('--yd-star-size', `${METRICS.starSize}px`)
  root.style.setProperty('--yd-bookmark-row-height', `${METRICS.bookmarkRowHeight}px`)
  root.style.setProperty('--yd-tab-scrollbar-height', `${METRICS.tabScrollbarHeight}px`)
  root.style.setProperty(
    '--yd-tab-scrollbar-min-thumb-width',
    `${METRICS.tabScrollbarMinThumbWidth}px`
  )
  root.style.setProperty('--yd-tab-padding-x', `${METRICS.tabPaddingX}px`)
  root.style.setProperty('--yd-tab-close-size', `${METRICS.tabCloseSize}px`)
  root.style.setProperty('--yd-tab-close-inset', `${METRICS.tabCloseInset}px`)
  root.style.setProperty('--yd-tab-bar-height', `${METRICS.tabBarHeight}px`)
  root.style.setProperty('--yd-tab-row-padding-y', `${METRICS.tabRowPaddingY}px`)
  root.style.setProperty('--yd-tab-row-offset-top', `${METRICS.tabRowOffsetTop}px`)
  root.style.setProperty('--yd-metadata-bar-height', `${METRICS.metadataBarHeight}px`)
  root.style.setProperty('--yd-metadata-padding-x', `${METRICS.metadataPaddingX}px`)
  root.style.setProperty('--yd-metadata-gap', `${METRICS.metadataGap}px`)
  root.style.setProperty('--yd-metadata-label-gap', `${METRICS.metadataLabelGap}px`)
  root.style.setProperty('--yd-metadata-font-size', `${METRICS.metadataFontSize}px`)
  root.style.setProperty('--yd-metadata-input-padding-y', `${METRICS.metadataInputPaddingY}px`)
  root.style.setProperty('--yd-metadata-input-padding-x', `${METRICS.metadataInputPaddingX}px`)
  root.style.setProperty('--yd-metadata-radius', `${METRICS.metadataRadius}px`)
  root.style.setProperty('--yd-palette-width', `${METRICS.paletteWidth}px`)
  root.style.setProperty('--yd-palette-max-height', `${METRICS.paletteMaxHeight}px`)
  root.style.setProperty('--yd-palette-top-offset', `${METRICS.paletteTopOffset}px`)
  root.style.setProperty('--yd-palette-radius', `${METRICS.paletteRadius}px`)
  root.style.setProperty('--yd-palette-input-padding-y', `${METRICS.paletteInputPaddingY}px`)
  root.style.setProperty('--yd-palette-input-padding-x', `${METRICS.paletteInputPaddingX}px`)
  root.style.setProperty('--yd-palette-input-font-size', `${METRICS.paletteInputFontSize}px`)
  root.style.setProperty('--yd-palette-row-padding-y', `${METRICS.paletteRowPaddingY}px`)
  root.style.setProperty('--yd-palette-row-padding-x', `${METRICS.paletteRowPaddingX}px`)
  root.style.setProperty('--yd-palette-row-gap', `${METRICS.paletteRowGap}px`)
  root.style.setProperty('--yd-palette-font-size', `${METRICS.paletteFontSize}px`)
  root.style.setProperty('--yd-palette-meta-font-size', `${METRICS.paletteMetaFontSize}px`)
  root.style.setProperty('--yd-palette-hint-font-size', `${METRICS.paletteHintFontSize}px`)
  root.style.setProperty('--yd-palette-key-padding-x', `${METRICS.paletteKeyPaddingX}px`)
  root.style.setProperty('--yd-palette-key-radius', `${METRICS.paletteKeyRadius}px`)
  root.style.setProperty('--yd-find-top', `${METRICS.findBarTop}px`)
  root.style.setProperty('--yd-find-padding-x', `${METRICS.findBarPaddingX}px`)
  root.style.setProperty('--yd-find-padding-y', `${METRICS.findBarPaddingY}px`)
  root.style.setProperty('--yd-find-gap', `${METRICS.findBarGap}px`)
  root.style.setProperty('--yd-find-row-gap', `${METRICS.findBarRowGap}px`)
  root.style.setProperty('--yd-find-radius', `${METRICS.findBarRadius}px`)
  root.style.setProperty('--yd-find-input-height', `${METRICS.findBarInputHeight}px`)
  root.style.setProperty('--yd-find-input-padding-x', `${METRICS.findBarInputPaddingX}px`)
  root.style.setProperty('--yd-find-input-radius', `${METRICS.findBarInputRadius}px`)
  root.style.setProperty('--yd-find-font-size', `${METRICS.findBarFontSize}px`)
  root.style.setProperty('--yd-find-icon-size', `${METRICS.findBarIconSize}px`)
  root.style.setProperty('--yd-find-toggle-size', `${METRICS.findBarToggleSize}px`)
  root.style.setProperty('--yd-find-toggle-radius', `${METRICS.findBarToggleRadius}px`)
  root.style.setProperty('--yd-find-toggle-font-size', `${METRICS.findBarToggleFontSize}px`)
  root.style.setProperty('--yd-find-rules-width', `${METRICS.findBarRulesWidth}px`)
  root.style.setProperty('--yd-find-rules-max-height', `${METRICS.findBarRulesMaxHeight}px`)
  root.style.setProperty('--yd-find-rules-padding', `${METRICS.findBarRulesPadding}px`)
  root.style.setProperty('--yd-find-rules-row-padding-y', `${METRICS.findBarRulesRowPaddingY}px`)
  root.style.setProperty('--yd-find-rules-row-padding-x', `${METRICS.findBarRulesRowPaddingX}px`)
  root.style.setProperty('--yd-find-rules-radius', `${METRICS.findBarRulesRadius}px`)
  root.style.setProperty('--yd-find-rules-gap', `${METRICS.findBarRulesGap}px`)
  root.style.setProperty(
    '--yd-find-rules-description-font-size',
    `${METRICS.findBarRulesDescriptionFontSize}px`
  )
  root.style.setProperty('--yd-tab-menu-min-width', `${METRICS.tabMenuMinWidth}px`)
  root.style.setProperty('--yd-tab-menu-padding-y', `${METRICS.tabMenuPaddingY}px`)
  root.style.setProperty('--yd-tab-menu-item-padding-y', `${METRICS.tabMenuItemPaddingY}px`)
  root.style.setProperty('--yd-tab-menu-item-padding-x', `${METRICS.tabMenuItemPaddingX}px`)
  root.style.setProperty('--yd-tab-menu-font-size', `${METRICS.tabMenuFontSize}px`)
  root.style.setProperty('--yd-tab-menu-radius', `${METRICS.tabMenuRadius}px`)
  root.style.setProperty('--yd-rename-width', `${METRICS.renameWidth}px`)
  root.style.setProperty('--yd-rename-padding', `${METRICS.renamePadding}px`)
  root.style.setProperty('--yd-rename-gap', `${METRICS.renameGap}px`)
  root.style.setProperty('--yd-rename-button-padding-y', `${METRICS.renameButtonPaddingY}px`)
  root.style.setProperty('--yd-rename-button-padding-x', `${METRICS.renameButtonPaddingX}px`)
  root.style.colorScheme = dark ? 'dark' : 'light'
}
