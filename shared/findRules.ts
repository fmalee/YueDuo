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
    key: 'conver_chapters',
    label: '整理章节',
    pattern: '\u3000+(第.+章) +',
    description: '规范章节格式（空行+顶格）',
    replacement: '\\n\\n$1 ',
    tidyEnabled: false
  },
  {
    key: 'insert_space',
    label: '补充缩进',
    pattern: '^(\\S)',
    description: '给无缩进行增加全角空格缩进',
    replacement: '\u3000\u3000$1',
    tidyEnabled: false
  },
  {
    key: 'spliced_dialogue',
    label: '合并对话段落',
    pattern: '：\n\u3000+',
    description: '将冒号后面的段落合并上来',
    replacement: '：',
    tidyEnabled: false
  },
  {
    key: 'cover_dialogue',
    label: '转换逗号对话',
    pattern: '([说道])，“',
    description: '将对话前的逗号改为冒号',
    replacement: '$1：“',
    tidyEnabled: false
  },
  {
    key: 'spliced_paragraph',
    label: '拼接段落',
    pattern: '([^。！”……？])\\n\\u3000+([\u4e00-\u9fa5].*[^。！”……？])',
    description: '将顶格段落拼接到上一个段落',
    replacement: '$1$2',
    tidyEnabled: false
  },
  {
    key: 'delete_line_break',
    label: '删除换行',
    pattern: '\\n(\\S)\\n*(?!\\u3000)',
    description: '将顶格段落拼接到上一个段落',
    replacement: '\\n',
    tidyEnabled: false
  },
  {
    key: 'fix_dialogue',
    label: '修复对话标点',
    pattern: '“(((?!["“”＂『』「」]).)*?)“',
    description: '将顶格段落拼接到上一个段落',
    replacement: '“$1”',
    tidyEnabled: false
  },
  {
    key: 'find_space',
    label: '查找空格',
    pattern: '(\\S)[ \\t\\u3000]',
    description: '查找非行首的空格、制表符',
    replacement: '$1',
    tidyEnabled: false
  },
  {
    key: 'compact_space',
    label: '精简空格',
    pattern: ' {0,}([a-zA-Z0-9]{1,}) {0,}',
    description: '删除英文和数字左右两边的空格',
    replacement: '$1',
    tidyEnabled: false
  },

  {
    key: 'to_halfwidth',
    label: '全角转半角',
    pattern: '[ａ-ｚＡ-Ｚ０-９＋－]',
    description: '把全角字母、数字与加减号转为半角，保留全角空格与中文标点。',
    replacement: null,
    tidyEnabled: false
  },
  {
    key: 'illegal_chars',
    label: '查找非法／乱码字符',
    pattern: '[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\u200b-\\u200f\\ufeff\\ufffd]',
    description: '匹配控制字符、零宽字符与替换符（乱码常见形态）。',
    replacement: null,
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
    key: 'convert_line_break', // 一键整理规则
    label: '转换换行符',
    pattern: '\\r\\n',
    description: '将Windows换行转换为Linux换行',
    replacement: '\\n',
    tidyEnabled: true
  },
  {
    key: 'trailing_invisible', // 一键整理规则
    label: '删除段末不可见字符',
    pattern: '[ \\t\\u3000\\x0b\\x0c\\u00a0\\u200b-\\u200f\\ufeff]+$',
    description: '删除段落末尾的空格、制表符、全角空格与零宽等不可见字符',
    replacement: '',
    tidyEnabled: true
  },
  {
    key: 'blank_lines', // 一键整理规则
    label: '删除多余空行',
    pattern: '(?:[ \\t\\u3000]*\\n){2,}',
    description: '连续两个及以上换行视为多余空行，压缩为一个空行。',
    replacement: '\\n',
    tidyEnabled: true
  },
  {
    key: 'add_indentation', // 一键整理规则
    label: '转换缩进',
    pattern: '^[ \\t\\u3000]{0,}',
    description: '将空格和制表符缩进转换全角空格缩进，未缩进则增加缩进',
    replacement: '\u3000\u3000',
    tidyEnabled: true
  },
  {
    key: 'tab_to_space', // 一键整理规则
    label: '转换制表符',
    pattern: '\\t',
    description: '将制表符转换为空格',
    replacement: ' ',
    tidyEnabled: true
  },
  {
    key: 'convert_tilde', // 一键整理规则
    label: '转换波浪号',
    pattern: ' *~ *',
    description: '将英文波浪号转换为中文波浪号',
    replacement: '～',
    tidyEnabled: true
  },
  {
    key: 'convert_dash', // 一键整理规则
    label: '转换破折号',
    pattern: ' *[—-]{2,} *',
    description: '将英文破折号转换为中文破折号，并补全',
    replacement: '——',
    tidyEnabled: true
  },
  {
    key: 'convert_ellipsis', // 一键整理规则
    label: '转换省略号',
    pattern: ' *[。\\.]{3,} *',
    description: '将多个句号点号转为省略号，并删除前后空格',
    replacement: '……',
    tidyEnabled: true
  },
  {
    key: 'fix_ellipsis', // 一键整理规则
    label: '补全省略号',
    pattern: ' *…+ *',
    description: '将半个省略号补全，并删除前后空格',
    replacement: '……',
    tidyEnabled: true
  },
  {
    key: 'convert_separator', // 一键整理规则
    label: '转换分割符',
    pattern: '\u3000+[＊*—]{2,}',
    description: '将段落间的分割符统一为省略号',
    replacement: '\u3000\u3000……',
    tidyEnabled: true
  }
]
