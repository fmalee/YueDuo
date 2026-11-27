<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { EditorView } from '@codemirror/view'
import { useFindReplace } from '@/composables/useFindReplace'
import { METRICS } from '@/styles/theme'
import { DEFAULT_RULES, type FindRule } from '../../shared/findRules'

/**
 * 自绘查找替换栏 UI 组件（方案 §3.1）：
 * 核心搜索/高亮/替换状态机位于 composables/useFindReplace.ts，本组件只负责布局、焦点、快捷键与拖拽调宽。
 */
const props = defineProps<{
  editor?: EditorView
  loading?: boolean
}>()

const {
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
  openBar: openFindState,
  close,
  next,
  previous,
  replaceCurrent,
  replaceAllMatches,
  scheduleRefresh,
  toggleRegex,
  applyRule: applyFindRule,
  attachSubscriptions,
  detachSubscriptions
} = useFindReplace({
  getEditor: () => props.editor,
  isLoading: () => Boolean(props.loading)
})

const width = ref<number>(METRICS.findBarWidth)
const barEl = ref<HTMLElement | null>(null)
const findInput = ref<HTMLInputElement | null>(null)
const replaceInput = ref<HTMLInputElement | null>(null)
const rulesButton = ref<HTMLElement | null>(null)
const rulesPanel = ref<HTMLElement | null>(null)
let resizeState: { startX: number; width: number } | null = null

const rules = DEFAULT_RULES

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown, true)
  window.addEventListener('yueduo:findReplace', onFindReplaceCommand)
  window.addEventListener('resize', clampToContainer)
  window.addEventListener('pointerdown', onDocumentPointerDown, true)
  attachSubscriptions()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('yueduo:findReplace', onFindReplaceCommand)
  window.removeEventListener('resize', clampToContainer)
  window.removeEventListener('pointerdown', onDocumentPointerDown, true)
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', stopResize)
  detachSubscriptions()
})

/** 快捷键（捕获阶段）：先于编辑器输入处理，统一由自绘查找栏接管 */
function onWindowKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  const key = e.key.toLowerCase()
  const mod = e.metaKey || e.ctrlKey
  if (mod && key === 'f') {
    e.preventDefault()
    e.stopPropagation()
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
  if (!openFindState(expandReplace)) return
  clampToContainer()
  void nextTick(() => {
    findInput.value?.focus()
    findInput.value?.select()
  })
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

function applyRule(rule: FindRule): void {
  applyFindRule(rule)
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
  color: var(--yd-danger);
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
