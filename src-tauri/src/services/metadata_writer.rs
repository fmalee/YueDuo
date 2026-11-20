//! 元数据写回（方案 §2.8）：逐行对齐 Python metadata_writer.rewrite_header。
//! 只改正文前 10 行，返回一处最小替换区间（**UTF-16 码元偏移**，Monaco executeEdits 口径），
//! 供编辑器一次可撤销编辑应用；无变化返回 None（避免无意义的 dirty）。纯函数可单测。

use std::sync::OnceLock;

use regex::Regex;

use crate::types::MetadataTextEdit;

/// 书名必须落在前两行才能被解析（对齐 Python _title_line_index）
const TITLE_PATTERN: &str = "《[^》]*》";
const AUTHOR_PATTERN: &str = r"^\s*作者\s*[：:]\s*(.*?)\s*$";
const TAGS_PATTERN: &str = r"^\s*主题\s*[：:]\s*(.*?)\s*$";
const HEADER_LINES: usize = 10;

fn patterns() -> &'static (Regex, Regex, Regex) {
    static PATTERNS: OnceLock<(Regex, Regex, Regex)> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        (
            Regex::new(TITLE_PATTERN).expect("TITLE_PATTERN 必须可编译"),
            Regex::new(AUTHOR_PATTERN).expect("AUTHOR_PATTERN 必须可编译"),
            Regex::new(TAGS_PATTERN).expect("TAGS_PATTERN 必须可编译"),
        )
    })
}

/// 待写回字段（None = 不动该字段）
#[derive(Debug, Default, Clone)]
pub struct MetadataWriteFields<'a> {
    pub title: Option<&'a str>,
    pub author: Option<&'a str>,
    /// 已按逗号/空白拆好的标签列表
    pub tags: Option<&'a [String]>,
}

fn title_line_index(lines: &[&str], title_re: &Regex) -> Option<usize> {
    let limit = lines.len().min(2);
    (0..limit).find(|&index| title_re.is_match(lines[index]))
}

fn matching_index(lines: &[&str], re: &Regex) -> Option<usize> {
    lines.iter().position(|line| re.is_match(line))
}

/// 每行行首相对正文的 **UTF-16** 偏移（行间固定一个 \n）
fn line_starts(lines: &[&str]) -> Vec<usize> {
    let mut starts = Vec::with_capacity(lines.len());
    let mut offset = 0usize;
    for line in lines {
        starts.push(offset);
        offset += line.chars().map(char::len_utf16).sum::<usize>() + 1;
    }
    starts
}

fn utf16_len(line: &str) -> usize {
    line.chars().map(char::len_utf16).sum()
}

/// 把字段写进正文头部，返回最小替换区间；字段全为 None 或内容无变化时返回 None。
/// 缺失行的补入顺序固定：书名 → 作者（紧随书名行）→ 标签（紧随作者行）。
pub fn rewrite_header(text: &str, fields: &MetadataWriteFields<'_>) -> Option<MetadataTextEdit> {
    let (title_re, author_re, tags_re) = patterns();
    let lines: Vec<&str> = text.split('\n').collect();
    let old_header_len = lines.len().min(HEADER_LINES);
    let old_header: Vec<&str> = lines[..old_header_len].to_vec();
    let mut header: Vec<String> = old_header.iter().map(|s| (*s).to_string()).collect();

    let mut title_index = title_line_index(&old_header, title_re);
    if let Some(title) = fields.title {
        match title_index {
            None => {
                // 书名必须出现在前两行才能被解析，缺省时补在正文最前面
                header.insert(0, format!("《{title}》"));
                title_index = Some(0);
            }
            Some(index) => {
                header[index] = title_re
                    .replace(&header[index], format!("《{title}》"))
                    .into_owned();
            }
        }
    }

    let mut author_index = matching_index(&old_header, author_re);
    if let Some(author) = fields.author {
        let value = format!("作者：{author}");
        match author_index {
            None => {
                // 解析只认前 10 行的作者行，紧随书名行补入即可
                let anchor = title_index.map_or(0, |i| i + 1);
                header.insert(anchor, value);
                author_index = Some(anchor);
            }
            Some(index) => header[index] = value,
        }
    }

    if let Some(tags) = fields.tags {
        let value = format!("主题：{}", tags.join(","));
        match matching_index(&old_header, tags_re) {
            None => {
                let anchor = if let Some(i) = author_index {
                    i + 1
                } else {
                    title_index.map_or(0, |i| i + 1)
                };
                header.insert(anchor, value);
            }
            Some(index) => header[index] = value,
        }
    }

    let changed =
        header.len() != old_header.len() || header.iter().zip(&old_header).any(|(a, b)| a != b);
    if !changed {
        return None;
    }

    // 前缀/后缀相同行不纳入替换区间：改一行只返回一行
    let max = old_header.len().min(header.len());
    let mut prefix = 0usize;
    while prefix < max && old_header[prefix] == header[prefix] {
        prefix += 1;
    }
    let mut suffix = 0usize;
    while suffix < max - prefix
        && old_header[old_header.len() - 1 - suffix] == header[header.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let old_block = &old_header[prefix..old_header.len() - suffix];
    let new_block = &header[prefix..header.len() - suffix];
    let starts = line_starts(&old_header);
    let start = if prefix < old_header.len() {
        starts[prefix]
    } else {
        starts[starts.len() - 1] + utf16_len(old_header[old_header.len() - 1])
    };
    let old_block_len: usize = old_block
        .iter()
        .map(|line| utf16_len(line))
        .sum::<usize>()
        .saturating_sub(old_block.len().saturating_sub(1)); // join('\n') 的 UTF-16 长度
    let end = start + old_block_len;

    let replacement = if !old_block.is_empty() {
        new_block.join("\n")
    } else if prefix > 0 {
        // 追加在既有行之后，先补一个换行再写新行
        format!("\n{}", new_block.join("\n"))
    } else {
        // 插在正文最前面，新行后需要一个换行与下文分隔
        format!("{}\n", new_block.join("\n"))
    };
    Some(MetadataTextEdit {
        start,
        end,
        replacement,
    })
}

/// UTF-16 偏移 → 字节偏移（Rust 切片口径；编辑器传来的边界必落在字符边界上）
fn utf16_to_byte_offset(text: &str, target: usize) -> usize {
    let mut utf16 = 0usize;
    let mut byte = 0usize;
    for ch in text.chars() {
        if utf16 >= target {
            break;
        }
        utf16 += ch.len_utf16();
        byte += ch.len_utf8();
    }
    byte
}

/// 按 TextEdit 生成写回后的正文（主进程据此重解析并同步库）
pub fn apply_text_edit(text: &str, edit: &MetadataTextEdit) -> String {
    let start_byte = utf16_to_byte_offset(text, edit.start);
    let end_byte = utf16_to_byte_offset(text, edit.end);
    let mut out = String::with_capacity(text.len() + edit.replacement.len());
    out.push_str(&text[..start_byte]);
    out.push_str(&edit.replacement);
    out.push_str(&text[end_byte..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields<'a>(
        title: Option<&'a str>,
        author: Option<&'a str>,
        tags: &'a [String],
    ) -> MetadataWriteFields<'a> {
        MetadataWriteFields {
            title,
            author,
            tags: if tags.is_empty() { None } else { Some(tags) },
        }
    }

    #[test]
    fn replaces_title_line_minimally() {
        let text = "《旧书名》\n作者：张三\n正文";
        let edit = rewrite_header(text, &fields(Some("新书名".into()), None, &[])).unwrap();
        // 只替换书名一处：《旧书名》占 5 个 UTF-16 码元
        assert_eq!(edit.start, 0);
        assert_eq!(edit.end, 5);
        assert_eq!(edit.replacement, "《新书名》");
        assert_eq!(apply_text_edit(text, &edit), "《新书名》\n作者：张三\n正文");
    }

    #[test]
    fn utf16_offsets_survive_astral_chars() {
        // 𫔭 是扩展区汉字，UTF-16 占 2 码元（Rust 1 char / 4 字节）——偏移必须按码元算；
        // 前缀裁剪按整行进行，含 𫔭 的首行整体在替换块内
        let text = "𫔭《旧》\n正文";
        let edit = rewrite_header(text, &fields(Some("新".into()), None, &[])).unwrap();
        assert_eq!(edit.start, 0);
        assert_eq!(edit.end, 5);
        assert_eq!(edit.replacement, "𫔭《新》");
        assert_eq!(apply_text_edit(text, &edit), "𫔭《新》\n正文");
    }

    #[test]
    fn inserts_missing_lines_in_fixed_order() {
        let text = "正文第一行\n第二行";
        let tags = vec!["玄幻".to_string(), "追更".to_string()];
        let edit = rewrite_header(
            text,
            &fields(Some("书".into()), Some("作者甲".into()), &tags),
        )
        .unwrap();
        // 书名补最前，作者紧随书名，标签紧随作者；被替换的是整个首行
        assert_eq!(apply_text_edit(text, &edit), "《书》\n作者：作者甲\n主题：玄幻,追更\n正文第一行\n第二行");
    }

    #[test]
    fn empty_text_builds_full_header() {
        let tags = vec!["玄幻".to_string()];
        let edit = rewrite_header(
            "",
            &fields(Some("书".into()), Some("作者甲".into()), &tags),
        )
        .unwrap();
        assert_eq!(apply_text_edit("", &edit), "《书》\n作者：作者甲\n主题：玄幻\n");
    }

    #[test]
    fn unchanged_fields_return_none() {
        let text = "《书名》\n作者：张三\n主题：玄幻\n正文";
        let tags = vec!["玄幻".to_string()];
        assert!(rewrite_header(
            text,
            &fields(Some("书名".into()), Some("张三".into()), &tags)
        )
        .is_none());
        assert!(rewrite_header(text, &Default::default()).is_none());
    }

    #[test]
    fn interior_change_trims_to_one_line() {
        let text = "《书名》\n作者：旧名\n主题：玄幻\n正文一\n正文二";
        let edit = rewrite_header(text, &fields(None, Some("新名".into()), &[])).unwrap();
        assert_eq!(apply_text_edit(text, &edit), "《书名》\n作者：新名\n主题：玄幻\n正文一\n正文二");
    }

    #[test]
    fn insert_after_last_header_line_appends_with_newline() {
        // 作者在第 10 行（头末）：标签紧随其后 → 全部旧行进前缀，start 越过整个旧头，
        // replacement 前补 \n（对齐 JS 原版「追加在既有行之后」分支）。
        // 注意书名识别只看前两行（titleLineIndex 限制），第 10 行的《书名》不算 title 行。
        let mut text = String::from("行零\n行一\n行二\n行三\n行四\n行五\n行六\n行七\n行八\n作者：张三");
        text.push('\n');
        text.push_str("正文");
        let tags = vec!["玄幻".to_string()];
        let edit = rewrite_header(&text, &fields(None, None, &tags)).unwrap();
        let applied = apply_text_edit(&text, &edit);
        assert_eq!(
            applied,
            "行零\n行一\n行二\n行三\n行四\n行五\n行六\n行七\n行八\n作者：张三\n主题：玄幻\n正文"
        );
    }
}
