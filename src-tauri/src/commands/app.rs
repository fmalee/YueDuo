//! app 域：app:syncMenuState —— 渲染层侧栏显隐回写菜单勾选。
//! AppHandle 是注入参数（不占前端 arg key），`state` 形参对应前端 { state: {...} }；
//! 菜单项写操作经 run_on_main_thread 回主线程执行（muda 要求主线程）。

use tauri::AppHandle;

use crate::types::AppMenuState;

#[tauri::command]
pub async fn app_sync_menu_state(app: AppHandle, state: AppMenuState) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        crate::shell::sync_menu_state(&handle, state.sidebar_visible, state.right_panel_visible);
    })
    .map_err(|e| e.to_string())
}
