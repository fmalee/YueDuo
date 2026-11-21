import type * as Monaco from 'monaco-editor/editor/editor.api'
import { useReaderStore } from '@/stores/reader'
import { useTabsStore } from '@/stores/tabs'
import { useCommandPalette } from './useCommandPalette'
import { useTabs } from './useTabs'
import { getActiveEditor } from './useSession'
import { deleteToLineStart, insertLineBelow, insertNewline, pageBy } from './useLineCommands'
import { showStatusMessage } from './useStatusMessage'

type Editor = Monaco.editor.IStandaloneCodeEditor

/** 键位：code 与键盘布局无关（Shift 不改变 code），meta/ctrl 合并成 mod */
export interface KeyChord {
  /** KeyboardEvent.code，如 'KeyS' / 'Enter' / 'Space' / 'Backspace' */
  code: string
  /** Cmd（macOS）/ Ctrl（其他平台） */
  mod?: boolean
  /** 严格 Control 键：Ctrl+Tab 是命令，Cmd+Tab 被系统应用切换器占用且到不了应用，二者必须区分 */
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

/** global = 编辑器内外一致；editor = 只在正文焦点内生效 */
export type KeyScope = 'global' | 'editor'

/** always = 始终可用；editable = 未锁定阅读时；readonly = 仅锁定阅读时 */
export type KeyAvailability = 'always' | 'editable' | 'readonly'

export interface KeybindingSpec {
  id: string
  label: string
  chord: KeyChord
  scope: KeyScope
  availability: KeyAvailability
  run: (editor: Editor | null) => void
}

export interface KeybindingOptions {
  toggleSidebar: () => void
  toggleRightPanel: () => void
}

/** 焦点在正文里（Monaco 用 EditContext 时是 div，回退时是 textarea，都在 .monaco-editor 内） */
function isEditorFocused(): boolean {
  return document.activeElement?.closest('.monaco-editor') != null
}

/** 查找框、重命名浮层、命令面板、元数据编辑等输入控件：键位必须放行 */
function isTextInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  if (el.closest('.monaco-editor')) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el.isContentEditable
}

/**
 * 组字判定只看事件自身的 isComposing：macOS 中文输入法激活期间 keydown 普遍携带 keyCode 229，
 * 拿 229 判断会把整段中文输入状态都当成组字、吞掉全部命令；isComposing 只在候选未上屏时为真。
 * 也不额外维护组字标志——标志一旦卡住就会永久吞键，事件属性每次都是实时的。
 */
function isComposing(e: KeyboardEvent): boolean {
  return e.isComposing
}

function matches(chord: KeyChord, e: KeyboardEvent): boolean {
  if (e.code !== chord.code) return false
  if (chord.ctrl != null) {
    // 严格匹配：Ctrl 按下状态一致，且 Cmd 未按下
    if (!!chord.ctrl !== e.ctrlKey || e.metaKey) return false
  } else if (!!chord.mod !== (e.metaKey || e.ctrlKey)) return false
  if (!!chord.shift !== e.shiftKey) return false
  if (!!chord.alt !== e.altKey) return false
  return true
}

/**
 * 集中键位表 + 捕获阶段分发器（window capture）
 * - 单一来源：编辑器内外同一键位走同一条命令，不再分别依赖 Monaco addCommand 与 window 兜底
 * - 捕获阶段先于 Monaco：锁定阅读的空格翻页、合并段落等不会被编辑器先消费
 * - 输入控件内一律放行；锁定阅读时写入类命令按只读语义禁用
 */
export function useEditorKeybindings(options: KeybindingOptions): { install: () => () => void } {
  const store = useTabsStore()
  const reader = useReaderStore()
  const palette = useCommandPalette()
  const { saveTab, newBlankTab, cycleTab } = useTabs()

  const bindings: KeybindingSpec[] = [
    {
      id: 'save',
      label: '保存',
      chord: { code: 'KeyS', mod: true },
      scope: 'global',
      availability: 'always',
      // 空白标签由 saveTab 走「另存为」，取消不做任何写入（与关闭空白标签同一路径）
      run: () => {
        const id = store.activeTabId
        if (!id) return
        void saveTab(id).catch((e) =>
          showStatusMessage(`保存失败：${e instanceof Error ? e.message : String(e)}`, 5000)
        )
      }
    },
    {
      id: 'newTab',
      label: '新建标签',
      chord: { code: 'KeyN', mod: true },
      scope: 'global',
      availability: 'always',
      run: () => newBlankTab()
    },
    {
      id: 'quickSearch',
      label: '速查',
      chord: { code: 'KeyP', mod: true },
      scope: 'global',
      availability: 'always',
      run: () => palette.toggle()
    },
    {
      // 浏览器风格标签切换：菜单里的同名加速键在 WKWebView 聚焦时会被 webview 吞掉
      // （Tab 属于网页焦点导航键，key equivalent 到不了 NSMenu），实际按键由这里兜住；
      // 菜单加速键仅作为无焦点场景的原生路径与菜单文案展示，两条路径按事件归属互斥不重复
      id: 'nextTab',
      label: '下一个标签',
      chord: { code: 'Tab', ctrl: true },
      scope: 'global',
      availability: 'always',
      run: () => cycleTab(1)
    },
    {
      id: 'prevTab',
      label: '上一个标签',
      chord: { code: 'Tab', ctrl: true, shift: true },
      scope: 'global',
      availability: 'always',
      run: () => cycleTab(-1)
    },
    {
      id: 'toggleLock',
      label: '锁定阅读',
      chord: { code: 'KeyL', mod: true },
      scope: 'global',
      availability: 'always',
      run: () => reader.toggle()
    },
    {
      id: 'toggleRightPanel',
      label: '显示/隐藏右侧栏',
      chord: { code: 'KeyB', mod: true },
      scope: 'global',
      availability: 'always',
      run: () => options.toggleRightPanel()
    },
    {
      id: 'toggleSidebar',
      label: '显示/隐藏左侧栏',
      chord: { code: 'KeyB', mod: true, shift: true },
      scope: 'global',
      availability: 'always',
      run: () => options.toggleSidebar()
    },
    {
      id: 'newline',
      label: '回车缩进',
      chord: { code: 'Enter' },
      scope: 'editor',
      availability: 'editable',
      run: (editor) => editor && insertNewline(editor, true)
    },
    {
      id: 'newlinePlain',
      label: '换行不缩进',
      chord: { code: 'Enter', shift: true },
      scope: 'editor',
      availability: 'editable',
      run: (editor) => editor && insertNewline(editor, false)
    },
    {
      // 捕获阶段拦下，避免 Monaco 自带的 insertLineAfter 再插一行
      id: 'insertLineBelow',
      label: '在下方插入行（带缩进）',
      chord: { code: 'Enter', mod: true },
      scope: 'editor',
      availability: 'editable',
      run: (editor) => editor && insertLineBelow(editor, true)
    },
    {
      id: 'insertLineBelowPlain',
      label: '在下方插入空行',
      chord: { code: 'Enter', mod: true, shift: true },
      scope: 'editor',
      availability: 'editable',
      run: (editor) => editor && insertLineBelow(editor, false)
    },
    {
      id: 'pageDown',
      label: '向下翻页',
      chord: { code: 'Space' },
      scope: 'editor',
      availability: 'readonly',
      run: (editor) => editor && pageBy(editor, 1)
    },
    {
      id: 'pageUp',
      label: '向上翻页',
      chord: { code: 'Space', shift: true },
      scope: 'editor',
      availability: 'readonly',
      run: (editor) => editor && pageBy(editor, -1)
    },
    {
      id: 'deleteToLineStart',
      label: '合并段落',
      chord: { code: 'Backspace', shift: true },
      scope: 'editor',
      availability: 'editable',
      run: (editor) => editor && deleteToLineStart(editor)
    },
    {
      // 中文输入法在候选上屏后会把 Shift+Backspace 当作输入法按键吞掉（到不了应用），
      // Shift+Option+Backspace 是实测可穿透输入法的替代键位（VS Code 宏同款）
      id: 'deleteToLineStartIme',
      label: '合并段落（输入法兼容键位）',
      chord: { code: 'Backspace', shift: true, alt: true },
      scope: 'editor',
      availability: 'editable',
      run: (editor) => editor && deleteToLineStart(editor)
    }
  ]

  function onKeydown(e: KeyboardEvent): void {
    // 统一组字守卫：候选未上屏（isComposing）时的输入类按键一律放行；
    // 带 Cmd/Ctrl 的是命令而不是输入法按键，照常分发
    if (isComposing(e) && !(e.metaKey || e.ctrlKey)) return
    const editorFocused = isEditorFocused()
    if (!editorFocused && isTextInput(e.target)) return
    const editor = getActiveEditor()
    for (const binding of bindings) {
      if (!matches(binding.chord, e)) continue
      if (binding.scope === 'editor' && (!editorFocused || !editor)) continue
      if (binding.availability === 'editable' && reader.locked) continue
      if (binding.availability === 'readonly' && !reader.locked) continue
      // 捕获阶段拦下：Monaco 与 Electron 菜单加速键都不再重复处理
      e.preventDefault()
      e.stopPropagation()
      binding.run(editor)
      return
    }
  }

  function install(): () => void {
    window.addEventListener('keydown', onKeydown, true)
    return () => window.removeEventListener('keydown', onKeydown, true)
  }

  return { install }
}
