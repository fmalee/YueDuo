import { computed, ref, shallowRef, watch } from 'vue'
import { isolateHistory } from '@codemirror/commands'
import { EditorSelection, type Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tabIdField } from '@/editor/codemirror'
import { clearFindHighlightEffect, setFindHighlightEffect } from '@/editor/findDecorations'
import { onEditorStateSwitch, onEditorViewUpdate } from '@/composables/useEditorBridge'
import { useReaderStore } from '@/stores/reader'
import { showStatusMessage } from '@/composables/useStatusMessage'
import type { FindRule } from '../../shared/findRules'
import { expandReplacement } from '../../shared/replaceTemplate'
import { searchDocument, type DocumentSearchMatch } from '../../shared/crossLineSearch'

/** 默认单词分隔符（全字匹配时传给 searchDocument） */
const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?'
const SEARCH_DEBOUNCE_MS = 100

function hasBoundDoc(view: EditorView): boolean {
  return view.state.field(tabIdField) !== null
}

/** 光标所在的连续文字段（中英文都以标点/空白为界）；光标在空白处时取它后面的那段 */
function wordAtCursor(lineText: string, offset: number): string {
  const clamped = Math.max(0, offset)
  let nextWord = ''
  for (const match of lineText.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (start <= clamped && clamped < end) return match[0]
    if (start >= clamped && !nextWord) nextWord = match[0]
  }
  return nextWord
}

function lowerBoundFrom(items: readonly DocumentSearchMatch[], target: number): number {
  let low = 0
  let high = items.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (items[mid].from < target) low = mid + 1
    else high = mid
  }
  return low
}

/** 保留大小写：全大写/全小写/首字母大写三种形态，其余原样 */
function applyPreservedCase(source: string, replacement: string): string {
  if (!replacement) return replacement
  const hasUpper = /[A-Z]/.test(source)
  const hasLower = /[a-z]/.test(source)
  if (hasUpper && !hasLower) return replacement.toUpperCase()
  if (!hasUpper && hasLower) return replacement.toLowerCase()
  if (/^[A-Z]/.test(source) && !/[A-Z]/.test(source.slice(1))) {
    const index = replacement.search(/[A-Za-z]/)
    if (index < 0) return replacement
    return (
      replacement.slice(0, index) +
      replacement.charAt(index).toUpperCase() +
      replacement.slice(index + 1).toLowerCase()
    )
  }
  return replacement
}

export interface UseFindReplaceOptions {
  getEditor: () => EditorView | undefined
  isLoading: () => boolean
}

/**
 * 查找替换核心状态机（方案 §3.1）：
 * - 全文扫描复用不可变 Text 引用缓存；
 * - 视口裁剪高亮通过 findDecorations ViewPlugin 渲染；
 * - 替换与全部替换均走原子事务 + isolateHistory 独立撤销步。
 */
export function useFindReplace(options: UseFindReplaceOptions) {
  const reader = useReaderStore()

  const open = ref(false)
  const replaceOpen = ref(false)
  const findText = ref('')
  const replaceText = ref('')
  const matchCase = ref(false)
  const wholeWord = ref(false)
  const regex = ref(false)
  const preserveCase = ref(false)
  const matches = shallowRef<DocumentSearchMatch[]>([])
  const currentIndex = ref(0)
  const regexError = ref(false)
  const rulesOpen = ref(false)

  let scanCache: { doc: Text; text: string } | null = null
  let lastFindText = ''
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let pendingAutoJump = false
  let selectingMatch = false
  let highlightSyncScheduled = false
  let disposeStateSwitch: (() => void) | null = null
  let disposeViewUpdate: (() => void) | null = null

  const hasMatches = computed(() => matches.value.length > 0)
  const canReplace = computed(() => hasMatches.value && !reader.locked)
  const counterText = computed(() => {
    if (!findText.value) return ''
    if (regexError.value) return '正则无效'
    if (!matches.value.length) return '无匹配'
    return `${currentIndex.value + 1} / ${matches.value.length}`
  })

  function scanTextOf(doc: Text): string {
    if (scanCache && scanCache.doc === doc) return scanCache.text
    const text = doc.toString()
    scanCache = { doc, text }
    return text
  }

  function clearTimers(): void {
    if (searchTimer) {
      clearTimeout(searchTimer)
      searchTimer = null
    }
    pendingAutoJump = false
  }

  function clearHighlight(view: EditorView): void {
    view.dispatch({ effects: clearFindHighlightEffect.of(undefined) })
  }

  function scheduleHighlightSync(): void {
    if (highlightSyncScheduled) return
    highlightSyncScheduled = true
    queueMicrotask(() => {
      highlightSyncScheduled = false
      const view = options.getEditor()
      if (!open.value || !view || !hasBoundDoc(view) || !matches.value.length) return
      view.dispatch({
        effects: setFindHighlightEffect.of({
          matches: matches.value,
          currentIndex: currentIndex.value
        })
      })
    })
  }

  function initialFindText(view: EditorView): string {
    const { state } = view
    const main = state.selection.main
    if (!main.empty) {
      const selected = state.sliceDoc(main.from, main.to)
      if (selected) return selected
    }
    const line = state.doc.lineAt(main.head)
    const word = wordAtCursor(line.text, main.head - line.from)
    return word || lastFindText
  }

  function updateCurrentIndex(): void {
    const view = options.getEditor()
    const list = matches.value
    if (!view || !hasBoundDoc(view) || list.length === 0) {
      currentIndex.value = 0
      return
    }
    const offset = view.state.selection.main.from
    let index = lowerBoundFrom(list, offset)
    if (index > 0 && offset < list[index - 1].to) {
      index -= 1
    }
    currentIndex.value = index < list.length ? index : 0
  }

  function selectMatch(index: number): void {
    const view = options.getEditor()
    const match = matches.value[index]
    if (!view || !match) return
    currentIndex.value = index
    selectingMatch = true
    try {
      view.dispatch({
        selection: { anchor: match.from, head: match.to },
        effects: [
          EditorView.scrollIntoView(EditorSelection.range(match.from, match.to), { y: 'center' }),
          setFindHighlightEffect.of({ matches: matches.value, currentIndex: index })
        ]
      })
    } finally {
      selectingMatch = false
    }
  }

  function refreshNow(autoJump = false): void {
    if (searchTimer) {
      clearTimeout(searchTimer)
      searchTimer = null
    }
    pendingAutoJump = false
    const view = options.getEditor()
    if (!open.value || !view || !hasBoundDoc(view)) {
      matches.value = []
      currentIndex.value = 0
      regexError.value = false
      if (view) clearHighlight(view)
      return
    }
    const pattern = findText.value
    if (!pattern) {
      matches.value = []
      currentIndex.value = 0
      regexError.value = false
      clearHighlight(view)
      return
    }
    try {
      const text = scanTextOf(view.state.doc)
      matches.value = searchDocument(text, pattern, {
        regex: regex.value,
        matchCase: matchCase.value,
        wordSeparators: wholeWord.value ? WORD_SEPARATORS : null
      })
      regexError.value = false
    } catch {
      matches.value = []
      currentIndex.value = 0
      regexError.value = true
      clearHighlight(view)
      return
    }
    updateCurrentIndex()
    if (autoJump && !regexError.value && matches.value.length > 0) {
      selectMatch(currentIndex.value)
      return
    }
    view.dispatch({
      effects: setFindHighlightEffect.of({
        matches: matches.value,
        currentIndex: currentIndex.value
      })
    })
  }

  function scheduleRefresh(autoJump = false): void {
    if (autoJump) pendingAutoJump = true
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      const jump = pendingAutoJump
      searchTimer = null
      refreshNow(jump)
    }, SEARCH_DEBOUNCE_MS)
  }

  function openBar(expandReplace: boolean): boolean {
    const view = options.getEditor()
    if (!view) return false
    if (!hasBoundDoc(view)) {
      showStatusMessage(
        options.isLoading() ? '文档正在载入，载入完成后再查找' : '没有可查找的文档',
        3000
      )
      return false
    }
    const initial = initialFindText(view)
    findText.value = initial || lastFindText
    if (findText.value) lastFindText = findText.value
    replaceOpen.value = expandReplace
    rulesOpen.value = false
    open.value = true
    refreshNow()
    return true
  }

  function close(): void {
    open.value = false
    rulesOpen.value = false
    clearTimers()
    matches.value = []
    currentIndex.value = 0
    regexError.value = false
    scanCache = null
    const view = options.getEditor()
    if (view) {
      clearHighlight(view)
      view.focus()
    }
  }

  function next(): void {
    const view = options.getEditor()
    if (!open.value || !view || !hasBoundDoc(view) || !matches.value.length) return
    selectMatch((currentIndex.value + 1) % matches.value.length)
  }

  function previous(): void {
    const view = options.getEditor()
    if (!open.value || !view || !hasBoundDoc(view) || !matches.value.length) return
    selectMatch((currentIndex.value - 1 + matches.value.length) % matches.value.length)
  }

  function buildReplacement(match: DocumentSearchMatch, original: string): string {
    const text = regex.value
      ? expandReplacement(replaceText.value, match.groups)
      : replaceText.value
    return preserveCase.value ? applyPreservedCase(original, text) : text
  }

  function replaceCurrent(): void {
    const view = options.getEditor()
    if (!open.value || !view || !hasBoundDoc(view)) return
    if (reader.locked) {
      showStatusMessage('已锁定，无法替换文本', 3000)
      return
    }
    if (regexError.value) {
      showStatusMessage('正则表达式无效，无法替换', 3000)
      return
    }
    const match = matches.value[currentIndex.value]
    if (!match) {
      showStatusMessage('未找到匹配', 3000)
      return
    }
    const original = view.state.sliceDoc(match.from, match.to)
    const insert = buildReplacement(match, original)
    view.dispatch({
      changes: { from: match.from, to: match.to, insert },
      annotations: isolateHistory.of('full')
    })
    refreshNow()
    if (!matches.value.length) return
    let index = lowerBoundFrom(matches.value, match.from + insert.length)
    if (index >= matches.value.length) index = 0
    selectMatch(index)
  }

  function replaceAllMatches(): void {
    const view = options.getEditor()
    if (!open.value || !view || !hasBoundDoc(view)) return
    if (reader.locked) {
      showStatusMessage('已锁定，无法替换文本', 3000)
      return
    }
    if (regexError.value) {
      showStatusMessage('正则表达式无效，无法替换', 3000)
      return
    }
    if (!matches.value.length) {
      showStatusMessage('未找到匹配', 3000)
      return
    }
    const changes = matches.value.map((m) => ({
      from: m.from,
      to: m.to,
      insert: buildReplacement(m, view.state.sliceDoc(m.from, m.to))
    }))
    view.dispatch({
      changes,
      annotations: isolateHistory.of('full')
    })
    refreshNow()
    showStatusMessage(`已替换 ${changes.length} 处`, 5000)
  }

  function toggleRegex(): void {
    regex.value = !regex.value
    if (regex.value) replaceOpen.value = true
  }

  function applyRule(rule: FindRule): void {
    findText.value = rule.pattern
    replaceText.value = rule.replacement ?? ''
    regex.value = true
    replaceOpen.value = true
    rulesOpen.value = false
    refreshNow()
  }

  function attachSubscriptions(): void {
    disposeStateSwitch = onEditorStateSwitch(() => {
      matches.value = []
      currentIndex.value = 0
      regexError.value = false
      scanCache = null
      const view = options.getEditor()
      if (open.value) refreshNow()
      else if (view) clearHighlight(view)
    })
    disposeViewUpdate = onEditorViewUpdate((update) => {
      if (!open.value) return
      if (update.docChanged) {
        scheduleRefresh()
        return
      }
      if (update.selectionSet && !selectingMatch && matches.value.length > 0) {
        const prev = currentIndex.value
        updateCurrentIndex()
        if (currentIndex.value !== prev) {
          scheduleHighlightSync()
        }
      }
    })
  }

  function detachSubscriptions(): void {
    disposeStateSwitch?.()
    disposeStateSwitch = null
    disposeViewUpdate?.()
    disposeViewUpdate = null
    clearTimers()
    scanCache = null
    const view = options.getEditor()
    if (view) clearHighlight(view)
  }

  watch(findText, () => {
    if (findText.value) lastFindText = findText.value
    if (open.value) scheduleRefresh()
  })

  watch([matchCase, wholeWord, regex], () => {
    if (open.value) scheduleRefresh(true)
  })

  return {
    open,
    replaceOpen,
    findText,
    replaceText,
    matchCase,
    wholeWord,
    regex,
    preserveCase,
    regexError,
    rulesOpen,
    hasMatches,
    canReplace,
    counterText,
    openBar,
    close,
    next,
    previous,
    replaceCurrent,
    replaceAllMatches,
    scheduleRefresh,
    toggleRegex,
    applyRule,
    attachSubscriptions,
    detachSubscriptions
  }
}
