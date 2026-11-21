//! meta 域（方案 §2.8 / §2.9）：元数据栏的读/写/评分三链路。
//! 语义对齐 electron/ipc/meta.ts：
//! - applyEdit 只在内存算最小区间替换（渲染层传当前正文，可能是未保存内容），
//!   按写回后正文重解析并同步 books（B1：不等保存），不写文件；
//! - 评分与书名/作者/标签同入口：库内走 books + 文件星级，库外只写文件星级。
//! Finder 注释/星级的 xattr 读写由 P3.3 finder 服务接入（当前 log-skip / 恒 false）。

use tauri::State;

use crate::services::{codec, finder, metadata, metadata_writer};
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
    // tags 的临时 Vec 需要与 fields 同生命周期，先声明后赋值（避免多余初始化）
    let tags_holder: Vec<String>;
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
    // 主题写回后同步 Finder 注释（方案 §2.10）：无主题与「旧注释相同」都由 service 跳过
    if matches!(field, MetadataField::Tags) {
        let topic = metadata::find_topic(&next_text);
        finder::write_comment(&path, topic.as_deref(), finder::sync_finder_comment_via_osascript);
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
    if let Some(book) = state.find_book_by_abs_path(&path)? {
        return Ok(RatingReadResult {
            rating: book.rating,
            in_library: true,
        });
    }
    // 库外没有 books 行 → 取文件 Finder 星级（读取失败按 0，对齐 Python finder_metadata）
    let rating = finder::read_rating(&path).unwrap_or(0);
    Ok(RatingReadResult {
        rating,
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
            // 查书 + 写评分单次拿锁完成（原先查、写各拿一次锁）
            let outcome = state
                .with_active_db(|db, root| {
                    let Some(book) = books::find_book_by_relative_path(db, root, &relative)? else {
                        return Ok(None);
                    };
                    books::set_book_rating(db, book.id, value).map(Some)
                })?
                .unwrap_or(None);
            if let Some((written, file_relative)) = outcome {
                // 文件星级 xattr：写失败静默，不影响库内评分（对齐原版）
                if let Some(file_relative) = file_relative {
                    let absolute = format!("{root}/{file_relative}");
                    finder::write_rating(&absolute, written);
                }
                return Ok(RatingWriteResult {
                    rating: written,
                    in_library: true,
                    persisted: true,
                });
            }
        }
    }
    // 库外没有 books 行，只写文件 Finder 星级；persisted=false 时渲染层必须回退
    let persisted = finder::write_rating(&path, value);
    Ok(RatingWriteResult {
        rating: value,
        in_library: false,
        persisted,
    })
}
