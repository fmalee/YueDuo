# Card 02：安装 CodeMirror 6 核心依赖并构建 `src/editor/` 引擎底座

- **前置依赖**：无（不改动任何现有 Monaco 代码，完全增量新增）
- **下游契约方**：Card 03（核心链路接线）、Card 04（`FindReplaceBar.vue` 重构）
- **目标**：
  1. 在 `package.json` 中安装 3 个 CM6 核心包（暂不卸载 `monaco-editor`）。
  2. 新建高内聚的 `src/editor/` 四件套：`dirtyState.ts`、`findDecorations.ts`、`codemirror.ts`、`textEdits.ts`。
  3. 扩展 `shared/crossLineSearch.ts` 提供纯文本 + 跨行正则统一搜索入口 `searchDocument`。

---

## 一、需读取与改动的文件清单

| 文件                            | 操作     | 说明                                                                                                    |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `package.json`                  | 修改     | 安装 `@codemirror/state`、`@codemirror/view`、`@codemirror/commands`（锁 `^6.x`，不装 search/language） |
| `src/styles/theme.ts`           | 只读     | 读取 `READING`、`readingLineHeight` 及 `--yd-*` token 命名                                              |
| `shared/types.ts`               | 只读     | 读取 `ReaderFont`、`TidyEdit`、`BookmarkInfo`                                                           |
| `shared/crossLineSearch.ts`     | 修改     | 保留原导出，新增统一搜索 `searchDocument()` 与 `DocumentSearchMatch`                                    |
| `src/editor/dirtyState.ts`      | **新增** | 基于 `invertedEffects` 的 O(1) 版本号判脏状态机                                                         |
| `src/editor/findDecorations.ts` | **新增** | 基于 `ViewPlugin` + `view.visibleRanges` 二分裁剪的查找高亮扩展                                         |
| `src/editor/codemirror.ts`      | **新增** | CM6 `EditorState`/`EditorView` 工厂、3 个 `Compartment`、主题/排版、`WeakMap` 跨状态监听、精准滚动工具  |
| `src/editor/textEdits.ts`       | **新增** | 纯 CM6 编辑动作：一键整理原子提交、书签精确漂移、回车缩进、下方插行、合并段落、翻页、取头部行           |

---

## 二、精确契约与实现要求（严禁变更导出名与签名，Card 03/04 严格依赖）

### 1. 依赖安装

运行 `npm install -D @codemirror/state@^6.0.0 @codemirror/view@^6.0.0 @codemirror/commands@^6.0.0`（或放入 `dependencies`/`devDependencies` 与项目现有 `package.json` 风格一致——本项目所有前端包均在 `devDependencies`，锁 `^6.x`）。**禁止**安装 `@codemirror/search`、`@codemirror/language` 或 `codemirror` 元包；**禁止**在本卡卸载 `monaco-editor`。

### 2. `src/editor/dirtyState.ts`（精确判脏，零 Bug 核心）

**原理**：与 Monaco `getAlternativeVersionId()` 数学同构，绝不使用脆弱的 `undoDepth` 计数（避免 500ms 输入合并和 history 裁剪导致失效）。

**精确实现要点**：

- 定义 `const setDocVersion = StateEffect.define<number>()`；模块级自增 `let versionSeq = 1`。
- `export const docVersionField = StateField.define<number>({ create: () => versionSeq++, update(value, tr) { ... } })`：
  - 遍历 `tr.effects` 查找 `setDocVersion`，若存在则取**最后一个** `e.value`（处理合并组撤销时倒序重放多条 effect，最后一个即该组开始前的原始版本）。
  - 否则若 `tr.docChanged`，返回 `versionSeq++`。
  - 否则返回 `value`。
- 利用 `@codemirror/commands` 的 `invertedEffects.of((tr) => ...)`：
  - 若 `tr.docChanged`，返回 `[setDocVersion.of(tr.startState.field(docVersionField))]`；否则返回 `[]`。
  - 撤销时自动把 `docVersionField` 还原为编辑前版本，并自动对撤销事务生成反向 effect 供重做还原！
- **精确导出**：
  ```ts
  export const docVersionField: StateField<number>
  export const dirtyTrackingExtension: Extension
  export function currentDocVersion(state: EditorState): number
  /** 保存后在激活视图上调用：隔离撤销历史并返回新的保存基线版本号 */
  export function isolateAndCaptureBaseline(view: EditorView): number
  /** 非当前标签离线保存时调用：返回隔离后的新 state 与新基线版本号 */
  export function isolateStateBaseline(state: EditorState): { state: EditorState; baseline: number }
  ```
  - 两者均通过派发 `isolateHistory.of('full')` 阻止保存后的首次输入与保存前 500ms 内的编辑合并进同一撤销组。

### 3. `src/editor/findDecorations.ts`（视口裁剪查找高亮）

- **精确导出**：
  ```ts
  export interface FindHighlightRange {
    from: number
    to: number
  }
  export interface FindHighlightPayload {
    matches: readonly FindHighlightRange[]
    currentIndex: number
  }
  export const setFindHighlightEffect: StateEffectType<FindHighlightPayload>
  export const clearFindHighlightEffect: StateEffectType<void>
  export const findDecorationsExtension: Extension
  ```
- **实现要求**：
  - `StateField<FindHighlightPayload>`：
    - 初始 `{ matches: [], currentIndex: -1 }`。
    - `tr.docChanged` 时立即清空为 `{ matches: [], currentIndex: -1 }`（防止旧偏移越界导致 `RangeSetBuilder` 抛错；随后 `FindReplaceBar` 会刷新）。
    - 收到 `clearFindHighlightEffect` 清空；收到 `setFindHighlightEffect` 替换。
  - `ViewPlugin`（挂 `decorations: (v) => v.decorations`）：
    - 仅在 `update.viewportChanged || update.docChanged || 收到上述 effect` 时重建 `DecorationSet`。
    - 遍历 `view.visibleRanges`：用二分查找定位首个 `matches[i].to > vFrom`，顺序扫描直到 `matches[i].from >= vTo`；记录 `lastAddedIndex` 防多区间重复添加。
    - 越界防御：仅当 `0 <= from < to <= doc.length` 时加入 `RangeSetBuilder`。
    - CSS class：当前项 `'yd-find-match-current'`，其余 `'yd-find-match'`（复用 `src/assets/base.css` 既有样式）。

### 4. `src/editor/codemirror.ts`（单视图多状态核心工厂）

- **精确导出**：
  ```ts
  export const tabIdField: StateField<string | null>

  export interface ReaderEditorConfig {
    dark: boolean
    font: ReaderFont
    fontSize: number
    locked: boolean
  }

  export interface Cm6ViewState {
    engine: 'cm6'
    scrollTop: number
    anchor: number
    head: number
  }

  export interface EditorViewListeners {
    onUpdate?: (update: ViewUpdate) => void
    onScroll?: (view: EditorView) => void
    onContextMenu?: (event: MouseEvent, view: EditorView) => void
  }

  export function isCm6ViewState(value: unknown): value is Cm6ViewState
  export function createEmptyState(config: ReaderEditorConfig): EditorState
  export function createTabState(
    tabId: string,
    text: string,
    config: ReaderEditorConfig
  ): EditorState
  export function createReaderView(
    parent: HTMLElement,
    initialState: EditorState,
    listeners: EditorViewListeners
  ): EditorView
  export function destroyReaderView(view: EditorView): void
  export function syncStateCompartments(state: EditorState, config: ReaderEditorConfig): EditorState
  export function updateViewTheme(view: EditorView, dark: boolean): void
  export function updateViewTypography(view: EditorView, font: ReaderFont, fontSize: number): void
  export function updateViewReadOnly(view: EditorView, locked: boolean): void
  export function getTopVisibleLine(view: EditorView): number
  export function getVisibleLineRange(view: EditorView): { top: number; bottom: number } | null
  export function scrollToTopLineImmediate(view: EditorView, lineNumber: number): void
  export function revealLineCentered(view: EditorView, lineNumber: number): void
  export function revealPosNearest(view: EditorView, pos: number): void
  export function revealRangeCentered(view: EditorView, from: number, to: number): void
  ```
- **核心防坑实现要求**：
  1. **跨 `view.setState()` 监听不丢失**：使用模块级 `const viewListeners = new WeakMap<EditorView, { listeners: EditorViewListeners; disposeScroll: () => void }>()`。在所有 `EditorState` 共享的基础扩展中挂载静态的 `EditorView.updateListener.of((u) => viewListeners.get(u.view)?.listeners.onUpdate?.(u))` 和 `EditorView.domEventHandlers({ contextmenu: (e, v) => { viewListeners.get(v)?.listeners.onContextMenu?.(e, v); return false } })`；`scroll` 监听挂在 `view.scrollDOM` 并在 `destroyReaderView` 中卸载。
  2. **3 个 `Compartment`**：
     - `themeCompartment`：`EditorView.theme({ ... }, { dark })`，绑定 `--yd-bg-3`（背景）、`--yd-text-1`（正文色）、`--yd-cursor`（光标）、`--yd-selection`（选区）、`--yd-text-3`（行号）、`--yd-text-2`（激活行号）、`height: '100%'`、`.cm-scroller { overflow: auto }`、`.cm-content { padding: '8px 20px' }`（20px 左右页边距）、`.cm-gutters { backgroundColor: 'var(--yd-bg-3)', borderRight: 'none', color: 'var(--yd-text-3)' }`、去掉 `.cm-editor.cm-focused` 蓝色默认 outline。
     - `typographyCompartment`：`EditorView.theme({ '&': { fontSize: `${fontSize}px`}, '.cm-content, .cm-gutter': { fontFamily: READING.fontFamilies[font], lineHeight:`${readingLineHeight(fontSize)}px` } })`。
     - `readOnlyCompartment`：`EditorState.readOnly.of(locked)`（**绝对禁止设置 `EditorView.editable.of(false)`**！）。
  3. **`syncStateCompartments(state, config)`**：用于切标签 `view.setState(synced)` 之前，一次性重配 3 个 `Compartment` 且携带 `annotations: Transaction.addToHistory.of(false)`，防止切回旧标签后主题/字体/锁定态不同步。
  4. **基础扩展集合**：`lineNumbers()`、`highlightActiveLineGutter()`（不开 `highlightActiveLine`）、`history({ minDepth: 500 })`、`dirtyTrackingExtension`、`findDecorationsExtension`、`EditorView.lineWrapping`、`scrollPastEnd()`、`keymap.of([...defaultKeymap, ...historyKeymap])`。
  5. **精准滚动工具**：
     - `getTopVisibleLine(view)`：通过 `view.lineBlockAtHeight(view.scrollDOM.scrollTop)` → `view.state.doc.lineAt(block.from).number`。
     - `getVisibleLineRange(view)`：顶部用 `scrollTop`，底部用 `scrollTop + view.scrollDOM.clientHeight`，各自 `lineBlockAtHeight` 映射到 1-based 行号。
     - `scrollToTopLineImmediate(view, lineNumber)`：夹取合法行号后派发 `effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 0 })`。
     - `revealLineCentered` / `revealRangeCentered`：使用 `{ y: 'center' }`；`revealPosNearest`：使用 `{ y: 'nearest' }`。

### 5. `src/editor/textEdits.ts`（纯 CM6 编辑动作）

- **精确导出**：
  ```ts
  export const INDENT_RE = /^[ \t\u3000]+/
  export function docHeadText(doc: Text, maxLines: number): string
  export function insertNewlineCmd(view: EditorView, withIndent: boolean): void
  export function insertLineBelowCmd(view: EditorView, withIndent: boolean): void
  export function deleteToLineStartCmd(view: EditorView): void
  export function pageByCmd(view: EditorView, direction: 1 | -1): number | null
  export function applyTidyEdits(view: EditorView, edits: readonly TidyEdit[]): void
  export function mapBookmarksByChanges(
    bookmarks: readonly BookmarkInfo[],
    oldDoc: Text,
    newDoc: Text,
    changes: ChangeSet
  ): BookmarkInfo[]
  ```
- **关键算法要求**：
  - **所有用户编辑动作**均携带 `effects: isolateHistory.of('full')`（等价原 Monaco `pushUndoStop` 包裹）且在 `view.state.readOnly` 时直接返回。
  - `insertNewlineCmd`：沿用当前行首 `[ \t\u3000]*` 缩进，无缩进时补 `\u3000\u3000`；`withIndent=false` 只插 `\n`；替换当前主选区并把光标置入新文本末尾，带 `scrollIntoView: true`。
  - `insertLineBelowCmd`：在当前行尾 `line.to` 插入 `\n${indent}`，光标移动到新行末尾（`line.to + 1 + indent.length`），带 `scrollIntoView: true`。
  - `deleteToLineStartCmd`：若主光标在 `pos === 0` 则返回；若在第 1 行则删除 `[0, head]`，否则删除 `[prevLine.to, head]`（连带吃掉前一行尾换行），聚焦视图。
  - `pageByCmd`：用 `getVisibleLineRange(view)` 计算 `pageLines = Math.max(1, bottom - top)`，目标行 `target = clamp(1, doc.lines, top + direction * pageLines)`，一次 `dispatch` 把光标移到 `doc.line(target).from` 并 `EditorView.scrollIntoView(pos, { y: 'start', yMargin: 0 })`，返回 `target`。
  - `applyTidyEdits(view, edits)`：按 `startLine` 升序排列，对每条 `TidyEdit`：
    - `from = doc.line(e.startLine).from`
    - `to = e.endLine >= doc.lines ? doc.line(doc.lines).to : doc.line(e.endLine + 1).from`
    - 一次 `view.dispatch({ changes, effects: isolateHistory.of('full') })` 原子提交！
    - 提交前记录 `{ line, col }`，提交后按新 `view.state.doc` 夹取行列恢复光标位置。
  - `mapBookmarksByChanges(bookmarks, oldDoc, newDoc, changes)`：
    - 收集 `changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => ...)` 中的纯删除段（`inserted.length === 0 && toA > fromA`）。
    - 对每条书签：若 `oldLine` 被某个纯删除段完整覆盖且吃掉了行前或行后换行（`fromA <= oldLine.from && toA >= oldLine.to && (fromA < oldLine.from || toA > oldLine.to)`），丢弃该书签；否则 `newPos = changes.mapPos(oldLine.from, 1)`，映射为 `newDoc.lineAt(newPos).number`。
    - 最终按行号升序去重（同新行号只保留第一条，避免撞数据库唯一约束）。

### 6. `shared/crossLineSearch.ts` 扩展

保留原 `MultilineMatch`、`searchMultilineRegex` 不变，新增：

```ts
export interface DocumentSearchMatch {
  from: number
  to: number
  groups: string[] | null
}

export interface DocumentSearchOptions {
  regex: boolean
  matchCase: boolean
  wordSeparators: string | null
}

export function searchDocument(
  text: string,
  pattern: string,
  options: DocumentSearchOptions
): DocumentSearchMatch[]
```

- `regex: true` → 调 `searchMultilineRegex` 转换结果。
- `regex: false`：
  - `matchCase: true` → `text.indexOf(pattern, pos)` 推进（步进 `pattern.length`），若传了 `wordSeparators` 则复用内置 `isWholeWord` 过滤。
  - `matchCase: false` → 转义正则元字符后用 `new RegExp(escaped, 'giu')` 扫描并跳过零长匹配（规避 `toLowerCase()` 导致极少数 Unicode 字符长度偏移），同样复用 `isWholeWord` 过滤。

---

## 三、防坑红线

1. **严禁**把 `EditorView.editable.of(false)` 写进 `readOnlyCompartment`。
2. **严禁**在本卡删除 `src/monaco.ts` 或修改现有业务 composable（保证零侵入）。
3. `dirtyState.ts` 严禁依赖 `undoDepth` 计数，必须使用 `invertedEffects` 反向版本号。
4. `codemirror.ts` 的 `updateListener` 与 `contextmenu` 必须通过 `WeakMap` 绑定到 `EditorView`，确保 `view.setState()` 切换状态后永不丢监听。

---

## 四、验收门禁

1. `npm run typecheck` 全通过（0 error）。
2. 核对 `package.json` 仅新增 3 个 `@codemirror/*` 包且无多余包。
