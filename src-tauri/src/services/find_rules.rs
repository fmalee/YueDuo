//! findRules.json 单一规则源（老李 2026-11-20 约定，方案 §3.2）：
//! - 本文件与 shared/findRules.ts 都只读 shared/findRules.json，增删规则只改 JSON；
//! - 数组顺序即一键整理执行顺序，tidyEnabled=true 的条目才参与整理；
//! - pattern 是 JS RegExp 口径（\uXXXX 转义、允许 lookahead），查找下拉由前端使用；
//!   Rust 侧只编译 tidyEnabled 与 to_halfwidth 用到的模式——这些均为 RE2 兼容语法
//!   （无 lookahead），经 [`compile_pattern`] 转换后可被 regex crate 编译。

use std::sync::OnceLock;

use serde::Deserialize;

/// 编译期嵌入，与 TS 侧 import 同一份文件（单一来源的保证）
pub const FIND_RULES_JSON: &str = include_str!("../../../shared/findRules.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindRule {
    pub key: String,
    pub label: String,
    pub pattern: String,
    pub description: String,
    pub replacement: Option<String>,
    pub tidy_enabled: bool,
}

/// 全部规则（数组顺序 = 整理顺序）。解析失败属代码/资源错误，panic 快速暴露。
pub fn rules() -> &'static [FindRule] {
    static RULES: OnceLock<Vec<FindRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        serde_json::from_str(FIND_RULES_JSON).expect("shared/findRules.json 必须是合法规则数组")
    })
}

/// 按 key 取规则（to_halfwidth 等由代码引用的规则用）
pub fn rule_by_key(key: &str) -> Option<&'static FindRule> {
    rules().iter().find(|r| r.key == key)
}

/// JS RegExp 口径 → regex crate 口径：`\uXXXX` 转 `\u{XXXX}`（`\xXX` 两种语法都合法，保留）。
/// 只扫描转义序列本身、不重扫替换结果。
fn translate_pattern(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 8);
    let mut chars = pattern.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.peek() {
            Some('u') => {
                // 收集 \u 后连续 4 位十六进制
                let hex: String = chars.clone().skip(1).take(4).collect();
                if hex.len() == 4 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    out.push_str("\\u{");
                    out.push_str(&hex);
                    out.push('}');
                    for _ in 0..5 {
                        chars.next();
                    }
                } else {
                    out.push('\\'); // 非 4 位十六进制：按字面保留（与 JS 行为一致地宽松）
                }
            }
            Some('U') => {
                // \UXXXXXXXX（8 位）同理转换；当前规则表未用，防御性支持
                let hex: String = chars.clone().skip(1).take(8).collect();
                if hex.len() == 8 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    out.push_str("\\U{");
                    out.push_str(&hex);
                    out.push('}');
                    for _ in 0..9 {
                        chars.next();
                    }
                } else {
                    out.push('\\');
                }
            }
            _ => {
                out.push('\\');
            }
        }
    }
    out
}

/// 编译规则模式。`multiline` 对齐 JS flags 的 `m`（`g` 由 replace_all 天然等价）。
pub fn compile_pattern(pattern: &str, multiline: bool) -> Result<regex::Regex, String> {
    let translated = translate_pattern(pattern);
    let source = if multiline {
        format!("(?m){translated}")
    } else {
        translated
    };
    regex::Regex::new(&source).map_err(|e| format!("规则模式编译失败 {pattern:?}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_parse_and_order_stable() {
        let rules = rules();
        assert_eq!(rules.len(), 24);
        // tidyEnabled 规则的顺序必须与数组顺序一致（一键整理的执行顺序）
        let tidy_keys: Vec<&str> = rules
            .iter()
            .filter(|r| r.tidy_enabled)
            .map(|r| r.key.as_str())
            .collect();
        assert_eq!(
            tidy_keys,
            vec![
                "convert_line_break",
                "trailing_invisible",
                "blank_lines",
                "add_indentation",
                "tab_to_space",
                "convert_tilde",
                "convert_dash",
                "convert_ellipsis",
                "fix_ellipsis",
                "convert_separator"
            ]
        );
        assert_eq!(rules[0].key, "conver_chapters");
        assert_eq!(rules[0].replacement.as_deref(), Some("\\n\\n$1 "));
        // 纯查找规则的 replacement 是 null
        assert!(rules.iter().find(|r| r.key == "find_halfwidth").unwrap().replacement.is_none());
    }

    #[test]
    fn to_halfwidth_rule_exists_and_compiles() {
        let rule = rule_by_key("to_halfwidth").expect("规则表缺少 to_halfwidth");
        compile_pattern(&rule.pattern, false).unwrap();
    }

    #[test]
    fn all_tidy_rules_compile_without_lookahead() {
        for rule in rules().iter().filter(|r| r.tidy_enabled) {
            compile_pattern(&rule.pattern, true)
                .unwrap_or_else(|e| panic!("tidy 规则 {} 不可编译: {e}", rule.key));
        }
    }

    #[test]
    fn translate_converts_unicode_escapes() {
        assert_eq!(translate_pattern("\\u3000+"), "\\u{3000}+");
        assert_eq!(translate_pattern("[\\x00-\\x08]"), "[\\x00-\\x08]");
        // 非十六进制跟随便：按字面保留
        assert_eq!(translate_pattern("\\uab"), "\\uab");
        // 非法路径不 panic（防御性）
        assert_eq!(translate_pattern("\\q"), "\\q");
    }
}
