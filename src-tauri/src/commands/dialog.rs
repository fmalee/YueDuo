//! dialog 域：原生对话框（tauri-plugin-dialog）。
//! 铁律：async command 跑在 tokio 线程池（非主线程），blocking_* 不会造成
//! 「主线程自己等自己」的死锁（首次迁移踩坑 6）；消息框用 blocking_show_with_result
//! 拿完整结果（自定义按钮文案随结果返回）。

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

/// 开发环境书库确认（对齐 ipc/library.ts confirmDevLibraryRoot）：
/// 只默认使用测试库；打开其它路径（很可能正是正式书库）先确认——
/// 扫描 enrich 会写 Finder 星级与注释，开发调试不应无声改动正式数据。
const DEV_LIBRARY_ROOT: &str = "/Users/Joey/Sites/Projects/小说";

fn filepath_to_string(file: FilePath) -> Option<String> {
    file.into_path().ok().map(|p| p.to_string_lossy().to_string())
}

fn pick_file(app: &AppHandle, save: bool, default_name: Option<&str>) -> Option<String> {
    let builder = app.dialog().file().add_filter("文本文件", &["txt"]);
    let builder = match default_name {
        Some(name) => builder.set_file_name(name),
        None => builder,
    };
    let picked = if save {
        builder.blocking_save_file()
    } else {
        builder.blocking_pick_file()
    };
    picked.and_then(filepath_to_string)
}

/// dialog:openFile —— 「文件 → 打开…」选择要打开的文本文件（None = 取消）
#[tauri::command]
pub async fn dialog_open_file(app: AppHandle) -> Result<Option<String>, String> {
    Ok(pick_file(&app, false, None))
}

/// dialog:saveFile —— 空白标签首次保存时选择落盘路径（None = 取消）
#[tauri::command]
pub async fn dialog_save_file(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let default = if name.to_lowercase().ends_with(".txt") {
        name
    } else {
        format!("{name}.txt")
    };
    Ok(pick_file(&app, true, Some(&default)))
}

/// dialog:chooseLibrary —— 选择书库根目录（None = 取消）
#[tauri::command]
pub async fn dialog_choose_library(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked.and_then(filepath_to_string))
}

fn show_message(
    app: &AppHandle,
    kind: MessageDialogKind,
    title: &str,
    message: &str,
    detail: &str,
    buttons: MessageDialogButtons,
) -> MessageDialogResult {
    // 插件消息框只有单文本位：detail 拼进正文（对齐 Electron message+detail 视觉）
    let text = if detail.is_empty() {
        message.to_string()
    } else {
        format!("{message}\n\n{detail}")
    };
    app.dialog()
        .message(text)
        .title(title)
        .kind(kind)
        .buttons(buttons)
        .blocking_show_with_result()
}

/// 插件在所有平台都把原生按钮结果映射为 `Custom(按钮文案)`（desktop.rs 统一转换，
/// macOS 上 rfd 返回 Yes/No/Cancel 也不例外）。按文案判定；Yes/No/Ok 原始值兜底
/// （rfd 行为可能随版本变化）。
fn result_is(result: &MessageDialogResult, text: &str, native_yes_ok: bool) -> bool {
    match result {
        MessageDialogResult::Custom(s) => s == text,
        MessageDialogResult::Ok | MessageDialogResult::Yes => native_yes_ok,
        _ => false,
    }
}

/// dialog:confirmClose —— dirty 标签关闭前三选一（中文三按钮；YesNoCancelCustom 原生支持）
#[tauri::command]
pub async fn dialog_confirm_close(app: AppHandle, title: String) -> Result<String, String> {
    let result = show_message(
        &app,
        MessageDialogKind::Info,
        "未保存的更改",
        &format!("「{title}」有未保存的更改"),
        "关闭前是否保存？",
        MessageDialogButtons::YesNoCancelCustom("保存".into(), "放弃更改".into(), "取消".into()),
    );
    Ok(if result_is(&result, "保存", true) {
        "save"
    } else if result_is(&result, "放弃更改", false) {
        "discard"
    } else {
        "cancel"
    }
    .to_string())
}

/// dialog:confirmTrash —— 删除标签文件前确认（默认按钮是取消，防误删）。
/// 自动化验收：YUE_TEST 下窗口不可见，模态框会卡住流程，直接放行。
#[tauri::command]
pub async fn dialog_confirm_trash(
    app: AppHandle,
    title: String,
    dirty: bool,
) -> Result<bool, String> {
    if std::env::var("YUE_TEST").is_ok() {
        return Ok(true);
    }
    let result = show_message(
        &app,
        MessageDialogKind::Warning,
        "移到废纸篓",
        &format!("将「{title}」移到废纸篓？"),
        if dirty {
            "未保存的修改也会一并丢弃。"
        } else {
            "文件会移到废纸篓，库内记录与书签一并删除。"
        },
        MessageDialogButtons::OkCancelCustom("移到废纸篓".into(), "取消".into()),
    );
    Ok(result_is(&result, "移到废纸篓", true))
}

/// dialog:showError —— 文件操作失败的可见提示
#[tauri::command]
pub async fn dialog_show_error(
    app: AppHandle,
    title: String,
    message: String,
) -> Result<(), String> {
    show_message(
        &app,
        MessageDialogKind::Error,
        &title,
        &title,
        &message,
        MessageDialogButtons::OkCustom("好".into()),
    );
    Ok(())
}

/// 开发环境书库确认：debug 构建且非自动化验收时，打开测试库以外的书库先弹确认。
pub async fn confirm_dev_library(app: &AppHandle, root: &str) -> Result<bool, String> {
    if !cfg!(debug_assertions) || std::env::var("YUE_TEST").is_ok() {
        return Ok(true);
    }
    let requested = std::fs::canonicalize(root).unwrap_or_else(|_| root.into());
    let dev_root =
        std::fs::canonicalize(DEV_LIBRARY_ROOT).unwrap_or_else(|_| DEV_LIBRARY_ROOT.into());
    if requested == dev_root {
        return Ok(true);
    }
    let result = show_message(
        app,
        MessageDialogKind::Warning,
        "开发环境书库确认",
        &format!("确定要在开发环境打开「{root}」吗？"),
        &format!(
            "开发环境默认只使用测试书库：{DEV_LIBRARY_ROOT}。\n扫描会写入 Finder 星级和注释；如果这是正式书库，这些数据会被开发调试改动。"
        ),
        MessageDialogButtons::OkCancelCustom("仍然打开".into(), "取消".into()),
    );
    Ok(result_is(&result, "仍然打开", true))
}
