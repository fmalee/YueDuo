//! 文本编码：探测、解码、换行归一、写回编码。
//! 忠实移植 electron/services/textCodec.ts（其复刻 Python text_codec.py）：
//! BOM 表（UTF-32 先于 UTF-16）→ 无 BOM UTF-16 NUL 判断 → chardetng + GB18030 复核 →
//! fallback utf-8→gb18030→big5 → 兜底 lossy utf-8。换行归一 CRLF/CR → LF。
//!
//! 对 TS 版的一处修正：UTF-16/32 BOM 的 canDecode 回环按 BOM 端序编码（TS iconv 'utf-16'
//! encode 恒 LE+BOM，BE 文件会误判降级；Python 原版无此问题）。
//!
//! 关键陷阱（首次迁移踩坑沉淀）：
//! - chardetng 不认识无 BOM 的 UTF-16，会误判 windows-1252 且 had_errors=false → NUL 判层不可省。
//! - encoding_rs 的 `UTF_16LE.encode()` output_encoding 是 UTF-8（WHATWG form 提交用），
//!   **不能用于写文件**；写回必须 `str::encode_utf16()` 逐码元小端输出。

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};

/// 工作编码（对齐 Python constants.WORK_ENCODING）
pub const WORK_ENCODING: &str = "utf-16-le";

pub struct DecodedText {
    pub text: String,
    pub encoding: String,
}

/// BOM 表：UTF-32 的 BOM 以 UTF-16 的 BOM 开头，必须先匹配 UTF-32（对齐 Python _BOMS 顺序）
const BOMS: [(&[u8], &str); 5] = [
    (&[0xff, 0xfe, 0x00, 0x00], "utf-32"),
    (&[0x00, 0x00, 0xfe, 0xff], "utf-32"),
    (&[0xef, 0xbb, 0xbf], "utf-8"),
    (&[0xff, 0xfe], "utf-16"),
    (&[0xfe, 0xff], "utf-16"),
];

/// chardet 对短文本易把 GBK 误判为韩/日/西欧；项目面向中文小说，
/// 这类结果再用 GB18030 严格解码复核（对齐 Python _SUSPECT_ENCODINGS）
const SUSPECT_ENCODINGS: [&str; 15] = [
    "windows-1252",
    "iso-8859-1",
    "ascii",
    "shift-jis",
    "sjis",
    "euc-jp",
    "eucjp",
    "windows-932",
    "cp932",
    "euc-kr",
    "euckr",
    "windows-949",
    "cp949",
    "johab",
    "shift_jis",
];

const FALLBACK_ENCODINGS: [&str; 3] = ["utf-8", "gb18030", "big5"];

/// chardet/内部编码名归一（小写、下划线转横线，对齐 TS normalizeChardetName）
fn normalize_name(name: &str) -> String {
    name.to_lowercase().replace('_', "-")
}

/// 手动 UTF-32 解码（encoding_rs 无 UTF-32）；非法码位返回 None（严格口径）
fn decode_utf32(data: &[u8], little: bool) -> Option<String> {
    if data.len() % 4 != 0 {
        return None;
    }
    let mut out = String::with_capacity(data.len() / 4);
    for chunk in data.chunks_exact(4) {
        let unit = if little {
            u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        } else {
            u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        };
        out.push(char::from_u32(unit)?);
    }
    Some(out)
}

fn encode_utf32(text: &str, little: bool, with_bom: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 4 + 4);
    if with_bom {
        if little {
            out.extend_from_slice(&[0xff, 0xfe, 0x00, 0x00]);
        } else {
            out.extend_from_slice(&[0x00, 0x00, 0xfe, 0xff]);
        }
    }
    for unit in text.chars().map(|c| c as u32) {
        let bytes = if little {
            unit.to_le_bytes()
        } else {
            unit.to_be_bytes()
        };
        out.extend_from_slice(&bytes);
    }
    out
}

/// 无 BOM 的 UTF-16 中文常被误判为 UTF-8；用 NUL 字节与换行数量判断字节序（Python/TS 同款）
fn guess_utf16_without_bom(data: &[u8]) -> Option<String> {
    if data.len() < 4 || !data.contains(&0) {
        return None;
    }
    let mut end = data.len().min(8192);
    if end % 2 == 1 {
        end -= 1;
    }
    let sample = &data[..end];
    let mut best: Option<(&'static Encoding, usize)> = None;
    for encoding in [UTF_16LE, UTF_16BE] {
        let (text, _, had_errors) = encoding.decode(sample);
        if had_errors {
            continue;
        }
        let newlines = text.matches('\n').count();
        if best.is_none() || newlines > best.unwrap().1 {
            best = Some((encoding, newlines));
        }
    }
    best.map(|(encoding, _)| normalize_name(encoding.name()))
}

/// 严格解码：无替换错误才返回 Some（含 BOM 切除语义，对齐 TS decodeStripBom）
fn decode_strict(data: &[u8], label: &str) -> Option<String> {
    match label {
        "utf-8" => {
            let body = data.strip_prefix(&[0xef, 0xbb, 0xbf][..]).unwrap_or(data);
            let (text, _, had_errors) = UTF_8.decode(body);
            if had_errors {
                None
            } else {
                Some(text.into_owned())
            }
        }
        "utf-16" => {
            let (encoding, rest) = if data.starts_with(&[0xff, 0xfe]) {
                (UTF_16LE, &data[2..])
            } else if data.starts_with(&[0xfe, 0xff]) {
                (UTF_16BE, &data[2..])
            } else {
                return None; // Python utf-16 解码器按 BOM 判字节序并剥除
            };
            let (text, _, had_errors) = encoding.decode(rest);
            if had_errors {
                None
            } else {
                Some(text.into_owned())
            }
        }
        "utf-32" => {
            let (little, rest) = if data.starts_with(&[0xff, 0xfe, 0x00, 0x00]) {
                (true, &data[4..])
            } else if data.starts_with(&[0x00, 0x00, 0xfe, 0xff]) {
                (false, &data[4..])
            } else {
                return None;
            };
            decode_utf32(rest, little)
        }
        _ => {
            let encoding = Encoding::for_label(label.as_bytes())?;
            let (text, _, had_errors) = encoding.decode(data);
            if had_errors {
                None
            } else {
                Some(text.into_owned())
            }
        }
    }
}

/// 严格可解码校验（对齐 Python decode 严格模式）：roundtrip 重编码必须与原字节一致。
/// UTF-16/32 BOM 情形按 BOM 端序回环（修正 TS 版 iconv 恒 LE 的缺口）。
fn can_decode(data: &[u8], label: &str) -> bool {
    match label {
        "utf-8" => {
            let bom = data.starts_with(&[0xef, 0xbb, 0xbf]);
            let body = if bom { &data[3..] } else { data };
            let Some(text) = decode_strict(data, label) else {
                return false;
            };
            if bom {
                let mut back = vec![0xef, 0xbb, 0xbf];
                back.extend_from_slice(text.as_bytes());
                back == data
            } else {
                text.as_bytes() == body
            }
        }
        "utf-16" => {
            let (little, bom): (bool, &[u8]) = if data.starts_with(&[0xff, 0xfe]) {
                (true, &[0xff, 0xfe])
            } else if data.starts_with(&[0xfe, 0xff]) {
                (false, &[0xfe, 0xff])
            } else {
                return false;
            };
            let Some(text) = decode_strict(data, label) else {
                return false;
            };
            let mut back = bom.to_vec();
            for unit in text.encode_utf16() {
                if little {
                    back.extend_from_slice(&unit.to_le_bytes());
                } else {
                    back.extend_from_slice(&unit.to_be_bytes());
                }
            }
            back == data
        }
        "utf-32" => {
            let little = data.starts_with(&[0xff, 0xfe, 0x00, 0x00]);
            if !little && !data.starts_with(&[0x00, 0x00, 0xfe, 0xff]) {
                return false;
            }
            let Some(text) = decode_strict(data, label) else {
                return false;
            };
            encode_utf32(&text, little, true) == data
        }
        _ => {
            let Some(text) = decode_strict(data, label) else {
                return false;
            };
            let Some(encoding) = Encoding::for_label(label.as_bytes()) else {
                return false;
            };
            let (back, _, _) = encoding.encode(&text);
            back.as_ref() == data
        }
    }
}

/// 编码探测（对齐 TS detectEncoding）
pub fn detect_encoding(data: &[u8]) -> String {
    for (bom, label) in BOMS {
        if data.len() >= bom.len() && data.starts_with(bom) {
            return label.to_string();
        }
    }
    if let Some(guess) = guess_utf16_without_bom(data) {
        return guess;
    }
    // chardetng 探测 + 可解码校验 + GB18030 复核；启发式统计用前 256KB 足够稳定
    let mut detector = chardetng::EncodingDetector::new();
    let sample_len = data.len().min(262144);
    detector.feed(&data[..sample_len], true);
    let encoding = detector.guess(None, true);
    let mut name = normalize_name(encoding.name());
    // encoding_rs 的 "gbk" 即 WHATWG gb18030 超集（同一解码器）；TS 版 chardet 与 Python
    // 都报告 gb18030，这里归一保持状态栏显示与历史一致
    if name == "gbk" {
        name = "gb18030".to_string();
    }
    if can_decode(data, &name) {
        if SUSPECT_ENCODINGS.contains(&name.as_str()) && can_decode(data, "gb18030") {
            return "gb18030".to_string();
        }
        return name;
    }
    for candidate in FALLBACK_ENCODINGS {
        if can_decode(data, candidate) {
            return candidate.to_string();
        }
    }
    "utf-8".to_string()
}

/// 探测 + 解码主流程（对齐 TS decodeWithFallbacks + decodeBytes）
fn decode_with_fallbacks(data: &[u8], encoding: &str) -> String {
    if let Some(text) = decode_strict(data, encoding) {
        return text;
    }
    for candidate in FALLBACK_ENCODINGS {
        if let Some(text) = decode_strict(data, candidate) {
            return text;
        }
    }
    // 仍失败时保留可读部分，避免整本书无法打开（errors="replace" 对齐）
    let (text, _, _) = UTF_8.decode(data);
    text.into_owned()
}

/// 供 read_text 主流程使用：探测 + 解码 + BOM 残留清理 + 换行归一
pub fn decode_bytes(data: &[u8]) -> DecodedText {
    if data.is_empty() {
        return DecodedText {
            text: String::new(),
            encoding: "utf-8".to_string(),
        };
    }
    let encoding = detect_encoding(data);
    let mut text = decode_with_fallbacks(data, &encoding);
    // BOM 已由解码链切除，这里兜底清掉残留的 ZERO WIDTH NO-BREAK SPACE
    if text.starts_with('\u{feff}') {
        text.remove(0);
    }
    DecodedText {
        text: normalize_newlines(&text),
        encoding,
    }
}

/// 换行归一：CRLF/CR → LF（对齐 Python _normalize_newlines）
pub fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// 按工作编码写字节：UTF-16LE 逐码元小端输出（不能用 encoding_rs 的 UTF_16LE.encode）
pub fn encode_for_write(text: &str) -> Vec<u8> {
    let normalized = normalize_newlines(text);
    let mut out = Vec::with_capacity(normalized.len() * 2 + 2);
    for unit in normalized.encode_utf16() {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

// ---------- 单测（数据脚本内构造，对齐 scripts/test-text-codec.ts 用例口径） ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(s: &str, bom: bool) -> Vec<u8> {
        let mut out = Vec::new();
        if bom {
            out.extend_from_slice(&[0xff, 0xfe]);
        }
        for unit in s.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    #[test]
    fn utf16le_with_bom_detected_and_decoded() {
        let data = utf16le("第一回　风云突变\n第二回\n", true);
        let out = decode_bytes(&data);
        assert_eq!(out.encoding, "utf-16");
        assert_eq!(out.text, "第一回　风云突变\n第二回\n");
    }

    #[test]
    fn utf16be_with_bom_detected_and_decoded() {
        let mut data = vec![0xfe, 0xff];
        for unit in "中文标题\n正文".encode_utf16() {
            data.extend_from_slice(&unit.to_be_bytes());
        }
        let out = decode_bytes(&data);
        assert_eq!(out.encoding, "utf-16");
        assert_eq!(out.text, "中文标题\n正文");
    }

    #[test]
    fn utf16le_without_bom_uses_nul_newline_guess() {
        let data = utf16le("第一章 开端\n继续内容\n", false);
        assert_eq!(detect_encoding(&data), "utf-16le");
        let out = decode_bytes(&data);
        assert_eq!(out.text, "第一章 开端\n继续内容\n");
    }

    #[test]
    fn utf32le_bom_decoded() {
        let mut data = vec![0xff, 0xfe, 0x00, 0x00];
        for c in "章节A\n".chars() {
            data.extend_from_slice(&(c as u32).to_le_bytes());
        }
        let out = decode_bytes(&data);
        assert_eq!(out.encoding, "utf-32");
        assert_eq!(out.text, "章节A\n");
    }

    #[test]
    fn utf8_bom_stripped() {
        let mut data = vec![0xef, 0xbb, 0xbf];
        data.extend_from_slice("你好".as_bytes());
        let out = decode_bytes(&data);
        assert_eq!(out.encoding, "utf-8");
        assert_eq!(out.text, "你好");
    }

    #[test]
    fn gb18030_detected_via_chardetng_with_strict_check() {
        // 「中文小说测试」的 GB18030 字节（手工构造：GBK 双字节编码）
        let mut data = Vec::new();
        for ch in "中文小说测试".chars() {
            let s = ch.to_string();
            let (encoded, _, had_errors) = encoding_rs::GBK.encode(&s);
            assert!(!had_errors);
            data.extend_from_slice(encoded.as_ref());
        }
        assert_eq!(detect_encoding(&data), "gb18030");
        let out = decode_bytes(&data);
        assert_eq!(out.text, "中文小说测试");
    }

    #[test]
    fn newlines_normalized() {
        assert_eq!(normalize_newlines("a\r\nb\rc\nd"), "a\nb\nc\nd");
        let out = decode_bytes(utf16le("x\r\ny\rz\n", true).as_slice());
        assert_eq!(out.text, "x\ny\nz\n");
    }

    #[test]
    fn encode_for_write_is_utf16le_normalized() {
        let bytes = encode_for_write("a\r\n中文\n");
        assert_eq!(bytes, utf16le("a\n中文\n", false));
        // 回环：解码还原归一后文本
        let out = decode_bytes(&bytes);
        assert_eq!(out.text, "a\n中文\n");
    }

    #[test]
    fn lossy_fallback_never_panics_on_garbage() {
        // 乱字节流：所有严格链失败也应返回可读字符串而非报错
        let garbage: Vec<u8> = (0u8..=255).collect();
        let out = decode_bytes(&garbage);
        assert!(!out.encoding.is_empty());
    }

    #[test]
    fn empty_input_defaults_utf8() {
        let out = decode_bytes(&[]);
        assert_eq!(out.text, "");
        assert_eq!(out.encoding, "utf-8");
    }

    /// 真实书库回归（对齐首次迁移 86 本对照口径）：全部可解码、无 panic。
    /// 需要本机书库，默认 #[ignore]，用 `cargo test -- --ignored` 运行。
    #[test]
    #[ignore]
    fn real_library_regression() {
        use std::fs;
        let root = std::path::Path::new("/Users/Joey/Sites/Projects/小说");
        if !root.is_dir() {
            panic!("书库不存在：{}", root.display());
        }
        let mut total = 0;
        let mut categories: std::collections::HashMap<String, usize> = Default::default();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase())
                    == Some("txt".into())
                {
                    let data = fs::read(&path).unwrap();
                    let out = decode_bytes(&data);
                    assert!(!out.text.is_empty() || data.is_empty());
                    *categories.entry(out.encoding).or_default() += 1;
                    total += 1;
                }
            }
        }
        println!("real library decode: {total} files, {categories:?}");
        assert!(total >= 80, "书库样本过少：{total}");
    }
}
