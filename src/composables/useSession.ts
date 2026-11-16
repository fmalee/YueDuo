import {
  fileWriteDraft,
  onSessionFlush,
  sessionFlushDone,
  sessionPersist,
  sessionRestore
} from '@/ipc/bridge'
import { useTabsStore } from '@/stores/tabs'
import { getTabModel, isDirty, saveViewState } from './useTabLifecycle'
import { monaco } from '@/monaco'
import type { SessionSnapshot } from '../../shared/types'

/**
 * 会话持久化（方案 §1.8）
 * - progress 存「视口顶部行」，恢复时滚到该行并顶部对齐（不居中原点，避免每次重启偏半屏）
 * - 标签增删/切换/滚动 → 2 秒防抖 session:persist；关窗/退出由主进程握手立即落盘
 * - 进度 Map 非 reactive：滚动是高频事件，绝不能进 Vue 响应式
 */
const PERSIST_DEBOUNCE_MS = 2000

const progress = new Map<string, number>()
/** 本次启动从库恢复的进度：标签首次激活时消费一次，之后交给 viewState */
const restoredProgress = new Map<string, number>()

let editor: monaco.editor.IStandaloneCodeEditor | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let subscribed = false
/** 验收注入：让下一次草稿写直接 reject（验证 persist 不被草稿失败牵连） */
let failNextDraftWrite = false

/** EditorHost 拿到编辑器实例后挂上（滚动抓取/退出补存草稿都靠它） */
export function attachSessionEditor(instance: monaco.editor.IStandaloneCodeEditor | null): void {
  editor = instance
}

/** 视口顶部行（方案 §1.8 的 progress_line 口径） */
function topVisibleLine(): number {
  return editor?.getVisibleRanges()[0]?.startLineNumber ?? 0
}

/** 切换标签/滚动时抓取顶部行（非 reactive Map） */
export function captureProgress(tabId: string): void {
  // 只有编辑器当前挂的正是该标签的 model 才可信；重载在途/已卸载时保留旧进度
  const entry = getTabModel(tabId)
  if (!editor || !entry || editor.getModel() !== entry.model) return
  const line = topVisibleLine()
  if (line > 0) progress.set(tabId, line)
}

/** 标签首次激活时取恢复进度（消费一次即删） */
export function takeRestoredProgress(tabId: string): number | null {
  const line = restoredProgress.get(tabId)
  if (line == null) return null
  restoredProgress.delete(tabId)
  return line
}

/**
 * 滚到指定行并顶部对齐（方案 §1.8 验收口径）：
 * revealLineNearTop 只保证「靠近顶部」，实际会偏几行；这里按行首像素精确对齐
 */
export function scrollToTopLine(line: number): void {
  if (!editor) return
  editor.setScrollTop(editor.getTopForLineNumber(line), monaco.editor.ScrollType.Immediate)
}

/** 标签增删/切换/滚动后 2 秒防抖落盘（方案 §1.8） */
export function schedulePersist(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void persistSessionNow().catch((e) => console.error('[session] 保存会话失败:', e))
  }, PERSIST_DEBOUNCE_MS)
}

/** 立即落盘（关窗/退出握手） */
export async function persistSessionNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const store = useTabsStore()
  if (store.activeTabId) captureProgress(store.activeTabId)
  const snapshot: SessionSnapshot = {
    activeTabId: store.activeTabId,
    tabs: store.tabs.map((t) => ({
      id: t.id,
      path: t.path,
      title: t.title,
      progressLine: progress.get(t.id) ?? 0,
      dirty: t.dirty,
      lastFocusedAt: t.lastFocusedAt
    }))
  }
  await sessionPersist(snapshot)
}

/** 启动时恢复标签顺序/active/阅读进度（model 由 EditorHost 懒加载） */
export async function restoreSession(): Promise<void> {
  const store = useTabsStore()
  const restored = await sessionRestore()
  if (restored.tabs.length === 0) return
  for (const row of restored.tabs) {
    if (row.progressLine <= 0) continue
    progress.set(row.id, row.progressLine)
    restoredProgress.set(row.id, row.progressLine)
  }
  store.hydrate(
    restored.tabs.map((row) => ({
      id: row.id,
      path: row.path,
      title: row.title,
      encoding: '',
      dirty: row.dirty,
      lastFocusedAt: row.lastFocusedAt
    })),
    restored.activeTabId
  )
}

/**
 * 退出/关窗落盘（方案 §1.8）：
 * 1. 先写快照（顺序/active/进度/dirty）——快照小且快，超时也一定已落库
 * 2. 再并行写驻留脏标签的 draft/view_state——单个失败/超时只损失该标签草稿，
 *    不牵连快照与其余草稿（主进程超时后至少保住快照 + 已完成的草稿）
 * 3. 无论成败都回 flushDone，绝不卡住退出
 */
async function flushForQuit(): Promise<void> {
  try {
    await persistSessionNow()
  } catch (e) {
    console.error('[session] 退出前快照落盘失败:', e)
  }
  try {
    await persistDirtyResidentTabs()
  } catch (e) {
    console.error('[session] 退出前草稿落盘失败:', e)
  } finally {
    try {
      await sessionFlushDone()
    } catch (e) {
      console.error('[session] flushDone 失败:', e)
    }
  }
}

/** 草稿并行写：每个任务单独兜底，任意一个 reject 都不影响其余任务与快照 */
async function persistDirtyResidentTabs(): Promise<void> {
  const store = useTabsStore()
  const writes: Promise<void>[] = []
  for (const tab of store.tabs) {
    const entry = getTabModel(tab.id)
    if (!entry || !isDirty(tab.id)) continue
    if (editor && store.activeTabId === tab.id) saveViewState(tab.id, editor)
    const meta = {
      path: tab.path,
      title: tab.title,
      progressLine: progress.get(tab.id) ?? 0,
      lastFocusedAt: tab.lastFocusedAt
    }
    let write: Promise<void>
    if (failNextDraftWrite) {
      failNextDraftWrite = false
      write = Promise.reject(new Error('YUE_TEST 注入的草稿写失败'))
    } else {
      write = fileWriteDraft(tab.id, entry.model.getValue(), entry.viewState, meta)
    }
    writes.push(write.catch((e) => console.error(`[session] 草稿落盘失败 ${tab.title}:`, e)))
  }
  await Promise.all(writes)
}

/** 订阅主进程退出握手（只挂一次；HMR 重挂载不重复注册） */
export function initSession(): void {
  if (subscribed) return
  subscribed = true
  onSessionFlush(() => {
    void flushForQuit()
  })
}

/** 验收辅助：滚到指定行（顶部对齐）并返回视口顶部行 */
export function scrollSessionTo(line: number): number | null {
  if (!editor) return null
  scrollToTopLine(line)
  return topVisibleLine()
}

/** 验收辅助：当前内存中的进度快照（非 reactive Map 的只读副本） */
export function progressSnapshot(): Record<string, number> {
  return Object.fromEntries(progress)
}

/** 验收辅助：注入一次草稿写失败（只作用于退出 flush 的并行草稿写） */
export function injectDraftWriteFailure(): void {
  failNextDraftWrite = true
}
