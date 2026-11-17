/**
 * 常用正则（查找框下拉的预置条目）
 * 逐条对齐 NovelManager `novelmanager/services/tidy_rules.py` 的 `SEARCH_RULES`：
 * key / 名称 / 模式 / 替换文本 / 说明 / 顺序完全一致（Python 为功能基线，AGENTS.md）。
 * 转换类规则（全角转半角）按 Python 注释「不放进查找下拉」，留给阶段 3.2 的一键整理。
 */
export interface FindRule {
  key: string
  label: string
  pattern: string
  description: string
  /** 选中后填入替换框的文本；null = 不填（只查找不替换） */
  replacement: string | null
}

/** 下拉首项占位文本：默认选中即它，不套用任何规则（对齐 Python `addItem("常用正则…", None)`） */
export const FIND_RULE_PLACEHOLDER = '常用正则…'

/** 与 Python `SEARCH_RULES` 同序同内容 */
export const DEFAULT_FIND_RULES: readonly FindRule[] = [
  {
    key: 'extract_chapters',
    label: '提取章节目录',
    pattern:
      '^[ \\t\\u3000]*(?:第[0-9零〇一二三四五六七八九十百千万两]+[章回节卷集部篇][^\\n]*|序章[^\\n]*|楔子[^\\n]*|卷首[^\\n]*|尾声[^\\n]*|后记[^\\n]*|番外[^\\n]*)$',
    description: '匹配章、回、节、卷等标题行，用于查看或提取目录。',
    replacement: null
  },
  {
    key: 'blank_lines',
    label: '查找多余空行',
    pattern: '(?:[ \\t\\u3000]*\\n){3,}',
    description: '连续三个及以上换行视为多余空行，整理时压缩为一个空行。',
    replacement: '\n\n'
  },
  {
    key: 'multiple_spaces',
    label: '查找多个空格',
    pattern: '[ \\t]{2,}',
    description: '匹配连续两个及以上的半角空格或制表符。',
    replacement: '\u3000'
  },
  {
    key: 'illegal_chars',
    label: '查找非法／乱码字符',
    pattern: '[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\u200b-\\u200f\\ufeff\\ufffd]',
    description: '匹配控制字符、零宽字符与替换符（乱码常见形态）。',
    replacement: ''
  },
  {
    key: 'dialogue',
    label: '查找对话内容',
    pattern: '[“"「『][^”"」』\\n]*[”"」』]',
    description: '匹配中文引号或直角引号包裹的对话内容。',
    replacement: null
  }
]

/** 复制一份可变副本：默认值只读，落盘与请求都要独立对象，避免调用方改到共享常量 */
export function cloneFindRules(rules: readonly FindRule[] = DEFAULT_FIND_RULES): FindRule[] {
  return rules.map((rule) => ({ ...rule }))
}
