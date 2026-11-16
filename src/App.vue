<script setup lang="ts">
import { onMounted, ref } from 'vue'
import TabBar from '@/components/TabBar.vue'
import EditorHost from '@/components/EditorHost.vue'
import { useTabs } from '@/composables/useTabs'
import { nativeSanity } from '@/ipc/bridge'

// 阶段 1.2 验收页：file:readText IPC → model → setModel 切换闭环
const { openFile } = useTabs()
const status = ref('未打开')
const pathInput = ref('/Users/Joey/Sites/Projects/小说/重生之心动.txt')

async function open(): Promise<void> {
  try {
    const id = await openFile(pathInput.value)
    status.value = `已打开标签 ${id}`
  } catch (e) {
    status.value = `打开失败：${String(e)}`
  }
}

async function testIpc(): Promise<void> {
  try {
    const r = await nativeSanity()
    status.value = `IPC OK —— better-sqlite3: ${r.betterSqlite3}，Electron ${r.electron}`
  } catch (e) {
    status.value = `IPC FAIL —— ${String(e)}`
  }
}

onMounted(() => {
  if (new URLSearchParams(location.search).get('auto') === '1') {
    // 自动验收：打开两本书验证多标签 + setModel 切换闭环
    openFile('/Users/Joey/Sites/Projects/小说/重生之心动.txt')
      .then(() => openFile('/Users/Joey/Sites/Projects/小说/风流小保安.txt'))
      .then(() => {
        document.title = 'YUE_TABS_OK'
      })
      .catch((e) => {
        document.title = `YUE_TABS_FAIL:${String(e).slice(0, 80)}`
      })
      .finally(testIpc)
  }
})
</script>

<template>
  <div class="app">
    <header class="bar">
      <input v-model="pathInput" class="path-input" />
      <button @click="open">打开</button>
      <button @click="testIpc">IPC</button>
      <span class="hint">{{ status }}</span>
    </header>
    <TabBar />
    <main class="main">
      <EditorHost />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid #ddd;
}
.path-input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 3px 6px;
}
.main {
  flex: 1;
  min-height: 0;
}
.hint {
  font-size: 12px;
  color: #888;
  white-space: nowrap;
}
</style>
