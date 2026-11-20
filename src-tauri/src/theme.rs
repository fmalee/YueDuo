//! 主题三态应用与推送（对齐 electron/ipc/theme.ts）。
//!
//! WKWebView 与 Chromium 的差异：Electron 的 nativeTheme.themeSource 会连带改写渲染层的
//! prefers-color-scheme，而 WKWebView 的 prefers-color-scheme 只跟随 NSWindow appearance
//! （默认 aqua=浅色，即使系统是深色）。因此这里必须显式 window.set_theme()：
//! - light / dark：锁定窗口外观；
//! - system：set_theme(None) 恢复跟随系统，系统切换经 WindowEvent::ThemeChanged 推送。
//! 前端 stores/settings.ts 的 matchMedia 判断与 theme:updated 订阅因此无需改动。

use tauri::{AppHandle, Emitter, Manager, Theme};

/// 按设置外观设置窗口主题，返回当前生效的 dark。
/// 失败只返回 Err（不 emit），调用方决定是否阻断。
pub fn apply_window_theme(app: &AppHandle, appearance: &str) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("主窗口不存在，无法设置主题")?;
    let theme = match appearance {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        "system" => None,
        other => return Err(format!("未知外观值: {other}")),
    };
    window.set_theme(theme).map_err(|e| format!("设置主题失败: {e}"))?;
    Ok(match theme {
        Some(Theme::Dark) => true,
        Some(Theme::Light) => false,
        // 跟随系统：读窗口当前生效外观
        _ => window
            .theme()
            .map(|t| matches!(t, Theme::Dark))
            .unwrap_or(false),
    })
}

/// 向渲染层推送 theme:updated（权威 dark 值）。
pub fn emit_theme_updated(app: &AppHandle, dark: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("theme:updated", serde_json::json!({ "dark": dark }));
    }
}
