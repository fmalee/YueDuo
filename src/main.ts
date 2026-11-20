import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'
import { useSettingsStore } from './stores/settings'
import { windowShow } from './ipc/bridge'

const pinia = createPinia()
const app = createApp(App)
app.use(pinia)

// 主题先于首帧注入，避免深色启动时闪一下浅色（方案 §1.10）
const settings = useSettingsStore(pinia)
void settings.init().finally(() => {
  app.mount('#app')
  // 窗口 visible=false（tauri.conf.json）：主题就绪后再显示，杜绝 WKWebView 白底闪烁
  void windowShow().catch((e) => console.error('[window] 显示窗口失败:', e))
})
