/**
 * 常用正则迁移校验（阶段 3.1 数据部分）
 * 1) 与 Python 旧项目 `tidy_rules.SEARCH_RULES` 逐条比对（key/名称/模式/替换/说明/顺序）
 * 2) 逐条验证正则可用（模式字符串没有把转义写坏）
 * 3) 验证经 settings 服务落盘/读回、缺字段与坏数据回落默认值
 * 运行：npx tsx scripts/test-find-rules.ts
 */
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_FIND_RULES, FIND_RULE_PLACEHOLDER } from '../shared/findRules'
import type { FindRule } from '../shared/findRules'
import { readSettings, writeSettings } from '../electron/services/settingsStore'
import { DEFAULT_SETTINGS } from '../shared/types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`ok - ${message}`)
}

/** 从旧项目导出 SEARCH_RULES；旧项目不在本机时返回 null（下面会明确提示跳过） */
function dumpPythonRules(): FindRule[] | null {
  const project = '/Users/Joey/Sites/Projects/NovelManager'
  if (!existsSync(join(project, 'novelmanager/services/tidy_rules.py'))) return null
  const code = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(project)})`,
    'from novelmanager.services.tidy_rules import SEARCH_RULES',
    'print(json.dumps([{"key": r.key, "label": r.label, "pattern": r.pattern,',
    '  "description": r.description, "replacement": r.replacement} for r in SEARCH_RULES],',
    '  ensure_ascii=False))'
  ].join('\n')
  const out = spawnSync('python3', ['-c', code], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`调用 python3 导出旧规则失败: ${out.stderr}`)
  return JSON.parse(out.stdout) as FindRule[]
}

function sameRule(a: FindRule, b: FindRule): boolean {
  return (
    a.key === b.key &&
    a.label === b.label &&
    a.pattern === b.pattern &&
    a.description === b.description &&
    a.replacement === b.replacement
  )
}

// 1) 与 Python 旧项目逐条一致（顺序即数组顺序）
const pythonRules = dumpPythonRules()
if (pythonRules) {
  assert(
    pythonRules.length === DEFAULT_FIND_RULES.length,
    `条目数一致（旧 ${pythonRules.length} / 新 ${DEFAULT_FIND_RULES.length}）`
  )
  pythonRules.forEach((rule, index) => {
    const mine = DEFAULT_FIND_RULES[index]
    assert(
      mine !== undefined && sameRule(rule, mine),
      `第 ${index + 1} 条与旧项目一致：${rule.key}「${rule.label}」`
    )
  })
} else {
  console.log('skip - 本机无 NovelManager 旧项目，跳过逐条导出比对（下方字面量断言仍覆盖内容）')
}

// 2) 字面量断言：顺序、名称、占位项（即使旧项目不在也不能漏掉迁移内容）
assert(
  DEFAULT_FIND_RULES.map((r) => r.key).join(',') ===
    'extract_chapters,blank_lines,multiple_spaces,illegal_chars,dialogue',
  '规则顺序与 Python SEARCH_RULES 一致（章节/空行/空格/非法字符/对话）'
)
assert(
  FIND_RULE_PLACEHOLDER === '常用正则…',
  '下拉首项占位文本为「常用正则…」，默认选中它即不套用规则'
)
assert(
  new Set(DEFAULT_FIND_RULES.map((r) => r.key)).size === DEFAULT_FIND_RULES.length,
  'key 无重复'
)

// 3) 正则按迁移后的字符串实际可用
function matches(key: string, text: string): boolean {
  const rule = DEFAULT_FIND_RULES.find((r) => r.key === key)!
  return new RegExp(rule.pattern, 'm').test(text)
}
assert(matches('extract_chapters', '　　第一章 起点'), '章节规则命中缩进章节行')
assert(matches('extract_chapters', '番外 一'), '章节规则命中番外行')
assert(!matches('extract_chapters', '他说第一章的故事结束了'), '章节规则只认行首，不命中正文中间')
assert(matches('blank_lines', '正文\n\n\n\n正文'), '空行规则命中连续三个以上换行')
assert(matches('multiple_spaces', '甲  \t乙'), '空格规则命中连续半角空白')
assert(matches('illegal_chars', '正文\u200b正文'), '非法字符规则命中零宽空格')
assert(matches('dialogue', '他说：「走。」然后'), '对话规则命中直角引号内容')

const replacementOf = (key: string): string | null =>
  DEFAULT_FIND_RULES.find((r) => r.key === key)!.replacement
assert(replacementOf('blank_lines') === '\n\n', '空行规则替换为单个空行')
assert(replacementOf('multiple_spaces') === '\u3000', '空格规则替换为全角空格')
assert(replacementOf('illegal_chars') === '', '非法字符规则替换为空串')
assert(
  replacementOf('extract_chapters') === null && replacementOf('dialogue') === null,
  '纯查找类规则不带替换文本'
)

// 4) 经 1.9 的 settings 服务读写：默认值直达、自定义条目原样保留、坏数据整组回落
const dir = mkdtempSync(join(tmpdir(), 'yue-find-rules-'))
try {
  const fresh = readSettings(dir)
  assert(fresh.findRules.length === DEFAULT_FIND_RULES.length, '无 settings.json 时读回默认常用正则')
  assert(
    fresh.findRules.every((rule, i) => sameRule(rule, DEFAULT_FIND_RULES[i])),
    '默认常用正则内容与迁移结果一致'
  )
  assert(fresh.appearance === DEFAULT_SETTINGS.appearance, '新增字段不影响其他设置项默认值')

  const custom = fresh.findRules.map((rule) =>
    rule.key === 'dialogue' ? { ...rule, label: '查找对白' } : rule
  )
  const written = writeSettings(dir, { ...fresh, findRules: custom })
  assert(written.findRules[4].label === '查找对白', '自定义规则经 settings:set 落盘')
  assert(readSettings(dir).findRules[4].label === '查找对白', '重启后（重新读文件）自定义规则保留')

  // 旧版本 settings.json 没有 findRules 字段：只回落该字段，其余设置保留
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ appearance: 'dark', sidebarWidth: 300, preloadCount: 3 }),
    'utf8'
  )
  const upgraded = readSettings(dir)
  assert(upgraded.findRules.length === DEFAULT_FIND_RULES.length, '旧设置文件缺字段时补默认常用正则')
  assert(
    upgraded.appearance === 'dark' && upgraded.sidebarWidth === 300 && upgraded.preloadCount === 3,
    '缺字段回落不重置其他设置'
  )

  // 坏条目（pattern 不是字符串）：整组回落，避免半份规则进入下拉
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      findRules: [{ key: 'x', label: 'x', pattern: 1, description: '', replacement: null }]
    }),
    'utf8'
  )
  const broken = readSettings(dir)
  assert(
    broken.findRules.length === DEFAULT_FIND_RULES.length &&
      broken.findRules[0].key === 'extract_chapters',
    '条目结构非法时整组回落默认值'
  )

  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ findRules: [] }), 'utf8')
  assert(readSettings(dir).findRules.length === DEFAULT_FIND_RULES.length, '空规则数组回落默认值')

  writeFileSync(join(dir, 'settings.json'), '{ 坏 JSON', 'utf8')
  assert(readSettings(dir).findRules.length === DEFAULT_FIND_RULES.length, 'JSON 损坏时回落默认值')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('all find-rule checks passed')
