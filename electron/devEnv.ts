/**
 * 开发环境约定（方案：开发/打包配置隔离）。
 * 开发态与打包版共用系统默认 userData 会让调试读写正式书库的设置、会话与数据库索引，
 * 这里把差异收成两个事实：怎么判定开发态、开发态默认用哪份书库。
 */

/** 开发态判定：Electron 45 从 node_modules 启动时 app.isPackaged 误报 true，以 dev server 地址为准 */
export function isDevRuntime(): boolean {
  return Boolean(process.env['ELECTRON_RENDERER_URL'])
}

/** 开发态默认书库：`/Users/Joey/Sites/Projects/小说` 本身就是复制出来的测试库 */
export const DEV_LIBRARY_ROOT = '/Users/Joey/Sites/Projects/小说'

/** 未设置书库根时的生效值：开发态回落测试库，打包版保持空（由用户选择） */
export function defaultLibraryRoot(root: string): string {
  if (root) return root
  return isDevRuntime() ? DEV_LIBRARY_ROOT : ''
}
