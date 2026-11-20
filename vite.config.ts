import { dirname, resolve } from 'path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'
import { fileURLToPath } from 'url'

const configDir = dirname(fileURLToPath(import.meta.url))
const monacoStringsJsPath = resolve(
  configDir,
  'node_modules/monaco-editor/esm/vs/base/common/strings.js'
)
const cjkWrapStringsPath = resolve(configDir, 'src/monaco/cjkWrapStrings.ts')

/** 拦截 Monaco strings.js，注入中文全角标点判断（仅 renderer，与原 electron.vite.config 同款） */
function monacoCjkWrapStringsPlugin(): Plugin {
  const normalizedStringsPath = monacoStringsJsPath.replace(/\\/g, '/')
  const normalizedWrapPath = cjkWrapStringsPath.replace(/\\/g, '/')
  return {
    name: 'monaco-cjk-wrap-strings',
    enforce: 'pre' as const,
    resolveId(id: string, importer: string | undefined) {
      const bareId = id.split('?')[0] ?? ''
      let candidate = bareId.replace(/\\/g, '/')
      if ((bareId.startsWith('.') || bareId.startsWith('/')) && importer) {
        candidate = resolve(dirname(importer), bareId).replace(/\\/g, '/')
      }
      const isMonacoStrings =
        candidate === normalizedStringsPath ||
        candidate.endsWith('/monaco-editor/esm/vs/base/common/strings.js')
      if (!isMonacoStrings) return null
      const importerNorm = (importer ?? '').replace(/\\/g, '/')
      if (importerNorm.includes('/monaco/cjkWrapStrings') || importerNorm === normalizedWrapPath) {
        return null
      }
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
