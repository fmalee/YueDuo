//! 应用壳：原生中文菜单（对齐 electron/menu.ts）、菜单命令下发、侧栏勾选回写。
//!
//! 与 Electron 版的差异（muda 能力边界）：
//! - 「朗读」「粘贴并匹配样式」无对应预定义项，省略；「强制重新加载」由 reload 覆盖；
//! - 单选组（外观/字体/字号/预载数量）muda 无 radio，用 CheckMenuItem 手动互斥；
//! - 缩放用 webview set_zoom 自实现（muda 无 zoom 预定义项）；
//! - 「关闭窗口」用自定义项（预定义 close_window 固定 Cmd+W，与「关闭标签」冲突）。
//! 菜单点击统一 emit `app:menuCommand`（payload 与 Electron 版同形状），渲染层
//! runMenuCommand 按当前 active 标签分发，与标签右键菜单共用动作。

use std::sync::Mutex;

use serde_json::json;
use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::types::{
    ContextMenuAction, ContextMenuItem, ContextMenuPredefinedRole, READER_FONTS, READER_FONT_SIZES,
};

/// 「显示 → 预载数量」可选值（对齐 electron/menu.ts）
const PRELOAD_CHOICES: [i64; 5] = [4, 8, 10, 15, 20];

/// 外观三态（方案 §1.10）：菜单里以单选组呈现，勾选项跟设置落盘值一致
const APPEARANCES: [(&str, &str); 3] =
    [("system", "跟随系统"), ("light", "浅色"), ("dark", "深色")];

/// 菜单项句柄集：单选/复选组需要跨事件读写勾选状态
pub struct MenuState {
    appearance: Vec<(String, CheckMenuItem<Wry>)>,
    fonts: Vec<(String, CheckMenuItem<Wry>)>,
    sizes: Vec<(i64, CheckMenuItem<Wry>)>,
    preloads: Vec<(i64, CheckMenuItem<Wry>)>,
    close_button: CheckMenuItem<Wry>,
    sidebar: CheckMenuItem<Wry>,
    right_panel: CheckMenuItem<Wry>,
    zoom: Mutex<f64>,
}

impl MenuState {
    /// 单选组互斥：点中 one，清掉同组其余项
    fn select_in(&self, group: &[(String, CheckMenuItem<Wry>)], id: &str) {
        for (key, item) in group {
            let _ = item.set_checked(key == id);
        }
    }

    fn select_in_by_value(&self, group: &[(i64, CheckMenuItem<Wry>)], value: i64) {
        for (key, item) in group {
            let _ = item.set_checked(*key == value);
        }
    }
}

/// 菜单命令下发：payload 与 Electron 版 app:menuCommand 同形状
fn send_command(app: &AppHandle, command: &str, value: Option<serde_json::Value>) {
    let payload = match value {
        Some(v) => json!({ "command": command, "value": v }),
        None => json!({ "command": command }),
    };
    let _ = app.emit("app:menuCommand", payload);
}

fn item(
    app: &AppHandle,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, label, true, accelerator)
}

fn add_item(
    menu: &Submenu<Wry>,
    app: &AppHandle,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<()> {
    menu.append(&item(app, id, label, accelerator)?)
}

fn add_check(
    menu: &Submenu<Wry>,
    app: &AppHandle,
    id: &str,
    label: &str,
    checked: bool,
    accelerator: Option<&str>,
) -> tauri::Result<CheckMenuItem<Wry>> {
    let check_item = CheckMenuItem::with_id(app, id, label, true, checked, accelerator)?;
    menu.append(&check_item)?;
    Ok(check_item)
}

/// 构建并安装应用菜单（setup 内调用；settings 已在 AppState 中，取启动落盘值勾选）。
pub fn install_menu(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let saved = {
        let state = app.state::<crate::state::AppState>();
        state
            .settings_get()
            .map_err(|e| format!("读取设置失败: {e}"))?
    };

    // ---- 悦读（应用菜单）----
    let app_menu = Submenu::with_id(app, "app", "悦读", true)?;
    app_menu.append(&PredefinedMenuItem::about(
        app,
        Some("关于 悦读"),
        Some(AboutMetadata::default()),
    )?)?;
    app_menu.append(&PredefinedMenuItem::services(app, Some("服务"))?)?;
    app_menu.append(&PredefinedMenuItem::hide(app, Some("隐藏 悦读"))?)?;
    app_menu.append(&PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?)?;
    app_menu.append(&PredefinedMenuItem::show_all(app, Some("全部显示"))?)?;
    app_menu.append(&PredefinedMenuItem::quit(app, Some("退出 悦读"))?)?;

    // ---- 文件 ----
    let file_menu = Submenu::with_id(app, "file", "文件", true)?;
    add_item(&file_menu, app, "cmd:newTab", "新建", Some("CmdOrCtrl+N"))?;
    add_item(&file_menu, app, "cmd:open", "打开…", Some("CmdOrCtrl+O"))?;
    add_item(&file_menu, app, "cmd:quickSearch", "速查", Some("CmdOrCtrl+P"))?;
    add_item(&file_menu, app, "cmd:chooseLibrary", "书库…", None)?;
    file_menu.append(&PredefinedMenuItem::separator(app)?)?;
    add_item(&file_menu, app, "cmd:save", "保存", Some("CmdOrCtrl+S"))?;
    add_item(&file_menu, app, "cmd:closeTab", "关闭标签", Some("CmdOrCtrl+W"))?;
    add_item(&file_menu, app, "cmd:closeOthers", "关闭其他标签", None)?;
    add_item(&file_menu, app, "cmd:closeAll", "关闭全部标签", None)?;
    file_menu.append(&PredefinedMenuItem::separator(app)?)?;
    // 自定义关闭窗口（预定义 close_window 固定 Cmd+W，与「关闭标签」冲突）
    add_item(&file_menu, app, "cmd:closeWindow", "关闭窗口", Some("Shift+CmdOrCtrl+W"))?;

    // ---- 编辑 ----
    let edit_menu = Submenu::with_id(app, "edit", "编辑", true)?;
    add_item(&edit_menu, app, "cmd:undo", "撤消", Some("CmdOrCtrl+Z"))?;
    add_item(&edit_menu, app, "cmd:redo", "恢复", Some("Shift+CmdOrCtrl+Z"))?;
    edit_menu.append(&PredefinedMenuItem::separator(app)?)?;
    edit_menu.append(&PredefinedMenuItem::cut(app, Some("剪切"))?)?;
    edit_menu.append(&PredefinedMenuItem::copy(app, Some("复制"))?)?;
    edit_menu.append(&PredefinedMenuItem::paste(app, Some("粘贴"))?)?;
    edit_menu.append(&PredefinedMenuItem::select_all(app, Some("全选"))?)?;
    edit_menu.append(&PredefinedMenuItem::separator(app)?)?;
    add_item(&edit_menu, app, "cmd:find", "查找", Some("CmdOrCtrl+F"))?;
    add_item(&edit_menu, app, "cmd:replace", "替换", Some("Ctrl+Cmd+F"))?;
    edit_menu.append(&PredefinedMenuItem::separator(app)?)?;
    add_item(&edit_menu, app, "cmd:tidy", "一键整理", None)?;
    let convert_menu = Submenu::with_id(app, "convert", "繁简转换", true)?;
    add_item(&convert_menu, app, "cmd:toSimplified", "繁体 → 简体", None)?;
    add_item(&convert_menu, app, "cmd:toTraditional", "简体 → 繁体", None)?;
    edit_menu.append(&convert_menu)?;
    add_item(&edit_menu, app, "cmd:toHalfwidth", "全角转半角", None)?;

    // ---- 显示 ----
    let view_menu = Submenu::with_id(app, "view", "显示", true)?;
    add_item(&view_menu, app, "cmd:toggleLock", "锁定阅读", Some("CmdOrCtrl+L"))?;
    view_menu.append(&PredefinedMenuItem::separator(app)?)?;
    let font_menu = Submenu::with_id(app, "font", "字体", true)?;
    let mut font_items = Vec::new();
    for (key, label) in READER_FONTS {
        font_items.push((
            key.to_string(),
            add_check(
                &font_menu,
                app,
                &format!("menu:font:{key}"),
                label,
                saved.reader_font == key,
                None,
            )?,
        ));
    }
    view_menu.append(&font_menu)?;
    let size_menu = Submenu::with_id(app, "size", "字号", true)?;
    let mut size_items = Vec::new();
    for size in READER_FONT_SIZES {
        size_items.push((
            size,
            add_check(
                &size_menu,
                app,
                &format!("menu:size:{size}"),
                &size.to_string(),
                saved.reader_font_size == size,
                None,
            )?,
        ));
    }
    view_menu.append(&size_menu)?;
    view_menu.append(&PredefinedMenuItem::separator(app)?)?;
    add_item(&view_menu, app, "cmd:reload", "重新加载", None)?;
    // 切换开发者工具仅在 debug 构建（或显式开 devtools 特性）时存在：
    // open_devtools 系列方法带 cfg 门控，release 不编译此项（右键菜单不再出现 Inspect Element）
    #[cfg(any(debug_assertions, feature = "devtools"))]
    add_item(&view_menu, app, "cmd:devtools", "切换开发者工具", None)?;
    view_menu.append(&PredefinedMenuItem::separator(app)?)?;
    add_item(&view_menu, app, "cmd:zoomReset", "实际大小", Some("CmdOrCtrl+0"))?;
    add_item(&view_menu, app, "cmd:zoomIn", "放大", Some("CmdOrCtrl+Plus"))?;
    add_item(&view_menu, app, "cmd:zoomOut", "缩小", Some("CmdOrCtrl+-"))?;
    view_menu.append(&PredefinedMenuItem::separator(app)?)?;
    view_menu.append(&PredefinedMenuItem::fullscreen(app, Some("切换全屏"))?)?;

    // ---- 窗口 ----
    let window_menu = Submenu::with_id(app, "window", "窗口", true)?;
    let preload_menu = Submenu::with_id(app, "preload", "预载数量", true)?;
    let mut preload_items = Vec::new();
    for count in PRELOAD_CHOICES {
        preload_items.push((
            count,
            add_check(
                &preload_menu,
                app,
                &format!("menu:preload:{count}"),
                &count.to_string(),
                saved.preload_count == count,
                None,
            )?,
        ));
    }
    window_menu.append(&preload_menu)?;
    window_menu.append(&PredefinedMenuItem::separator(app)?)?;
    let appearance_menu = Submenu::with_id(app, "appearance", "外观", true)?;
    let mut appearance_items = Vec::new();
    for (mode, label) in APPEARANCES {
        appearance_items.push((
            mode.to_string(),
            add_check(
                &appearance_menu,
                app,
                &format!("menu:appearance:{mode}"),
                label,
                saved.appearance == mode,
                None,
            )?,
        ));
    }
    window_menu.append(&appearance_menu)?;
    window_menu.append(&PredefinedMenuItem::separator(app)?)?;
    let sidebar = add_check(
        &window_menu,
        app,
        "menu:sidebar",
        "显示左侧栏",
        true,
        Some("Shift+CmdOrCtrl+B"),
    )?;
    let right_panel = add_check(
        &window_menu,
        app,
        "menu:rightPanel",
        "显示右侧栏",
        true,
        Some("CmdOrCtrl+B"),
    )?;
    let close_button = add_check(
        &window_menu,
        app,
        "menu:closeButton",
        "显示标签关闭按钮",
        saved.close_button_always_visible,
        None,
    )?;
    window_menu.append(&PredefinedMenuItem::separator(app)?)?;
    add_item(&window_menu, app, "cmd:nextTab", "下一个标签", Some("Control+Tab"))?;
    add_item(&window_menu, app, "cmd:prevTab", "上一个标签", Some("Shift+Control+Tab"))?;
    window_menu.append(&PredefinedMenuItem::separator(app)?)?;
    window_menu.append(&PredefinedMenuItem::minimize(app, Some("最小化"))?)?;
    window_menu.append(&PredefinedMenuItem::bring_all_to_front(app, Some("前置全部窗口"))?)?;

    // ---- 帮助 ----
    let help_menu = Submenu::with_id(app, "help", "帮助", true)?;
    help_menu.append(&PredefinedMenuItem::about(
        app,
        Some("关于 悦读"),
        Some(AboutMetadata::default()),
    )?)?;

    let menu = tauri::menu::Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )?;
    app.set_menu(menu)?;

    let state = MenuState {
        appearance: appearance_items,
        fonts: font_items,
        sizes: size_items,
        preloads: preload_items,
        close_button,
        sidebar,
        right_panel,
        zoom: Mutex::new(1.0),
    };
    app.manage(state);

    // 菜单事件统一分发：命令类透传渲染层，勾选类就地维护后带值透传
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref().to_string();
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
        let menu_state = app.state::<MenuState>();
        match id.as_str() {
            "cmd:closeWindow" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
            "cmd:reload" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("location.reload()");
                }
            }
            #[cfg(any(debug_assertions, feature = "devtools"))]
            "cmd:devtools" => {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_devtools_open() {
                        window.close_devtools();
                    } else {
                        window.open_devtools();
                    }
                }
            }
            "cmd:zoomReset" => {
                if let Some(window) = app.get_webview_window("main") {
                    *menu_state.zoom.lock().unwrap() = 1.0;
                    let _ = window.set_zoom(1.0);
                }
            }
            "cmd:zoomIn" | "cmd:zoomOut" => {
                if let Some(window) = app.get_webview_window("main") {
                    let mut level = menu_state.zoom.lock().unwrap();
                    *level = if id == "cmd:zoomIn" {
                        (*level + 0.1).min(3.0)
                    } else {
                        (*level - 0.1).max(0.5)
                    };
                    let _ = window.set_zoom(*level);
                }
            }
            // 勾选项（sidebar/rightPanel/closeButton）：muda 在点击时已自动翻转勾选态
            // （macOS impl: state.checked = !state.checked + set_checked），这里只读取
            // 翻转后的新状态下发；再手动取反 = 双重翻转，配合 sync_menu_state 回写会
            // 永远原地踏步（潜伏 bug：迁移以来三个勾选项从菜单点击都切不开）。
            "menu:sidebar" => {
                let next = menu_state.sidebar.is_checked().unwrap_or(true);
                send_command(app, "toggleSidebar", Some(json!(next)));
            }
            "menu:rightPanel" => {
                let next = menu_state.right_panel.is_checked().unwrap_or(true);
                send_command(app, "toggleRightPanel", Some(json!(next)));
            }
            "menu:closeButton" => {
                let next = menu_state.close_button.is_checked().unwrap_or(true);
                send_command(app, "toggleCloseButton", Some(json!(next)));
            }
            _ => {
                // 命令与单选组
                if let Some(mode) = id.strip_prefix("menu:appearance:") {
                    menu_state.select_in(&menu_state.appearance, mode);
                    send_command(app, "appearance", Some(json!(mode)));
                } else if let Some(key) = id.strip_prefix("menu:font:") {
                    menu_state.select_in(&menu_state.fonts, key);
                    send_command(app, "readerFont", Some(json!(key)));
                } else if let Some(size) = id.strip_prefix("menu:size:") {
                    if let Ok(value) = size.parse::<i64>() {
                        menu_state.select_in_by_value(&menu_state.sizes, value);
                        send_command(app, "readerFontSize", Some(json!(value)));
                    }
                } else if let Some(count) = id.strip_prefix("menu:preload:") {
                    if let Ok(value) = count.parse::<i64>() {
                        menu_state.select_in_by_value(&menu_state.preloads, value);
                        send_command(app, "preloadCount", Some(json!(value)));
                    }
                } else if let Some(command) = id.strip_prefix("cmd:") {
                    send_command(app, command, None);
                }
            }
        }
    });

    Ok(())
}

/// app:syncMenuState —— 侧栏显隐回写菜单勾选（由 commands/app.rs 调用，需在主线程写）。
pub fn sync_menu_state(app: &AppHandle, sidebar_visible: bool, right_panel_visible: bool) {
    let state = app.state::<MenuState>();
    let _ = state.sidebar.set_checked(sidebar_visible);
    let _ = state.right_panel.set_checked(right_panel_visible);
}

/// 弹出原生右键菜单（必须在主线程调用，由 commands/app.rs 的 run_on_main_thread 保证）。
pub fn popup_context_menu(
    app: &AppHandle,
    request_id: &str,
    items: &[ContextMenuItem],
) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    for entry in items {
        match entry {
            ContextMenuItem::Separator => {
                let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
                menu.append(&sep).map_err(|e| e.to_string())?;
            }
            ContextMenuItem::Predefined { role, label } => {
                let text = label.as_deref();
                let predefined = match role {
                    ContextMenuPredefinedRole::Cut => PredefinedMenuItem::cut(app, text),
                    ContextMenuPredefinedRole::Copy => PredefinedMenuItem::copy(app, text),
                    ContextMenuPredefinedRole::Paste => PredefinedMenuItem::paste(app, text),
                    ContextMenuPredefinedRole::SelectAll => {
                        PredefinedMenuItem::select_all(app, text)
                    }
                }
                .map_err(|e| e.to_string())?;
                menu.append(&predefined).map_err(|e| e.to_string())?;
            }
            ContextMenuItem::Item { id, label, enabled } => {
                let menu_item = MenuItem::with_id(
                    app,
                    format!("ctx:{request_id}:{id}"),
                    label,
                    *enabled,
                    None::<&str>,
                )
                .map_err(|e| e.to_string())?;
                menu.append(&menu_item).map_err(|e| e.to_string())?;
            }
        }
    }
    window.popup_menu(&menu).map_err(|e| e.to_string())
}
