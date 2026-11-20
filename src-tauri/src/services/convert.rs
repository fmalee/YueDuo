//! 文本转换（方案 §3.2）：全角半角、OpenCC 简繁、一键整理。
//! 纯 Rust 业务（不依赖 tauri 类型），词表目录由调用方传入（打包 resource_dir / 开发仓库根）。
//!
//! 简繁策略（对齐 electron/services/chineseConvert.ts，改顺序会改变结果）：
//! 1. 保护词整词跳过（keep.txt）→ 2. 词组最长匹配（phrases）→ 3. 单字一对一（characters
//! 首候选）→ 4. 一字多义且 ambiguous.txt 收录的保留原字并计数。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;

use crate::services::find_rules::{self, FindRule};
use crate::types::{ConvertResult, TidyResult};

// ---------- 替换模板展开（对齐 shared/replaceTemplate.ts，一键整理与查找替换同语义） ----------

/// `\n` → 换行、`\t` → 制表符、`\\` → 单反斜杠，其余反斜杠序列按字面保留（不重扫展开结果）。
fn unescape_template(template: &str) -> String {
    if !template.contains('\\') {
        return template.to_string();
    }
    let mut result = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            result.push(ch);
            continue;
        }
        match chars.peek() {
            None => result.push('\\'), // 末尾孤立的 `\`
            Some('n') => {
                result.push('\n');
                chars.next();
            }
            Some('t') => {
                result.push('\t');
                chars.next();
            }
            Some('\\') => {
                result.push('\\');
                chars.next();
            }
            Some(_) => result.push('\\'), // `\` 按字面，后续字符照常扫描
        }
    }
    result
}

/// `$1`–`$9` 捕获组、`$&`/`$0` 整个匹配、`$$` 字面 `$`；越界/多位数/未闭合按字面。
/// `groups[0]` 是整个匹配；组未参与匹配按空串（与 JS String.replace 一致）。
fn expand_groups(template: &str, groups: &[Option<&str>]) -> String {
    let whole = groups.first().copied().flatten().unwrap_or("");
    let mut result = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '$' {
            result.push(ch);
            continue;
        }
        match chars.peek() {
            None => result.push('$'), // 末尾孤立的 `$`
            Some('$') => {
                result.push('$');
                chars.next();
            }
            Some('&') => {
                result.push_str(whole);
                chars.next();
            }
            Some(c) if c.is_ascii_digit() => {
                let digit = *c;
                // 只认单位数组号：`$10` 这类多位数整体按字面（先把 `$` 吐回去）
                let mut iter = chars.clone();
                iter.next(); // 跳过当前数字
                if iter.peek().is_some_and(|n| n.is_ascii_digit()) {
                    result.push('$');
                    continue;
                }
                let index = digit.to_digit(10).unwrap() as usize;
                if index < groups.len() {
                    result.push_str(groups[index].unwrap_or(""));
                } else {
                    result.push('$');
                    result.push(digit);
                }
                chars.next();
            }
            Some(_) => result.push('$'), // `$` 按字面，后续字符照常扫描
        }
    }
    result
}

/// 一次展开入口 = 先转义展开再分组展开（对齐 TS expandReplacement）
pub fn expand_replacement(template: &str, groups: &[Option<&str>]) -> String {
    expand_groups(&unescape_template(template), groups)
}

// ---------- 全角转半角（对齐 electron/services/textConvert.ts） ----------

/// 只换规则表 to_halfwidth 命中的全角字母、数字与加减号；
/// 全角空格是正文缩进依据、中文标点没有对应半角，两者都不在规则内。
pub fn to_halfwidth(text: &str) -> Result<ConvertResult, String> {
    let rule: &'static FindRule =
        find_rules::rule_by_key("to_halfwidth").ok_or("规则表缺少 to_halfwidth")?;
    let re = find_rules::compile_pattern(&rule.pattern, false)?;
    let text = re
        .replace_all(text, |caps: &regex::Captures| {
            let m = caps.get(0).unwrap().as_str();
            match m.chars().next() {
                // 模式是单字符类：每个匹配恰一个全角字符
                Some(c) => char::from_u32(c as u32 - 0xfee0)
                    .map(|half| half.to_string())
                    .unwrap_or_else(|| m.to_string()),
                None => m.to_string(),
            }
        })
        .into_owned();
    Ok(ConvertResult {
        text,
        kept: 0,
        kept_words: 0,
    })
}

// ---------- 简繁转换（对齐 electron/services/chineseConvert.ts） ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Direction {
    /// 简转繁（st_characters / st_phrases）
    S2T,
    /// 繁转简（ts_characters / ts_phrases）
    T2S,
}

/// 按码位逐层建树；匹配时也按码位走，扩展区汉字（如 𫔭）才能与词表对齐
#[derive(Default)]
struct TrieNode {
    children: HashMap<char, TrieNode>,
    value: Option<String>,
}

impl TrieNode {
    fn insert(&mut self, source: &str, target: String) {
        let mut node = self;
        for ch in source.chars() {
            node = node.children.entry(ch).or_default();
        }
        node.value = Some(target);
    }

    /// 从 chars[start] 起找最长命中，返回 [命中长度(字符数), 目标词]
    fn longest_match(&self, chars: &[char], start: usize) -> Option<(usize, String)> {
        let mut node = self;
        let mut best: Option<(usize, String)> = None;
        for (offset, ch) in chars[start..].iter().enumerate() {
            node = node.children.get(ch)?;
            if let Some(value) = &node.value {
                best = Some((offset + 1, value.clone()));
            }
        }
        best
    }
}

struct DictTable {
    /// 一对一单字映射
    unique: HashMap<char, String>,
    /// 一对多且无法脱离上下文判断的字：保留原字
    ambiguous: HashSet<char>,
    keep: TrieNode,
    phrases: TrieNode,
}

/// 读取 OpenCC 词表：每行 `源<TAB>候选1 候选2 …`，# 开头为注释
fn read_entries(dict_dir: &Path, file_name: &str) -> Result<Vec<(String, Vec<String>)>, String> {
    let path = dict_dir.join(file_name);
    let raw = std::fs::read_to_string(&path)
        .map_err(|_| format!("缺少简繁转换词表：{}", path.display()))?;
    let mut entries = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((source, rest)) = line.split_once('\t') else {
            continue;
        };
        let candidates: Vec<String> = rest.split_whitespace().map(String::from).collect();
        if !source.is_empty() {
            if let Some(first) = candidates.first() {
                if !first.is_empty() {
                    entries.push((source.to_string(), candidates));
                }
            }
        }
    }
    Ok(entries)
}

fn read_lines(dict_dir: &Path, file_name: &str) -> Vec<String> {
    std::fs::read_to_string(dict_dir.join(file_name))
        .map(|raw| {
            raw.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('#'))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

fn build_table(direction: Direction, dict_dir: &Path) -> Result<DictTable, String> {
    let (char_file, phrase_file) = match direction {
        Direction::S2T => ("st_characters.txt", "st_phrases.txt"),
        Direction::T2S => ("ts_characters.txt", "ts_phrases.txt"),
    };
    let ambiguous_chars: HashSet<String> = read_lines(dict_dir, "ambiguous.txt")
        .iter()
        .flat_map(|line| line.split_whitespace().map(String::from))
        .collect();
    let mut unique = HashMap::new();
    let mut ambiguous = HashSet::new();
    for (source, candidates) in read_entries(dict_dir, char_file)? {
        let Some(ch) = source.chars().next().filter(|_| source.chars().count() == 1) else {
            continue; // 单字表只收单字（防御性，词表本身如此）
        };
        if candidates.len() == 1 {
            unique.insert(ch, candidates[0].clone());
        } else if ambiguous_chars.contains(&source) {
            // 一字多义且词组表判断不了 → 保留原字，由调用方计数告知用户
            ambiguous.insert(ch);
        } else {
            // 多出的候选只是生僻异体（开／𫔭），按词表首选项转换
            unique.insert(ch, candidates[0].clone());
        }
    }
    let mut phrases = TrieNode::default();
    for (source, candidates) in read_entries(dict_dir, phrase_file)? {
        if let Some(first) = candidates.first() {
            phrases.insert(&source, first.clone());
        }
    }
    let mut keep = TrieNode::default();
    for word in read_lines(dict_dir, "keep.txt") {
        keep.insert(&word, word.clone());
    }
    Ok(DictTable {
        unique,
        ambiguous,
        keep,
        phrases,
    })
}

/// 词表缓存（单方向一次加载；词表目录在进程内不变，首建后复用）
fn table(direction: Direction, dict_dir: &Path) -> Result<&'static DictTable, String> {
    static S2T: OnceLock<DictTable> = OnceLock::new();
    static T2S: OnceLock<DictTable> = OnceLock::new();
    let cell = match direction {
        Direction::S2T => &S2T,
        Direction::T2S => &T2S,
    };
    if let Some(t) = cell.get() {
        return Ok(t);
    }
    let built = build_table(direction, dict_dir)?;
    let _ = cell.set(built); // 竞争时两份内容一致，取胜者即可
    Ok(cell.get().ok_or("词表加载竞争失败")?)
}

/// 简繁转换核心（策略顺序见模块注释）
pub fn convert(text: &str, direction: Direction, dict_dir: &Path) -> Result<ConvertResult, String> {
    if text.is_empty() {
        return Ok(ConvertResult {
            text: text.to_string(),
            kept: 0,
            kept_words: 0,
        });
    }
    let table = table(direction, dict_dir)?;
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() * 2);
    let mut kept: i64 = 0;
    let mut kept_words: i64 = 0;
    let mut index = 0usize;
    while index < chars.len() {
        if let Some((len, target)) = table.keep.longest_match(&chars, index) {
            out.push_str(&target);
            index += len;
            kept_words += 1;
            continue;
        }
        if let Some((len, target)) = table.phrases.longest_match(&chars, index) {
            out.push_str(&target);
            index += len;
            continue;
        }
        let ch = chars[index];
        match table.unique.get(&ch) {
            Some(target) => out.push_str(target),
            None => {
                out.push(ch);
                if table.ambiguous.contains(&ch) {
                    kept += 1;
                }
            }
        }
        index += 1;
    }
    Ok(ConvertResult {
        text: out,
        kept,
        kept_words,
    })
}

/// 简转繁（标准字形）
pub fn to_traditional(text: &str, dict_dir: &Path) -> Result<ConvertResult, String> {
    convert(text, Direction::S2T, dict_dir)
}

/// 繁转简（标准字形）
pub fn to_simplified(text: &str, dict_dir: &Path) -> Result<ConvertResult, String> {
    convert(text, Direction::T2S, dict_dir)
}

// ---------- 一键整理（对齐 electron/services/tidy.ts） ----------

/// 一键整理固定顺序：
/// 1. 归一换行（原版另有工作编码 UTF-16LE 往返——Rust String 已保证合法 Unicode，恒等，略）
/// 2. 繁转简（含保护词）
/// 3. 全角转半角（以 to_halfwidth 规则为准）
/// 4. 按 findRules.json 数组顺序执行 tidyEnabled 的规则
/// 替换模板走与查找替换栏同一个展开入口；缺替换文本的条目跳过并记 warning。
pub fn tidy(text: &str, dict_dir: &Path) -> Result<TidyResult, String> {
    let mut result = text.replace("\r\n", "\n").replace('\r', "\n");
    let converted = to_simplified(&result, dict_dir)?;
    result = converted.text;
    result = to_halfwidth(&result)?.text;
    // 预编译 tidy 规则（转义展开一次完成；分组展开依赖每个匹配，替换时进行）
    let mut steps: Vec<(regex::Regex, String)> = Vec::new();
    for rule in find_rules::rules().iter().filter(|r| r.tidy_enabled) {
        let Some(replacement) = &rule.replacement else {
            eprintln!("[tidy] 规则「{}」已开启整理但没有替换文本，已跳过", rule.key);
            continue;
        };
        let re = find_rules::compile_pattern(&rule.pattern, true)?;
        steps.push((re, unescape_template(replacement)));
    }
    for (re, template) in steps {
        result = re
            .replace_all(&result, |caps: &regex::Captures| {
                let groups: Vec<Option<&str>> = (0..caps.len())
                    .map(|i| caps.get(i).map(|m| m.as_str()))
                    .collect();
                expand_groups(&template, &groups)
            })
            .into_owned();
    }
    Ok(TidyResult {
        text: result,
        convert_kept: converted.kept,
        convert_kept_words: converted.kept_words,
    })
}

// ---------- 单测 ----------

#[cfg(test)]
mod tests {
    use super::*;

    /// 开发态词表目录（与 commands 层的探测顺序一致）
    fn dict_dir() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/dicts")
    }

    #[test]
    fn expand_groups_semantics_match_js() {
        let groups = [Some("整匹配"), Some("甲"), None];
        assert_eq!(expand_groups("[$1]", &groups), "[甲]");
        assert_eq!(expand_groups("[$2]", &groups), "[]"); // 未参与匹配 → 空串
        assert_eq!(expand_groups("[$3]", &groups), "[$3]"); // 越界按字面
        assert_eq!(expand_groups("[$10]", &groups), "[$10]"); // 多位数整体按字面
        assert_eq!(expand_groups("[$&]", &groups), "[整匹配]");
        assert_eq!(expand_groups("[$0]", &groups), "[整匹配]");
        assert_eq!(expand_groups("[$$]", &groups), "[$]");
        assert_eq!(expand_groups("[$]", &groups), "[$]"); // 未闭合按字面
    }

    #[test]
    fn unescape_template_semantics_match_js() {
        assert_eq!(unescape_template("a\\nb"), "a\nb");
        assert_eq!(unescape_template("a\\tb"), "a\tb");
        assert_eq!(unescape_template("a\\\\b"), "a\\b");
        assert_eq!(unescape_template("a\\qb"), "a\\qb"); // 其余序列按字面
        assert_eq!(unescape_template("a\\"), "a\\"); // 末尾孤立反斜杠
        assert_eq!(expand_replacement("$1\\n$2", &[Some("w"), Some("x"), Some("y")]), "x\ny");
    }

    #[test]
    fn halfwidth_converts_letters_digits_signs_only() {
        let out = to_halfwidth("ａＢ１２＋－Ｚｚ，。　").unwrap();
        assert_eq!(out.text, "aB12+-Zz，。　"); // 全角空格与中文标点保留
        assert_eq!((out.kept, out.kept_words), (0, 0));
    }

    #[test]
    fn s2t_uses_phrase_then_char_and_keeps_ambiguous() {
        let dir = dict_dir();
        // 词组最长匹配：干部 → 幹部（单字「干」是多义保留字，词组表负责消歧）
        let out = to_traditional("干部", &dir).unwrap();
        assert_eq!(out.text, "幹部");
        assert_eq!(out.kept_words, 0);
        // 单字一对一
        let out = to_traditional("开", &dir).unwrap();
        assert_eq!(out.text, "開");
        // 多义字单看无法判断 → 保留原字并计数
        let out = to_traditional("干", &dir).unwrap();
        assert_eq!(out.text, "干");
        assert_eq!(out.kept, 1);
    }

    #[test]
    fn t2s_converts_standard_forms() {
        let dir = dict_dir();
        let out = to_simplified("幹部", &dir).unwrap();
        assert_eq!(out.text, "干部");
        let out = to_simplified("開級", &dir).unwrap();
        assert_eq!(out.text, "开级"); // 開 多候选取首项（开），級 单字
        assert_eq!((out.kept, out.kept_words), (0, 0));
    }

    #[test]
    fn tidy_pipeline_matches_electron_order() {
        // 输入不含词表汉字，转换步为恒等，期望值可用 node 复现原版管线逐字验证：
        // 归一换行 → 繁转简(恒等) → 半角(ＡＢＣ１２３→ABC123)
        // → 换行符规则(无 \r\n) → 段末不可见(行1尾「　」删除) → 多余空行(3 换行压缩 1)
        // → 转换缩进(\t → 　) → 制表符(无残留) → 波浪号(" ~ " → ～)
        // 注意：文末 \n 之后的「幻影行」同样被 add_indentation 加缩进（JS 原版同款行为），
        // 已用 node 对 `^[ \t\u3000]{0,}` gm 验证：'abc\n' → 'Xabc\nX'。
        let input = "　　Title ~ end　\r\n\r\n\r\n\tＡＢＣ１２３\n";
        let out = tidy(input, &dict_dir()).unwrap();
        assert_eq!(out.text, "　　Title～end\n　　ABC123\n　　");
        assert_eq!((out.convert_kept, out.convert_kept_words), (0, 0));
    }

    #[test]
    fn tidy_replacement_expands_groups() {
        // convert_dash：` *[—-]{2,} *` → `——`；注意 add_indentation 会给未缩进行加缩进
        // （规则描述「未缩进则增加缩进」，Electron 版行为一致）
        let input = "前--后\n\n\n\n续";
        let out = tidy(input, &dict_dir()).unwrap();
        assert_eq!(out.text, "　　前——后\n　　续");
    }
}
