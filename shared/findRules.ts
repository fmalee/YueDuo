/**
 * 查找 / 一键整理规则表（唯一规则源，方案 §3.2）
 * 数组顺序即一键整理的执行顺序：只跑 tidyEnabled 为 true 的条目，其余仅出现在查找下拉。
 * 增删改规则只改这里，不要在 tidy.ts 里另写固定步骤。
 */
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
 * 顺序即整理顺序：
 * 删除段末不可见字符 → 多个空格转全角 → 半角空格与制表符转全角 → 删除多余空行
 * → 非法字符 → 提取章节目录 → 查找对话 → 全角转半角
 * 默认开启整理的只有「删除段末不可见字符」和「删除多余空行」，其余按需自行开启。
 */
export const DEFAULT_RULES: readonly FindRule[] = [
  {
    key: 'trailing_invisible',
    label: '删除段末不可见字符',
    pattern: '[ \\t\\u3000\\x0b\\x0c\\u00a0\\u200b-\\u200f\\ufeff]+$',
    description: '删除段落末尾的空格、制表符、全角空格与零宽等不可见字符。',
    replacement: '',
    tidyEnabled: true
  },
  {
    key: 'multiple_spaces',
    label: '多个空格转全角',
    pattern: '[ \\t]{2,}',
    description: '连续两个及以上的半角空格或制表符替换为一个全角空格。',
    replacement: '\u3000',
    tidyEnabled: false
  },
  {
    key: 'halfwidth_spaces',
    label: '半角空格与制表符转全角',
    pattern: '[ \\t]',
    description: '半角空格与制表符逐字替换为全角空格，用于缩进全角化。',
    replacement: '\u3000',
    tidyEnabled: false
  },
  {
    key: 'blank_lines',
    label: '删除多余空行',
    pattern: '(?:[ \\t\\u3000]*\\n){3,}',
    description: '连续三个及以上换行视为多余空行，压缩为一个空行。',
    replacement: '\n\n',
    tidyEnabled: true
  },
  {
    key: 'illegal_chars',
    label: '查找非法／乱码字符',
    pattern: '[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\u200b-\\u200f\\ufeff\\ufffd]',
    description: '匹配控制字符、零宽字符与替换符（乱码常见形态）。',
    replacement: '',
    tidyEnabled: false
  },
  {
    key: 'extract_chapters',
    label: '提取章节目录',
    pattern:
      '^[ \\t\\u3000]*(?:第[0-9零〇一二三四五六七八九十百千万两]+[章回节卷集部篇][^\\n]*|序章[^\\n]*|楔子[^\\n]*|卷首[^\\n]*|尾声[^\\n]*|后记[^\\n]*|番外[^\\n]*)$',
    description: '匹配章、回、节、卷等标题行，用于查看或提取目录。',
    replacement: null,
    tidyEnabled: false
  },
  {
    key: 'dialogue',
    label: '查找对话内容',
    pattern: '[“"「『][^”"」』\\n]*[”"」』]',
    description: '匹配中文引号或直角引号包裹的对话内容。',
    replacement: null,
    tidyEnabled: false
  },
  {
    key: 'to_halfwidth',
    label: '全角转半角',
    pattern: '[ａ-ｚＡ-Ｚ０-９＋－]',
    description: '把全角字母、数字与加减号转为半角，保留全角空格与中文标点。',
    replacement: null,
    tidyEnabled: false
  }
]
