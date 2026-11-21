import { ref } from 'vue'
import { libraryChapters } from '@/ipc/bridge'
import type { ChapterInfo } from '../../shared/types'
import { formatError } from '../utils/format'

/**
 * 右栏章节状态（方案 §2.6）：按当前标签的 path 提取，切换标签只保留最新一轮结果。
 * 章节不是正文，可以进 Vue 响应式；提取在主进程完成，渲染层只负责展示与跳转。
 */
const chapters = ref<ChapterInfo[]>([])
const loading = ref(false)
const error = ref('')
let currentTabId = ''
let currentPath = ''
let generation = 0

const message = formatError

async function loadChapters(tabId: string, path: string): Promise<void> {
  const gen = ++generation
  currentTabId = tabId
  currentPath = path
  error.value = ''
  if (!path) {
    chapters.value = []
    loading.value = false
    return
  }
  loading.value = true
  try {
    const list = await libraryChapters(path)
    if (gen !== generation) return
    chapters.value = list
  } catch (e) {
    if (gen !== generation) return
    chapters.value = []
    error.value = message(e)
  } finally {
    if (gen === generation) loading.value = false
  }
}

/** 保存后重提：只针对右栏当前这本书，其他标签保存不触发 */
export function refreshChaptersForPath(path: string): void {
  if (!path || path !== currentPath) return
  void loadChapters(currentTabId, currentPath)
}

export function useChapters(): {
  chapters: typeof chapters
  loading: typeof loading
  error: typeof error
  loadChapters: typeof loadChapters
} {
  return { chapters, loading, error, loadChapters }
}
