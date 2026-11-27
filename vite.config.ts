import { dirname, resolve } from 'path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'url'

const configDir = dirname(fileURLToPath(import.meta.url))

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
  plugins: [vue()],
  server: {
    port: 1420,
    strictPort: true
  }
})
