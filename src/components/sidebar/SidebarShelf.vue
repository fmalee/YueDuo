<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { libraryFastScan } from '@/ipc/bridge'
import { useLibraryStore } from '@/stores/library'
import { useTabs } from '@/composables/useTabs'
import { chooseAndSwitchLibrary } from '@/composables/useLibrarySwitch'
import type { LibraryEntry } from '../../../shared/types'

/**
 * 书架页（方案 §2.5）：资源管理器式惰性树。
 * 只读文件名，目录在前、TXT 在后，默认折叠；展开某目录时才读下一层，不碰数据库。
 */
interface Row {
  entry: LibraryEntry
  depth: number
}

const library = useLibraryStore()
const { openFile, activateTab } = useTabs()

/** 相对路径 → 该层条目；'' 是书库根 */
const entries = reactive(new Map<string, LibraryEntry[]>())
const expanded = reactive(new Set<string>())
const loading = reactive(new Set<string>())
const openError = ref('')

const rows = computed<Row[]>(() => {
  const result: Row[] = []
  const walk = (list: LibraryEntry[] | undefined, depth: number): void => {
    if (!list) return
    for (const entry of list) {
      result.push({ entry, depth })
      if (entry.isDir && expanded.has(entry.relativePath)) {
        walk(entries.get(entry.relativePath), depth + 1)
      }
    }
  }
  walk(entries.get(''), 0)
  return result
})

const loadingRoot = computed(() => loading.has(''))

const status = computed(() => {
  if (library.scanning) return `正在扫描，已检查 ${library.scanned} 个文件…`
  if (library.lastEnrich) return `共 ${library.lastEnrich.total} 本`
  return ''
})

async function loadDir(relativeDir: string): Promise<void> {
  if (loading.has(relativeDir)) return
  loading.add(relativeDir)
  try {
    entries.set(relativeDir, await libraryFastScan(relativeDir))
  } catch (e) {
    openError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.delete(relativeDir)
  }
}

/** 换库/首次挂载：重建目录树（回根目录并折叠），不触发扫描 */
async function reloadRoot(): Promise<void> {
  entries.clear()
  expanded.clear()
  openError.value = ''
  if (library.root) await loadDir('')
}

/**
 * 刷新 = 对当前活动书库做一次完整重扫（新增入库、对账识别移动、删除出库），
 * 完成后由 fileRevision 重读目录树、enrich 刷新四类列表；活动标签与会话不受影响。
 */
async function refreshLibrary(): Promise<void> {
  if (!library.root || library.scanning) return
  openError.value = ''
  const ok = await library.rescanLibrary()
  if (!ok && library.error) openError.value = `刷新失败：${library.error}`
}

/**
 * 文件增删改后重读已加载的目录（含根），保留展开状态。
 * 不用 reloadRoot：那会清空展开集，每次删除都把整棵树折叠回去。
 */
async function reloadLoaded(): Promise<void> {
  if (!library.root) return
  openError.value = ''
  const dirs = new Set(entries.keys())
  dirs.add('')
  await Promise.all([...dirs].map((dir) => loadDir(dir)))
}

async function activate(entry: LibraryEntry): Promise<void> {
  if (entry.isDir) {
    if (expanded.has(entry.relativePath)) {
      expanded.delete(entry.relativePath)
      return
    }
    expanded.add(entry.relativePath)
    if (!entries.has(entry.relativePath)) await loadDir(entry.relativePath)
    return
  }
  openError.value = ''
  try {
    const id = await openFile(`${library.root}/${entry.relativePath}`)
    activateTab(id)
  } catch (e) {
    openError.value = `打开失败：${e instanceof Error ? e.message : String(e)}`
  }
}

watch(
  () => library.root,
  () => {
    void reloadRoot()
  },
  { immediate: true }
)

// 删除/重命名后目录树跟着变（库内列表由同一个 notifyFilesChanged 刷新）
watch(
  () => library.fileRevision,
  () => {
    void reloadLoaded()
  }
)
</script>

<template>
  <div class="yd-panel">
    <div class="yd-panel-scroll">
      <template v-if="library.root">
        <div
          v-for="row in rows"
          :key="row.entry.relativePath"
          class="tree-row"
          :class="{ directory: row.entry.isDir }"
          :style="{
            paddingLeft: `calc(var(--yd-panel-padding) + ${row.depth} * var(--yd-library-indent))`
          }"
          :title="row.entry.relativePath"
          @click="activate(row.entry)"
        >
          <span class="tree-icon">{{
            row.entry.isDir ? (expanded.has(row.entry.relativePath) ? '▾' : '▸') : '·'
          }}</span>
          <span class="tree-name">{{ row.entry.name }}</span>
        </div>
        <div v-if="!rows.length" class="yd-sidebar-empty">
          {{ loadingRoot ? '正在读取目录…' : '目录为空' }}
        </div>
      </template>
      <div v-else class="yd-sidebar-empty">
        <div>{{ library.error || '尚未选择书架目录' }}</div>
        <button class="yd-text-button choose" @click="chooseAndSwitchLibrary()">选择书库</button>
      </div>
    </div>
    <footer class="yd-panel-footer">
      <span class="status" :title="library.root">
        {{ openError || status || library.root || '未设置书库' }}
      </span>
      <button
        class="yd-text-button"
        :disabled="!library.root || library.scanning"
        :title="library.scanning ? '正在扫描当前书库…' : '重新扫描当前书库，更新目录与列表'"
        @click="refreshLibrary"
      >
        {{ library.scanning ? '刷新中…' : '刷新' }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.tree-row {
  display: flex;
  align-items: center;
  gap: 3px;
  height: var(--yd-sidebar-item-height);
  padding-right: var(--yd-panel-padding);
  color: var(--yd-text-1);
  font-size: var(--yd-sidebar-font-size);
  white-space: nowrap;
  cursor: pointer;
}
.tree-row:hover {
  background: var(--yd-hover-1);
}
.tree-icon {
  flex: none;
  width: 12px;
  color: var(--yd-text-3);
  text-align: center;
}
.tree-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.yd-text-button:disabled {
  color: var(--yd-text-3);
  cursor: default;
  opacity: 0.55;
}
.yd-text-button:disabled:hover {
  background: transparent;
}
.choose {
  margin-top: 4px;
  border: 1px solid var(--yd-border-1);
}
</style>
