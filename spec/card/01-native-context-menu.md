# Card 01：统一 Tauri 原生右键菜单底座 + 顶部撤消/恢复接管

- **前置依赖**：无
- **下游契约方**：Card 03（正文右键菜单与 CM6 撤消/恢复分流）
- **目标**：
  1. 在 Rust 与 IPC 层新增统一的原生弹出菜单通道 `app_popup_menu`（零新增 Rust 依赖，复用内置 `tauri::menu`）。
  2. 将顶部「编辑」菜单的「撤消」「恢复」改为自定义命令 `cmd:undo`/`cmd:redo`，在前端按焦点分流。
  3. 新增前端统一调度器 `src/composables/useContextMenu.ts`，先将 `TabBar.vue` 与 `SidebarEdit.vue` 的自绘右键菜单迁到原生菜单并清理旧菜单 DOM/CSS。

---

## 一、需读取与改动的文件清单

| 文件 | 操作 | 说明 |
| --- | --- | --- |
| `src-tauri/src/types.rs` | 修改 | 新增 `ContextMenuPredefinedRole`、`ContextMenuItem`、`ContextMenuAction` |
| `src-tauri/src/shell.rs` | 修改 | 新增 `popup_context_menu()`；`on_menu_event` 顶部拦截 `ctx:`；顶部撤消/恢复改为 `cmd:undo`/`cmd:redo` |
| `src-tauri/src/commands/app.rs` | 修改 | 新增 `async fn app_popup_menu`（经 `run_on_main_thread` 弹出） |
| `src-tauri/src/lib.rs` | 修改 | `generate_handler!` 注册 `commands::app::app_popup_menu` |
| `shared/types.ts` | 修改 | `AppMenuCommand` 增 `'undo' \| 'redo'`；同步 `ContextMenu*` 类型 |
| `src/ipc/bridge.ts` | 修改 | 新增 `appPopupMenu()`、`onContextMenuAction()` |
| `src/composables/useContextMenu.ts` | **新增** | 统一原生右键菜单调度器（单次订阅 + 最新 `requestId` 覆盖） |
| `src/components/TabBar.vue` | 修改 | 删除自绘右键菜单 DOM/状态/CSS/全局监听，改调 `popupContextMenu`（**保留重命名浮层**） |
| `src/components/sidebar/SidebarEdit.vue` | 修改 | 删除自绘右键菜单 DOM/状态/CSS/全局监听，改调 `popupContextMenu` |
| `src/App.vue` | 修改 | `runMenuCommand` 增加 `case 'undo'` / `case 'redo'` 焦点分流 |

---

## 二、精确契约与实现要求

### 1. 跨进程类型契约（严禁改名，Card 03 直接依赖）

**`shared/types.ts`**：
```ts
// AppMenuCommand 追加：
//   | 'undo'
//   | 'redo'

export type ContextMenuPredefinedRole = 'cut' | 'copy' | 'paste' | 'selectAll'

export type ContextMenuItem =
  | { kind: 'item'; id: string; label: string; enabled?: boolean }
  | { kind: 'predefined'; role: ContextMenuPredefinedRole; label?: string }
  | { kind: 'separator' }

export interface ContextMenuAction {
  requestId: string
  itemId: string
}
```

**`src-tauri/src/types.rs`**：
```rust
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContextMenuPredefinedRole {
    Cut,
    Copy,
    Paste,
    SelectAll,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ContextMenuItem {
    Item {
        id: String,
        label: String,
        #[serde(default = "default_true")]
        enabled: bool,
    },
    Predefined {
        role: ContextMenuPredefinedRole,
        label: Option<String>,
    },
    Separator,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuAction {
    pub request_id: String,
    pub item_id: String,
}
```

### 2. Rust 弹出菜单与事件路由（`src-tauri/src/shell.rs` & `commands/app.rs` & `lib.rs`）

- **`shell.rs` 顶部「编辑」菜单**：
  - 将原 `PredefinedMenuItem::undo` / `PredefinedMenuItem::redo` 替换为：
    ```rust
    add_item(&edit_menu, app, "cmd:undo", "撤消", Some("CmdOrCtrl+Z"))?;
    add_item(&edit_menu, app, "cmd:redo", "恢复", Some("Shift+CmdOrCtrl+Z"))?;
    ```
  - `cut` / `copy` / `paste` / `select_all` 保持 `PredefinedMenuItem` 不动。
- **`shell.rs` 的 `on_menu_event` 顶部拦截**：
  - 在 `let menu_state = app.state::<MenuState>();` **之前**最先判断：
    ```rust
    if let Some(rest) = id.strip_prefix("ctx:") {
        if let Some((request_id, item_id)) = rest.split_once(':') {
            let _ = app.emit(
                "app:contextMenu",
                ContextMenuAction {
                    request_id: request_id.to_string(),
                    item_id: item_id.to_string(),
                },
            );
        }
        return;
    }
    ```
- **`shell.rs` 新增 `pub fn popup_context_menu(app: &AppHandle, request_id: &str, items: &[ContextMenuItem]) -> Result<(), String>`**：
  - 必须在主线程调用（由 `commands/app.rs` 保证）。
  - 使用 `tauri::menu::{ContextMenu, Menu, MenuItem, PredefinedMenuItem}` 构建菜单：
    - `ContextMenuItem::Separator` → `PredefinedMenuItem::separator(app)`
    - `ContextMenuItem::Predefined { role, label }` → 按 `role` 映射 `PredefinedMenuItem::cut / copy / paste / select_all(app, label.as_deref())`
    - `ContextMenuItem::Item { id, label, enabled }` → `MenuItem::with_id(app, format!("ctx:{request_id}:{id}"), label, *enabled, None::<&str>)`
  - 通过 `app.get_webview_window("main")` 调用 `window.popup_menu(&menu).map_err(|e| e.to_string())`（找不到窗口直接返回 `Ok(())`）。
- **`commands/app.rs` 新增 command**：
  ```rust
  #[tauri::command]
  pub async fn app_popup_menu(
      app: AppHandle,
      request_id: String,
      items: Vec<ContextMenuItem>,
  ) -> Result<(), String> {
      let handle = app.clone();
      app.run_on_main_thread(move || {
          if let Err(e) = crate::shell::popup_context_menu(&handle, &request_id, &items) {
              eprintln!("[context-menu] 弹出菜单失败: {e}");
          }
      })
      .map_err(|e| e.to_string())
  }
  ```
- **`lib.rs`**：在 `generate_handler![]` 中注册 `commands::app::app_popup_menu`。

### 3. 前端 IPC 与调度器（`src/ipc/bridge.ts` & `src/composables/useContextMenu.ts`）

- **`src/ipc/bridge.ts`**（app 域追加）：
  ```ts
  export function appPopupMenu(requestId: string, items: ContextMenuItem[]): Promise<null> {
    return ipcInvoke<null>('app_popup_menu', { requestId, items })
  }

  export function onContextMenuAction(callback: (payload: ContextMenuAction) => void): () => void {
    return subscribe<ContextMenuAction>('app:contextMenu', callback)
  }
  ```
- **`src/composables/useContextMenu.ts`**：
  ```ts
  export async function popupContextMenu(
    items: ContextMenuItem[],
    onSelect: (itemId: string) => void
  ): Promise<void>
  ```
  - 模块级单次订阅 `onContextMenuAction`（避免重复注册与 HMR 泄漏）。
  - 模块级仅存**最新一次** `{ requestId: string; onSelect: (itemId: string) => void } | null`：每次调用生成递增 `requestId` 覆盖旧值（屏幕同时只能有一个原生右键菜单，用户点外部取消不产生回调 Map 泄漏）。
  - 收到匹配 `requestId` 的 action 时清空当前引用并调用 `onSelect(itemId)`。

### 4. `TabBar.vue` 与 `SidebarEdit.vue` 收口

- **`src/components/TabBar.vue`**：
  - `openTabMenu(e: MouseEvent, tabId: string)`：`e.preventDefault()` 后根据 `tab` 构造项并调 `popupContextMenu`：
    - `save`（保存）、`close`（关闭）、`closeOthers`（关闭其他，`enabled: store.tabs.length > 1`）、`closeAll`（关闭全部）
    - `separator`
    - `rename`（重命名…，`enabled: Boolean(tab.path)`）、`move`（移动…，`enabled: Boolean(tab.path)`）、`delete`（删除…，`enabled: Boolean(tab.path)`）、`reveal`（在 Finder 中显示，`enabled: Boolean(tab.path)`）
  - 删除自绘 `<div class="tab-context-menu">` Teleport、`menu`/`menuEl`/`menuTab` 状态、`onGlobalPointerDown`、`onGlobalBlur` 以及 `.tab-context-menu` / `.tab-menu-*` CSS。
  - **重要**：完整保留重命名浮层（`rename`、`renameInput`、`beginRename`、`cancelRename`、`submitRename`、Esc 取消重命名监听与 `.rename-*` 样式）。
  - **注意样式细节**：不要删 `src/styles/theme.ts` 中的任何 token（本卡不动 `theme.ts`，留待 Card 05 统一清理）。
- **`src/components/sidebar/SidebarEdit.vue`**：
  - `openMenu(e: MouseEvent, tabId: string)`：`e.preventDefault()` 后调 `popupContextMenu`：
    - `close`（关闭）、`closeOthers`（关闭其他，`enabled: store.tabs.length > 1`）
  - 删除自绘 `.context-menu` Teleport、`menu` 状态、`dismiss`、`onWindowPointerDown`、`onWindowKeydown`、`blur` 监听及 `.context-menu` / `.menu-item` CSS（`@scroll="dismiss"` 同步去掉）。

### 5. `src/App.vue` 顶部「撤消 / 恢复」分流

- 在 `runMenuCommand` 增加：
  ```ts
  case 'undo':
  case 'redo':
    runUndoRedo(payload.command)
    break
  ```
- 实现 `runUndoRedo(action: 'undo' | 'redo')`：
  - 若 `document.activeElement` 是 `HTMLInputElement` 或 `HTMLTextAreaElement` 且不在 `.monaco-editor` 内：调用 `document.execCommand(action)`。
  - 否则（当前阶段仍为 Monaco）：若焦点在 `.monaco-editor` 内，通过 `getActiveEditor()?.trigger('menu', action, null)` 执行（Card 03 会切换为 `.cm-editor` + CM6 `undo`/`redo`）。

---

## 三、防坑红线

1. `app_popup_menu` 必须为 `async` 且在 `run_on_main_thread` 内构建并弹出菜单；严禁在 tokio 工作线程直接构造 `muda` 菜单。
2. `shell.rs` 的 `on_menu_event` 拦截 `ctx:` 时用 `split_once(':')`（兼容 `itemId` 含冒号），拦截后直接 `return`，不可触碰 `MenuState`。
3. 严禁删除 `TabBar.vue` 的重命名浮层逻辑或 Esc 关闭重命名监听。

---

## 四、验收门禁

1. `cargo test --manifest-path /Users/Joey/Sites/Projects/YueDuo/src-tauri/Cargo.toml` 全通过。
2. `npm run typecheck`（node + web 双侧）全通过。
3. 建议人工冒烟：`npm run dev` 启动后，右键标签栏和左栏「编辑」页确认原生菜单弹出、单标签时「关闭其他」置灰、空白标签时文件项置灰、点击各项动作与重命名浮层正常、编辑器与输入框 `Cmd+Z` 撤消正常。
