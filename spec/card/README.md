# CodeMirror 6 迁移总控与分阶段省流卡片索引

本项目将编辑器底座由 `Monaco Editor` 迁移为轻量级的 `CodeMirror 6`，并将全仓三处右键菜单统一收口为 Tauri 原生弹出菜单。

## 执行顺序与依赖拓扑

```text
01-native-context-menu  (无依赖，Rust + 前端原生右键底座)
02-codemirror-core      (无依赖，安装 CM6 + 新增 src/editor/ 引擎层)
        │
        ▼
03-switch-editor-core   (强依赖 01、02；原子切换编辑器核心链路)
        │
        ▼
04-find-replace-migration (强依赖 03；重构 FindReplaceBar.vue 并接入)
        │
        ▼
05-cleanup-and-verify   (强依赖 04；卸载 Monaco、清理遗留与全量验收)
```

> 建议严格按 `01 → 02 → 03 → 04 → 05` 顺序逐卡执行。每张卡片完成后**必须通过该卡门禁命令**，确认无误再执行下一张卡片。

## 卡片清单

| 卡片                                                           | 主题                                                                     | 门禁命令                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [01-native-context-menu.md](./01-native-context-menu.md)       | Tauri 原生右键菜单底座 + 顶部撤消/恢复接管 + 标签栏/左栏右键收口         | `cargo test --manifest-path src-tauri/Cargo.toml` & `npm run typecheck`   |
| [02-codemirror-core.md](./02-codemirror-core.md)               | 安装 CM6 核心包 + 构建 `src/editor/` 引擎四件套 + 统一搜索内核           | `npm run typecheck`                                                       |
| [03-switch-editor-core.md](./03-switch-editor-core.md)         | 编辑器核心链路切换（生命周期/LRU/会话/编辑/快捷键/书签/元数据/正文右键） | `npm run typecheck` + 启动冒烟验证                                        |
| [04-find-replace-migration.md](./04-find-replace-migration.md) | `FindReplaceBar.vue` 迁至 CM6 偏移搜索与视口裁剪高亮                     | `npm run typecheck` + 查找替换实测                                        |
| [05-cleanup-and-verify.md](./05-cleanup-and-verify.md)         | 卸载 Monaco、清理 Vite 补丁与废弃代码、更新 `AGENTS.md`、全量构建验收    | `npm run typecheck` & `npm run lint` & `cargo test` & `npm run build:app` |

## 全程不可违反的硬红线

1. **禁止假读与禁读目录**：修改前先读对应目标文件；严禁读取 `.git`、`.trae`、`.vscode`、`node_modules`、`resources`、`src-tauri/Cargo.lock`、`src-tauri/icons`、`package-lock.json`、`pnpm-lock.yaml`。
2. **全文绝不进 Vue 响应式**：全文字符串只留在 CM6 `EditorState.doc`，Pinia store 与 Vue `ref`/`reactive` 只存元信息与数字指标。
3. **单实例切换**：全局唯一 `EditorView` 实例，切换标签通过 `view.setState(state)`，绝不用 `:key` 重建组件。
4. **锁定阅读红线**：只读锁定只使用 `EditorState.readOnly.of(true)`，**严禁 `EditorView.editable.of(false)`**（否则失焦、空格翻页、选区复制全部失效）。
5. **O(1) 判脏**：严禁调用 `doc.toString()` 对比判脏，必须使用 `src/editor/dirtyState.ts` 的 `invertedEffects` 版本号状态机。
6. **大文档查找高亮**：严禁对全文所有命中挂载装饰，必须通过 `ViewPlugin` 仅对 `view.visibleRanges` 二分裁剪挂载。
7. **Rust 异步与主线程铁律**：新增 Tauri command 必须为 `async`；操作 `muda` 菜单必须通过 `app.run_on_main_thread`；禁止在事件回调中同步阻塞等待。
8. **契约四处同步**：新增/变更 IPC 通道必须同步 `src-tauri/src/types.rs`、`shared/types.ts`、`src-tauri/src/commands/*.rs`（及 `lib.rs` 注册）、`src/ipc/bridge.ts`。
