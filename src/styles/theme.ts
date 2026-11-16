/**
 * 主题 token 唯一来源（AGENTS.md：颜色/间距/字号只在这里定义，经 --yd-* 注入）
 * 命名沿用 base.css 的分层习惯：bg-1/2/3 由外到内、text-1/2/3 由主到次
 */
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
  cursor: '#4a3f2f',
  selection: '#e6dcc9'
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
  cursor: '#e8e2d5',
  selection: '#4a4233'
}

/** 组件尺寸 token（CSS 变量 --yd-statusbar-height 等由 applyTheme 注入） */
export const METRICS = {
  statusBarHeight: 24,
  statusBarPaddingX: 12,
  statusBarGap: 14,
  statusBarFontSize: 12
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
  root.style.colorScheme = dark ? 'dark' : 'light'
}
