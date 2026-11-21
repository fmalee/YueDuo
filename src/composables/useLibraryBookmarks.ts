import { computed, ref } from 'vue'
import { libraryAllBookmarks } from '@/ipc/bridge'
import type { LibraryBookmarkGroup } from '../../shared/types'
import { formatError } from '../utils/format'

/**
 * 全库书签分组状态（方案 §2.7）：按书合并，组内按行号升序。
 * 与当前书书签分开：这份供右栏「书签」页，当前书书签仍挂在章节页下半部分。
 */
const groups = ref<LibraryBookmarkGroup[]>([])
const loading = ref(false)
const error = ref('')
let generation = 0

const total = computed(() =>
  groups.value.reduce((sum: number, group) => sum + group.bookmarks.length, 0)
)

async function loadLibraryBookmarks(): Promise<void> {
  const gen = ++generation
  loading.value = true
  error.value = ''
  try {
    const list = await libraryAllBookmarks()
    if (gen !== generation) return
    groups.value = list
  } catch (e) {
    if (gen !== generation) return
    groups.value = []
    error.value = formatError(e)
  } finally {
    if (gen === generation) loading.value = false
  }
}

export function useLibraryBookmarks(): {
  groups: typeof groups
  loading: typeof loading
  error: typeof error
  total: typeof total
  loadLibraryBookmarks: typeof loadLibraryBookmarks
} {
  return { groups, loading, error, total, loadLibraryBookmarks }
}

/** 添加/删除书签后让全库分组跟着刷新（右栏未必停在书签页） */
export function refreshLibraryBookmarks(): void {
  void loadLibraryBookmarks()
}
