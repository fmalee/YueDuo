//! settings 域：settings:get / settings:set（读写 app_data_dir/settings.json）。
//! set 落盘后同步窗口主题（appearance 三态）并推送 theme:updated 权威值。

use tauri::{AppHandle, State};

use crate::state::AppState;
use crate::types::AppSettings;

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.settings_get()
}

#[tauri::command]
pub async fn settings_set(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let saved = state.settings_set(settings)?;
    // 外观变化时窗口 appearance 与渲染层 token 一起切（apply 失败不影响设置已落盘）
    if let Ok(dark) = crate::theme::apply_window_theme(&app, &saved.appearance) {
        crate::theme::emit_theme_updated(&app, dark);
    }
    Ok(saved)
}
