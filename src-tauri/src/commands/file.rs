//! file 域：文本读写、文件身份、改名/删除/定位、草稿（P1 readText/stat/writeText + P2 收尾）。
//! readText 走 tauri::ipc::Response 二进制帧：绕开 JSON 序列化大文本（CJK 在 JSON
//! 里 UTF-8 3 字节/字 vs UTF-16 2 字节/字，且省掉两侧 JSON parse/serialize 全量拷贝），
//! 这是启动恢复大书速度的关键优化（首次迁移已诊断）。

use std::path::{Path, PathBuf};

use tauri::ipc::Response;
use tauri::State;

use crate::services::files;
use crate::state::books;
use crate::state::session as session_store;
use crate::state::AppState;
use crate::types::{
    DraftEntry, DraftTabMeta, FileReadMeta, FileRenameResult, FileStat, FileTrashResult,
    FileWriteResult,
};

#[tauri::command]
pub async fn file_read_text(path: String) -> Result<Response, String> {
    let outcome = files::read_text(Path::new(&path))?;
    let stat = files::stat_of(Path::new(&path))?;
    let meta = serde_json::to_vec(&FileReadMeta {
        encoding: outcome.encoding,
        stat,
    })
    .map_err(|e| e.to_string())?;
    let mut payload = Vec::with_capacity(4 + meta.len() + outcome.text.len() * 2);
    payload.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    payload.extend_from_slice(&meta);
    for unit in outcome.text.encode_utf16() {
        payload.extend_from_slice(&unit.to_le_bytes());
    }
    Ok(Response::new(payload))
}

/// file:readChunk —— 大文件并行分块读（性能专项）。WKWebView 自定义协议单响应编组
/// 实测 ~13MB/s（串行），多请求走独立编组管线并行后 ~30MB/s；再叠 zstd L3 压缩
/// （UTF-16 中文 ~25-30%），等效吞吐再乘 ~3。返回原始文件字节（zstd 压缩），
/// 解码在前端 TextDecoder 完成（与主进程同款探测链选编码）。
/// 帧格式：[u32 LE headerLen][header JSON][zstd(原始字节)]；chunk 0 的 header 含
/// encoding/size/compressed。
#[tauri::command]
pub async fn file_read_chunk(path: String, offset: u64, len: u32) -> Result<Response, String> {
    use std::fs;
    use std::io::{Read, Seek, SeekFrom, Write};
    let mut f = fs::File::open(&path).map_err(|e| format!("读取文件失败 {path}: {e}"))?;
    let size = f
        .metadata()
        .map_err(|e| format!("读取文件信息失败 {path}: {e}"))?
        .len();
    let start = offset.min(size);
    let end = (start + len as u64).min(size);
    f.seek(SeekFrom::Start(start))
        .map_err(|e| format!("文件定位失败 {path}: {e}"))?;
    let mut buf = vec![0u8; (end - start) as usize];
    f.read_exact(&mut buf)
        .map_err(|e| format!("读取文件失败 {path}: {e}"))?;
    // gzip L1（fast）：实测 UTF-16 中文 ~52%，miniz_oxide L1 压缩快、并行摊薄；
    // 前端 DecompressionStream('gzip') 原生解压 ~1GB/s
    let mut enc = flate2::write::GzEncoder::new(
        Vec::with_capacity(buf.len() / 2),
        flate2::Compression::fast(),
    );
    enc.write_all(&buf)
        .map_err(|e| format!("压缩失败: {e}"))?;
    let compressed = enc
        .finish()
        .map_err(|e| format!("压缩收尾失败: {e}"))?;
    let header = if offset == 0 {
        serde_json::json!({
            "encoding": crate::services::codec::detect_encoding(&buf),
            "size": size,
            "compressed": true,
        })
    } else {
        serde_json::json!({"compressed": true})
    };
    let meta = serde_json::to_vec(&header).map_err(|e| e.to_string())?;
    let mut payload = Vec::with_capacity(4 + meta.len() + compressed.len());
    payload.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    payload.extend_from_slice(&meta);
    payload.extend_from_slice(&compressed);
    Ok(Response::new(payload))
}

#[tauri::command]
pub async fn file_stat(path: String) -> Result<FileStat, String> {
    files::stat_of(Path::new(&path))
}

#[tauri::command]
pub async fn file_write_text(path: String, text: String) -> Result<FileWriteResult, String> {
    let stat = files::write_text(Path::new(&path), &text)?;
    // 保存后按正文前十行「主题」同步 Finder 注释（方案 §2.10）：无主题/相同内容由 service 跳过；
    // xattr 已写入但 Finder 同步失败只降级为 written，不阻塞保存主流程
    let topic = crate::services::metadata::find_topic(&text);
    crate::services::finder::write_comment(
        &path,
        topic.as_deref(),
        crate::services::finder::sync_finder_comment_via_osascript,
    );
    Ok(FileWriteResult { stat })
}

// ---------- 改名 / 删除 / 定位（方案 §3.5） ----------

/// file:rename —— 重命名当前标签的文件：
/// 只在原目录改名、自动补 .txt；改名成功后同步 books 身份（relative_path/filename），
/// id 不变，书签/评分/进度全保留；库身份同步失败只记日志交给对账，不反报改名失败。
#[tauri::command]
pub async fn file_rename(
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<FileRenameResult, String> {
    if path.is_empty() {
        return Err("当前标签没有可重命名的文件".into());
    }
    let name = new_name.trim();
    if name.is_empty() {
        return Err("文件名不能为空".into());
    }
    if name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err("文件名不能包含路径分隔符".into());
    }
    let mut name = name.to_string();
    if !name.to_lowercase().ends_with(".txt") {
        name.push_str(".txt");
    }
    let source = Path::new(&path);
    let new_path = source
        .parent()
        .map(|dir| dir.join(&name))
        .ok_or("目标路径无父目录")?;
    let new_path_str = new_path.to_string_lossy().to_string();
    if new_path_str == path {
        let stat = files::stat_of(source)?;
        let title = source
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        return Ok(FileRenameResult { path, title, stat });
    }
    if new_path.exists() {
        return Err(format!("「{name}」已存在"));
    }

    // 改名后旧路径不复存在，库内相对路径必须在 rename 前取
    let root = state.active_root();
    let old_relative = books::relative_in_library(&root, &path);

    std::fs::rename(source, &new_path).map_err(|e| format!("改名失败: {e}"))?;
    let stat = files::stat_of(&new_path)?;

    if let Some(old_relative) = old_relative {
        if let Some(new_relative) = books::relative_in_library(&root, &new_path_str) {
            // 文件已改名成功；库身份同步失败交给下次扫描对账修复，不能反过来报改名失败
            state.with_active_db(|db, _| {
                if let Err(e) = books::rename_book_record(db, &old_relative, &new_relative, &name) {
                    eprintln!("[file] 重命名后同步库身份失败: {e}");
                }
                Ok::<(), String>(())
            })?;
        }
    }
    Ok(FileRenameResult {
        path: new_path_str,
        title: name,
        stat,
    })
}

/// file:move —— 移动标签文件到书库内其它目录（含库根，文件名不变）：
/// 目标目录必须在书库内（库外文件无法维持 books 身份）；移动成功后同步 books 身份
/// （relative_path 更新、id 不变，书签/评分/进度全保留）；同步失败只记日志交给对账。
#[tauri::command]
pub async fn file_move(
    state: State<'_, AppState>,
    path: String,
    dest_dir: String,
) -> Result<FileRenameResult, String> {
    if path.is_empty() {
        return Err("当前标签没有可移动的文件".into());
    }
    let source = Path::new(&path);
    if !source.is_file() {
        return Err("源文件不存在".into());
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or("源路径无文件名")?;
    let dest = Path::new(&dest_dir);
    if !dest.is_dir() {
        return Err("目标目录不存在".into());
    }
    let new_path = dest.join(&name);
    let new_path_str = new_path.to_string_lossy().to_string();
    if new_path_str == path {
        // 已在目标目录：视为成功不做磁盘动作（与 rename 同路径语义一致）
        let stat = files::stat_of(source)?;
        return Ok(FileRenameResult {
            path,
            title: name,
            stat,
        });
    }
    if new_path.exists() {
        return Err(format!("目标目录已有「{name}」"));
    }
    // 目标必须落在书库内：相对路径是库身份的锚点，库外目录直接拒绝
    let root = state.active_root();
    let canonical_root = std::fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
    let canonical_dest =
        std::fs::canonicalize(dest).map_err(|e| format!("目标目录不可用: {e}"))?;
    if !canonical_dest.starts_with(&canonical_root) {
        return Err("目标目录必须在书库内".into());
    }

    // 移动后旧路径不复存在，库内相对路径必须在 move 前取
    let old_relative = books::relative_in_library(&root, &path);

    std::fs::rename(source, &new_path).map_err(|e| format!("移动失败: {e}"))?;
    let stat = files::stat_of(&new_path)?;

    if let Some(old_relative) = old_relative {
        if let Some(new_relative) = books::relative_in_library(&root, &new_path_str) {
            // 文件已移动成功；库身份同步失败交给下次扫描对账修复，不能反过来报移动失败
            state.with_active_db(|db, _| {
                if let Err(e) = books::rename_book_record(db, &old_relative, &new_relative, &name) {
                    eprintln!("[file] 移动后同步库身份失败: {e}");
                }
                Ok::<(), String>(())
            })?;
        }
    }
    Ok(FileRenameResult {
        path: new_path_str,
        title: name,
        stat,
    })
}

/// file:trash —— 移到废纸篓：先取库内相对路径再 trash；成功后删 books 行（书签随 CASCADE）。
/// 库记录清理失败只记日志，磁盘操作已成功，下次扫描对账会补齐。
#[tauri::command]
pub async fn file_trash(
    state: State<'_, AppState>,
    path: String,
) -> Result<FileTrashResult, String> {
    if path.is_empty() {
        return Err("当前标签没有可删除的文件".into());
    }
    let root = state.active_root();
    let relative_path = books::relative_in_library(&root, &path);
    trash::delete(&path).map_err(|e| format!("移入废纸篓失败: {e}"))?;
    let mut removed_book = false;
    if let Some(relative_path) = relative_path {
        match state.with_active_db(|db, _| books::delete_book_record(db, &relative_path)) {
            Ok(Some(removed)) => removed_book = removed,
            Ok(None) => {}
            Err(e) => eprintln!("[file] 移入废纸篓后清理库记录失败: {e}"),
        }
    }
    Ok(FileTrashResult { removed_book })
}

/// file:reveal —— 在 Finder 中显示文件（macOS `open -R`；打包后仅 macOS 目标）
#[tauri::command]
pub async fn file_reveal(path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("当前标签没有可显示的文件".into());
    }
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Finder 定位失败: {e}"))?;
    Ok(())
}

// ---------- 草稿（LRU 卸载与退出补写，方案 §1.7 / §1.8） ----------
// 只写 draft/view_state 两列，其余列归 session:persist，互不覆盖

#[tauri::command]
pub async fn file_write_draft(
    state: State<'_, AppState>,
    tab_id: String,
    text: Option<String>,
    view_state: serde_json::Value,
    meta: Option<DraftTabMeta>,
) -> Result<(), String> {
    state
        .with_active_db(|db, root| {
            session_store::write_draft(db, &tab_id, text.as_deref(), &view_state, meta.as_ref(), root)
        })?;
    Ok(())
}

#[tauri::command]
pub async fn file_read_draft(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Option<DraftEntry>, String> {
    Ok(match state.with_active_db(|db, _| session_store::read_draft(db, &tab_id))? {
        Some(entry) => entry,
        None => None,
    })
}

#[tauri::command]
pub async fn file_clear_draft(state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    state
        .with_active_db(|db, _| session_store::clear_draft(db, &tab_id))?;
    Ok(())
}
