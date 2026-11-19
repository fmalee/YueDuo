import { monaco, READER_EDITOR_OPTIONS, readerTypographyOptions } from '@/monaco'
import type { ReaderFont } from '../../shared/types'
import type { ConvertCommand } from './useEditorCommands'

type Editor = monaco.editor.IStandaloneCodeEditor

/**
 * 编辑器实例创建与 options（方案 §0.2）
 * 单实例 + 每标签 model，参数只在 create 时生效；字体/字号后续走 applyReaderTypography。
 */
export function createReaderEditor(
  host: HTMLElement,
  locked: boolean,
  font: ReaderFont,
  fontSize: number
): Editor {
  return monaco.editor.create(host, {
    ...READER_EDITOR_OPTIONS,
    ...readerTypographyOptions(font, fontSize),
    value: '',
    readOnly: locked
  })
}

/** 正文字体/字号切换：updateOptions 立即生效，不动 model 与光标（不通过 CSS 覆盖） */
export function applyReaderTypography(editor: Editor, font: ReaderFont, fontSize: number): void {
  editor.updateOptions(readerTypographyOptions(font, fontSize))
}

/** 锁定阅读切换：只关输入，保留光标与滚动；锁定时焦点交还正文，空格才能翻页 */
export function applyReadOnly(editor: Editor, locked: boolean): void {
  editor.updateOptions({ readOnly: locked })
  if (locked) editor.focus()
}

export interface EditorActionHandlers {
  /** 右键「添加书签」（提示文案在调用方给状态栏） */
  addBookmark: () => void
  /** 右键「转换」组（全角转半角 / 简转繁 / 繁转简） */
  convert: (command: ConvertCommand) => void
  /** 右键「一键整理」 */
  tidy: () => void
}

/**
 * 右键菜单动作（方案 §2.7 / §3.2）：有选区转选区、否则转全文，实现全在 useEditorCommands。
 * precondition 让只读（锁定阅读）时这些项置灰。
 */
export function registerEditorActions(editor: Editor, handlers: EditorActionHandlers): void {
  editor.addAction({
    id: 'yueduo.addBookmark',
    label: '添加书签',
    contextMenuGroupId: 'bookmarks',
    contextMenuOrder: 1,
    precondition: '!editorReadonly',
    run: () => handlers.addBookmark()
  })
  editor.addAction({
    id: 'yueduo.toHalfwidth',
    label: '全角转半角',
    contextMenuGroupId: 'convert',
    contextMenuOrder: 1,
    precondition: '!editorReadonly',
    run: () => handlers.convert('toHalfwidth')
  })
  editor.addAction({
    id: 'yueduo.toTraditional',
    label: '简转繁',
    contextMenuGroupId: 'convert',
    contextMenuOrder: 2,
    precondition: '!editorReadonly',
    run: () => handlers.convert('toTraditional')
  })
  editor.addAction({
    id: 'yueduo.toSimplified',
    label: '繁转简',
    contextMenuGroupId: 'convert',
    contextMenuOrder: 3,
    precondition: '!editorReadonly',
    run: () => handlers.convert('toSimplified')
  })
  editor.addAction({
    id: 'yueduo.tidy',
    label: '一键整理',
    contextMenuGroupId: 'convert',
    contextMenuOrder: 4,
    precondition: '!editorReadonly',
    run: () => handlers.tidy()
  })
}
