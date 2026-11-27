# Card 03：原子切换编辑器核心链路至 CodeMirror 6

- **前置依赖**：Card 01、Card 02 均已完成且通过门禁
- **下游契约方**：Card 04（`FindReplaceBar.vue` 迁至 CM6 后重新接回 `:editor`）
- **目标**：
  将除 `FindReplaceBar.vue` 外的全部编辑器核心链路（生命周期/LRU、会话恢复、状态栏指标、快捷键与行命令、转换/一键整理、书签漂移与添加、元数据双向同步、正文原生右键菜单、顶部菜单撤消/恢复、`__yueTest` 验收通道）一次性切换至 `CodeMirror 6`。

---

## 一、需读取与改动的文件清单

| 分组 | 文件 | 核心改动 |
| --- | --- | --- |
| **生命周期与会话** | `src/composables/useTabLifecycle.ts` | `ModelEntry` 改为存 `state: EditorState` + `viewState: Cm6ViewState \| null` + `baselineVersion: number`；`getTabState` 优先读 live `view.state`；增加 `syncActiveTabState`、`updateTabStateOffline`、事件桥接 `onEditorViewUpdate`/`onEditorStateSwitch`；旧 Monaco `viewState` 安全忽略 |
| | `src/composables/useEditorSetup.ts` | 薄封装调用 `src/editor/codemirror.ts`（`createReaderEditor`、`applyReaderTypography`、`applyReadOnly`、`applyEditorTheme`、`openEditorContextMenu`） |
| | `src/composables/useEditorViewState.ts` | `activateFor` 切 `EditorState` 前调用 `syncStateCompartments`；空态/重载/缺失态切 `createEmptyState`；`restoreEditorFocus` 修正 `.cm-editor` 与外部输入框判定 |
| | `src/composables/useSession.ts` | 类型换 `EditorView`；`topVisibleLine`、`applyRestoredView`、`scrollToTopLine`、`jumpToLine` 改用 `src/editor/codemirror.ts` 工具；`resetSessionForSwitch` 切空占位态；草稿写盘取 `entry.state.doc.toString()` |
| **编辑与快捷键** | `src/composables/useLineCommands.ts` | 类型换 `EditorView`，直接委派 `src/editor/textEdits.ts`；保留 `INDENT_RE` 导出 |
| | `src/composables/useEditorCommands.ts` | 类型换 `EditorView`；`convertSelection` / `tidyDocument` 用 `view.state.doc === originalDoc` O(1) 校验；`tidyDocument` 直接调 `applyTidyEdits`（删 400 行分批与 `setTimeout`）；`saveActive` 调 `resetBaseline` |
| | `src/composables/useEditorKeybindings.ts` | 类型换 `EditorView`；`.monaco-editor` → `.cm-editor`（**`isTextInput` 必须先排除 `.cm-editor` 再判 `isContentEditable`**） |
| | `src/composables/useStatusMetrics.ts` | `refreshStatusMetrics(doc: Text \| null)`：`doc.lines`、`doc.length`（O(1)） |
| **书签与元数据** | `src/composables/useBookmarkDrift.ts` | `handleBookmarkDrift(tabId, path, oldDoc, newDoc, changes)` 改调 `mapBookmarksByChanges`，去掉旧 `lineCounts` 粗差量算法 |
| | `src/composables/useBookmarks.ts` | 读 `getTabState(tab.id)?.doc` 的 `doc.lines` / `doc.line(line).text` |
| | `src/components/right/BookmarkList.vue` | `lineText` 读 `getTabState(id)?.doc` |
| | `src/composables/useMetadataEdit.ts` | 直接用 UTF-16 `result.edit.start`/`end` 派发 `changes` + `annotations: isolateHistory.of('full')`；切走标签时离线 `entry.state.update` 写回注册表 |
| | `src/components/MetadataBar.vue` | 订阅 `onEditorStateSwitch` + `onEditorViewUpdate`，用 `docHeadText(doc, 10)` 本地解析（去掉 `model.onDidChangeContent`） |
| **宿主与外围** | `src/components/EditorHost.vue` | 挂载单 `EditorView`；监听 `settings.dark` 切主题；接入正文原生右键菜单；暂写 `<FindReplaceBar :loading="loading" />`（Card 04 接回 `:editor`） |
| | `src/composables/useTabs.ts` | `getTabModel(id)?.model.getValue()` → `getTabState(id)?.doc.toString()`（2 处） |
| | `src/utils/format.ts` | 移除 `monaco` 类型导入，`modelHeadText` 改为 `docHeadText`（或重导出自 `src/editor/textEdits.ts`） |
| | `src/stores/settings.ts` | 移除 `import { applyMonacoTheme } from '@/monaco'` 及调用（CM6 主题由 `EditorHost.vue` 监听 `settings.dark` 响应） |
| | `src/App.vue` | `runUndoRedo` 切为 `.cm-editor` + CM6 `undo(view)`/`redo(view)`（锁定态跳过）；适配 `editAndSave` 与 `__yueTest`（`getModelText`/`applyEdit`） |
| | `src/main.ts` | 修正 `import.meta.env.PROD` 右键放行：排除 `.cm-editor` 内的 `[contenteditable="true"]` |
| | `src/assets/base.css` | `.monaco-editor` → `.cm-editor` |

---

## 二、核心实现细节与精确要求

### 1. `useTabLifecycle.ts` 不可变状态同步（防过期快照铁律）

- `TabStateEntry`（可保留 `ModelEntry` 类型别名减少改动面）：
  ```ts
  export interface ModelEntry {
    state: EditorState
    viewState: Cm6ViewState | null
    loadedAt: number
    /** 保存基线版本号（-1 表示脏草稿重载哨兵，保存前恒脏） */
    baselineVersion: number
    encoding: string
  }
  ```
- **注册实时视图引用或同步回写**：
  - 每次 `EditorView` 收到 `onUpdate`（只要 `update.state !== update.startState`），立即调用 `syncTabState(tabId, update.state)` 更新 `registry.get(tabId).state = update.state`！
  - 新增 `getTabState(tabId: string): EditorState | null`：优先检查若 `activeView?.state.field(tabIdField) === tabId` 则返回 `activeView.state`，否则返回 `registry.get(tabId)?.state ?? null`。
  - 新增 `applyTabEdit(tabId: string, from: number, to: number, insert: string, isolate = true): boolean`：若为当前激活视图则 `view.dispatch(...)`，否则离线 `entry.state.update(...)` 并写回 `entry.state`（供 `useMetadataEdit.ts` 与 `App.vue` `__yueTest` 共用）。
- **判脏与保存基线**：
  - `isDirty(tabId)`：取最新 `state`，若无返回 `false`；`entry.baselineVersion === -1 || currentDocVersion(state) !== entry.baselineVersion`。
  - `resetBaseline(tabId, view?)`：若该标签正挂载在 `view` 上，调用 `isolateAndCaptureBaseline(view)` 更新 `entry.baselineVersion`；否则调用 `isolateStateBaseline(entry.state)` 更新 `entry.state` 与 `entry.baselineVersion`。
- **`saveViewState` / `restoreViewState` 与旧库兼容**：
  - `saveViewState(tabId, view)`：仅当 `view.state.field(tabIdField) === tabId` 时保存 `{ engine: 'cm6', scrollTop: view.scrollDOM.scrollTop, anchor: main.anchor, head: main.head }`，并同步 `entry.state = view.state`。
  - `restoreViewState(tabId, view)`：校验 `isCm6ViewState(entry.viewState)`；夹取 `anchor`/`head` 到 `[0, doc.length]` 派发 selection，并设置 `view.scrollDOM.scrollTop = vs.scrollTop`（辅以 `requestAnimationFrame(() => { if (view.state.field(tabIdField) === tabId) view.scrollDOM.scrollTop = vs.scrollTop })` 兜底大文档首帧布局）。
  - `reloadModel` 读到旧版 Monaco `draft.viewState` 时，因 `!isCm6ViewState(draft.viewState)` 自动置 `entry.viewState = null`，零报错退回 SQLite `progressLine`/`cursorLine`/`cursorColumn`。
- **视图事件订阅桥（供 `MetadataBar.vue` 与 Card 04 `FindReplaceBar.vue` 使用）**：
  - 在 `useTabLifecycle.ts`（或 `useSession.ts`）导出：
    ```ts
    export function onEditorViewUpdate(listener: (update: ViewUpdate) => void): () => void
    export function emitEditorViewUpdate(update: ViewUpdate): void
    export function onEditorStateSwitch(listener: (tabId: string | null) => void): () => void
    export function emitEditorStateSwitch(tabId: string | null): void
    ```

### 2. 正文原生右键菜单（`useEditorSetup.ts` + `EditorHost.vue`）

在 `EditorView` 的 `onContextMenu(event, view)` 回调中：
1. 先 `event.preventDefault()` 阻止 WKWebView 默认菜单。
2. 若当前处于空占位态（`view.state.field(tabIdField) === null`），直接返回。
3. 实时读取状态：
   - `locked = reader.locked`
   - `hasSelection = !view.state.selection.main.empty`
   - `canUndo = !locked && undoDepth(view.state) > 0`
   - `canRedo = !locked && redoDepth(view.state) > 0`
4. 构造菜单项（严格按混合策略 + 用户已确认的置灰规则）：
   - `{ kind: 'item', id: 'undo', label: '撤销', enabled: canUndo }`
   - `{ kind: 'item', id: 'redo', label: '恢复', enabled: canRedo }`
   - `{ kind: 'separator' }`
   - 剪切：`!locked && hasSelection` → `{ kind: 'predefined', role: 'cut', label: '剪切' }`，否则 `{ kind: 'item', id: '__cut', label: '剪切', enabled: false }`
   - 复制：`hasSelection` → `{ kind: 'predefined', role: 'copy', label: '复制' }`，否则 `{ kind: 'item', id: '__copy', label: '复制', enabled: false }`
   - 粘贴：`!locked` → `{ kind: 'predefined', role: 'paste', label: '粘贴' }`，否则 `{ kind: 'item', id: '__paste', label: '粘贴', enabled: false }`
   - `{ kind: 'separator' }`
   - `{ kind: 'item', id: 'addBookmark', label: '添加书签', enabled: !locked }`
   - `{ kind: 'separator' }`
   - `{ kind: 'item', id: 'toHalfwidth', label: '全角转半角', enabled: !locked }`
   - `{ kind: 'item', id: 'toLower', label: '转换为小写', enabled: !locked && hasSelection }`（**无选区置灰**）
   - `{ kind: 'item', id: 'toUpper', label: '转换为大写', enabled: !locked && hasSelection }`（**无选区置灰**）
   - `{ kind: 'item', id: 'toTraditional', label: '简转繁', enabled: !locked }`
   - `{ kind: 'item', id: 'toSimplified', label: '繁转简', enabled: !locked }`
   - `{ kind: 'item', id: 'tidy', label: '一键整理', enabled: !locked }`
   - `{ kind: 'separator' }`
   - `{ kind: 'predefined', role: 'selectAll', label: '全选' }`
5. 点击回调中分别分发 `undo(view)`、`redo(view)`、`addBookmark`、`convert`、`transformCase`、`tidy`。

### 3. `EditorHost.vue` 关键接线细节

- 样式类 `.monaco-container` 改为 `.cm-container`，并确保 `.cm-container :deep(.cm-editor) { height: 100%; }`（防止撑破容器或出现双滚动条）。
- 监听 `() => settings.dark` → `applyEditorTheme(editor.value, dark)`。
- `onUpdate(update)` 中：
  1. 若 `update.state !== update.startState` 且有 `tabId`：`syncTabState(tabId, update.state)`。
  2. 广播 `emitEditorViewUpdate(update)`（驱动 `MetadataBar` 及后续 `FindReplaceBar`）。
  3. 若 `update.docChanged`：
     - `store.patchTab(tabId, { dirty: isDirty(tabId) })`
     - `refreshStatusMetrics(update.state.doc)`
     - 文件标签：更新书名标题（`docHeadText(update.state.doc, 10)`）+ 调 `handleBookmarkDrift(tabId, tab.path, update.startState.doc, update.state.doc, update.changes)`；空白标签：节流 `scheduleBlankTitle`。
  4. 若 `update.selectionSet || update.docChanged`：
     - `setCursorLine(update.state.doc.lineAt(update.state.selection.main.head).number)`
     - 若 `update.selectionSet` 且有 `activePath()`：`library.scheduleReadStamp(path)`。
- `onScroll`：抓 `captureProgress(id)` + `schedulePersist()` + `library.scheduleReadStamp(path)`。
- **重要（保证 Card 03 独立 `typecheck` 绿灯）**：模板中 `<FindReplaceBar>` 暂时只传 `:loading="loading"`（去掉 `:editor="editor"`），待 Card 04 重构完 `FindReplaceBar.vue` 后接回。

### 4. `src/main.ts` 打包版右键放行修正

```ts
if (import.meta.env.PROD) {
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement | null
    if (
      target?.closest('input, textarea') ||
      (target?.closest('[contenteditable="true"]') && !target.closest('.cm-editor'))
    ) {
      return
    }
    e.preventDefault()
  })
}
```

### 5. `useEditorViewState.ts` 焦点归还修正

```ts
function restoreEditorFocus(): void {
  const active = document.activeElement
  if (!active) {
    focusEditor()
    return
  }
  if (active.closest('.cm-editor')) return
  const tag = active.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
  focusEditor()
}
```

---

## 三、防坑红线

1. **切标签同步 Compartment**：`activateFor` 每次 `view.setState(...)` 前必须执行 `syncStateCompartments(entry.state, currentConfig)`，否则切回旧标签后主题/字体/字号/锁定态错乱。
2. **禁止跳过 `isTextInput` 排除 `.cm-editor`**：CM6 内容区是 `contenteditable="true"`，必须先判 `if (el.closest('.cm-editor')) return false` 再判 `el.isContentEditable`。
3. **顶部菜单 `undo`/`redo`**：`App.vue` 焦点在 `.cm-editor` 内且 `reader.locked` 为真时不得执行撤销/恢复；焦点在普通 `<input>`/`<textarea>` 内走 `document.execCommand`。
4. **`isolateHistory` 字段位置**：`@codemirror/commands` 的 `isolateHistory.of('full')` 是 `AnnotationType`，派发时必须放在 `annotations:` 中（不可放 `effects:`）。
5. **暂不卸载 `monaco-editor`**：因 `FindReplaceBar.vue` 尚未迁完，本卡不动 `package.json`、`src/monaco.ts`、`vite.config.ts`。

---

## 四、验收门禁

1. `npm run typecheck` 全通过（0 error）。
2. 启动 `npm run dev` 冒烟验证：
   - 打开/切换多个标签、切深浅主题、切 5 种中文字体与字号，切回旧标签样式完全同步。
   - 输入/保存/撤销回清洁态（连续快速打字后再撤消也能精确消掉未保存圆点）。
   - 回车自动缩进、Shift+回车纯换行、Cmd+回车下方插行、Shift+Option+Backspace 合并段落。
   - 锁定阅读下空格向下翻页、Shift+空格向上翻页、无法编辑但可选区复制。
   - 锁定与解锁态下分别右键正文，确认无选区时剪切/复制/转换为小写/转换为大写置灰、粘贴无权限弹窗、撤销/恢复正常、顶部菜单撤消/恢复与 `Cmd+Z` 只撤消一步不双倍撤消。
   - 一键整理可一次 `Cmd+Z` 完整撤销；元数据栏修改同步正文且正文前 10 行编辑同步回元数据栏；书签在增删行和一键整理后行号精准漂移。
   - 含旧版 Monaco `view_state` 的测试库冷启动不报错且恢复阅读进度。
