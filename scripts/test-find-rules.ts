/**
 * 规则表校验（阶段 3.2 口径）
 * 1) 8 条规则的内容、数组顺序（顺序即一键整理顺序）与默认 tidyEnabled 分布
 * 2) 逐条验证正则可用；新增「删段末不可见字符」「半角空格与制表符转全角」的命中与替换
 * 3) 一键整理默认只跑 tidyEnabled 的条目：删段末不可见字符、删多余空行
 * 4) 规则表不再进 settings.json：旧文件 rules 字段读取时忽略，其余设置与坏数据回落不受影响
 * 运行：npx tsx scripts/test-find-rules.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_RULES, FIND_RULE_PLACEHOLDER } from '../shared/findRules'
import { readSettings, writeSettings } from '../electron/services/settingsStore'
import type { AppSettings } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'
import { tidyText } from '../electron/services/tidy'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`ok - ${message}`)
}

const rule = (key: string): (typeof DEFAULT_RULES)[number] => {
  const found = DEFAULT_RULES.find((item) => item.key === key)
  if (!found) throw new Error(`缺少规则: ${key}`)
  return found
}

function matches(key: string, text: string): boolean {
  return new RegExp(rule(key).pattern, 'm').test(text)
}

// 1) 顺序与默认开关
assert(
  DEFAULT_RULES.map((r) => r.key).join(',') ===
    'trailing_invisible,multiple_spaces,halfwidth_spaces,blank_lines,illegal_chars,extract_chapters,dialogue,to_halfwidth',
  '规则表顺序与方案一致（顺序即整理顺序）'
)
assert(
  DEFAULT_RULES.filter((r) => r.tidyEnabled)
    .map((r) => r.key)
    .join(',') === 'trailing_invisible,blank_lines',
  '默认只开启「删段末不可见字符」「删除多余空行」两条整理规则'
)
assert(
  DEFAULT_RULES.filter((r) => r.key !== 'trailing_invisible' && r.key !== 'blank_lines').every(
    (r) => !r.tidyEnabled
  ),
  '其余规则默认只进查找、不参与整理（to_halfwidth 未锁定）'
)
assert(FIND_RULE_PLACEHOLDER === '常用正则…', '下拉首项占位文本为「常用正则…」')
assert(new Set(DEFAULT_RULES.map((r) => r.key)).size === DEFAULT_RULES.length, 'key 无重复')

// 2) 正则与替换文本
assert(matches('trailing_invisible', '正文　  \u200b'), '段末不可见字符规则命中全角空格/零宽')
assert(!matches('trailing_invisible', '正文  \u200b后文'), '段末规则只认行尾')
assert(rule('trailing_invisible').replacement === '', '段末不可见字符规则替换为空串')
assert(matches('halfwidth_spaces', '甲 乙\t丙'), '半角空格与制表符规则命中半角空白')
assert(rule('halfwidth_spaces').replacement === '\u3000', '半角空白规则替换为全角空格')
assert(matches('multiple_spaces', '甲  \t乙'), '多个空格规则命中连续半角空白')
assert(rule('multiple_spaces').replacement === '\u3000', '多个空格规则替换为全角空格')
assert(matches('blank_lines', '正文\n\n\n\n正文'), '空行规则命中连续三个以上换行')
assert(rule('blank_lines').replacement === '\n\n', '空行规则替换为单个空行')
assert(matches('illegal_chars', '正文\u200b正文'), '非法字符规则命中零宽空格')
assert(rule('illegal_chars').replacement === '', '非法字符规则替换为空串')
assert(matches('extract_chapters', '　　第一章 起点'), '章节规则命中缩进章节行')
assert(!matches('extract_chapters', '他说第一章的故事结束了'), '章节规则只认行首')
assert(matches('dialogue', '他说：「走。」然后'), '对话规则命中直角引号内容')
assert(matches('to_halfwidth', 'ＡＢＣ１２３＋－'), '全角转半角规则命中全角字母数字加减号')
assert(
  rule('extract_chapters').replacement === null &&
    rule('dialogue').replacement === null &&
    rule('to_halfwidth').replacement === null,
  '纯查找/转换类规则不带替换文本（整理时跳过）'
)

// 3) 一键整理默认行为
assert(
  tidyText('正文  \u200b\n\n\n\n下一段').text === '正文\n\n下一段',
  '默认整理执行删段末不可见字符与删多余空行'
)
assert(tidyText('甲 乙\t丙').text === '甲 乙\t丙', '半角空白默认不转全角（规则未开启）')
assert(tidyText('ＡＢＣ１２３').text === 'ABC123', '全角字母数字按固定步骤转半角')

// 4) settings 不再持久化规则表
const dir = mkdtempSync(join(tmpdir(), 'yue-find-rules-'))
try {
  const fresh = readSettings(dir)
  assert(!('rules' in fresh), '设置对象不再包含 rules 字段')
  assert(fresh.appearance === DEFAULT_SETTINGS.appearance, '缺文件时其余设置项按默认值')

  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      appearance: 'dark',
      sidebarWidth: 300,
      preloadCount: 3,
      rules: [{ key: 'legacy', searchEnabled: true }]
    }),
    'utf8'
  )
  const legacy = readSettings(dir)
  assert(!('rules' in legacy), '旧设置文件里的 rules 字段读取时忽略')
  assert(
    legacy.appearance === 'dark' && legacy.sidebarWidth === 300 && legacy.preloadCount === 3,
    '忽略 rules 不影响其他设置项'
  )

  const written = writeSettings(dir, { ...legacy, closeButtonAlwaysVisible: true })
  assert(written.closeButtonAlwaysVisible === true, '写回设置正常')
  assert(!('rules' in readSettings(dir)), '写回后文件仍不包含规则表')

  writeFileSync(join(dir, 'settings.json'), '{ 坏 JSON', 'utf8')
  const broken = readSettings(dir) as AppSettings
  assert(!('rules' in broken) && broken.appearance === DEFAULT_SETTINGS.appearance, 'JSON 损坏回落默认值')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('all find-rule checks passed')
