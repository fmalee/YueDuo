//! convert 域（方案 §3.2）：右键「转换」组与一键整理共用。
//! 选区/整文范围由渲染层决定，这里只做纯文本进出；可撤销由编辑器侧保证。
//! 词表目录解析：打包走 resource_dir/dicts（bundle.resources 映射），开发走仓库根
//! resources/dicts（CARGO_MANIFEST_DIR 编译期注入，无需运行时探测）。

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::services::convert as service;
use crate::types::{ConvertResult, TidyResult};

/// 词表目录：resource_dir/dicts 优先（打包），回落仓库根（开发）。两处都缺失才报错。
fn resolve_dict_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("dicts"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/dicts"),
    );
    for dir in &candidates {
        if dir.join("st_characters.txt").is_file() {
            return Ok(dir.clone());
        }
    }
    Err(format!(
        "缺少简繁转换词表，尝试过：{}",
        candidates
            .iter()
            .map(|d| d.display().to_string())
            .collect::<Vec<_>>()
            .join("、")
    ))
}

#[tauri::command]
pub async fn convert_to_halfwidth(text: String) -> Result<ConvertResult, String> {
    service::to_halfwidth(&text)
}

#[tauri::command]
pub async fn convert_to_simplified(app: AppHandle, text: String) -> Result<ConvertResult, String> {
    let dict_dir = resolve_dict_dir(&app)?;
    service::to_simplified(&text, &dict_dir)
}

#[tauri::command]
pub async fn convert_to_traditional(
    app: AppHandle,
    text: String,
) -> Result<ConvertResult, String> {
    let dict_dir = resolve_dict_dir(&app)?;
    service::to_traditional(&text, &dict_dir)
}

/// 一键整理：原始字节通道（大文书的主要 IPC 成本在 ~20MB 全文 JSON 序列化/解析）。
/// 前端 invoke(cmd, Uint8Array) → InvokeBody::Raw；返回值只含变更行编辑列表（小 JSON）。
#[tauri::command]
pub async fn convert_tidy(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<TidyResult, String> {
    let text = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            // TextEncoder 保证合法 UTF-8，lossy 对合法输入零拷贝借用
            String::from_utf8_lossy(bytes).into_owned()
        }
        // 兼容回落：HMR 过渡期旧前端仍可能发 { text } JSON（dev 下编译期常量不变但模块未整页刷新）
        tauri::ipc::InvokeBody::Json(value) => value
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| "一键整理需要原始字节载荷（Uint8Array）或 { text } JSON".to_string())?,
    };
    let dict_dir = resolve_dict_dir(&app)?;
    // 纯 CPU 流水线放 blocking 线程，避免占死 async 池
    tauri::async_runtime::spawn_blocking(move || service::tidy(&text, &dict_dir))
        .await
        .map_err(|e| format!("整理任务失败: {e}"))?
}
