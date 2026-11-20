import {
  appPerfLog,
  fileClearDraft,
  fileReadText,
  fileRename,
  fileReveal,
  fileStat,
  fileTrash,
  chooseSaveFile,
  confirmClose,
  confirmTrash,
  libraryBookByPath,
  showError
} from '@/ipc/bridge'
import { useTabsStore } from '@/stores/tabs'
import { useLibraryStore } from '@/stores/library'
import {
  createTabModel,
  getTabModel,
  isDirty,
  disposeTabModel,
  setStatCache,
  getStatCache,
  removeStatCache,
  waitUnloadSettled
} from './useTabLifecycle'
import { useEditorCommands } from './useEditorCommands'
import { focusEditor, persistSessionNow, schedulePersist } from './useSession'
import { flushBookmarkDrift } from './useBookmarkDrift'
import { parseMetadata } from '../../shared/metadataParser'
import type { ConfirmChoice, FileStat } from '../../shared/types'

let seq = 0
const newTabId = (): string => `tab-${Date.now().toString(36)}-${seq++}`

/**
 * 在途打开去重（方案 §1.5 补丁）：大文件 readText 有数百毫秒在途窗口，
 * 窗口内再次双击会同文件打开两个标签（Electron 版历史 bug）。同路径并发调用
 * 共享同一个 Promise，天然只建一个标签；打开完成后由第一层 path 快查兜底。
 */
const pendingOpens = new Map<string, Promise<string>>()

/** IPC 错误带 `[file:rename] ` 前缀：UI 只展示给用户看的部分 */
function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^\[[^\]]+\]\s*/, '')
}

/**
 * 标签书名（方案 §1.5）：与元数据栏同一口径 —— 正文前两行书名号优先，
 * 否则文件名去后缀；标签标题不再显示 `.txt`。
 */
function bookTitle(text: string, path: string): string {
  const fileName = path.slice(path.lastIndexOf('/') + 1)
  const parent = path.slice(0, path.lastIndexOf('/'))
  return parseMetadata(text, fileName, parent.slice(parent.lastIndexOf('/') + 1)).title
}

/** 标签打开/切换/关闭/新建业务（渲染层编排，全文经 IPC 后直接进 model） */
export function useTabs(): {
  openFile: (path: string) => Promise<string>
  newBlankTab: () => string
  closeTab: (id: string) => Promise<void>
  closeOtherTabs: (id: string) => Promise<void>
  closeAllTabs: () => Promise<void>
  activateTab: (id: string) => void
  cycleTab: (step: 1 | -1) => void
  saveTab: (id: string) => Promise<boolean>
  renameTab: (id: string, newName: string) => Promise<string | null>
  deleteTabFile: (id: string) => Promise<boolean>
  revealTabFile: (id: string) => void
} {
  const store = useTabsStore()
  const library = useLibraryStore()
  const { saveActive } = useEditorCommands()

  /**
   * 同文件去重（方案 §1.6）：dev+ino 优先（覆盖硬链接），realPath 兜底（覆盖符号链接）。
   * ino 只在单卷内唯一，必须带 dev，否则外接盘撞号会认错文件。
   */
  function findSameFile(stat: FileStat): string | null {
    for (const t of store.tabs) {
      const s = getStatCache(t.id)
      if (!s) continue
      if (s.dev === stat.dev && s.ino === stat.ino) return t.id
      if (s.realPath === stat.realPath) return t.id
    }
    return null
  }

  async function doOpenFile(path: string): Promise<string> {
    const normalized = path.replace(/\/+$/, '')
    // 第一层：path 快查（已打开则免一次 IPC）
    const byPath = store.tabs.find((t) => t.path === normalized)
    if (byPath) {
      store.setActive(byPath.id)
      void library.markRead(normalized)
      return byPath.id
    }

    // 第二层：先 stat 查重（软链/硬链接等不同路径指向同一文件时不得整份读取）
    const stat = await fileStat(normalized)
    const dup = findSameFile(stat)
    if (dup) {
      store.setActive(dup)
      void library.markRead(normalized)
      return dup
    }

    const t0 = performance.now()
    const { text, encoding } = await fileReadText(normalized)
    const t1 = performance.now()

    const id = newTabId()
    // 打开时书名优先取库内记录（扫描口径与正文解析一致），库外文件按正文/文件名兜底
    const book = await libraryBookByPath(normalized).catch(() => null)
    const title = book?.title || bookTitle(text, normalized)

    createTabModel(id, text, encoding)
    const t2 = performance.now()
    if (t1 - t0 > 80) {
      void appPerfLog(
        `openFile ${normalized.split('/').pop()}: readText=${Math.round(t1 - t0)}ms model=${Math.round(t2 - t1)}ms chars=${text.length}`
      )
    }
    setStatCache(id, stat)
    // 与新建空白标签一致：插到当前标签紧后面，数组顺序变化随 schedulePersist 落盘
    store.insertTabAfter(
      {
        id,
        path: normalized,
        title, // 书名作标签标题，完整显示不裁切（VS Code 逻辑）
        encoding,
        dirty: false,
        lastFocusedAt: Date.now()
      },
      store.activeTabId
    )
    store.setActive(id)
    // 打开即写最近阅读时间（方案 §2.5）；阅读中的位置变化由 useLibraryStore 60 秒防抖更新（§2.11）
    void library.markRead(normalized)
    schedulePersist()
    return id
  }

  /** 带在途去重的对外入口：同路径并发调用共享同一个 Promise */
  function openFile(path: string): Promise<string> {
    const normalized = path.replace(/\/+$/, '')
    const pending = pendingOpens.get(normalized)
    if (pending) return pending
    const p = doOpenFile(path).finally(() => pendingOpens.delete(normalized))
    pendingOpens.set(normalized, p)
    return p
  }

  /**
   * Cmd+N 新建空白标签（方案 §1.5：不弹保存框）：
   * 插到当前标签紧后面并成为活动标签，数组顺序变化随 schedulePersist 落盘
   */
  function newBlankTab(): string {
    const id = newTabId()
    const afterId = store.activeTabId
    createTabModel(id, '')
    store.insertTabAfter(
      {
        id,
        path: '',
        title: '未命名',
        encoding: '',
        dirty: false,
        lastFocusedAt: Date.now()
      },
      afterId
    )
    store.setActive(id)
    schedulePersist()
    return id
  }

  /**
   * 保存指定标签（方案 §3.5：文件菜单与标签右键菜单共用）。
   * 空白标签先走「保存为」；取消返回 false，调用方（关闭流程）据此中止。
   */
  async function saveTab(id: string): Promise<boolean> {
    const tab = store.tabs.find((t) => t.id === id)
    if (!tab) return false
    // 模型未驻留（LRU 已卸载）时不能保存，避免写出空内容
    if (!getTabModel(id)) return false
    store.setActive(id)
    if (!tab.path) {
      const chosen = await chooseSaveFile(tab.title)
      if (!chosen) return false
      // 落盘后按正文书名（含书名号）重算标题，没有就走新文件名去后缀
      const text = getTabModel(id)?.model.getValue() ?? ''
      store.patchTab(id, { path: chosen, title: bookTitle(text, chosen) })
    }
    return saveActive()
  }

  /** 释放标签的模型/身份缓存/草稿并移除元信息（关闭与删除文件共用） */
  async function destroyTab(id: string): Promise<void> {
    await waitUnloadSettled(id)
    disposeTabModel(id)
    removeStatCache(id)
    // 关闭即清理草稿（save 路径 saveActive 内已清，幂等）
    void fileClearDraft(id)
    store.removeTab(id)
    schedulePersist()
    // 点击条目已经把焦点留在 body（div 不可聚焦）；关闭后不还焦点就要再点一次正文
    focusEditor()
  }

  /** 关闭：dirty 才弹确认（保存/放弃/取消，原生对话框） */
  async function closeTab(id: string): Promise<void> {
    const tab = store.tabs.find((t) => t.id === id)
    if (!tab) return
    // LRU 卸载在途：等 draft 落定再走关闭逻辑（save 读内容、discard 清草稿都依赖）
    await waitUnloadSettled(id)
    if (isDirty(id)) {
      store.setActive(id)
      const choice: ConfirmChoice = await confirmClose(tab.title)
      if (choice === 'cancel') return
      if (choice === 'save' && !(await saveTab(id))) return
    }
    await destroyTab(id)
  }

  /** 关闭其他标签；脏标签仍逐个询问，取消则保留该标签 */
  async function closeOtherTabs(id: string): Promise<void> {
    const others = store.tabs.filter((t) => t.id !== id).map((t) => t.id)
    for (const other of others) await closeTab(other)
  }

  async function closeAllTabs(): Promise<void> {
    const ids = store.tabs.map((t) => t.id)
    for (const id of ids) await closeTab(id)
  }

  /**
   * 重命名（方案 §3.5）：磁盘改名由主进程做并同步 books 身份；
   * 成功后就地更新标签 path/title 与 stat 缓存，立即落盘会话。
   * 返回 null = 成功或未改名，返回字符串 = 给浮层展示的错误。
   */
  async function renameTab(id: string, newName: string): Promise<string | null> {
    const tab = store.tabs.find((t) => t.id === id)
    if (!tab) return '标签已关闭'
    if (!tab.path) return '空白标签不能重命名'
    // 先把待落库的书签漂移写回旧路径（books id 不变，改名后书签继续跟随）
    await flushBookmarkDrift()
    try {
      const result = await fileRename(tab.path, newName)
      if (result.path === tab.path) return null
      // 书名不随文件名变：正文有书名号仍用书名，否则按新文件名去后缀
      const text = getTabModel(id)?.model.getValue()
      store.patchTab(id, {
        path: result.path,
        title: text === undefined ? tab.title : bookTitle(text, result.path)
      })
      setStatCache(id, result.stat)
      await persistSessionNow()
      // 改名同样改变书架显示的文件名：驱动目录树与库内列表一起重读
      void library.notifyFilesChanged()
      return null
    } catch (e) {
      return cleanError(e)
    }
  }

  /** 移到废纸篓（方案 §3.5）：确认后删文件 + 库记录，静默关闭标签（不再走保存确认） */
  async function deleteTabFile(id: string): Promise<boolean> {
    const tab = store.tabs.find((t) => t.id === id)
    if (!tab?.path) return false
    const dirty = isDirty(id) || tab.dirty
    const confirmed = await confirmTrash(tab.title, dirty)
    if (!confirmed) return false
    await flushBookmarkDrift()
    let removedBook: boolean
    try {
      removedBook = (await fileTrash(tab.path)).removedBook
    } catch (e) {
      void showError('移到废纸篓失败', cleanError(e)).catch(() => {})
      return false
    }
    await destroyTab(id)
    await persistSessionNow()
    // 删除后书架目录树、历史/追更/评分/标签与计数立即刷新，不需要重启
    void library.notifyFilesChanged(removedBook)
    return true
  }

  /** 在 Finder 中显示文件 */
  function revealTabFile(id: string): void {
    const tab = store.tabs.find((t) => t.id === id)
    if (!tab?.path) return
    void fileReveal(tab.path).catch((e) => console.error('[file] Finder 显示失败:', e))
  }

  function activateTab(id: string): void {
    store.setActive(id)
    schedulePersist()
    // 切到同一标签时 activeTabId 不变、激活流程不触发，这里直接还焦点
    focusEditor()
    const tab = store.tabs.find((t) => t.id === id)
    if (tab?.path) void library.markRead(tab.path)
    // 切标签立即落掉旧标签待写的最近阅读（同 Python currentChanged → _flush_read_stamps）
    void library.flushReadStamps()
  }

  /** 下一个/上一个标签（窗口菜单）：按标签栏顺序循环，到头绕回另一端 */
  function cycleTab(step: 1 | -1): void {
    if (store.tabs.length < 2) return
    const index = store.tabs.findIndex((t) => t.id === store.activeTabId)
    if (index === -1) return
    const next = (index + step + store.tabs.length) % store.tabs.length
    activateTab(store.tabs[next].id)
  }

  return {
    openFile,
    newBlankTab,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    activateTab,
    cycleTab,
    saveTab,
    renameTab,
    deleteTabFile,
    revealTabFile
  }
}

export { getTabModel, isDirty }
