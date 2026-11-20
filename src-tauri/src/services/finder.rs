//! Finder／Path Finder 扩展属性读写（对齐 Python finder_metadata / plistlib）：
//! - 星级 com.apple.metadata:kMDItemStarRating：bplist00 实数（float marker 0x23）
//! - 注释 com.apple.metadata:kMDItemFinderComment：bplist00 字符串
//! 用 `xattr` crate 直读写原始字节（免 spawn，等价于原版 `xattr -px/-w -x` 十六进制通道），
//! 注释写完再经 osascript 让 Finder 同步简介/Spotlight 索引。
//! 不引入 plist 依赖，bplist00 手写构造必须与 python3 plistlib.dumps(FMT_BINARY) 逐字节一致：
//! - 字符串：全 ASCII 走 UTF-8 marker 0x5X/0x5F，否则 UTF-16BE marker 0x6X/0x6F
//! - 扩展长度：token|0xF 后跟内联整数对象（0x10/0x11/0x12/0x13 + 大端长度）
//! - 偏移表宽度按「头 + 对象」总长度取 1/2/4/8 字节
//! - trailer 32 字节（Python pack('>5xBBBQQQ', sortVersion, offsetSize, refSize, ...)）

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const RATING_ATTR: &str = "com.apple.metadata:kMDItemStarRating";
const COMMENT_ATTR: &str = "com.apple.metadata:kMDItemFinderComment";
const HEADER: &[u8] = b"bplist00";

/// 对齐 Python `value.encode('ascii')`：全部码元 < 128 才走 UTF-8 marker
fn is_ascii_only(value: &str) -> bool {
    value.chars().all(|ch| (ch as u32) <= 0x7f)
}

fn read_uint_be(buf: &[u8], offset: usize, size: usize) -> u64 {
    let mut value = 0u64;
    for byte in &buf[offset..offset + size] {
        value = value * 256 + u64::from(*byte);
    }
    value
}

/// 读顶层对象位置（32 字节 trailer，Python plistlib 口径）；结构不合法返回 None
fn read_top_object(buf: &[u8]) -> Option<(usize, u8)> {
    if buf.len() < 40 || &buf[0..8] != HEADER {
        return None;
    }
    let trailer = buf.len() - 32;
    let offset_size = buf[trailer + 6] as usize;
    if !(1..=8).contains(&offset_size) {
        return None;
    }
    let num_objects = read_uint_be(buf, trailer + 8, 8);
    let top_object = read_uint_be(buf, trailer + 16, 8);
    let offset_table_offset = read_uint_be(buf, trailer + 24, 8) as usize;
    if num_objects < 1 || top_object >= num_objects || offset_table_offset >= buf.len() {
        return None;
    }
    let entry = offset_table_offset + top_object as usize * offset_size;
    if entry + offset_size > buf.len() {
        return None;
    }
    let offset = read_uint_be(buf, entry, offset_size) as usize;
    if offset >= buf.len() {
        return None;
    }
    Some((offset, buf[offset]))
}

/// 只解析顶层 real/int（Finder 星级为 real）；结构不合法返回 None
pub fn parse_bplist_number(buf: &[u8]) -> Option<f64> {
    let (offset, marker) = read_top_object(buf)?;
    let type_code = marker >> 4;
    let info = marker & 0x0f;

    if type_code == 0x2 {
        if info == 0x2 && offset + 5 <= buf.len() {
            let mut bytes = [0u8; 4];
            bytes.copy_from_slice(&buf[offset + 1..offset + 5]);
            return Some(f32::from_be_bytes(bytes) as f64);
        }
        if info == 0x3 && offset + 9 <= buf.len() {
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&buf[offset + 1..offset + 9]);
            return Some(f64::from_be_bytes(bytes));
        }
        return None;
    }
    if type_code == 0x1 {
        let size = [1usize, 2, 4, 8][info as usize];
        if size == 0 || offset + 1 + size > buf.len() {
            return None;
        }
        return Some(read_uint_be(buf, offset + 1, size) as f64);
    }
    None
}

/// Python _count_to_size：宽度按最小可容纳字节取 1/2/4/8
fn count_to_size(count: usize) -> usize {
    if count < 0x100 {
        1
    } else if count < 0x1_0000 {
        2
    } else if count < 0x8000_0000 {
        4
    } else {
        8
    }
}

/// Python _write_size：<15 单字节；否则 token|0xF + 内联整数对象 + 大端长度
fn encode_size(token: u8, size: usize) -> Vec<u8> {
    if size < 0x0f {
        return vec![token | size as u8];
    }
    let mut out = vec![token | 0x0f];
    if size < 0x100 {
        out.push(0x10);
        out.push(size as u8);
    } else if size < 0x1_0000 {
        out.push(0x11);
        out.extend_from_slice(&(size as u16).to_be_bytes());
    } else if size < 0x1_0000_0000 {
        out.push(0x12);
        out.extend_from_slice(&(size as u32).to_be_bytes());
    } else {
        out.push(0x13);
        out.extend_from_slice(&(size as u64).to_be_bytes());
    }
    out
}

/// 单个顶层对象的完整 bplist00：头 + 对象 + 偏移表 + 32 字节 trailer
fn build_single_object(object: &[u8]) -> Vec<u8> {
    let offset_table_offset = HEADER.len() + object.len();
    let offset_size = count_to_size(offset_table_offset);
    let mut offset_table = vec![0u8; offset_size];
    offset_table.copy_from_slice(&(HEADER.len() as u64).to_be_bytes()[8 - offset_size..]);

    let mut trailer = vec![0u8; 32];
    trailer[5] = 0; // sortVersion
    trailer[6] = offset_size as u8;
    trailer[7] = 1; // refSize（单对象）
    trailer[8..16].copy_from_slice(&1u64.to_be_bytes()); // 对象数
    trailer[16..24].copy_from_slice(&0u64.to_be_bytes()); // 顶层对象索引
    trailer[24..32].copy_from_slice(&(offset_table_offset as u64).to_be_bytes());

    let mut out = Vec::with_capacity(offset_table_offset + offset_size + 32);
    out.extend_from_slice(HEADER);
    out.extend_from_slice(object);
    out.extend_from_slice(&offset_table);
    out.extend_from_slice(&trailer);
    out
}

/// 构造只含一个 8 字节实数的 bplist00（与 Python plistlib.dumps(float) 同构）
pub fn build_bplist_number(value: f64) -> Vec<u8> {
    let mut payload = vec![0x23u8];
    payload.extend_from_slice(&value.to_be_bytes());
    build_single_object(&payload)
}

/// 字符串对象：Python 全 ASCII 走 0x5X，含非 ASCII 走 UTF-16BE 0x6X（低 4 位是字符数）
fn encode_bplist_string(value: &str) -> Vec<u8> {
    if is_ascii_only(value) {
        let mut out = encode_size(0x50, value.len());
        out.extend_from_slice(value.as_bytes());
        return out;
    }
    let utf16: Vec<u8> = value
        .encode_utf16()
        .flat_map(|unit| unit.to_be_bytes())
        .collect();
    let mut out = encode_size(0x60, utf16.len() / 2);
    out.extend_from_slice(&utf16);
    out
}

/// 构造只含一个字符串的 bplist00（与 Python plistlib.dumps(str) 逐字节一致）
pub fn build_bplist_string(value: &str) -> Vec<u8> {
    build_single_object(&encode_bplist_string(value))
}

/// 扩展长度内联整数对象：0x10/0x11/0x12/0x13 + 1/2/4/8 字节大端
fn read_extended_length(buf: &[u8], offset: usize) -> Option<(usize, usize)> {
    if offset >= buf.len() || buf[offset] >> 4 != 0x1 {
        return None;
    }
    let info = (buf[offset] & 0x0f) as usize;
    let size = [1usize, 2, 4, 8][info];
    if size == 0 || offset + 1 + size > buf.len() {
        return None;
    }
    let length = read_uint_be(buf, offset + 1, size) as usize;
    Some((length, offset + 1 + size))
}

/// 只解析顶层字符串：兼容 Python 的 UTF-16BE marker 与 Finder/其它工具写出的 UTF-8 marker
pub fn parse_bplist_string(buf: &[u8]) -> Option<String> {
    let (offset, marker) = read_top_object(buf)?;
    let type_code = marker >> 4;
    let info = marker & 0x0f;
    if type_code != 0x5 && type_code != 0x6 {
        return None;
    }

    let mut length = info as usize;
    let mut start = offset + 1;
    if info == 0x0f {
        let (ext_length, ext_start) = read_extended_length(buf, offset + 1)?;
        length = ext_length;
        start = ext_start;
    }

    if type_code == 0x5 {
        if start + length > buf.len() {
            return None;
        }
        return String::from_utf8(buf[start..start + length].to_vec()).ok();
    }
    let end = start + length * 2;
    if end > buf.len() {
        return None;
    }
    let units: Vec<u16> = buf[start..end]
        .chunks_exact(2)
        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
        .collect();
    Some(String::from_utf16(&units).ok()?)
}

// ---------- xattr 读写（crate 直读写原始字节） ----------

fn read_attr(path: &str, attr: &str) -> Option<Vec<u8>> {
    xattr::get(path, attr).ok().flatten()
}

fn write_attr(path: &str, attr: &str, value: &[u8]) -> Result<(), String> {
    xattr::set(path, attr, value).map_err(|e| format!("xattr 写入失败 {path}: {e}"))
}

/// 读星级：0～5。非 macOS 返回 None（调用方保留库内评分）；
/// macOS 上无属性/读取失败按 0 分（对齐 Python finder_metadata.rating）。
pub fn read_rating(path: &str) -> Option<i64> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let value = read_attr(path, RATING_ATTR)
        .and_then(|raw| parse_bplist_number(&raw))
        .unwrap_or(0.0);
    Some(value.round().clamp(0.0, 5.0) as i64)
}

/// 写星级：写前读旧值，相同跳过；返回是否「已持久化」（含跳过，对齐 meta.writeFileRating）。
/// 失败返回 false，不影响数据库评分。
pub fn write_rating(path: &str, rating: i64) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let value = rating.clamp(0, 5);
    if read_rating(path) == Some(value) {
        return true;
    }
    write_attr(path, RATING_ATTR, &build_bplist_number(value as f64)).is_ok()
}

/// 读 Finder 注释；非 macOS、无属性或无法解析返回 None
pub fn read_comment(path: &str) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    read_attr(path, COMMENT_ATTR).and_then(|raw| parse_bplist_string(&raw))
}

/// 注释写入结果（shared 侧契约同 Electron 版）：
/// - refreshed：xattr 已写入，Finder 也同步完成（简介立即可见）
/// - written：xattr 已写入，但 Finder 同步失败，调用方需知道
/// - skipped：非 macOS、无内容或与旧值相同，未写
/// - failed：xattr 写入本身失败
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinderCommentStatus {
    Refreshed,
    Written,
    Skipped,
    Failed,
}

/// 让 Finder 写入同一条注释：raw xattr 只改文件本身，Finder／Path Finder 的简介
/// 不总是直接读 xattr——Spotlight 索引会滞后，Finder 自己的缓存还可能长期停在旧值；
/// 经 Finder 走它自己的元数据 API 才会立即刷新。失败不影响已写入的 xattr。
/// 路径与注释都作为 osascript 的 argv 传入，不拼进脚本文本，双引号／反斜杠／换行／中文
/// 不会破坏语法，也不会被当成脚本执行。2 秒超时（对齐原版 execFile timeout）。
pub fn sync_finder_comment_via_osascript(path: &str, text: &str) -> Result<(), String> {
    let mut child = Command::new("osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "tell application \"Finder\" to set comment of (POSIX file (item 1 of argv) as alias) to (item 2 of argv)",
            "-e",
            "end run",
            path,
            text,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("osascript 启动失败: {e}"))?;
    let deadline = Instant::now() + Duration::from_millis(2000);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("osascript 退出码异常: {status}"))
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("osascript 同步超时(2s)".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// 写 Finder 注释（方案 §2.10）：无主题跳过；写前读旧注释，内容相同也跳过，
/// 减少写操作、避免反复改动文件。xattr 写成功后尝试让 Finder 同步；
/// 同步失败只降级为 `Written`，不抛出、不阻塞保存主流程。
/// `sync` 注入口便于单测验证降级路径。
pub fn write_comment(
    path: &str,
    text: Option<&str>,
    sync: impl Fn(&str, &str) -> Result<(), String>,
) -> FinderCommentStatus {
    if !cfg!(target_os = "macos") {
        return FinderCommentStatus::Skipped;
    }
    let Some(text) = text.filter(|t| !t.is_empty()) else {
        return FinderCommentStatus::Skipped;
    };
    if read_comment(path).as_deref() == Some(text) {
        return FinderCommentStatus::Skipped;
    }
    let value = build_bplist_string(text);
    if let Err(e) = write_attr(path, COMMENT_ATTR, &value) {
        eprintln!("[finder] 注释 xattr 写入失败：{e}");
        return FinderCommentStatus::Failed;
    }
    // xattr 已落盘；再让 Finder 同步一次索引，Finder 简介里立即能看到
    match sync(path, text) {
        Ok(()) => FinderCommentStatus::Refreshed,
        Err(e) => {
            eprintln!("[finder] 注释已写入 xattr，但 Finder 同步失败：{e}（{path}）");
            FinderCommentStatus::Written
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_roundtrip_and_structure() {
        let bytes = build_bplist_number(3.0);
        assert!(bytes.starts_with(HEADER));
        assert_eq!(bytes.len(), 8 + 9 + 1 + 32, "头+对象+偏移表+trailer");
        assert_eq!(parse_bplist_number(&bytes), Some(3.0));
        // 小数与边界
        assert_eq!(parse_bplist_number(&build_bplist_number(4.5)), Some(4.5));
        // 非 bplist / 截断 → None
        assert_eq!(parse_bplist_number(b"not a plist"), None);
    }

    #[test]
    fn string_roundtrip_ascii_and_utf16() {
        let ascii = build_bplist_string("hello");
        assert_eq!(parse_bplist_string(&ascii), Some("hello".into()));
        // 中文走 UTF-16BE marker
        let cjk = build_bplist_string("玄幻 追更");
        assert_eq!(parse_bplist_string(&cjk), Some("玄幻 追更".into()));
        // 超过 15 字符触发扩展长度（0x6F + 内联整数）
        let long = "这是一段超过十五个字符的中文注释内容用于测试扩展长度编码";
        assert!(long.chars().count() > 15);
        let bytes = build_bplist_string(long);
        assert_eq!(parse_bplist_string(&bytes), Some(long.into()));
        // 空串
        assert_eq!(parse_bplist_string(&build_bplist_string("")), Some("".into()));
    }

    #[test]
    fn parses_utf8_marker_written_by_other_tools() {
        // Finder/其它工具可能写 UTF-8 marker（0x5X），Python 口径也兼容
        let payload = {
            let mut p = vec![0x55u8]; // 0x50 | 5
            p.extend_from_slice("hello".as_bytes());
            build_single_object(&p)
        };
        assert_eq!(parse_bplist_string(&payload), Some("hello".into()));
    }

    /// 与 python3 plistlib.dumps(FMT_BINARY) 逐字节对照（防漂移的权威口径）
    #[test]
    fn byte_identical_to_python_plistlib() {
        let Some(python) = which_python() else {
            eprintln!("python3 不可用，跳过逐字节对照");
            return;
        };
        for (name, ours) in [
            ("num", build_bplist_number(4.0)),
            ("ascii", build_bplist_string("hello")),
            ("cjk", build_bplist_string("玄幻")),
            ("long", build_bplist_string("这段注释超过十五个字符以触发扩展长度编码路径")),
        ] {
            let expected = python_plist_bytes(&python, name);
            assert_eq!(ours, expected, "bplist00 与 plistlib 不一致：{name}");
        }
    }

    fn which_python() -> Option<String> {
        Command::new("python3")
            .arg("-c")
            .arg("print('ok')")
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|_| "python3".to_string())
    }

    fn python_plist_bytes(python: &str, kind: &str) -> Vec<u8> {
        let expr = match kind {
            "num" => "4.0",
            "ascii" => "'hello'",
            "cjk" => "'玄幻'",
            _ => "'这段注释超过十五个字符以触发扩展长度编码路径'",
        };
        use std::io::Write;
        let mut child = Command::new(python)
            .arg("-c")
            .arg(
                "import sys, plistlib\n\
                 value = eval(sys.stdin.read())\n\
                 sys.stdout.buffer.write(plistlib.dumps(value, fmt=plistlib.FMT_BINARY))",
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("python3 子进程");
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(expr.as_bytes())
            .unwrap();
        let out = child.wait_with_output().expect("python3 输出");
        assert!(out.status.success(), "python3 执行失败");
        out.stdout
    }

    #[test]
    fn comment_write_status_contract() {
        // 临时文件上验证真实 xattr 通道（macOS 专属；无主题跳过不写）
        if !cfg!(target_os = "macos") {
            return;
        }
        let dir = std::env::temp_dir().join(format!("yueduo-finder-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("书.txt");
        std::fs::write(&path, b"x").unwrap();
        let path_str = path.to_str().unwrap();

        // 无主题 → skipped（不产生属性）
        let noop = |_: &str, _: &str| Ok::<(), String>(());
        assert_eq!(
            write_comment(path_str, None, noop),
            FinderCommentStatus::Skipped
        );
        assert_eq!(read_comment(path_str), None);
        // 写入 + osascript 真同步（Finder 可能拒绝但 xattr 已落盘 → Refreshed 或 Written）
        let status = write_comment(path_str, Some("测试注释"), |p, t| {
            sync_finder_comment_via_osascript(p, t)
        });
        assert!(matches!(
            status,
            FinderCommentStatus::Refreshed | FinderCommentStatus::Written
        ));
        assert_eq!(read_comment(path_str), Some("测试注释".into()));
        // 相同内容 → skipped
        assert_eq!(
            write_comment(path_str, Some("测试注释"), noop),
            FinderCommentStatus::Skipped
        );
        // 星级往返
        assert_eq!(read_rating(path_str), Some(0));
        assert!(write_rating(path_str, 4));
        assert_eq!(read_rating(path_str), Some(4));
        // 再次写相同值 → 仍返回 true（已持久化）
        assert!(write_rating(path_str, 4));
        // 非法值 clamp
        assert!(write_rating(path_str, 9));
        assert_eq!(read_rating(path_str), Some(5));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
