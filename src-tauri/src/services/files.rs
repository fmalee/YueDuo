//! 文件读写：read_text / stat / write_text（对齐 electron/ipc/file.ts 的纯文件部分）。
//! 保存先写临时文件再 rename 原子替换（Python 同款语义）；保存后 inode 已变，
//! 必须由调用方用返回的 stat 刷新缓存。
//! rename/trash 与 Finder 注释同步已接入：见 commands/file.rs 与 services/finder.rs。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::services::codec::{decode_bytes, encode_for_write};
use crate::types::FileStat;

pub struct ReadTextOutcome {
    pub text: String,
    pub encoding: String,
}

/// 文件身份（同文件去重依据：dev+ino 优先，realPath 兜底）
pub fn stat_of(path: &Path) -> Result<FileStat, String> {
    use std::os::unix::fs::MetadataExt;
    let md = fs::metadata(path).map_err(|e| format!("读取文件信息失败 {}: {e}", path.display()))?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let real_path = fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string_lossy().to_string());
    Ok(FileStat {
        dev: md.dev() as i64,
        ino: md.ino() as i64,
        size: md.len() as i64,
        mtime_ms: mtime,
        real_path,
    })
}

/// file:readText —— 读文本（探测+解码+换行归一）
pub fn read_text(path: &Path) -> Result<ReadTextOutcome, String> {
    let data = fs::read(path).map_err(|e| format!("读取文件失败 {}: {e}", path.display()))?;
    let out = decode_bytes(&data);
    Ok(ReadTextOutcome {
        text: out.text,
        encoding: out.encoding,
    })
}

fn tmp_path(dir: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    dir.join(format!(".{}-{nanos}.yueduo-tmp", std::process::id()))
}

/// file:writeText —— 保存（UTF-16LE + 临时文件写 + rename 原子替换）。
/// 临时文件与目标同盘（同目录写失败时退系统 tmp 走复制语义，对齐 TS 版降级路径）；
/// 中断不破坏原文件。
pub fn write_text(path: &Path, text: &str) -> Result<FileStat, String> {
    let data = encode_for_write(text);
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("目标路径无父目录: {}", path.display()))?
        .to_path_buf();
    let tmp = tmp_path(&dir);
    match fs::write(&tmp, &data) {
        Ok(()) => {
            // unix rename 原子替换既有目标
            fs::rename(&tmp, path)
                .map_err(|e| format!("原子替换失败 {}: {e}", path.display()))?;
        }
        Err(_) => {
            // 同目录不可写：退系统 tmp（跨盘 rename 会失败，此时退化为直接写）
            let fallback = tmp_path(&std::env::temp_dir());
            fs::write(&fallback, &data).map_err(|e| format!("写临时文件失败: {e}"))?;
            fs::copy(&fallback, path).map_err(|e| format!("写目标文件失败: {e}"))?;
            let _ = fs::remove_file(&fallback);
        }
    }
    Ok(stat_of(path)?)
}

// ---------- 单测 ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "yueduo-p1-{}-{}-{nanos}",
            tag,
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_then_read_roundtrip_utf16le() {
        let dir = temp_dir("write");
        let path = dir.join("书.txt");
        let stat = write_text(&path, "第一章　开端\r\n正文内容\n").unwrap();
        assert_eq!(stat.size % 2, 0, "UTF-16LE 必须偶数字节");
        let out = read_text(&path).unwrap();
        assert_eq!(out.text, "第一章　开端\n正文内容\n");
        // 保存后 inode 变化 → stat 刷新可用
        let again = stat_of(&path).unwrap();
        assert_eq!(again.ino, stat.ino);
        assert_eq!(again.real_path, stat.real_path);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn overwrite_preserves_atomic_semantics() {
        let dir = temp_dir("atomic");
        let path = dir.join("a.txt");
        write_text(&path, "旧内容").unwrap();
        let first = stat_of(&path).unwrap();
        write_text(&path, "新内容更长一些").unwrap();
        let second = stat_of(&path).unwrap();
        assert_ne!(first.ino, second.ino, "rename 替换后 inode 必须变化");
        // 临时文件不残留
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("yueduo-tmp"))
            .collect();
        assert!(leftovers.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }
}
