import { fileReadDraft, fileReadText } from '@/ipc/bridge'
import { useTabsStore } from '@/stores/tabs'
import { useSettingsStore } from '@/stores/settings'
import { useLibraryStore } from '@/stores/library'
import { useTabs } from './useTabs'
import { useEditorCommands } from './useEditorCommands'
import { useCommandPalette } from './useCommandPalette'
import { switchLibrary } from './useLibrarySwitch'
import { applyTabEdit, getTabModel, getTabState, residentModelCount } from './useTabLifecycle'
import { statusMetrics } from './useStatusMetrics'
import {
  caretSnapshot,
  injectDraftWriteFailure,
  persistSessionNow,
  progressSnapshot,
  scrollSessionTo,
  setCaretForTest
} from './useSession'
import type { AppMenuPayload } from '../../shared/types'

/**
 * 自动化验收通道（仅 URL 携带 ?auto=1 时挂载到 globalThis.__yueTest；非产品路径）
 */
export function mountTestHarnessIfNeeded(runMenuCommand: (payload: AppMenuPayload) => void): void {
  const params = new URLSearchParams(location.search)
  if (params.get('auto') !== '1') return

  const store = useTabsStore()
  const settings = useSettingsStore()
  const library = useLibraryStore()
  const palette = useCommandPalette()
  const { openFile, newBlankTab, activateTab, saveTab, renameTab, deleteTabFile, revealTabFile } =
    useTabs()
  const { saveActive } = useEditorCommands()

  async function editAndSave(): Promise<Record<string, unknown>> {
    const testPath = '/tmp/yue-save-test.txt'
    if (!store.tabs.some((t) => t.path === testPath)) {
      await openFile(testPath)
    }
    const tab = store.tabs.find((t) => t.path === testPath)
    if (!tab || !getTabModel(tab.id)) return { error: '测试标签打开失败' }
    store.setActive(tab.id)
    const mark = `【YUE_SAVE_MARK ${Date.now()}】`
    applyTabEdit(tab.id, 0, 0, mark)
    const dirtyAfterEdit = store.activeTab?.dirty === true
    await saveActive()
    const dirtyAfterSave = store.activeTab?.dirty === false
    const { text, encoding } = await fileReadText(tab.path)
    return {
      dirtyAfterEdit,
      saved: dirtyAfterSave,
      rereadContainsMark: text.includes(mark),
      savedEncoding: encoding
    }
  }

  const autoParam = (key: string, fallback: string): string => params.get(key) ?? fallback

  Object.assign(globalThis, {
    __yueTest: {
      openFile,
      newBlankTab,
      activateTab,
      editAndSave,
      saveActive,
      // LRU 验收通道（方案 §1.7）
      residentCount: () => residentModelCount(),
      getModelText: (tabId: string) => getTabState(tabId)?.doc.toString() ?? null,
      readDraft: (tabId: string) => fileReadDraft(tabId),
      applyEdit: (tabId: string, insertText: string) => applyTabEdit(tabId, 0, 0, insertText),
      tabsState: () => ({
        count: store.tabs.length,
        tabs: store.tabs.map((t) => ({
          id: t.id,
          title: t.title,
          path: t.path,
          encoding: t.encoding,
          dirty: t.dirty
        })),
        active: store.activeTab?.title ?? null
      }),
      // 菜单命令验收通道（方案 §3.5）：与顶部菜单共用同一套动作
      menuCommand: (command: AppMenuPayload['command'], value?: AppMenuPayload['value']) =>
        runMenuCommand(value === undefined ? { command } : { command, value }),
      saveTab,
      renameTab,
      deleteTabFile,
      revealTabFile,
      // 主题验收通道（方案 §1.10）
      themeState: () => ({
        appearance: settings.appearance,
        dark: settings.dark,
        statusBar: { ...statusMetrics }
      }),
      // 会话验收通道（方案 §1.8）：进度取视口顶部行，落盘走真实链路
      sessionProgress: () => progressSnapshot(),
      scrollToLine: (line: number) => scrollSessionTo(line),
      // 光标恢复验收（方案 §1.12）：读光标/视口，或只放光标不滚动
      caretState: () => caretSnapshot(),
      setCaret: (line: number, column: number) => setCaretForTest(line, column),
      flushSession: () => persistSessionNow(),
      failDraftWriteOnce: () => injectDraftWriteFailure(),
      // 设置验收通道（方案 §1.9）：读当前值 / 走真实落盘链路改值
      settingsState: () => settings.snapshot(),
      setLibraryRoot: (root: string) => settings.setLibraryRoot(root),
      setPreloadCount: (count: number) => settings.setPreloadCount(count),
      setSidebarWidth: (width: number) => settings.setSidebarWidth(width),
      // 书库验收通道（方案 §2.5）：四类列表 + 标签下钻 + 评分筛选状态
      libraryState: () => ({
        root: library.root,
        fallback: library.fallback,
        scanning: library.scanning,
        scanned: library.scanned,
        lastEnrich: library.lastEnrich,
        error: library.error,
        history: library.history.map((b) => b.title),
        following: library.following.map((b) => b.title),
        tags: library.tags.map((t) => `${t.name}:${t.count}:${t.rating}`),
        activeTag: library.activeTag,
        tagBooks: library.tagBooks.map((b) => b.title),
        ratingFilter: library.ratingFilter,
        rated: library.rated.map((b) => b.title)
      }),
      openLibraryRoot: (root: string) => switchLibrary(root),
      libraryRefresh: () => library.refreshLists(),
      libraryEnrich: () => library.enrich(),
      // 快速检索验收通道（方案 §2.12）：走真实快照 + 120ms 防抖链路
      paletteState: () => ({
        visible: palette.visible.value,
        query: palette.query.value,
        results: palette.results.value.map((entry) => entry.title),
        selected: palette.selectedIndex.value
      }),
      openPalette: () => palette.open(),
      closePalette: () => palette.close(),
      setPaletteQuery: (value: string) => {
        palette.query.value = value
      }
    }
  })

  openFile(autoParam('book1', '/Users/Joey/Sites/Projects/小说/重生之心动.txt'))
    .then(() => openFile(autoParam('book2', '/Users/Joey/Sites/Projects/小说/风流小保安.txt')))
    .then(() => {
      document.title = 'YUE_TABS_OK'
    })
    .catch((e) => {
      document.title = `YUE_TABS_FAIL:${String(e).slice(0, 80)}`
    })
}
