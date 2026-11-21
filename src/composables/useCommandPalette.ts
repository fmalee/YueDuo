import { nextTick, ref, shallowRef, watch } from 'vue'
import { libraryAllBooks } from '@/ipc/bridge'
import { buildPaletteEntries, queryEntries, type PaletteEntry } from '../../shared/librarySearch'
import { useTabs } from './useTabs'
import { focusEditor } from './useSession'
import { showStatusMessage } from './useStatusMessage'
import { formatError } from '../utils/format'

/**
 * Cmd+P 快速检索（方案 §2.12）：唤出时读一遍书库快照，输入只在内存里过滤。
 * 快照与防抖计时器放模块级（不参与 Vue 响应式）；只有可见状态与结果列表是响应式的。
 */
const QUERY_DELAY_MS = 120

const visible = ref(false)
const query = ref('')
const results = shallowRef<PaletteEntry[]>([])
const selectedIndex = ref(0)

let entries: PaletteEntry[] = []
let timer: ReturnType<typeof setTimeout> | null = null
/** 唤出代际：连续唤出时丢掉过期快照的返回 */
let generation = 0
/** 快照读取中：此时输入变化不排防抖，读完后按当前输入补一次过滤 */
let loading = false

function clearTimer(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

function applyQuery(text: string): void {
  results.value = queryEntries(entries, text)
  selectedIndex.value = 0
}

watch(query, (value) => {
  if (!visible.value || loading) return
  clearTimer()
  timer = setTimeout(() => {
    timer = null
    applyQuery(value)
  }, QUERY_DELAY_MS)
})

/** 唤出：清空输入并立即展示「最近阅读」列表，不等防抖也不额外查一次 */
async function open(): Promise<void> {
  const gen = ++generation
  clearTimer()
  loading = true
  query.value = ''
  selectedIndex.value = 0
  results.value = []
  visible.value = true
  try {
    entries = buildPaletteEntries(await libraryAllBooks())
  } catch (e) {
    entries = []
    showStatusMessage(`读取书库失败：${formatError(e)}`)
  }
  if (gen !== generation) return
  loading = false
  // 快照读取期间用户可能已经输入，这里按当前输入补一次过滤
  applyQuery(query.value)
}

/** 收起并把焦点交还正文（面板里的输入框会拿走编辑器焦点） */
function close(): void {
  clearTimer()
  visible.value = false
  void nextTick(() => focusEditor())
}

function toggle(): void {
  if (visible.value) close()
  else void open()
}

/** 上下键移动选中：夹在结果范围内（对齐 Python 面板） */
function moveSelection(step: number): void {
  const count = results.value.length
  if (!count) return
  selectedIndex.value = Math.min(Math.max(selectedIndex.value + step, 0), count - 1)
}

/** 回车/点击打开：先收起再走 openFile（重复打开去重、最近阅读、会话持久化都在那里） */
async function activate(index = selectedIndex.value): Promise<void> {
  const entry = results.value[index]
  if (!entry) return
  close()
  try {
    await useTabs().openFile(entry.path)
  } catch (e) {
    showStatusMessage(`打开失败：${formatError(e)}`)
  }
}

export function useCommandPalette(): {
  visible: typeof visible
  query: typeof query
  results: typeof results
  selectedIndex: typeof selectedIndex
  open: () => Promise<void>
  close: () => void
  toggle: () => void
  moveSelection: (step: number) => void
  activate: (index?: number) => Promise<void>
} {
  return { visible, query, results, selectedIndex, open, close, toggle, moveSelection, activate }
}
