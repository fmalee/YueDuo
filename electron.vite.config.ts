import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve('electron/main.ts'),
        // native 模块与其依赖必须外置，禁止打进 bundle
        external: ['better-sqlite3', 'bindings', 'file-uri-to-path']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve('electron/preload.ts')
      }
    }
  },
  renderer: {
    root: resolve('src'),
    publicDir: resolve('public'),
    build: {
      rollupOptions: {
        input: resolve('src/index.html')
      }
    },
    resolve: {
      alias: {
        '@': resolve('src')
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
    plugins: [vue()]
  }
})
