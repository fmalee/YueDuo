import {
  fileWriteDraft,
  onSessionFlush,
  sessionFlushDone,
  sessionPersist,
  sessionRestore
} from '@/ipc/bridge'
import { useTabsStore } from '@/stores/tabs'
import { useLibraryStore } from '@/stores/library'
import {
  getTabModel,
  isDirty,
  resetTabLifecycle,
  restoreViewState,
  saveViewState
} from './useTabLifecycle'
import { flushBookmarkDrift, resetBookmarkDrift } from './useBookmarkDrift'
import { monaco } from '@/monaco'
import { parseMetadata } from '../../shared/metadataParser'
import type { SessionRestore, SessionSnapshot } from '../../shared/types'

/**
 * 会话持久化（方案 §1.8 / §1.12）
 * - progress 存「视口顶部行」，恢复时滚到该行并顶部对齐（不居中原点，避免每次重启偏半屏）
 * - cursor 存光标行列：只恢复视口不恢复光标会让人以为「重启丢位置」（光标跑到第一行）
 * - 标签增删/切换/滚动 → 2 秒防抖 session:persist；关窗/退出由主进程握手立即落盘
 * - progress/cursor Map 非 reactive：滚动是高频事件，绝不能进 Vue 响应式
 */
const PERSIST_DEBOUNCE_MS = 2000

interface CaretPos {
  line: number
  column: number
}

interface RestoredView {
  /** 视口顶部行（0 = 无记录） */
  topLine: number
  /** 光标位置（null = 旧库无光标字段，退回草稿 view_state） */
  caret: CaretPos | null
}

const progress = new Map<string, number>()
const carets = new Map<string, CaretPos>()
/** 本次启动从库恢复的视图：标签首次激活时消费一次，之后交给 viewState */
const restoredView = new Map<string, RestoredView>()

let editor: monaco.editor.IStandaloneCodeEditor | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let subscribed = false
/** 验收注入：让下一次草稿写直接 reject（验证 persist 不被草稿失败牵连） */
let failNextDraftWrite = false

/** EditorHost 拿到编辑器实例后挂上（滚动抓取/退出补存草稿都靠它） */
export function attachSessionEditor(instance: monaco.editor.IStandaloneCodeEditor | null): void {
  editor = instance
}

/** 当前编辑器实例（元数据写回等编排用；EditorHost 未挂载时为 null） */
export function getActiveEditor(): monaco.editor.IStandaloneCodeEditor | null {
  return editor
}

/**
 * 把焦点交还正文：
 * 标签栏/左栏条目是普通 div，点击后焦点掉到 body；LRU 重载的 setModel(null) 也会让 textarea 失焦。
 * 不还焦点的话，切完标签/恢复会话后必须先点一次正文才能打字（用户实测的焦点丢失）。
 */
export function focusEditor(): void {
  editor?.focus()
}

/** 视口顶部行（方案 §1.8 的 progress_line 口径） */
function topVisibleLine(): number {
  return editor?.getVisibleRanges()[0]?.startLineNumber ?? 0
}

/** 切换标签/滚动时抓取顶部行与光标（非 reactive Map） */
export function captureProgress(tabId: string): void {
  // 只有编辑器当前挂的正是该标签的 model 才可信；重载在途/已卸载时保留旧进度
  const entry = getTabModel(tabId)
  if (!editor || !entry || editor.getModel() !== entry.model) return
  const line = topVisibleLine()
  if (line > 0) progress.set(tabId, line)
  const pos = editor.getPosition()
  if (pos) carets.set(tabId, { line: pos.lineNumber, column: pos.column })
}

/**
 * 应用启动恢复的视图（消费一次）：
 * 1. 视口滚到 progress_line 并顶部对齐
 * 2. 光标放回上次行列
 * 3. 视口以「光标可见」为准：光标在屏内就不动进度；落到屏外才最小幅度滚到可见
 * 旧库没有 cursor 字段时退回草稿 view_state（其 selection/scrolling 同源）
 */
export function applyRestoredView(tabId: string): boolean {
  const view = restoredView.get(tabId)
  if (!view) return false
  restoredView.delete(tabId)
  if (!editor) return true
  const model = editor.getModel()
  if (!model) return true
  if (view.topLine > 0) {
    const top = Math.min(view.topLine, model.getLineCount())
    editor.setScrollTop(editor.getTopForLineNumber(top), monaco.editor.ScrollType.Immediate)
  }
  if (view.caret) {
    const line = Math.min(view.caret.line, model.getLineCount())
    const column = Math.max(1, Math.min(view.caret.column, model.getLineMaxColumn(line)))
    const pos = { lineNumber: line, column }
    editor.setPosition(pos)
    // 光标在屏内就不动进度；只有窗口尺寸变化等原因让它落到屏外时，才最小幅度滚动回来
    editor.revealPosition(pos, monaco.editor.ScrollType.Immediate)
  } else {
    restoreViewState(tabId, editor)
  }
  return true
}

/**
 * 滚到指定行并顶部对齐（方案 §1.8 验收口径）：
 * revealLineNearTop 只保证「靠近顶部」，实际会偏几行；这里按行首像素精确对齐
 */
export function scrollToTopLine(line: number): void {
  if (!editor) return
  editor.setScrollTop(editor.getTopForLineNumber(line), monaco.editor.ScrollType.Immediate)
}

/** 右栏章节/书签跳转（方案 §2.6）：光标落到目标行首、居中显示并交还焦点 */
export function jumpToLine(line: number): boolean {
  if (!editor) return false
  const model = editor.getModel()
  if (!model) return false
  const target = Math.max(1, Math.min(Math.round(line), model.getLineCount()))
  editor.setPosition({ lineNumber: target, column: 1 })
  editor.revealLineInCenter(target, monaco.editor.ScrollType.Immediate)
  editor.focus()
  return true
}

/** 全库书签可能指向未打开的书：目标标签的 model 挂上后再跳（同 Python pending jumps） */
const pendingJumps = new Map<string, number>()

/** 跨书点击书签：目标标签已激活则立即跳，否则排队等 EditorHost 激活完成 */
export function requestLineJump(tabId: string, line: number): void {
  const store = useTabsStore()
  const entry = getTabModel(tabId)
  if (editor && store.activeTabId === tabId && entry && editor.getModel() === entry.model) {
    jumpToLine(line)
    return
  }
  pendingJumps.set(tabId, line)
}

/** EditorHost 完成 setModel 后消费排队跳转 */
export function applyPendingLineJump(tabId: string): boolean {
  const line = pendingJumps.get(tabId)
  if (line === undefined) return false
  pendingJumps.delete(tabId)
  return jumpToLine(line)
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
    tabs: store.tabs.map((t) => {
      const caret = carets.get(t.id)
      return {
        id: t.id,
        path: t.path,
        title: t.title,
        progressLine: progress.get(t.id) ?? 0,
        cursorLine: caret?.line ?? 0,
        cursorColumn: caret?.column ?? 0,
        dirty: t.dirty,
        lastFocusedAt: t.lastFocusedAt
      }
    })
  }
  await sessionPersist(snapshot)
}

/** 启动时恢复标签顺序/active/阅读进度（model 由 EditorHost 懒加载） */
export async function restoreSession(): Promise<void> {
  applyRestoredSession(await sessionRestore())
}

/**
 * 换库时清空渲染层会话（方案 §2.13）：
 * 编辑器解绑 → 释放全部 model 与身份缓存 → 清空进度/恢复视图/待跳转 → 清空标签元信息。
 * 顺序必须先解绑再 dispose，避免编辑器仍挂着一个已释放的 model。
 */
function resetSessionForSwitch(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  editor?.setModel(null)
  resetBookmarkDrift()
  resetTabLifecycle()
  progress.clear()
  carets.clear()
  restoredView.clear()
  pendingJumps.clear()
  useTabsStore().hydrate([], null)
}

/**
 * 恢复的标签标题（方案 §1.5）：旧会话里存的是带 `.txt` 的文件名，
 * 与当前文件名一致时按书名口径去后缀；正文书名标题原样保留。
 */
function restoredTitle(path: string, title: string): string {
  const fileName = path.slice(path.lastIndexOf('/') + 1)
  return title === fileName ? parseMetadata('', fileName, '').title : title
}

/**
 * 恢复一份会话（启动 / 换库共用）：
 * 先重置渲染层再灌入新库的标签行与阅读位置；草稿仍由 EditorHost 激活时按 tabId 懒读，
 * 因为此时活动库已经是新库，读到的只会是新库自己的草稿。
 */
export function applyRestoredSession(restored: SessionRestore | null): void {
  resetSessionForSwitch()
  if (!restored || restored.tabs.length === 0) return
  for (const row of restored.tabs) {
    if (row.progressLine > 0) progress.set(row.id, row.progressLine)
    if (row.cursorLine > 0) {
      carets.set(row.id, { line: row.cursorLine, column: row.cursorColumn || 1 })
    }
    if (row.progressLine > 0 || row.cursorLine > 0) {
      restoredView.set(row.id, {
        topLine: row.progressLine,
        caret: row.cursorLine > 0 ? { line: row.cursorLine, column: row.cursorColumn || 1 } : null
      })
    }
  }
  useTabsStore().hydrate(
    restored.tabs.map((row) => ({
      id: row.id,
      path: row.path,
      title: restoredTitle(row.path, row.title),
      encoding: '',
      dirty: row.dirty,
      lastFocusedAt: row.lastFocusedAt
    })),
    restored.activeTabId
  )
}

/**
 * 换库前存档旧会话（方案 §2.13）：
 * 1. 书签漂移与最近阅读先落库（它们有自己的防抖）
 * 2. 会话快照落盘（顺序/active/进度/光标）
 * 3. 驻留脏标签补写草稿全文与视图状态
 * 任一步失败都抛错，调用方据此放弃换库——旧库仍是活动库、数据未动。
 */
export async function archiveSessionForSwitch(): Promise<void> {
  await flushBookmarkDrift()
  try {
    await useLibraryStore().flushReadStamps()
  } catch (e) {
    console.error('[session] 换库前最近阅读落盘失败:', e)
  }
  await persistSessionNow()
  const failed = await persistDirtyResidentTabs()
  if (failed > 0) {
    throw new Error(`有 ${failed} 个标签草稿存档失败，已取消换库`)
  }
}

/**
 * 退出/关窗落盘（方案 §1.8）：
 * 1. 先写快照（顺序/active/进度/dirty）——快照小且快，超时也一定已落库
 * 2. 再并行写驻留脏标签的 draft/view_state——单个失败/超时只损失该标签草稿，
 *    不牵连快照与其余草稿（主进程超时后至少保住快照 + 已完成的草稿）
 * 3. 无论成败都回 flushDone，绝不卡住退出
 */
async function flushForQuit(): Promise<void> {
  // 书签行号漂移先落库：它有 800ms 防抖，退出时可能还有未写的调整
  await flushBookmarkDrift()
  // 最近阅读的位置防抖（方案 §2.11）：退出前把待写时间戳落库（同 Python aboutToQuit）
  try {
    await useLibraryStore().flushReadStamps()
  } catch (e) {
    console.error('[session] 退出前最近阅读落盘失败:', e)
  }
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

/**
 * 草稿并行写：每个任务单独兜底，任意一个 reject 都不影响其余任务与快照；
 * 返回失败数（退出时忽略，换库存档时据此回滚）。
 */
async function persistDirtyResidentTabs(): Promise<number> {
  const store = useTabsStore()
  let failed = 0
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
    writes.push(
      write.catch((e) => {
        failed++
        console.error(`[session] 草稿落盘失败 ${tab.title}:`, e)
      })
    )
  }
  await Promise.all(writes)
  return failed
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

/** 验收辅助：当前光标行列与视口顶部行（方案 §1.12：重启后光标必须回原位） */
export function caretSnapshot(): { line: number; column: number; topLine: number } | null {
  if (!editor) return null
  const pos = editor.getPosition()
  return pos ? { line: pos.lineNumber, column: pos.column, topLine: topVisibleLine() } : null
}

/** 验收辅助：直接放置光标且不滚动（构造「光标与视口分离」的场景） */
export function setCaretForTest(line: number, column: number): boolean {
  const model = editor?.getModel()
  if (!editor || !model || line < 1 || line > model.getLineCount()) return false
  editor.setPosition({ lineNumber: line, column })
  return true
}

/** 验收辅助：注入一次草稿写失败（只作用于退出 flush 的并行草稿写） */
export function injectDraftWriteFailure(): void {
  failNextDraftWrite = true
}
