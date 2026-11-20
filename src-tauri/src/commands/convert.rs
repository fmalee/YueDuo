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

#[tauri::command]
pub async fn convert_tidy(app: AppHandle, text: String) -> Result<TidyResult, String> {
    let dict_dir = resolve_dict_dir(&app)?;
    service::tidy(&text, &dict_dir)
}
