//! app 域：app:syncMenuState（侧栏显隐回写菜单勾选）与 app_popup_menu（原生右键弹出菜单）。
//! AppHandle 是注入参数（不占前端 arg key）；
//! 菜单项写操作与弹出操作经 run_on_main_thread 回主线程执行（muda 要求主线程）。

use tauri::AppHandle;

use crate::types::{AppMenuState, ContextMenuItem};

#[tauri::command]
pub async fn app_sync_menu_state(app: AppHandle, state: AppMenuState) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        crate::shell::sync_menu_state(&handle, state.sidebar_visible, state.right_panel_visible);
    })
    .map_err(|e| e.to_string())
}

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
