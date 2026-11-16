import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    // 主进程与所有 Node 侧 services/ipc 入口
    entry: resolve('electron/main.ts')
  },
  preload: {
    entry: resolve('electron/preload.ts')
  },
  renderer: {
    root: resolve('src'),
    resolve: {
      alias: {
        '@': resolve('src')
      }
    },
    plugins: [vue()]
  }
})
