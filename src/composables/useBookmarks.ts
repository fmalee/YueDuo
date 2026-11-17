import { ref } from 'vue'
import { libraryAddBookmark, libraryBookmarks, libraryRemoveBookmark } from '@/ipc/bridge'
import { getTabModel } from '@/composables/useTabLifecycle'
import { caretSnapshot } from '@/composables/useSession'
import { useTabsStore } from '@/stores/tabs'
import {
  localBookmarkLines,
  noteBookmarkAdded,
  noteBookmarkRemoved,
  seedBookmarkLines
} from './useBookmarkDrift'
import { refreshLibraryBookmarks } from './useLibraryBookmarks'
import type { BookmarkInfo } from '../../shared/types'

/**
 * 右栏当前书书签状态（方案 §2.6/§2.7）：按当前标签的 path 读取，行号 1-based、升序。
 * 新增/删除直接采用主进程返回的最新列表，避免渲染层自行拼装造成排序漂移；
 * 有未落库的行号漂移时以内存列表为准，等防抖回写后再与库对齐。
 */
const NOTE_MAX_CHARS = 40
const INDENT = /^[ \t\u3000]+/

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
    seedBookmarkLines(path, list)
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
  noteBookmarkAdded(path, line, note)
  if (path === currentPath) bookmarks.value = localBookmarkLines(path) ?? list
  refreshLibraryBookmarks()
}

async function removeBookmark(path: string, line: number): Promise<void> {
  const list = await libraryRemoveBookmark(path, line)
  noteBookmarkRemoved(path, line)
  if (path === currentPath) bookmarks.value = localBookmarkLines(path) ?? list
  refreshLibraryBookmarks()
}

/**
 * 从当前光标行添加书签（右键菜单与章节页按钮共用）：
 * 空行顺延到下一个有文字的行，同行不重复，摘要截 40 字；返回提示文案。
 */
async function addBookmarkAtCaret(): Promise<string> {
  const store = useTabsStore()
  const tab = store.activeTab
  if (!tab?.path) throw new Error('当前标签没有可收录的内容')
  const model = getTabModel(tab.id)?.model
  if (!model) throw new Error('当前正文尚未载入')
  let line = caretSnapshot()?.line ?? 1
  let text = ''
  while (line <= model.getLineCount()) {
    text = model.getLineContent(line).replace(INDENT, '').trim()
    if (text) break
    line++
  }
  if (!text) throw new Error('光标以下没有可收录的内容')
  const local = localBookmarkLines(tab.path)
  const list =
    local ?? (currentPath === tab.path ? bookmarks.value : await libraryBookmarks(tab.path))
  if (list.some((bookmark) => bookmark.line === line)) throw new Error('该行已有书签')
  await addBookmark(tab.path, line, text.slice(0, NOTE_MAX_CHARS))
  return `已添加第 ${line} 行书签`
}

export function useBookmarks(): {
  bookmarks: typeof bookmarks
  loading: typeof loading
  error: typeof error
  loadBookmarks: typeof loadBookmarks
  addBookmark: typeof addBookmark
  removeBookmark: typeof removeBookmark
  addBookmarkAtCaret: typeof addBookmarkAtCaret
} {
  return {
    bookmarks,
    loading,
    error,
    loadBookmarks,
    addBookmark,
    removeBookmark,
    addBookmarkAtCaret
  }
}
