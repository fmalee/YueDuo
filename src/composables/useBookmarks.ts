import { ref } from 'vue'
import { libraryAddBookmark, libraryBookmarks, libraryRemoveBookmark } from '@/ipc/bridge'
import type { BookmarkInfo } from '../../shared/types'

/**
 * 右栏书签状态（方案 §2.6）：按当前标签的 path 读取，行号 1-based、升序。
 * 新增/删除直接采用主进程返回的最新列表，避免渲染层自行拼装造成排序漂移。
 */
const bookmarks = ref<BookmarkInfo[]>([])
const loading = ref(false)
const error = ref('')
let currentPath = ''
let generation = 0

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function loadBookmarks(path: string): Promise<void> {
  const gen = ++generation
  currentPath = path
  error.value = ''
  if (!path) {
    bookmarks.value = []
    loading.value = false
    return
  }
  loading.value = true
  try {
    const list = await libraryBookmarks(path)
    if (gen !== generation) return
    bookmarks.value = list
  } catch (e) {
    if (gen !== generation) return
    bookmarks.value = []
    error.value = message(e)
  } finally {
    if (gen === generation) loading.value = false
  }
}

async function addBookmark(path: string, line: number, note: string): Promise<void> {
  const list = await libraryAddBookmark(path, line, note)
  if (path === currentPath) bookmarks.value = list
}

async function removeBookmark(path: string, line: number): Promise<void> {
  const list = await libraryRemoveBookmark(path, line)
  if (path === currentPath) bookmarks.value = list
}

export function useBookmarks(): {
  bookmarks: typeof bookmarks
  loading: typeof loading
  error: typeof error
  loadBookmarks: typeof loadBookmarks
  addBookmark: typeof addBookmark
  removeBookmark: typeof removeBookmark
} {
  return { bookmarks, loading, error, loadBookmarks, addBookmark, removeBookmark }
}
