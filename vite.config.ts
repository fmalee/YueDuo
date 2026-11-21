import { dirname, resolve } from 'path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'
import { fileURLToPath } from 'url'

const configDir = dirname(fileURLToPath(import.meta.url))
const cjkWrapStringsPath = resolve(configDir, 'src/monaco/cjkWrapStrings.ts')

/**
 * 拦截 Monaco strings.js，注入中文全角标点判断（仅 renderer，与原 electron.vite.config 同款）。
 * 匹配只用「绝对路径以后缀结尾」：等值判断被其后缀覆盖，无需另存原版路径常量；
 * importer 是补丁自身时放行（补丁文件还要引用原版 strings.js），避免循环重定向。
 */
function monacoCjkWrapStringsPlugin(): Plugin {
  return {
    name: 'monaco-cjk-wrap-strings',
    enforce: 'pre',
    resolveId(id: string, importer: string | undefined) {
      const bareId = id.split('?')[0] ?? ''
      // 相对导入按 importer 解析成绝对路径再比对；Windows 反斜杠归一，macOS 上无损
      let candidate = bareId.replace(/\\/g, '/')
      if (bareId.startsWith('.') && importer) {
        candidate = resolve(dirname(importer), bareId).replace(/\\/g, '/')
      }
      if (!candidate.endsWith('/monaco-editor/esm/vs/base/common/strings.js')) return null
      if ((importer ?? '').replace(/\\/g, '/').includes('/monaco/cjkWrapStrings')) return null
      return cjkWrapStringsPath
    }
  }
}

export default defineConfig({
  root: resolve(configDir, 'src'),
  publicDir: resolve(configDir, 'public'),
  base: './',
  build: {
    outDir: resolve(configDir, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(configDir, 'src/index.html')
    }
  },
  resolve: {
    alias: {
      '@': resolve(configDir, 'src')
    }
  },
  // Monaco 拆成多个入口导入（核心 API + 右键菜单/剪贴板/命令面板贡献）：预打包会各打一份共享模块，
  // 导致菜单注册表不是同一个实例、右键菜单为空；这些入口改为直接按源码模块加载，
  // 共享模块按 URL 只实例化一次。生产构建由 Rollup 去重，不受影响。
  optimizeDeps: {
    exclude: [
      'monaco-editor/editor/editor.api',
      'monaco-editor/editor/contrib/contextmenu/browser/contextmenu',
      'monaco-editor/editor/contrib/clipboard/browser/clipboard',
      'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess',
      'monaco-editor/nls',
      'monaco-editor/nls/lang/zh-cn',
      'monaco-editor/platform/actions/common/actions',
      'monaco-editor/platform/contextkey/common/contextkey'
    ]
  },
  plugins: [vue(), monacoCjkWrapStringsPlugin()],
  server: {
    port: 1420,
    strictPort: true
  }
})
