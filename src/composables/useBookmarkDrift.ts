import { libraryReplaceBookmarks } from '@/ipc/bridge'
import type { BookmarkInfo } from '../../shared/types'

/**
 * 书签行号漂移跟随（方案 §2.7，与 Python _on_contents_change 同口径）：
 * - 每次模型内容变化按「行数差量」平移书签：变更行之前不动；插入时其后书签下移，
 *   删除时落在删除区内的书签丢弃，其后的书签上移；
 * - 800ms 防抖后整本回写数据库，避免每次击键都写库；
 * - 书签列表按 path 存在非响应式 Map，高频编辑事件不进 Vue 响应式。
 */
const FLUSH_DEBOUNCE_MS = 800

const linesByPath = new Map<string, BookmarkInfo[]>()
/** 每个标签上次见到的行数；切标签/LRU 重载后由 EditorHost 重置，避免误算差量 */
const lineCounts = new Map<string, number>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const inFlight = new Map<string, Promise<void>>()
/** 回写在途时又有新编辑：当前轮结束后按最新内存再写一次 */
const pendingAgain = new Set<string>()
const listeners = new Set<(path: string) => void>()

function copy(list: BookmarkInfo[]): BookmarkInfo[] {
  return list.map((item) => ({ line: item.line, note: item.note }))
}

/** 右栏读取后播种基线；回写在途时不覆盖，避免用旧库数据冲掉漂移结果 */
export function seedBookmarkLines(path: string, list: BookmarkInfo[]): void {
  if (!path || timers.has(path)) return
  linesByPath.set(path, copy(list))
}

/** 当前内存中的书签（含未落库的漂移），无记录返回 null */
export function localBookmarkLines(path: string): BookmarkInfo[] | null {
  const list = linesByPath.get(path)
  return list ? copy(list) : null
}

/** 添加成功后同步内存，避免随后一次读取用旧行号覆盖 */
export function noteBookmarkAdded(path: string, line: number, note: string): void {
  if (!path) return
  const list = linesByPath.get(path) ?? []
  const rest = list.filter((item) => item.line !== line)
  rest.push({ line, note })
  rest.sort((a, b) => a.line - b.line)
  linesByPath.set(path, rest)
}

export function noteBookmarkRemoved(path: string, line: number): void {
  const list = linesByPath.get(path)
  if (!list) return
  linesByPath.set(
    path,
    list.filter((item) => item.line !== line)
  )
}

/** 模型切换/重载后重置该标签的行数基线（首次变化只记录，不做差量） */
export function trackBookmarkTab(tabId: string, lineCount: number): void {
  lineCounts.set(tabId, lineCount)
}

function scheduleFlush(path: string): void {
  const existing = timers.get(path)
  if (existing) clearTimeout(existing)
  timers.set(
    path,
    setTimeout(() => {
      timers.delete(path)
      void flushPath(path)
    }, FLUSH_DEBOUNCE_MS)
  )
}

async function flushPath(path: string): Promise<void> {
  const running = inFlight.get(path)
  if (running) {
    // 当前轮写的是旧快照；标记结束后再按最新内存写一次
    pendingAgain.add(path)
    return running
  }
  const run = (async (): Promise<void> => {
    do {
      pendingAgain.delete(path)
      const list = linesByPath.get(path)
      if (!list) return
      try {
        await libraryReplaceBookmarks(path, list)
        for (const listener of listeners) listener(path)
      } catch (e) {
        // 下一次编辑会重新调度；这里只记日志，不打断编辑
        console.error('[bookmark] 回写行号漂移失败:', e)
        return
      }
    } while (pendingAgain.has(path))
  })()
  inFlight.set(path, run)
  try {
    await run
  } finally {
    if (inFlight.get(path) === run) inFlight.delete(path)
  }
}

function applyDrift(
  list: BookmarkInfo[],
  delta: number,
  changedLine: number,
  removedLines: number
): BookmarkInfo[] {
  const adjusted: BookmarkInfo[] = []
  for (const bookmark of list) {
    if (bookmark.line < changedLine) adjusted.push(bookmark)
    else if (delta > 0) adjusted.push({ line: bookmark.line + delta, note: bookmark.note })
    else if (bookmark.line > changedLine + removedLines) {
      adjusted.push({ line: bookmark.line + delta, note: bookmark.note })
    }
  }
  // 平移后可能落到同一行（例如两段被合并），按行号去重，避免撞数据库唯一约束
  const seen = new Set<number>()
  return adjusted.filter((bookmark) => {
    if (seen.has(bookmark.line)) return false
    seen.add(bookmark.line)
    return true
  })
}

/**
 * 内容变化后平移书签（EditorHost 的 onDidChangeModelContent 调用）。
 * changes 为 Monaco 原始变更区间（旧文档坐标），只取最早的起始行作为变更行。
 */
export function handleBookmarkDrift(
  tabId: string,
  path: string,
  changes: readonly { range: { startLineNumber: number } }[],
  currentLineCount: number
): void {
  const previous = lineCounts.get(tabId)
  lineCounts.set(tabId, currentLineCount)
  if (previous === undefined || previous === currentLineCount || !path) return
  const list = linesByPath.get(path)
  if (!list || list.length === 0) return

  const delta = currentLineCount - previous
  const changedLine = changes.length
    ? Math.min(...changes.map((change) => change.range.startLineNumber))
    : 1
  const adjusted = applyDrift(list, delta, changedLine, Math.max(0, -delta))
  if (
    adjusted.length === list.length &&
    adjusted.every((bookmark, index) => bookmark.line === list[index].line)
  ) {
    return
  }
  linesByPath.set(path, adjusted)
  scheduleFlush(path)
}

/**
 * 换库时清空内存基线（方案 §2.13）：旧库的路径/行号/防抖计时不能带到新库。
 * flush 已由存档流程先行完成；这里只丢弃数据，订阅者（右栏）保持不动。
 */
export function resetBookmarkDrift(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  linesByPath.clear()
  lineCounts.clear()
  pendingAgain.clear()
}

/** 立即回写所有待落库的漂移（切标签/保存/退出前调用） */
export async function flushBookmarkDrift(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const paths = [...timers.keys()]
    if (paths.length === 0) return
    for (const path of paths) {
      const timer = timers.get(path)
      if (timer) clearTimeout(timer)
      timers.delete(path)
    }
    await Promise.all(paths.map((path) => flushPath(path)))
  }
  // 连续编辑超过 3 轮仍未停：保留定时器，退出握手也不能无限等待
}

/** 落库后通知右栏刷新（当前书列表 + 全库分组） */
export function onBookmarksFlushed(listener: (path: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
