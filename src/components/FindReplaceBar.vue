<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { monaco } from '@/monaco'
import { useReaderStore } from '@/stores/reader'
import { showStatusMessage } from '@/composables/useStatusMessage'
import { METRICS } from '@/styles/theme'
import { DEFAULT_RULES } from '../../shared/findRules'
import type { FindRule } from '../../shared/findRules'
import { expandReplacement } from '../../shared/replaceTemplate'
import { searchMultilineRegex } from '../../shared/crossLineSearch'

/** 统一的命中项：与 Monaco 的 FindMatch 同形，正则模式由全文扫描自建（可跨行） */
interface FindResult {
  range: monaco.Range
  matches: string[] | null
}

/**
 * 自绘查找替换栏（方案 §3.1）：
 * 非正则搜索交给 Monaco 的 model API（findMatches / findNextMatch / findPreviousMatch）；
 * 正则模式按全文扫描（shared/crossLineSearch），以支持 `\n` 跨行命中；
 * executeEdits 负责替换、装饰集合负责高亮；这里只做输入、状态与布局。
 */
const props = defineProps<{
  editor?: monaco.editor.IStandaloneCodeEditor
  loading?: boolean
}>()

/** 与 Monaco 默认单词分隔符一致（全词匹配时传给 findMatches） */
const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?'
const SEARCH_DEBOUNCE_MS = 100
/** 命中过多时只装饰可视区附近，计数仍用全量结果（方案 §3.1） */
const MAX_DECORATIONS = 5000
const DECORATION_MARGIN_LINES = 200
/**
 * findMatches 的 limitResultCount：Monaco 内部按 `resultLen >= limit` 截断，
 * 传 -1 只会返回 1 条；这里取 Monaco 批量替换同款上限，视为不限。
 */
const MATCH_LIMIT = 1_073_741_824

/**
 * 正则全文扫描的取文缓存：按 model 引用 + versionId 缓存 getValue 结果。
 * 搜索框每敲一个字都全量扫描，13MB 全文的 getValue/分配占大头；文档未变时直接复用。
 */
let scanCache: { model: monaco.editor.ITextModel; versionId: number; text: string } | null = null
function scanTextOf(model: monaco.editor.ITextModel): string {
  if (scanCache && scanCache.model === model && scanCache.versionId === model.getVersionId()) {
    return scanCache.text
  }
  const text = model.getValue()
  scanCache = { model, versionId: model.getVersionId(), text }
  return text
}

const reader = useReaderStore()

const open = ref(false)
const replaceOpen = ref(false)
const findText = ref('')
const replaceText = ref('')
const matchCase = ref(false)
const wholeWord = ref(false)
const regex = ref(false)
const preserveCase = ref(false)
const matches = shallowRef<FindResult[]>([])
const currentIndex = ref(0)
const regexError = ref(false)
const rulesOpen = ref(false)

const width = ref<number>(METRICS.findBarWidth)

const barEl = ref<HTMLElement | null>(null)
const findInput = ref<HTMLInputElement | null>(null)
const replaceInput = ref<HTMLInputElement | null>(null)
const rulesButton = ref<HTMLElement | null>(null)
const rulesPanel = ref<HTMLElement | null>(null)

/** 上次的查找文本：无选区、光标所在行没有内容时用它兜底（方案 §3.1） */
let lastFindText = ''
/** 与 matches 一一对应的起始偏移，供二分定位当前项 */
let matchStarts: number[] = []
let decorations: monaco.editor.IEditorDecorationsCollection | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null
let decorationTimer: ReturnType<typeof setTimeout> | null = null
/** 下一次防抖刷新后是否自动跳到首个匹配（输入/开关变化时置位，由刷新消费） */
let pendingAutoJump = false
let attached: monaco.editor.IStandaloneCodeEditor | null = null
const disposables: monaco.IDisposable[] = []
let resizeState: { startX: number; width: number } | null = null

const rules = DEFAULT_RULES
const hasMatches = computed(() => matches.value.length > 0)
const canReplace = computed(() => hasMatches.value && !reader.locked)
const counterText = computed(() => {
  if (!findText.value) return ''
  if (regexError.value) return '正则无效'
  if (!matches.value.length) return '无匹配'
  return `${currentIndex.value + 1} / ${matches.value.length}`
})

watch(
  () => props.editor,
  (next) => {
    disposeAttached()
    decorations = null
    if (next) attach(next)
  },
  { immediate: true }
)

watch(findText, () => {
  if (findText.value) lastFindText = findText.value
  if (open.value) scheduleRefresh()
})

/** 开关变化视同新的查找：防抖后跳到首个匹配（从当前光标向后找，越界回绕） */
watch([matchCase, wholeWord, regex], () => {
  if (open.value) scheduleRefresh(true)
})

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown, true)
  window.addEventListener('yueduo:findReplace', onFindReplaceCommand)
  window.addEventListener('resize', clampToContainer)
  window.addEventListener('pointerdown', onDocumentPointerDown, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('yueduo:findReplace', onFindReplaceCommand)
  window.removeEventListener('resize', clampToContainer)
  window.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', stopResize)
  clearTimers()
  decorations?.clear()
  decorations = null
  disposeAttached()
})

function attach(instance: monaco.editor.IStandaloneCodeEditor): void {
  attached = instance
  disposables.push(
    instance.onDidChangeModel(() => {
      matches.value = []
      matchStarts = []
      currentIndex.value = 0
      decorations?.clear()
      if (open.value) refreshNow()
    }),
    instance.onDidChangeModelContent(() => {
      if (open.value) scheduleRefresh()
    }),
    instance.onDidChangeCursorSelection(() => {
      if (!open.value) return
      updateCurrentIndex()
      scheduleDecorationUpdate()
    })
  )
}

function disposeAttached(): void {
  for (const disposable of disposables) disposable.dispose()
  disposables.length = 0
  attached = null
}

function clearTimers(): void {
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  if (decorationTimer) {
    clearTimeout(decorationTimer)
    decorationTimer = null
  }
  pendingAutoJump = false
}

/** 快捷键（捕获阶段）：先于 Monaco 的输入处理，内置查找 widget 永不触发 */
function onWindowKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  const key = e.key.toLowerCase()
  const mod = e.metaKey || e.ctrlKey
  if (mod && key === 'f') {
    e.preventDefault()
    e.stopPropagation()
    // Ctrl+Cmd+F 直接展开替换行；Cmd+F 收起替换行（用户确认的新口径）
    openBar(e.metaKey && e.ctrlKey)
    return
  }
  if (!open.value) return
  if (mod && !e.altKey && key === 'g') {
    e.preventDefault()
    e.stopPropagation()
    if (e.shiftKey) previous()
    else next()
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    if (rulesOpen.value) rulesOpen.value = false
    else close()
  }
}

/** 菜单「查找/替换」：与 Cmd+F / Ctrl+Cmd+F 走同一条打开路径 */
function onFindReplaceCommand(e: Event): void {
  openBar((e as CustomEvent<string>).detail === 'replace')
}

function openBar(expandReplace: boolean): void {
  const instance = attached ?? props.editor
  if (!instance) return
  if (!instance.getModel()) {
    showStatusMessage(props.loading ? '文档正在载入，载入完成后再查找' : '没有可查找的文档', 3000)
    return
  }
  const initial = initialFindText(instance)
  findText.value = initial || lastFindText
  if (findText.value) lastFindText = findText.value
  replaceOpen.value = expandReplace
  rulesOpen.value = false
  open.value = true
  clampToContainer()
  refreshNow()
  void nextTick(() => {
    findInput.value?.focus()
    findInput.value?.select()
  })
}

/**
 * 打开时的查找文本（用户口径）：
 * 有选区用选区；否则用光标所在单词；所在行没有内容时用上次的查找文本。
 */
function initialFindText(instance: monaco.editor.IStandaloneCodeEditor): string {
  const model = instance.getModel()
  if (!model) return ''
  const selection = instance.getSelection()
  if (selection && !selection.isEmpty()) {
    const selected = model.getValueInRange(selection)
    if (selected) return selected
  }
  const position = instance.getPosition()
  if (position) {
    const word = wordAtCursor(model, position)
    if (word) return word
    const line = model.getLineContent(position.lineNumber)
    if (!line.trim()) return lastFindText
  }
  return lastFindText
}

/** 光标所在的连续文字段（中英文都以标点/空白为界）；光标在空白处时取它后面的那段 */
function wordAtCursor(model: monaco.editor.ITextModel, position: monaco.Position): string {
  const line = model.getLineContent(position.lineNumber)
  const offset = Math.max(0, position.column - 1)
  let next = ''
  for (const match of line.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (start <= offset && offset < end) return match[0]
    if (start >= offset && !next) next = match[0]
  }
  return next
}

function close(): void {
  open.value = false
  rulesOpen.value = false
  clearTimers()
  matches.value = []
  matchStarts = []
  currentIndex.value = 0
  regexError.value = false
  decorations?.clear()
  props.editor?.focus()
}

/**
 * 防抖刷新。autoJump 置位叠加而非重置：同一轮里 watch 与 @input 都会调度，
 * 只要有一次要求跳转，防抖结束后就跳到最终结果。
 */
function scheduleRefresh(autoJump = false): void {
  if (autoJump) pendingAutoJump = true
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    const jump = pendingAutoJump
    searchTimer = null
    refreshNow(jump)
  }, SEARCH_DEBOUNCE_MS)
}

function scheduleDecorationUpdate(): void {
  if (decorationTimer) return
  decorationTimer = setTimeout(() => {
    decorationTimer = null
    applyDecorations()
  }, 60)
}

function wordSeparators(): string | null {
  return wholeWord.value ? WORD_SEPARATORS : null
}

/** 全量计数 + 命中（不截断，计数才准确）；过滤零长度命中，避免替换空串 */
function refreshNow(autoJump = false): void {
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  // 直接刷新视为消费掉待跳转标记，避免替换/打开等路径被残留标记带偏
  pendingAutoJump = false
  const instance = attached ?? props.editor
  const model = instance?.getModel()
  if (!open.value || !instance || !model) {
    matches.value = []
    matchStarts = []
    currentIndex.value = 0
    regexError.value = false
    decorations?.clear()
    return
  }
  const pattern = findText.value
  if (!pattern) {
    matches.value = []
    matchStarts = []
    currentIndex.value = 0
    regexError.value = false
    decorations?.clear()
    return
  }
  if (regex.value) {
    // 正则模式按全文匹配：Monaco 的 findMatches 逐行扫描，`\n` 永远跨不过行
    try {
      const text = scanTextOf(model)
      const found = searchMultilineRegex(text, pattern, matchCase.value, wordSeparators())
      matches.value = found.map((hit) => ({
        range: rangeFromOffsets(model, hit.index, hit.index + hit.length),
        matches: hit.groups
      }))
      matchStarts = found.map((hit) => hit.index)
      regexError.value = false
    } catch {
      matches.value = []
      matchStarts = []
      currentIndex.value = 0
      regexError.value = true
      decorations?.clear()
      return
    }
  } else {
    try {
      const found = model.findMatches(
        pattern,
        false,
        false,
        matchCase.value,
        wordSeparators(),
        false,
        MATCH_LIMIT
      )
      matches.value = found.filter((match) => !match.range.isEmpty())
      matchStarts = matches.value.map((match) => model.getOffsetAt(match.range.getStartPosition()))
      regexError.value = false
    } catch {
      matches.value = []
      matchStarts = []
      regexError.value = true
    }
  }
  updateCurrentIndex()
  applyDecorations()
  // 输入/开关变化后自动定位到首个匹配；无匹配或正则无效时不动光标
  if (autoJump && !regexError.value && matches.value.length) selectMatch(currentIndex.value)
}

/** 全文偏移 → Monaco 区间（跨行时首尾行不同） */
function rangeFromOffsets(
  model: monaco.editor.ITextModel,
  startOffset: number,
  endOffset: number
): monaco.Range {
  const start = model.getPositionAt(startOffset)
  const end = model.getPositionAt(endOffset)
  return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column)
}

/** 当前项 = 光标位置处或其后的首个命中（越界回到第一项），二分定位 */
function updateCurrentIndex(): void {
  const instance = attached ?? props.editor
  const model = instance?.getModel()
  if (!instance || !model || !matches.value.length) {
    currentIndex.value = 0
    return
  }
  const position = instance.getSelection()?.getStartPosition() ?? instance.getPosition()
  if (!position) {
    currentIndex.value = 0
    return
  }
  const offset = model.getOffsetAt(position)
  let index = lowerBound(matchStarts, offset)
  if (index > 0) {
    const previousEnd = model.getOffsetAt(matches.value[index - 1].range.getEndPosition())
    if (offset < previousEnd) index -= 1
  }
  currentIndex.value = index < matches.value.length ? index : 0
}

function lowerBound(values: number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (values[mid] < target) low = mid + 1
    else high = mid
  }
  return low
}

/** 命中过多时只装饰可视区 ±200 行，当前项始终保留 */
function applyDecorations(): void {
  const instance = attached ?? props.editor
  const model = instance?.getModel()
  if (!instance || !model) {
    decorations?.clear()
    return
  }
  if (!open.value || !matches.value.length) {
    decorations?.clear()
    return
  }
  if (!decorations) decorations = instance.createDecorationsCollection()
  const ranges = instance.getVisibleRanges()
  const top = Math.max(1, (ranges[0]?.startLineNumber ?? 1) - DECORATION_MARGIN_LINES)
  const bottom =
    ranges.length > 0
      ? ranges[ranges.length - 1].endLineNumber + DECORATION_MARGIN_LINES
      : model.getLineCount()
  const indexSet = new Set<number>()
  if (matches.value.length <= MAX_DECORATIONS) {
    for (let i = 0; i < matches.value.length; i++) indexSet.add(i)
  } else {
    for (let i = 0; i < matches.value.length; i++) {
      const range = matches.value[i].range
      if (
        i === currentIndex.value ||
        (range.endLineNumber >= top && range.startLineNumber <= bottom)
      ) {
        indexSet.add(i)
      }
    }
  }
  const items: monaco.editor.IModelDeltaDecoration[] = []
  for (const index of indexSet) {
    items.push({
      range: matches.value[index].range,
      options: {
        inlineClassName: index === currentIndex.value ? 'yd-find-match-current' : 'yd-find-match',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
    })
  }
  decorations.set(items)
}

function selectMatch(index: number): void {
  const instance = attached ?? props.editor
  const match = matches.value[index]
  if (!instance || !match) return
  instance.setSelection(match.range)
  instance.revealRangeInCenter(match.range, monaco.editor.ScrollType.Immediate)
  currentIndex.value = index
  applyDecorations()
}

/** 下一个/上一个：非正则走 model.findNextMatch / findPreviousMatch，越界由 Monaco 环绕 */
function next(): void {
  const instance = attached ?? props.editor
  const model = instance?.getModel()
  if (!open.value || !instance || !model || !matches.value.length) return
  if (regex.value) {
    // 跨行命中 findNextMatch 定位不到，直接在命中表里环绕
    selectMatch((currentIndex.value + 1) % matches.value.length)
    return
  }
  const current = matches.value[currentIndex.value]
  const start = current
    ? current.range.getEndPosition()
    : (instance.getPosition() ?? { lineNumber: 1, column: 1 })
  const found = model.findNextMatch(
    findText.value,
    start,
    regex.value,
    matchCase.value,
    wordSeparators(),
    false
  )
  let index = found ? indexOfMatch(found) : -1
  if (index < 0) index = (currentIndex.value + 1) % matches.value.length
  else if (index === currentIndex.value && matches.value.length > 1) {
    index = (index + 1) % matches.value.length
  }
  selectMatch(index)
}

function previous(): void {
  const instance = attached ?? props.editor
  const model = instance?.getModel()
  if (!open.value || !instance || !model || !matches.value.length) return
  if (regex.value) {
    selectMatch((currentIndex.value - 1 + matches.value.length) % matches.value.length)
    return
  }
  const current = matches.value[currentIndex.value]
  const start = current
    ? current.range.getStartPosition()
    : (instance.getPosition() ?? { lineNumber: 1, column: 1 })
  const found = model.findPreviousMatch(
    findText.value,
    start,
    regex.value,
    matchCase.value,
    wordSeparators(),
    false
  )
  let index = found ? indexOfMatch(found) : -1
  if (index < 0) index = (currentIndex.value - 1 + matches.value.length) % matches.value.length
  else if (index === currentIndex.value && matches.value.length > 1) {
    index = (index - 1 + matches.value.length) % matches.value.length
  }
  selectMatch(index)
}

function indexOfMatch(match: FindResult): number {
  const instance = attached ?? props.editor
  const model = instance?.getModel()
  if (!model) return -1
  const offset = model.getOffsetAt(match.range.getStartPosition())
  let index = lowerBound(matchStarts, offset)
  while (index < matches.value.length && matchStarts[index] === offset) {
    if (sameRange(matches.value[index].range, match.range)) return index
    index++
  }
  return -1
}

function sameRange(a: monaco.Range, b: monaco.Range): boolean {
  return (
    a.startLineNumber === b.startLineNumber &&
    a.startColumn === b.startColumn &&
    a.endLineNumber === b.endLineNumber &&
    a.endColumn === b.endColumn
  )
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

/**
 * 替换文本：正则模式下先把 `\n` / `\t` / `\\` 展开成实际字符，再展开 $1–$9 / $& / $$
 * （用查找正则的捕获组），最后按需套保留大小写；非正则模式保持替换框原文，与旧行为一致。
 */
function buildReplacement(match: FindResult, original: string): string {
  const text = regex.value ? expandReplacement(replaceText.value, match.matches) : replaceText.value
  return preserveCase.value ? applyPreservedCase(original, text) : text
}

/** 单个替换：替换当前项后跳到它后面的首个命中，焦点留在替换框（方案 §3.1） */
function replaceCurrent(): void {
  const instance = attached ?? props.editor
  const model = instance?.getModel()
  if (!open.value || !instance || !model) return
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
  const original = model.getValueInRange(match.range)
  const text = buildReplacement(match, original)
  const startOffset = model.getOffsetAt(match.range.getStartPosition())
  instance.pushUndoStop()
  instance.executeEdits('findReplace', [{ range: match.range, text, forceMoveMarkers: true }])
  instance.pushUndoStop()
  refreshNow()
  if (!matches.value.length) return
  let index = lowerBound(matchStarts, startOffset + text.length)
  if (index >= matches.value.length) index = 0
  selectMatch(index)
}

/** 全部替换：一次 executeEdits 应用所有命中，可用一次撤销整体恢复 */
function replaceAllMatches(): void {
  const instance = attached ?? props.editor
  const model = instance?.getModel()
  if (!open.value || !instance || !model) return
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
  const edits = matches.value.map((match) => {
    const original = model.getValueInRange(match.range)
    return { range: match.range, text: buildReplacement(match, original) }
  })
  const count = edits.length
  instance.pushUndoStop()
  instance.executeEdits('findReplaceAll', edits)
  instance.pushUndoStop()
  refreshNow()
  showStatusMessage(`已替换 ${count} 处`, 5000)
}

/** 查找框内容变化（输入/粘贴）：防抖后刷新并跳到首个匹配；IME 组字中不跳 */
function onFindInput(e: Event): void {
  if ((e as InputEvent).isComposing) return
  if (open.value) scheduleRefresh(true)
}

function onFindEnter(e: KeyboardEvent): void {
  if (e.isComposing) return
  e.preventDefault()
  if (e.shiftKey) previous()
  else next()
}

function onReplaceEnter(e: KeyboardEvent): void {
  if (e.isComposing) return
  e.preventDefault()
  if (e.metaKey || e.ctrlKey) replaceAllMatches()
  else replaceCurrent()
}

function onInputEscape(e: KeyboardEvent): void {
  if (e.isComposing) return
  e.preventDefault()
  close()
}

function toggleReplace(): void {
  replaceOpen.value = !replaceOpen.value
  if (replaceOpen.value) void nextTick(() => replaceInput.value?.focus())
}

/** 打开正则开关时自动展开替换行；关闭正则不动替换行，保持用户当前状态 */
function toggleRegex(): void {
  regex.value = !regex.value
  if (regex.value) replaceOpen.value = true
}

function applyRule(rule: FindRule): void {
  findText.value = rule.pattern
  replaceText.value = rule.replacement ?? ''
  regex.value = true
  // 选规则等于打开正则：同样自动展开替换行
  replaceOpen.value = true
  rulesOpen.value = false
  refreshNow()
  void nextTick(() => findInput.value?.focus())
}

/** 常用正则面板：点面板与按钮以外的地方收起 */
function onDocumentPointerDown(e: PointerEvent): void {
  if (!rulesOpen.value) return
  const target = e.target as Node
  if (rulesPanel.value?.contains(target) || rulesButton.value?.contains(target)) return
  rulesOpen.value = false
}

function clampToContainer(): void {
  const containerWidth = barEl.value?.parentElement?.clientWidth ?? 0
  if (!containerWidth) return
  const maxByContainer = Math.max(
    METRICS.findBarMinWidth,
    containerWidth - METRICS.findBarMargin * 2
  )
  width.value = Math.min(
    Math.max(width.value, METRICS.findBarMinWidth),
    Math.min(METRICS.findBarMaxWidth, maxByContainer)
  )
}

/** 左边缘拖拽：右边缘固定在容器右侧，宽度变化只移动左边缘 */
function startResize(e: PointerEvent): void {
  if (e.button !== 0) return
  e.preventDefault()
  resizeState = { startX: e.clientX, width: width.value }
  document.body.style.cursor = 'ew-resize'
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', stopResize, { once: true })
}

function onResizeMove(e: PointerEvent): void {
  if (!resizeState) return
  const containerWidth = barEl.value?.parentElement?.clientWidth ?? 0
  const maxByContainer = Math.max(
    METRICS.findBarMinWidth,
    containerWidth - METRICS.findBarMargin * 2
  )
  const maxWidth = Math.min(METRICS.findBarMaxWidth, maxByContainer)
  // 右边缘固定，指针左移（clientX 变小）才变宽
  const deltaX = resizeState.startX - e.clientX
  width.value = Math.min(Math.max(resizeState.width + deltaX, METRICS.findBarMinWidth), maxWidth)
}

function stopResize(): void {
  resizeState = null
  document.body.style.cursor = ''
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', stopResize)
}
</script>

<template>
  <div
    v-show="open"
    ref="barEl"
    class="find-bar"
    :style="{ width: `${width}px`, right: `${METRICS.findBarMargin}px` }"
    role="search"
  >
    <button
      class="collapse"
      :class="{ expanded: replaceOpen }"
      :title="replaceOpen ? '收起替换行' : '展开替换行'"
      :aria-expanded="replaceOpen"
      @click="toggleReplace"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M6 3.5 10.5 8 6 12.5" />
      </svg>
    </button>

    <div class="find-body">
      <div class="find-row">
        <div class="input-shell">
          <input
            ref="findInput"
            v-model="findText"
            class="find-input"
            type="text"
            placeholder="查找"
            spellcheck="false"
            autocomplete="off"
            @input="onFindInput"
            @keydown.enter="onFindEnter"
            @keydown.esc="onInputEscape"
          />
          <div class="input-toggles">
            <button
              class="toggle"
              :class="{ active: matchCase }"
              title="区分大小写"
              :aria-pressed="matchCase"
              @click="matchCase = !matchCase"
            >
              Aa
            </button>
            <button
              class="toggle word-toggle"
              :class="{ active: wholeWord }"
              title="全字匹配"
              :aria-pressed="wholeWord"
              @click="wholeWord = !wholeWord"
            >
              ab
            </button>
            <button
              class="toggle regex-toggle"
              :class="{ active: regex }"
              title="使用正则表达式"
              :aria-pressed="regex"
              @click="toggleRegex"
            >
              .*
            </button>
          </div>
        </div>

        <span v-if="counterText" class="counter" :class="{ error: regexError }">
          {{ counterText }}
        </span>
        <button
          class="icon-button"
          :disabled="!hasMatches"
          title="上一个匹配（Shift+Enter / Shift+Cmd+G）"
          @click="previous"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 12.5v-9M3.5 8 8 3.5 12.5 8" />
          </svg>
        </button>
        <button
          class="icon-button"
          :disabled="!hasMatches"
          title="下一个匹配（Enter / Cmd+G）"
          @click="next"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8 8 12.5 12.5 8" />
          </svg>
        </button>

        <div class="rules-anchor">
          <button
            ref="rulesButton"
            class="icon-button"
            :class="{ active: rulesOpen }"
            title="常用正则"
            :aria-expanded="rulesOpen"
            @click="rulesOpen = !rulesOpen"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 4h8M5 8h8M5 12h8" />
              <circle cx="2.4" cy="4" r="0.9" fill="currentColor" stroke="none" />
              <circle cx="2.4" cy="8" r="0.9" fill="currentColor" stroke="none" />
              <circle cx="2.4" cy="12" r="0.9" fill="currentColor" stroke="none" />
            </svg>
          </button>
          <div v-if="rulesOpen" ref="rulesPanel" class="rules-panel">
            <button
              v-for="rule in rules"
              :key="rule.key"
              class="rule-row"
              :title="rule.description"
              @click="applyRule(rule)"
            >
              <span class="rule-label">{{ rule.label }}</span>
              <span class="rule-desc">{{ rule.description }}</span>
            </button>
          </div>
        </div>

        <button class="icon-button" title="关闭（Esc）" @click="close">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      <div v-show="replaceOpen" class="find-row replace-row">
        <div class="input-shell">
          <input
            ref="replaceInput"
            v-model="replaceText"
            class="find-input"
            type="text"
            placeholder="替换为"
            spellcheck="false"
            autocomplete="off"
            @keydown.enter="onReplaceEnter"
            @keydown.esc="onInputEscape"
          />
          <div class="input-toggles">
            <button
              class="toggle"
              :class="{ active: preserveCase }"
              title="保留大小写"
              :aria-pressed="preserveCase"
              @click="preserveCase = !preserveCase"
            >
              aA
            </button>
          </div>
        </div>
        <button
          class="icon-button"
          :disabled="!canReplace"
          title="替换（Enter）"
          @click="replaceCurrent"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 2v6.5M5 5.5 8 8.5l3-3M3 13h10" />
          </svg>
        </button>
        <button
          class="icon-button"
          :disabled="!canReplace"
          title="全部替换（Cmd+Enter）"
          @click="replaceAllMatches"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 2v5.5M2.5 5 5 7.5 7.5 5M11 2v5.5M8.5 5 11 7.5 13.5 5M3 13h10" />
          </svg>
        </button>
      </div>
    </div>

    <div class="resize-handle" title="拖拽调整查找栏宽度" @pointerdown="startResize"></div>
  </div>
</template>

<style scoped>
.find-bar {
  position: absolute;
  top: var(--yd-find-top);
  z-index: 20;
  display: flex;
  align-items: stretch;
  padding: var(--yd-find-padding-y) calc(var(--yd-find-padding-x) + 4px) var(--yd-find-padding-y)
    var(--yd-find-padding-x);
  border: 1px solid var(--yd-border-1);
  border-radius: var(--yd-find-radius);
  background: var(--yd-bg-2);
  box-shadow: 0 2px 10px var(--yd-shadow);
  color: var(--yd-text-1);
  font-size: var(--yd-find-font-size);
  user-select: none;
}
.collapse {
  flex: none;
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--yd-find-toggle-size);
  height: var(--yd-find-toggle-size);
  padding: 0;
  border: none;
  border-radius: var(--yd-find-toggle-radius);
  background: transparent;
  color: var(--yd-text-3);
}
.collapse:hover {
  background: var(--yd-hover-1);
  color: var(--yd-text-1);
}
.collapse svg {
  width: var(--yd-find-icon-size);
  height: var(--yd-find-icon-size);
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.12s ease;
}
.collapse.expanded svg {
  transform: rotate(90deg);
}
.find-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--yd-find-row-gap);
  min-width: 0;
}
.find-row {
  display: flex;
  align-items: center;
  gap: var(--yd-find-gap);
  min-width: 0;
}
.input-shell {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
}
.find-input {
  width: 100%;
  height: var(--yd-find-input-height);
  padding: 0
    calc(var(--yd-find-toggle-size) * 3 + var(--yd-find-gap) * 2 + var(--yd-find-padding-x)) 0
    var(--yd-find-input-padding-x);
  border: 1px solid var(--yd-border-1);
  border-radius: var(--yd-find-input-radius);
  outline: none;
  background: var(--yd-bg-3);
  color: var(--yd-text-1);
  font: inherit;
  font-size: var(--yd-find-font-size);
}
.replace-row .find-input {
  padding-right: calc(var(--yd-find-toggle-size) + var(--yd-find-gap) + var(--yd-find-padding-x));
}
.find-input::placeholder {
  color: var(--yd-text-3);
}
.find-input:focus {
  border-color: var(--yd-accent);
}
.input-toggles {
  position: absolute;
  right: var(--yd-find-padding-x);
  display: flex;
  gap: var(--yd-find-gap);
}
.toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--yd-find-toggle-size);
  height: var(--yd-find-toggle-size);
  padding: 0;
  border: none;
  border-radius: var(--yd-find-toggle-radius);
  background: transparent;
  color: var(--yd-text-3);
  font-size: var(--yd-find-toggle-font-size);
  line-height: 1;
}
.toggle:hover {
  background: var(--yd-hover-1);
  color: var(--yd-text-1);
}
.toggle.active,
.toggle.active:hover {
  background: var(--yd-active-1);
  color: var(--yd-text-1);
}
.word-toggle {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.regex-toggle {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.counter {
  flex: none;
  color: var(--yd-text-3);
  white-space: nowrap;
}
.counter.error {
  color: var(--yd-accent);
}
.icon-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--yd-find-toggle-size);
  height: var(--yd-find-toggle-size);
  padding: 0;
  border: none;
  border-radius: var(--yd-find-toggle-radius);
  background: transparent;
  color: var(--yd-text-2);
}
.icon-button:hover:not(:disabled) {
  background: var(--yd-hover-1);
  color: var(--yd-text-1);
}
.icon-button:disabled {
  opacity: 0.35;
  cursor: default;
}
.icon-button.active,
.icon-button.active:hover {
  background: var(--yd-active-1);
  color: var(--yd-text-1);
}
.icon-button svg {
  width: var(--yd-find-icon-size);
  height: var(--yd-find-icon-size);
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.rules-anchor {
  position: relative;
  flex: none;
}
.rules-panel {
  position: absolute;
  top: calc(100% + var(--yd-find-gap));
  right: 0;
  z-index: 30;
  width: var(--yd-find-rules-width);
  max-height: var(--yd-find-rules-max-height);
  padding: var(--yd-find-rules-padding);
  border: 1px solid var(--yd-border-1);
  border-radius: var(--yd-find-rules-radius);
  overflow-y: auto;
  background: var(--yd-bg-1);
  box-shadow: 0 4px 14px var(--yd-shadow);
}
.rule-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--yd-find-rules-gap);
  width: 100%;
  padding: var(--yd-find-rules-row-padding-y) var(--yd-find-rules-row-padding-x);
  border: none;
  border-radius: var(--yd-find-rules-radius);
  background: transparent;
  color: var(--yd-text-1);
  text-align: left;
}
.rule-row:hover {
  background: var(--yd-hover-1);
}
.rule-label {
  font-size: var(--yd-find-font-size);
  line-height: 1.3;
}
.rule-desc {
  color: var(--yd-text-3);
  font-size: var(--yd-find-rules-description-font-size);
  line-height: 1.4;
}
.resize-handle {
  position: absolute;
  top: 0;
  left: 0;
  width: 5px;
  height: 100%;
  cursor: ew-resize;
}
.resize-handle::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 1px;
  width: 2px;
  height: 16px;
  border-radius: 1px;
  background: var(--yd-border-1);
  opacity: 0;
  transform: translateY(-50%);
  transition: opacity 0.12s ease;
}
.find-bar:hover .resize-handle::after {
  opacity: 1;
}
</style>
