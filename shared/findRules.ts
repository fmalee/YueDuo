/**
 * 查找/转换规则表（常用正则）
 * 6 条规则与 NovelManager `tidy_rules._RULES` 同序，前 5 条进查找下拉，
 * 第 6 条「全角转半角」是转换类规则，只在右键「转换」菜单里出现。
 *
 * 关于 `searchEnabled`：旧版没有「是否出现在查找下拉」的字段——
 * Python 的 `SEARCH_RULES` 是手写元组，Vue 版则是 6 条平铺数组；
 * 旧版已有的开关式字段是 Python `SearchRule.tidy_enabled`（布尔、默认关闭、
 * 只执行显式开启的规则），这里沿用同一命名与语义风格补 `searchEnabled`：
 * 布尔、默认开启、只有转换类规则显式关闭。
 */
export interface FindRule {
  key: string
  label: string
  pattern: string
  description: string
  /** 选中后填入替换框的文本；null = 不填（纯查找或由代码按字符区间换算） */
  replacement: string | null
  /** 是否出现在查找框的常用正则下拉（false = 只进右键转换菜单） */
  searchEnabled: boolean
}

/** 下拉首项占位文本：默认选中即它，不套用任何规则（对齐 Python `addItem("常用正则…", None)`） */
export const FIND_RULE_PLACEHOLDER = '常用正则…'

/** 与 Python `_RULES` 同序同内容（含转换类规则） */
export const DEFAULT_RULES: readonly FindRule[] = [
  {
    key: 'extract_chapters',
    label: '提取章节目录',
    pattern:
      '^[ \\t\\u3000]*(?:第[0-9零〇一二三四五六七八九十百千万两]+[章回节卷集部篇][^\\n]*|序章[^\\n]*|楔子[^\\n]*|卷首[^\\n]*|尾声[^\\n]*|后记[^\\n]*|番外[^\\n]*)$',
    description: '匹配章、回、节、卷等标题行，用于查看或提取目录。',
    replacement: null,
    searchEnabled: true
  },
  {
    key: 'blank_lines',
    label: '查找多余空行',
    pattern: '(?:[ \\t\\u3000]*\\n){3,}',
    description: '连续三个及以上换行视为多余空行，整理时压缩为一个空行。',
    replacement: '\n\n',
    searchEnabled: true
  },
  {
    key: 'multiple_spaces',
    label: '查找多个空格',
    pattern: '[ \\t]{2,}',
    description: '匹配连续两个及以上的半角空格或制表符。',
    replacement: '\u3000',
    searchEnabled: true
  },
  {
    key: 'illegal_chars',
    label: '查找非法／乱码字符',
    pattern: '[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\u200b-\\u200f\\ufeff\\ufffd]',
    description: '匹配控制字符、零宽字符与替换符（乱码常见形态）。',
    replacement: '',
    searchEnabled: true
  },
  {
    key: 'dialogue',
    label: '查找对话内容',
    pattern: '[“"「『][^”"」』\\n]*[”"」』]',
    description: '匹配中文引号或直角引号包裹的对话内容。',
    replacement: null,
    searchEnabled: true
  },
  {
    key: 'to_halfwidth',
    label: '全角转半角',
    pattern: '[ａ-ｚＡ-Ｚ０-９＋－]',
    description: '把全角字母、数字与加减号转为半角，保留全角空格与中文标点。',
    replacement: null,
    searchEnabled: false
  }
]

/** 查找下拉使用的子集（等价 Python `SEARCH_RULES`） */
export const DEFAULT_FIND_RULES: readonly FindRule[] = DEFAULT_RULES.filter(
  (rule) => rule.searchEnabled
)

/** 复制一份可变副本：默认值只读，落盘与请求都要独立对象，避免调用方改到共享常量 */
export function cloneRules(rules: readonly FindRule[] = DEFAULT_RULES): FindRule[] {
  return rules.map((rule) => ({ ...rule }))
}
