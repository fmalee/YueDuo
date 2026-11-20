//! 悦读后端核心库（纯 Rust，替代 Electron 主进程）。
//! Vue + Monaco 前端原样保留，IPC 出口为按域 typed commands（`src/ipc/bridge.ts` 直调）。
//!
//! 铁律（AGENTS.md）：
//! - command 一律 async（跑在 tokio 线程池）：blocking 对话框/长任务绝不落在主线程。
//! - 业务写在 state/ 与 services/，commands/ 只收敛参数与返回。
//! - 命令错误统一 `Result<T, String>`，前端 bridge 转成异常。

pub mod commands;
pub mod services;
pub mod shell;
pub mod state;
pub mod theme;
pub mod types;

use tauri::{Manager, RunEvent, Theme, WindowEvent};

/// Tauri 应用入口（供 main.rs 调用）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 数据目录：优先 YUE_USER_DATA（自动化验收隔离），否则 app_data_dir。
            let user_data = match std::env::var("YUE_USER_DATA") {
                Ok(dir) if !dir.trim().is_empty() => std::path::PathBuf::from(dir),
                _ => app
                    .path()
                    .app_data_dir()
                    .map_err(|e| format!("无法定位应用数据目录: {e}"))?,
            };
            // Electron 版数据一次性搬家（settings.json + library-db 回落库），幂等。
            state::migrate_electron_user_data(&user_data)?;
            let state = state::AppState::new(user_data)?;
            // 主题先于首帧生效：设置窗口 appearance，前端首帧 matchMedia 即反映正确值。
            // 失败不阻断启动（渲染层回落浅色）。
            let _ = theme::apply_window_theme(app.handle(), &state.settings_get()?.appearance);
            app.manage(state);
            // 原生中文菜单（单选组取启动落盘值；点击经 app:menuCommand 交渲染层分发）
            shell::install_menu(app.handle()).map_err(|e| format!("菜单安装失败: {e}"))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::app::app_sync_menu_state,
            commands::library::library_current,
            commands::library::library_open,
            commands::library::library_activate,
            commands::library::library_abort,
            commands::library::library_fast_scan,
            commands::library::library_enrich,
            commands::library::library_history,
            commands::library::library_all_books,
            commands::library::library_following,
            commands::library::library_tags,
            commands::library::library_books_by_tag,
            commands::library::library_rated,
            commands::library::library_set_tag_rating,
            commands::library::library_mark_read,
            commands::library::library_book_by_path,
            commands::library::library_set_book_rating,
            commands::library::library_sync_metadata,
            commands::library::library_chapters,
            commands::library::library_bookmarks,
            commands::library::library_add_bookmark,
            commands::library::library_remove_bookmark,
            commands::library::library_all_bookmarks,
            commands::library::library_replace_bookmarks,
            commands::file::file_read_text,
            commands::file::file_stat,
            commands::file::file_write_text,
            commands::file::file_rename,
            commands::file::file_trash,
            commands::file::file_reveal,
            commands::file::file_write_draft,
            commands::file::file_read_draft,
            commands::file::file_clear_draft,
            commands::dialog::dialog_open_file,
            commands::dialog::dialog_save_file,
            commands::dialog::dialog_choose_library,
            commands::dialog::dialog_confirm_close,
            commands::dialog::dialog_confirm_trash,
            commands::dialog::dialog_show_error,
            commands::session::session_persist,
            commands::session::session_restore,
            commands::session::session_relocate,
            commands::session::session_flush_done,
            commands::convert::convert_to_halfwidth,
            commands::convert::convert_to_simplified,
            commands::convert::convert_to_traditional,
            commands::convert::convert_tidy,
        ])
        .build(tauri::generate_context!())
        .expect("悦读启动失败")
        .run(|app, event| {
            match event {
                // 外观=system 时窗口外观随系统变化，推送权威值给渲染层
                // （light/dark 锁定后系统切换不会触发 ThemeChanged，无需过滤抖动）。
                RunEvent::WindowEvent {
                    event: WindowEvent::ThemeChanged(theme),
                    ..
                } => {
                    if let Some(state) = app.try_state::<state::AppState>() {
                        let is_system = state
                            .settings_get()
                            .map(|s| s.appearance == "system")
                            .unwrap_or(false);
                        if is_system {
                            theme::emit_theme_updated(app, matches!(theme, Theme::Dark));
                        }
                    }
                }
                // 退出前关库：WAL checkpoint 落盘，避免残留 -wal/-shm。
                RunEvent::Exit => {
                    if let Some(state) = app.try_state::<state::AppState>() {
                        state.shutdown();
                    }
                }
                _ => {}
            }
        });
}
