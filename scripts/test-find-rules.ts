/**
 * 规则表迁移校验（阶段 3.1 数据部分）
 * 1) 与 Python 旧项目 `tidy_rules._RULES` 逐条比对（key/名称/模式/替换/说明/顺序，6 条含转换类）
 * 2) 按 `searchEnabled` 口径比对：开启的条目必须与 Python `SEARCH_RULES` 完全一致
 * 3) 逐条验证正则可用；验证经 settings 服务落盘/读回与坏数据整组回落
 * 运行：npx tsx scripts/test-find-rules.ts
 */
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DEFAULT_FIND_RULES,
  DEFAULT_RULES,
  FIND_RULE_PLACEHOLDER
} from '../shared/findRules'
import type { FindRule } from '../shared/findRules'
import { readSettings, writeSettings } from '../electron/services/settingsStore'
import { DEFAULT_SETTINGS } from '../shared/types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`ok - ${message}`)
}

interface PythonRules {
  all: FindRule[]
  searchKeys: string[]
}

/** 直接从旧项目导出 `_RULES`（6 条）与 `SEARCH_RULES`（查找下拉子集） */
function dumpPythonRules(): PythonRules | null {
  const project = '/Users/Joey/Sites/Projects/NovelManager'
  if (!existsSync(join(project, 'novelmanager/services/tidy_rules.py'))) return null
  const code = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(project)})`,
    'from novelmanager.services.tidy_rules import _RULES, SEARCH_RULES',
    'def dump(r):',
    '    return {"key": r.key, "label": r.label, "pattern": r.pattern,',
    '            "description": r.description, "replacement": r.replacement}',
    'print(json.dumps({"all": [dump(r) for r in _RULES],',
    '                  "searchKeys": [r.key for r in SEARCH_RULES]}, ensure_ascii=False))'
  ].join('\n')
  const out = spawnSync('python3', ['-c', code], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`调用 python3 导出旧规则失败: ${out.stderr}`)
  return JSON.parse(out.stdout) as PythonRules
}

function sameRule(a: Omit<FindRule, 'searchEnabled'>, b: FindRule): boolean {
  return (
    a.key === b.key &&
    a.label === b.label &&
    a.pattern === b.pattern &&
    a.description === b.description &&
    a.replacement === b.replacement
  )
}

// 1) 与 Python _RULES 逐条一致（顺序即数组顺序，含转换类第 6 条）
const python = dumpPythonRules()
if (python) {
  assert(
    python.all.length === DEFAULT_RULES.length,
    `规则表条目数一致（旧 ${python.all.length} / 新 ${DEFAULT_RULES.length}）`
  )
  python.all.forEach((rule, index) => {
    const mine = DEFAULT_RULES[index]
    assert(
      mine !== undefined && sameRule(rule, mine),
      `第 ${index + 1} 条与旧项目一致：${rule.key}「${rule.label}」`
    )
  })
  const enabledKeys = DEFAULT_RULES.filter((rule) => rule.searchEnabled).map((rule) => rule.key)
  assert(
    enabledKeys.join(',') === python.searchKeys.join(','),
    `开关口径与旧项目 SEARCH_RULES 一致（${python.searchKeys.length} 条进下拉）`
  )
} else {
  console.log('skip - 本机无 NovelManager 旧项目，跳过逐条导出比对（下方字面量断言仍覆盖内容）')
}

// 2) 字面量断言：顺序、开关分布、占位项
assert(
  DEFAULT_RULES.map((r) => r.key).join(',') ===
    'extract_chapters,blank_lines,multiple_spaces,illegal_chars,dialogue,to_halfwidth',
  '规则表顺序与 Python _RULES 一致（转换类排在最后）'
)
assert(
  DEFAULT_RULES.filter((r) => r.searchEnabled).length === 5 &&
    DEFAULT_RULES.find((r) => r.key === 'to_halfwidth')?.searchEnabled === false,
  '只有「全角转半角」的 searchEnabled 为 false，其余 5 条为 true'
)
assert(
  DEFAULT_FIND_RULES.length === 5 && !DEFAULT_FIND_RULES.some((r) => r.key === 'to_halfwidth'),
  '查找下拉子集不含「全角转半角」'
)
assert(
  FIND_RULE_PLACEHOLDER === '常用正则…',
  '下拉首项占位文本为「常用正则…」，默认选中它即不套用规则'
)
assert(
  new Set(DEFAULT_RULES.map((r) => r.key)).size === DEFAULT_RULES.length,
  'key 无重复'
)

// 3) 正则按迁移后的字符串实际可用
function matches(key: string, text: string): boolean {
  const rule = DEFAULT_RULES.find((r) => r.key === key)!
  return new RegExp(rule.pattern, 'm').test(text)
}
assert(matches('extract_chapters', '　　第一章 起点'), '章节规则命中缩进章节行')
assert(matches('extract_chapters', '番外 一'), '章节规则命中番外行')
assert(!matches('extract_chapters', '他说第一章的故事结束了'), '章节规则只认行首，不命中正文中间')
assert(matches('blank_lines', '正文\n\n\n\n正文'), '空行规则命中连续三个以上换行')
assert(matches('multiple_spaces', '甲  \t乙'), '空格规则命中连续半角空白')
assert(matches('illegal_chars', '正文\u200b正文'), '非法字符规则命中零宽空格')
assert(matches('dialogue', '他说：「走。」然后'), '对话规则命中直角引号内容')
assert(matches('to_halfwidth', 'ＡＢＣ１２３＋－'), '全角转半角规则命中全角字母数字加减号')

const replacementOf = (key: string): string | null =>
  DEFAULT_RULES.find((r) => r.key === key)!.replacement
assert(replacementOf('blank_lines') === '\n\n', '空行规则替换为单个空行')
assert(replacementOf('multiple_spaces') === '\u3000', '空格规则替换为全角空格')
assert(replacementOf('illegal_chars') === '', '非法字符规则替换为空串')
assert(
  replacementOf('extract_chapters') === null &&
    replacementOf('dialogue') === null &&
    replacementOf('to_halfwidth') === null,
  '纯查找/转换类规则不带替换文本'
)

// 4) 经 1.9 的 settings 服务读写：默认值直达、自定义条目原样保留、坏数据整组回落
const dir = mkdtempSync(join(tmpdir(), 'yue-find-rules-'))
try {
  const fresh = readSettings(dir)
  assert(fresh.rules.length === DEFAULT_RULES.length, '无 settings.json 时读回默认规则表')
  assert(
    fresh.rules.every((rule, i) => sameRule(DEFAULT_RULES[i], rule)),
    '默认规则表内容与迁移结果一致'
  )
  assert(
    fresh.rules.find((rule) => rule.key === 'to_halfwidth')?.searchEnabled === false,
    '默认落盘保留转换类的 searchEnabled=false'
  )
  assert(fresh.appearance === DEFAULT_SETTINGS.appearance, '新增字段不影响其他设置项默认值')

  const custom = fresh.rules.map((rule) =>
    rule.key === 'dialogue' ? { ...rule, label: '查找对白' } : rule
  )
  const written = writeSettings(dir, { ...fresh, rules: custom })
  assert(written.rules[4].label === '查找对白', '自定义规则经 settings:set 落盘')
  assert(readSettings(dir).rules[4].label === '查找对白', '重启后（重新读文件）自定义规则保留')

  // 旧版本 settings.json 没有 rules 字段：只回落该字段，其余设置保留
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ appearance: 'dark', sidebarWidth: 300, preloadCount: 3 }),
    'utf8'
  )
  const upgraded = readSettings(dir)
  assert(upgraded.rules.length === DEFAULT_RULES.length, '旧设置文件缺字段时补默认规则表')
  assert(
    upgraded.appearance === 'dark' && upgraded.sidebarWidth === 300 && upgraded.preloadCount === 3,
    '缺字段回落不重置其他设置'
  )

  // 旧字段名 findRules（5 条、无开关）不再读取，统一按默认 6 条表重建
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ findRules: [{ key: 'legacy' }] }), 'utf8')
  assert(readSettings(dir).rules.length === DEFAULT_RULES.length, '旧字段 findRules 不再生效，回落默认规则表')

  // 坏条目（pattern / searchEnabled 类型不对）：整组回落，避免半份规则进入下拉与转换菜单
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      rules: [
        { key: 'x', label: 'x', pattern: 'x', description: '', replacement: null, searchEnabled: 'yes' }
      ]
    }),
    'utf8'
  )
  const broken = readSettings(dir)
  assert(
    broken.rules.length === DEFAULT_RULES.length && broken.rules[0].key === 'extract_chapters',
    '条目结构非法时整组回落默认值'
  )

  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ rules: [] }), 'utf8')
  assert(readSettings(dir).rules.length === DEFAULT_RULES.length, '空规则数组回落默认值')

  writeFileSync(join(dir, 'settings.json'), '{ 坏 JSON', 'utf8')
  assert(readSettings(dir).rules.length === DEFAULT_RULES.length, 'JSON 损坏时回落默认值')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('all find-rule checks passed')
