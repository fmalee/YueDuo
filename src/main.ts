import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'
import { useSettingsStore } from './stores/settings'

const pinia = createPinia()
const app = createApp(App)
app.use(pinia)

// 主题先于首帧注入，避免深色启动时闪一下浅色（方案 §1.10）
const settings = useSettingsStore(pinia)
void settings.init().finally(() => app.mount('#app'))
