/**
 * 查找 / 一键整理规则表（唯一规则源，方案 §3.2）
 * 规则数据在 findRules.json（TS 与 Rust 共用：Rust 侧 include_str! 嵌入）；
 * 本文件只提供类型与导出。数组顺序即一键整理的执行顺序：
 * 只跑 tidyEnabled 为 true 的条目，其余仅出现在查找下拉。
 * 增删改规则只改 findRules.json，不要在 tidy/convert 里另写固定步骤。
 */
import rulesJson from './findRules.json'

export interface FindRule {
  key: string
  label: string
  pattern: string
  description: string
  /** 选中后填入替换框的文本；null = 不填（纯查找或由代码按字符区间换算） */
  replacement: string | null
  /** 是否参与一键整理（按数组顺序执行）；false = 仅用于查找 */
  tidyEnabled: boolean
}

/** 下拉首项占位文本：默认选中即它，不套用任何规则（对齐 Python `addItem("常用正则…", None)`） */
export const FIND_RULE_PLACEHOLDER = '常用正则…'

/**
 * 顺序即整理顺序：删除段末不可见字符 → 多个空格转全角 → 半角空格与制表符转全角
 * → 删除多余空行 → 非法字符 → 提取章节目录 → 查找对话 → 全角转半角 → …
 * 默认开启整理的只有「转换换行符」「删除段末不可见字符」「删除多余空行」等
 * tidyEnabled: true 的条目，其余按需自行开启。
 */
export const DEFAULT_RULES: readonly FindRule[] = rulesJson
