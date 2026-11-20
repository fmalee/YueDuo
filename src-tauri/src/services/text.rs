//! 章节提取（方案 §2.6）：正则与 Python `tidy_rules.EXTRACT_CHAPTERS` 逐字一致，
//! 按行匹配「第…章/回/节/卷/集/部/篇」及序章/楔子/卷首/尾声/后记/番外。
//! 不做全文结构化，只返回标题行与行号供右栏跳转。

use regex::Regex;

use crate::types::ChapterInfo;

pub const CHAPTER_PATTERN: &str = r"^[ \t\u{3000}]*(?:第[0-9零〇一二三四五六七八九十百千万两]+[章回节卷集部篇][^\n]*|序章[^\n]*|楔子[^\n]*|卷首[^\n]*|尾声[^\n]*|后记[^\n]*|番外[^\n]*)$";

pub fn parse_chapters(text: &str) -> Vec<ChapterInfo> {
    let pattern = Regex::new(CHAPTER_PATTERN).unwrap();
    text.split('\n')
        .enumerate()
        .filter(|(_, line)| pattern.is_match(line))
        .map(|(i, line)| ChapterInfo {
            title: line.trim().to_string(),
            line: (i + 1) as i64,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_chapter_lines_with_line_numbers() {
        let text = "第一章 开端\n\n　　第二章 中段\n普通段落\n第2章 数字编号\n尾声\n不是第X章\n";
        let chapters = parse_chapters(text);
        let lines: Vec<i64> = chapters.iter().map(|c| c.line).collect();
        // 行 1/3/5/6 命中；「不是第X章」因「第X章」无数字序号而不匹配
        assert_eq!(lines, vec![1, 3, 5, 6]);
        assert_eq!(chapters[0].title, "第一章 开端");
        assert_eq!(chapters[2].title, "第2章 数字编号");
        assert_eq!(chapters[3].title, "尾声");
    }
}
