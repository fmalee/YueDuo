import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'
import { useSettingsStore } from './stores/settings'
import { windowShow } from './ipc/bridge'

const pinia = createPinia()
const app = createApp(App)
app.use(pinia)

// 打包版禁用 WKWebView 原生右键菜单（Reload/Inspect Element 日常用不上，devtools 特性
// 在 release 也开着所以菜单会露出来）；输入框内放行——原生菜单里有复制/粘贴可用。
// preventDefault 后 WebKit 不再弹原生菜单，应用自绘的标签/编辑器菜单不受影响。
// 编译期分流：import.meta.env.PROD 在 dev 为 false，代码被 Vite 死代码消除，dev 完整保留。
if (import.meta.env.PROD) {
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement | null
    if (
      target?.closest('input, textarea') ||
      (target?.closest('[contenteditable="true"]') && !target.closest('.cm-editor'))
    ) {
      return
    }
    e.preventDefault()
  })
}

// 主题先于首帧注入，避免深色启动时闪一下浅色（方案 §1.10）
const settings = useSettingsStore(pinia)
void settings.init().finally(() => {
  app.mount('#app')
  // 窗口 visible=false（tauri.conf.json）：主题就绪后再显示，杜绝 WKWebView 白底闪烁
  void windowShow().catch((e) => console.error('[window] 显示窗口失败:', e))
})
