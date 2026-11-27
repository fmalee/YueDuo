/**
 * 替换模板的转义展开（仅正则模式使用）
 * `\n` → 换行、`\t` → 制表符、`\\` → 单个反斜杠，其余反斜杠序列按字面保留。
 * 与分组展开互不干扰：两者都只扫描输入、不重扫展开结果，
 * 因此 `$1\n` 会得到「捕获组 + 换行」，`\\$1` 得到「反斜杠 + 捕获组」。
 */
export function unescapeReplaceTemplate(template: string): string {
  if (!template.includes('\\')) return template
  let result = ''
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]
    if (ch !== '\\') {
      result += ch
      continue
    }
    const next = template[i + 1]
    if (next === undefined) {
      // 末尾孤立的 `\`
      result += '\\'
      continue
    }
    if (next === 'n') {
      result += '\n'
      i += 1
      continue
    }
    if (next === 't') {
      result += '\t'
      i += 1
      continue
    }
    if (next === '\\') {
      result += '\\'
      i += 1
      continue
    }
    // `\` 后跟其他字符：`\` 按字面，后续字符照常扫描
    result += '\\'
  }
  return result
}

/**
 * 查找替换模板展开（方案 §3.1）
 * 支持 `$1`–`$9`（捕获组）、`$&` / `$0`（整个匹配）、`$$`（字面 `$`）。
 * 其余写法（越界组号、多位数如 `$10`、未闭合的 `$`、`$` 后跟其他字符）一律按字面输出，不报错。
 * 纯函数，不依赖编辑器 / Vue，便于单测。
 */
export function expandReplaceTemplate(
  template: string,
  groups: readonly (string | undefined)[] | null
): string {
  // 没有捕获信息（非正则查找）时整段按字面处理，保持原有替换行为
  if (groups === null || !template.includes('$')) return template
  /** groups[0] 是整个匹配，与 `$&` / `$0` 等价 */
  const whole = groups[0] ?? ''
  let result = ''
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]
    if (ch !== '$') {
      result += ch
      continue
    }
    const next = template[i + 1]
    if (next === undefined) {
      // 末尾孤立的 `$`
      result += '$'
      continue
    }
    if (next === '$') {
      result += '$'
      i += 1
      continue
    }
    if (next === '&') {
      result += whole
      i += 1
      continue
    }
    if (next >= '0' && next <= '9') {
      // 只认单位数组号：`$10` 这类多位数整体按字面
      const after = template[i + 2]
      if (after !== undefined && after >= '0' && after <= '9') {
        result += '$'
        continue
      }
      const index = next.charCodeAt(0) - 48
      if (index < groups.length) {
        // 组存在但未参与匹配（如 `(a)|(b)` 的另一个分支）按空串处理，与 JS String.replace 一致
        result += groups[index] ?? ''
      } else {
        result += '$' + next
      }
      i += 1
      continue
    }
    // `$` 后跟其他字符：`$` 按字面，后续字符照常扫描
    result += '$'
  }
  return result
}

/**
 * 替换串统一展开入口：先展开 `\n` / `\t` / `\\` 转义，再展开 `$1`–`$9` / `$&` / `$0` / `$$`。
 * 查找替换栏（正则模式）与一键整理都走这里，保证同一条规则里的 replacement 两处语义一致。
 * 两次展开都只扫描输入、不重扫结果，所以 `$1\n` 得到「捕获组 + 换行」而不会互相破坏。
 */
export function expandReplacement(
  template: string,
  groups: readonly (string | undefined)[] | null
): string {
  return expandReplaceTemplate(unescapeReplaceTemplate(template), groups)
}
