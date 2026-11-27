# Card 04：迁移自绘查找替换栏 `FindReplaceBar.vue` 至 CodeMirror 6

- **前置依赖**：Card 03 已完成且通过门禁
- **下游契约方**：Card 05（完成后全仓不再有任何业务文件引用 Monaco）
- **目标**：
  1. 重构 `src/components/FindReplaceBar.vue`，彻底移除 `monaco` 导入，接入 CM6 `EditorView`、Card 02 的 `searchDocument()` 与 `findDecorations.ts` 视口裁剪高亮。
  2. 在 `src/components/EditorHost.vue` 恢复向 `<FindReplaceBar :editor="editor" :loading="loading" />` 传参。

---

## 一、需读取与改动的文件清单

| 文件 | 操作 | 说明 |
| --- | --- | --- |
| `src/editor/findDecorations.ts` | 只读 | 确认 `setFindHighlightEffect`、`clearFindHighlightEffect` |
| `src/editor/codemirror.ts` | 只读 | 确认 `tabIdField`、`revealRangeCentered` |
| `shared/crossLineSearch.ts` | 只读 | 确认 `searchDocument`、`DocumentSearchMatch` |
| `src/composables/useTabLifecycle.ts` | 只读 | 确认 `onEditorViewUpdate`、`onEditorStateSwitch` |
| `src/components/FindReplaceBar.vue` | 重构 | 全面切至 CM6 偏移模型 + `Text` 不可变缓存 + 视口高亮 + 原子替换 |
| `src/components/EditorHost.vue` | 修改 | 恢复 `<FindReplaceBar :editor="editor" :loading="loading" />` |

---

## 二、精确实现要求

### 1. Props 与文档判定
- `props`: `{ editor?: EditorView; loading?: boolean }`
- 判断当前是否有打开文档：封装 `hasBoundDoc(view)` → `view.state.field(tabIdField) !== null`（替代原 `instance.getModel() !== null`）。

### 2. `doc.toString()` 单槽缓存（零冗余拷贝）
- CM6 的 `state.doc`（`Text` 实例）严格不可变：
  ```ts
  let scanCache: { doc: Text; text: string } | null = null
  function scanTextOf(doc: Text): string {
    if (scanCache && scanCache.doc === doc) return scanCache.text
    const text = doc.toString()
    scanCache = { doc, text }
    return text
  }
  ```
- 关闭面板或卸载组件时置 `scanCache = null` 释放内存。

### 3. 统一搜索管线（替代 `model.findMatches` / `findNextMatch` / `findPreviousMatch`）
- `matches` 改为 `shallowRef<DocumentSearchMatch[]>([])`（每项 `{ from, to, groups }`，天然按 `from` 升序，彻底省去 `matchStarts` 换算与 `monaco.Range` 构造！）。
- `refreshNow(autoJump = false)`：
  - 若 `!open.value || !view || !hasBoundDoc(view) || !findText.value`：清空 `matches` 并派发 `clearFindHighlightEffect`。
  - 调用 `searchDocument(scanTextOf(view.state.doc), findText.value, { regex: regex.value, matchCase: matchCase.value, wordSeparators: wholeWord.value ? WORD_SEPARATORS : null })`。
  - 捕获正则编译异常时设 `regexError.value = true` 并派发 `clearFindHighlightEffect`。
  - 成功后调用 `updateCurrentIndex()`，再派发 `setFindHighlightEffect.of({ matches: matches.value, currentIndex: currentIndex.value })`。
  - 若 `autoJump && !regexError.value && matches.value.length > 0`：调用 `selectMatch(currentIndex.value)`。
- **二分定位当前项 `updateCurrentIndex()`**：
  - 取 `offset = view.state.selection.main.from`。
  - 二分查找首个 `matches[i].from >= offset`；若 `i > 0 && offset < matches[i - 1].to` 则 `i -= 1`；越界回绕 `0`。
- **上一个 / 下一个（`next()` / `previous()`）**：
  - 统一直接在 `matches.value` 环绕推进：
    - `next()`：`selectMatch((currentIndex.value + 1) % matches.value.length)`
    - `previous()`：`selectMatch((currentIndex.value - 1 + matches.value.length) % matches.value.length)`
  - （与原正则模式一致，且比来回调用编辑器逐次查找更快、跨行/普通完全一致。）
- **`selectMatch(index)`**：
  - 派发单次事务选中并居中滚动，同时更新当前项高亮：
    ```ts
    view.dispatch({
      selection: { anchor: match.from, head: match.to },
      effects: [
        EditorView.scrollIntoView(EditorSelection.range(match.from, match.to), { y: 'center' }),
        setFindHighlightEffect.of({ matches: matches.value, currentIndex: index })
      ]
    })
    ```

### 4. 初始查找文本（`initialFindText` 与 `wordAtCursor`）
- 若主选区非空：取 `view.state.sliceDoc(main.from, main.to)`。
- 否则：取当前行 `const line = view.state.doc.lineAt(main.head)`，行内偏移 `offset = main.head - line.from`，复用原 `/[\p{L}\p{N}_]+/gu` 扫描逻辑；空行或无词退回 `lastFindText`。

### 5. 替换与全部替换（撤销粒度对齐）
- **`replaceCurrent()`**：
  - 校验 `!reader.locked`、`!regexError.value`、当前命中存在。
  - 取 `original = view.state.sliceDoc(match.from, match.to)`，`insert = buildReplacement(match, original)`。
  - 一次派发并独立撤销步：
    ```ts
    view.dispatch({
      changes: { from: match.from, to: match.to, insert },
      annotations: isolateHistory.of('full')
    })
    ```
  - 立即 `refreshNow()`，再二分定位首个 `from >= match.from + insert.length`（越界回绕 `0`）并 `selectMatch(index)`，焦点仍留在替换框。
- **`replaceAllMatches()`**：
  - 构造全量 `changes = matches.value.map((m) => ({ from: m.from, to: m.to, insert: buildReplacement(m, view.state.sliceDoc(m.from, m.to)) }))`。
  - 一次派发完成全部替换，带 `annotations: isolateHistory.of('full')`（一次 `Cmd+Z` 完整还原！）。
  - 立即 `refreshNow()` 并显示 `已替换 ${changes.length} 处`。

### 6. 订阅编辑器事件（替代 `instance.onDidChange*`）
- 在 `onMounted` 订阅 Card 03 暴露的：
  - `onEditorStateSwitch`（切标签/重载）：清空 `matches`，清 `scanCache`，若 `open.value` 则 `refreshNow()`。
  - `onEditorViewUpdate(update)`：
    - 若 `!open.value` 跳过。
    - `update.docChanged` → `scheduleRefresh()`。
    - `update.selectionSet`（且非自身 `selectMatch` 引起重复）→ `updateCurrentIndex()` 并派发 `setFindHighlightEffect` 同步当前项高亮。
- 在 `onBeforeUnmount` 取消订阅、清空定时器、清空 `scanCache`、若视图仍存在则派发 `clearFindHighlightEffect`。
- `close()` 时派发 `clearFindHighlightEffect` 并 `props.editor?.focus()`。

### 7. 保留全部既有交互与模板样式
- 完整保留 `Cmd+F` / `Ctrl+Cmd+F` / `Cmd+G` / `Shift+Cmd+G` / `Esc` 捕获阶段快捷键、常用正则下拉面板、`aA` 保留大小写、左边缘拖拽调宽、全部 HTML 模板与 CSS 样式。

---

## 三、防坑红线

1. **严禁**对全量 `matches` 直接构造全文档装饰；必须经 `setFindHighlightEffect` 交由 `findDecorations.ts` 的 `ViewPlugin` 仅装饰 `view.visibleRanges`。
2. 替换与全部替换必须携带 `annotations: isolateHistory.of('full')`（注意 `isolateHistory` 是 `AnnotationType`，放 `annotations` 而非 `effects`），确保单步/全部替换各自对应一次独立撤销。
3. 切标签或关闭查找栏时务必清空高亮与 `scanCache`，避免残留高亮或持有旧 10MB 字符串引用导致内存泄漏。

---

## 四、验收门禁

1. `npm run typecheck` 全通过（0 error）。
2. 启动 `npm run dev` 实测：
   - `Cmd+F` / `Ctrl+Cmd+F` 唤出、选中文本/光标词自动带入、常用正则面板应用规则。
   - 区分大小写、全字匹配、跨行正则（如 `\n{2,}`）命中计数与跳转准确。
   - 打开 10MB+ 大书查找高频字（如「的」，数万命中），快速上下滚动零卡顿、可视区高亮即时跟随。
   - 单个替换（焦点留在替换框并跳至下一处）、保留大小写、`$1`/`\n` 捕获组展开、全部替换与一次 `Cmd+Z` 完整撤消。
   - 切换标签时查找结果自动切到新文档，关闭查找栏后高亮彻底清除且焦点还给正文。
