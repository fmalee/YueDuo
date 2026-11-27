# Card 05：彻底清理 Monaco 遗留、更新文档与全量构建验收

- **前置依赖**：Card 04 已完成且通过门禁
- **目标**：
  1. 彻底卸载 `monaco-editor` 并删除遗留文件与 Vite 补丁插件。
  2. 清理 `src/styles/theme.ts` 中自绘右键菜单废弃 token（保护重命名浮层样式不被误伤）。
  3. 更新 `AGENTS.md` 与相关代码注释中的编辑器技术栈描述与硬约束。
  4. 执行全仓 `monaco` 残留扫描、全量类型检查、Lint、Rust 单测与打包验收。

---

## 一、需读取与改动的文件清单

| 文件                                                   | 操作     | 说明                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`                                         | 修改     | 卸载 `monaco-editor`（执行 `npm uninstall monaco-editor`）                                                                                                                                                                                                                                                   |
| `src/monaco.ts`                                        | **删除** | 移除 Monaco 初始化、NLS 与主题定义                                                                                                                                                                                                                                                                           |
| `src/monaco/cjkWrapStrings.ts`                         | **删除** | 移除全角标点宽度劫持补丁（同时删空目录 `src/monaco/`）                                                                                                                                                                                                                                                       |
| `vite.config.ts`                                       | 修改     | 删除 `monacoCjkWrapStringsPlugin`、`cjkWrapStringsPath`、`optimizeDeps.exclude` 8 项与无用 `Plugin` 类型导入                                                                                                                                                                                                 |
| `src/styles/theme.ts`                                  | 修改     | 清理已废弃的自绘菜单 token（`tabMenuMinWidth`、`tabMenuPaddingY`、`tabMenuItemPaddingY`、`tabMenuItemPaddingX`、`tabMenuRadius` 及对应 CSS 变量注入）；将 `TabBar.vue` `.rename-button` 引用的 `--yd-tab-menu-font-size` 改为 `--yd-find-font-size`（或保留 `renameButtonFontSize`）后再删 `tabMenuFontSize` |
| `src/components/TabBar.vue`                            | 修改     | 仅同步 `.rename-button` 的 `font-size` 变量（配合 `theme.ts` 清理）                                                                                                                                                                                                                                          |
| `AGENTS.md`                                            | 修改     | 更新「项目定位」「技术栈基线」「架构与目录」「文本与编码」「Monaco 硬约束 → CodeMirror 6 硬约束」「界面约定」等章节                                                                                                                                                                                          |
| `src-tauri/src/lib.rs` / `types.rs` / `shared/*.ts` 等 | 轻改     | 仅修正仍称呼「Monaco」的过时文档注释（不动业务逻辑）                                                                                                                                                                                                                                                         |

---

## 二、精确清理与文档更新要求

### 1. 卸载与文件删除

- 执行 `npm uninstall monaco-editor`。
- 删除 `src/monaco.ts` 与 `src/monaco/cjkWrapStrings.ts`（删除空的 `src/monaco/` 目录）。
- 精简 `vite.config.ts`：仅保留 `root`、`publicDir`、`base`、`build`、`resolve.alias`、`plugins: [vue()]`、`server`。

### 2. `src/styles/theme.ts` 废弃菜单 token 安全清理

- 先全局 grep `tab-menu` / `tabMenu`，确认只有 `TabBar.vue` 的 `.rename-button` 引用了 `--yd-tab-menu-font-size`。
- 把 `TabBar.vue` 中 `.rename-button` 的 `font-size: var(--yd-tab-menu-font-size);` 改为 `font-size: var(--yd-find-font-size);`（同为 12px），再安全删除 `theme.ts` 中的 6 个 `tabMenu*` 键及对应 `setProperty` 行。

### 3. `AGENTS.md` 同步更新要点

- **技术栈基线**：`Monaco 0.57` 改为 `CodeMirror 6（@codemirror/state、@codemirror/view、@codemirror/commands）`；说明 `noImplicitAny: false` 按历史口径保留（若仍保留）。
- **架构与目录**：补充 `src/editor`（CodeMirror 6 引擎层：实例/Compartment 工厂、O(1) 判脏、视口裁剪高亮、纯编辑动作）。
- **原「Monaco 硬约束」替换为「CodeMirror 6 硬约束」**：
  - 单 `EditorView` 实例 + 每标签不可变 `EditorState`（非 reactive `Map`）+ `view.setState()` 切换，禁止用 `:key` 重建；`updateListener` 实时回写最新 `EditorState`；空态/加载态切共享只读空占位态（`tabIdField = null`）。
  - 每次 `view.setState()` 前必须经 `syncStateCompartments()` 同步全局主题、字体、字号与锁定态（带 `addToHistory: false`）。
  - 锁定阅读只用 `EditorState.readOnly.of(true)`，严禁 `EditorView.editable.of(false)`。
  - O(1) 判脏走 `src/editor/dirtyState.ts`（`docVersionField` + `invertedEffects` 反向版本号），严禁调用 `doc.toString()` 对比。
  - 查找高亮走 `src/editor/findDecorations.ts`（`ViewPlugin` 仅对 `view.visibleRanges` 二分裁剪挂 `Decoration.mark`）。
  - 统一原生右键菜单走 `app_popup_menu`（剪切/复制/粘贴/全选混合预定义策略，撤销/恢复走自定义项）；顶部菜单撤消/恢复走 `cmd:undo`/`cmd:redo` 按焦点分流。
  - 打包版 `src/main.ts` 的 `contextmenu` 放行规则必须排除 `.cm-editor` 内的 `[contenteditable="true"]`。

### 4. 全仓 `monaco` 零残留检查

- 对 `src/`、`shared/`、`vite.config.ts`、`package.json` 执行忽略大小写的 `monaco` 检索，确认除历史兼容性注释（如旧版 `view_state` 兼容说明）外零代码/类型/样式残留。

---

## 三、全量门禁与人工验收清单

### 自动化门禁（必须全部绿灯）

1. `npm run typecheck`（node + web 双侧）
2. `npm run lint`（0 error / 0 warning）
3. `cargo test --manifest-path /Users/Joey/Sites/Projects/YueDuo/src-tauri/Cargo.toml`（全用例通过）
4. `npm run build:app`（完整前端构建 + Tauri Release 打包成功，核对打包体积显著瘦身）

### 人工验收清单（交付用户核验）

1. **10MB+ 实书性能与排版**：打开 10MB+ 中文小说，切换 5 种系统字体与字号，确认软换行右缘对齐无溢出、中文 IME 连续打字无行抖动、滚轮滚动与锁定空格翻页流畅、全文高频字（数万命中）查找滚动无卡顿、一键整理一次 `Cmd+Z` 完整还原。
2. **原生右键菜单（锁定与解锁双态）**：
   - 正文无选区：剪切/复制/转换为小写/转换为大写置灰；有选区：全部亮起；锁定态：除复制（有选区时）与全选外全部置灰。
   - 点击「粘贴」无任何 WKWebView 权限确认弹窗；点击「撤销」「恢复」与顶部菜单/快捷键完全同步。
   - 标签栏与左栏「编辑」页右键菜单正常，无打包版 WebKit 原生 `Reload/Inspect Element` 穿帮。
3. **旧库平滑升级**：使用含旧版 Monaco `view_state` 的测试库冷启动，会话标签、阅读进度行与光标位置正常恢复无报错。
