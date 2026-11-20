//! 元数据解析（方案 §2.4，对齐 shared/metadataParser.ts / Python metadata_parser）：
//! - 书名：正文前两行书名号内；否则文件名去后缀
//! - 作者：正文前十行「作者：」；否则「佚名」
//! - 标签：正文前十行「主题：」（逗号/空白分隔）；否则所在目录名
//! - 字数：非空白字符数（不扫全文，只切前 10 行做字段提取）
//! Rust 侧与 TS 侧同一口径（避免两套解析漂移）。

use regex::Regex;

use crate::types::ParsedMetadata;

/// 标签在库内以空格分隔；正文里逗号和空白都算分隔符（对齐 Python split_tags）
pub fn split_tags(value: &str) -> Vec<String> {
    value
        .split(|c: char| c == ',' || c == '，' || c.is_whitespace())
        .filter(|t| !t.is_empty())
        .map(String::from)
        .collect()
}

fn find_value(lines: &[&str], pattern: &Regex) -> Option<String> {
    for line in lines {
        if let Some(caps) = pattern.captures(line) {
            let value = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// 取正文前十行「主题：」后的原文，供同步 Finder 注释等需要原样的场景使用（对齐 Python find_topic）
pub fn find_topic(text: &str) -> Option<String> {
    let pattern = Regex::new(r"^\s*主题\s*[：:]\s*(.+?)\s*$").unwrap();
    find_value(&first_lines(text), &pattern)
}

fn first_lines(text: &str) -> Vec<&str> {
    // TS split('\n', 10)：切成最多 11 段取前 10 行（含截断尾巴），这里同口径
    let mut lines: Vec<&str> = text.split('\n').take(10).collect();
    lines.truncate(10);
    lines
}

/// Python Path.stem 口径：只去最后一个后缀，'.txt' 这类无主名的点文件保留原名
fn stem(filename: &str) -> &str {
    match filename.rfind('.') {
        Some(idx) if idx > 0 => &filename[..idx],
        _ => filename,
    }
}

/// 解析单本书的元数据。
/// filename 只用于书名兜底（去最后一个后缀），directory_name 只用于标签兜底。
pub fn parse_metadata(text: &str, filename: &str, directory_name: &str) -> ParsedMetadata {
    let lines = first_lines(text);
    let title_pattern = Regex::new("《([^》]+)》").unwrap();
    let author_pattern = Regex::new(r"^\s*作者\s*[：:]\s*(.+?)\s*$").unwrap();
    let tags_pattern = Regex::new(r"^\s*主题\s*[：:]\s*(.+?)\s*$").unwrap();

    let mut title: Option<String> = None;
    for line in lines.iter().take(2) {
        if let Some(caps) = title_pattern.captures(line) {
            let value = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
            if !value.is_empty() {
                title = Some(value.to_string());
                break;
            }
        }
    }

    let tags_text = find_value(&lines, &tags_pattern);
    let tags = match tags_text {
        Some(text) if !split_tags(&text).is_empty() => split_tags(&text),
        // 主题行存在但解析为空标签：与 TS 一致退回目录名
        Some(_) if directory_name.is_empty() => vec![],
        _ if !directory_name.is_empty() => vec![directory_name.to_string()],
        _ => vec![],
    };
    let author = find_value(&lines, &author_pattern).unwrap_or_else(|| "佚名".to_string());

    ParsedMetadata {
        title: title.unwrap_or_else(|| stem(filename).to_string()),
        author,
        tags,
        // Python 口径：len("".join(text.split()))，空行与全角缩进都不计
        word_count: text.chars().filter(|c| !c.is_whitespace()).count() as i64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_title_author_tags_and_fallbacks() {
        let text = "《测试书名》\n作者：张三\n主题：玄幻, 完结\n正文";
        let meta = parse_metadata(text, "文件名.txt", "目录名");
        assert_eq!(meta.title, "测试书名");
        assert_eq!(meta.author, "张三");
        assert_eq!(meta.tags, vec!["玄幻", "完结"]);
        // 非空白字符数（ASCII 逗号是标点不是空白，计入）：
        // 《测试书名》6 + 作者：张三 5 + 主题：玄幻, 6 + 完结 2 + 正文 2 = 21
        assert_eq!(meta.word_count, 21);
    }

    #[test]
    fn falls_back_to_filename_and_directory() {
        let meta = parse_metadata("没有元数据的正文", "无字段书.txt", "同人");
        assert_eq!(meta.title, "无字段书");
        assert_eq!(meta.author, "佚名");
        assert_eq!(meta.tags, vec!["同人"]);
    }

    #[test]
    fn find_topic_returns_raw_value() {
        assert_eq!(find_topic("主题： 玄幻 · 完结"), Some("玄幻 · 完结".into()));
        assert_eq!(find_topic("没有主题"), None);
    }
}
