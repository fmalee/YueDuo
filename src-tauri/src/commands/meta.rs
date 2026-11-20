//! meta 域（方案 §2.8 / §2.9）：元数据栏的读/写/评分三链路。
//! 语义对齐 electron/ipc/meta.ts：
//! - applyEdit 只在内存算最小区间替换（渲染层传当前正文，可能是未保存内容），
//!   按写回后正文重解析并同步 books（B1：不等保存），不写文件；
//! - 评分与书名/作者/标签同入口：库内走 books + 文件星级，库外只写文件星级。
//! Finder 注释/星级的 xattr 读写由 P3.3 finder 服务接入（当前 log-skip / 恒 false）。

use tauri::State;

use crate::services::{codec, metadata, metadata_writer};
use crate::state::books;
use crate::state::AppState;
use crate::types::{
    MetadataEditResult, MetadataField, MetadataTextEdit, ParsedMetadata, RatingReadResult,
    RatingWriteResult,
};

fn basename(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn dirname_name(path: &str) -> String {
    std::path::Path::new(path)
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn parse_from(text: &str, path: &str) -> ParsedMetadata {
    metadata::parse_metadata(text, &basename(path), &dirname_name(path))
}

/// meta:read —— 按磁盘正文解析元数据，供元数据栏首屏展示。
/// 文件已在库内时元数据栏优先读库记录，这里只覆盖库外/尚未入库的文件。
#[tauri::command]
pub async fn meta_read(path: String) -> Result<ParsedMetadata, String> {
    if path.is_empty() {
        return Err("缺少文件路径".into());
    }
    let data = std::fs::read(&path).map_err(|e| format!("读取文件失败 {path}: {e}"))?;
    let text = codec::decode_bytes(&data).text;
    Ok(parse_from(&text, &path))
}

/// meta:applyEdit —— 渲染层把编辑器当前正文传进来（可能是未保存内容），主进程只在内存里
/// 算最小替换区间，再按写回后的正文重解析并同步 books（B1：不等保存），不写文件。
#[tauri::command]
pub async fn meta_apply_edit(
    state: State<'_, AppState>,
    path: String,
    text: String,
    field: MetadataField,
    value: String,
) -> Result<MetadataEditResult, String> {
    if path.is_empty() {
        return Err("缺少文件路径".into());
    }
    // tags 的临时 Vec 需要与 fields 同生命周期，先落到局部变量
    let mut tags_holder: Vec<String> = Vec::new();
    let fields = match field {
        MetadataField::Title => metadata_writer::MetadataWriteFields {
            title: Some(&value),
            ..Default::default()
        },
        MetadataField::Author => metadata_writer::MetadataWriteFields {
            author: Some(&value),
            ..Default::default()
        },
        MetadataField::Tags => {
            tags_holder = metadata::split_tags(&value);
            metadata_writer::MetadataWriteFields {
                tags: Some(tags_holder.as_slice()),
                ..Default::default()
            }
        }
    };
    let edit: Option<MetadataTextEdit> = metadata_writer::rewrite_header(&text, &fields);
    let next_text = match &edit {
        Some(e) => metadata_writer::apply_text_edit(&text, e),
        None => text,
    };
    let parsed = parse_from(&next_text, &path);

    // 库内命中即同步 books（不读盘）；库外/未入库 updated=false（打开任意 txt 不报错）
    let mut updated = false;
    let root = state.active_root();
    if !root.is_empty() {
        if let Some(relative) = books::relative_in_library(&root, &path) {
            updated = state
                .with_active_db(|db, _| {
                    books::update_book_metadata(
                        db,
                        &relative,
                        &parsed.title,
                        &parsed.author,
                        &parsed.tags.join(" "),
                    )
                })?
                .unwrap_or(false);
        }
    }
    // 主题写回后同步 Finder 注释（方案 §2.10）——P3.3 finder 服务接入，此处仅提示
    if matches!(field, MetadataField::Tags) {
        eprintln!("[meta] Finder 注释同步待 P3.3（finder 服务）接入");
    }
    Ok(MetadataEditResult {
        edit,
        updated,
        metadata: parsed,
    })
}

/// meta:readRating —— 库内取 books.rating（与文件星级保持同步），库外取文件 Finder 星级。
#[tauri::command]
pub async fn meta_read_rating(
    state: State<'_, AppState>,
    path: String,
) -> Result<RatingReadResult, String> {
    if path.is_empty() {
        return Err("缺少文件路径".into());
    }
    let root = state.active_root();
    if !root.is_empty() {
        if let Some(relative) = books::relative_in_library(&root, &path) {
            let book = state
                .with_active_db(|db, _| {
                    books::find_book_by_relative_path(db, &root, &relative)
                })?
                .unwrap_or(None);
            if let Some(book) = book {
                return Ok(RatingReadResult {
                    rating: book.rating,
                    in_library: true,
                });
            }
        }
    }
    // 库外没有 books 行 → 取文件 Finder 星级（P3.3 接入 xattr 前恒 0）
    Ok(RatingReadResult {
        rating: 0,
        in_library: false,
    })
}

/// meta:applyRating —— 库内走 books + 文件星级；库外只写文件 Finder 星级，
/// persisted=false 时渲染层必须回退，不能让点击看起来成功却在重开后消失。
#[tauri::command]
pub async fn meta_apply_rating(
    state: State<'_, AppState>,
    path: String,
    rating: f64,
) -> Result<RatingWriteResult, String> {
    if path.is_empty() {
        return Err("缺少文件路径".into());
    }
    // 对齐 Math.min(5, Math.max(0, Math.round(Number(rating) || 0)))
    let value = if rating.is_finite() {
        rating.round() as i64
    } else {
        0
    }
    .clamp(0, 5);
    let root = state.active_root();
    if !root.is_empty() {
        if let Some(relative) = books::relative_in_library(&root, &path) {
            let book = state
                .with_active_db(|db, _| {
                    books::find_book_by_relative_path(db, &root, &relative)
                })?
                .unwrap_or(None);
            if let Some(book) = book {
                let (written, file_relative) = state
                    .with_active_db(|db, _| books::set_book_rating(db, book.id, value))?
                    .ok_or_else(|| "尚未打开书库".to_string())?;
                // 文件星级 xattr 写入由 P3.3 finder 服务接入（当前仅库内评分生效）
                let _ = file_relative;
                return Ok(RatingWriteResult {
                    rating: written,
                    in_library: true,
                    persisted: true,
                });
            }
        }
    }
    // 库外没有 books 行，只写文件 Finder 星级（P3.3 接入前恒 persisted=false → 渲染层回退）
    Ok(RatingWriteResult {
        rating: value,
        in_library: false,
        persisted: false,
    })
}
