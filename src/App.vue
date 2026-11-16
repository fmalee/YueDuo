<script setup lang="ts">
import { onMounted, ref } from 'vue'
import EditorHost from '@/components/EditorHost.vue'

// 0.2 阶段验收页：Monaco 大文件一次性 setValue 瞬开
const host = ref<InstanceType<typeof EditorHost>>()
const loading = ref(false)

async function openBigFile(): Promise<void> {
  if (!host.value || loading.value) return
  loading.value = true
  try {
    const resp = await fetch('/test/rebirth.txt')
    const text = await resp.text()
    const ms = host.value.loadText(text, '重生之心动.txt')
    // 自动化验收通道：结果写进 title，CDP /json 可直接读取
    document.title = `YUE_RESULT:${text.length}chars:${ms}ms`
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (new URLSearchParams(location.search).get('auto') === '1') {
    openBigFile()
  }
})
</script>

<template>
  <div class="app">
    <header class="bar">
      <button :disabled="loading" @click="openBigFile">
        {{ loading ? '读取中…' : '打开 5.1MB 测试文本' }}
      </button>
      <span class="hint">阶段 0.2 验收：一次性 setValue 应近瞬开</span>
    </header>
    <main class="main">
      <EditorHost ref="host" />
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
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid #ddd;
}
.main {
  flex: 1;
  min-height: 0;
}
.hint {
  font-size: 12px;
  color: #888;
}
</style>
