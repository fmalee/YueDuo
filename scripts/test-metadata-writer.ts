import { applyTextEdit, rewriteHeader } from '../electron/services/metadataWriter'
import { parseMetadata } from '../electron/services/metadataParser'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`ok - ${message}`)
}

function applied(text: string, fields: Parameters<typeof rewriteHeader>[1]): string {
  const edit = rewriteHeader(text, fields)
  return edit ? applyTextEdit(text, edit) : text
}

// 1) 已有书名行：只替换书名号内文本，区间只覆盖这一行（方案 §2.8 最小替换）
const base = ['《旧名》', '作者：旧作者', '主题：旧标签', '正文第一行', '正文第二行'].join('\n')
const titleEdit = rewriteHeader(base, { title: '新名' })
assert(titleEdit !== null, '改书名返回编辑区间')
assert(titleEdit!.start === 0 && titleEdit!.end === 4, '书名编辑只覆盖书名行（0–4）')
assert(titleEdit!.replacement === '《新名》', '书名替换文本正确')
assert(
  applied(base, { title: '新名' }).split('\n')[0] === '《新名》',
  '书名写入后首行正确'
)

// 2) 作者行：带行首空白与全角冒号也能识别，写回为规范格式
const authorEdit = rewriteHeader(base, { author: '新作者' })
assert(authorEdit !== null && authorEdit.start === 5, '作者编辑从第二行行首开始')
assert(
  authorEdit!.end - authorEdit!.start === '作者：旧作者'.length,
  '作者编辑只覆盖作者行'
)
assert(applied(base, { author: '新作者' }).split('\n')[1] === '作者：新作者', '作者写回正确')
const spacedAuthor = ['《名》', '  作者：张三', '正文'].join('\n')
assert(
  applied(spacedAuthor, { author: '李四' }).split('\n')[1] === '作者：李四',
  '行首空白与全角冒号写回规范格式'
)

// 3) 标签：按逗号分隔原文解析，写回统一半角逗号连接
const tagsEdit = rewriteHeader(base, { tags: ['科幻', '星际'] })
assert(tagsEdit !== null, '改标签返回编辑区间')
assert(
  applied(base, { tags: ['科幻', '星际'] }).split('\n')[2] === '主题：科幻,星际',
  '标签写回为半角逗号连接'
)

// 4) 三个字段全缺失：按书名 → 作者 → 标签顺序补行，正文不丢
const plain = ['正文第一行', '正文第二行'].join('\n')
const filled = applied(plain, { title: '孤本', author: '某某', tags: ['武侠', '江湖'] })
assert(
  filled === '《孤本》\n作者：某某\n主题：武侠,江湖\n正文第一行\n正文第二行',
  '缺失字段按书名→作者→标签顺序补行'
)

// 5) 只有书名缺失：插在正文最前面；书名第 3 行不算（只认前两行）
const titleOnThird = ['第一行', '第二行', '《第三行书名》', '正文'].join('\n')
const titleThirdFilled = applied(titleOnThird, { title: '新名' })
assert(titleThirdFilled.startsWith('《新名》\n第一行'), '书名缺失时补在正文最前面')
assert(titleThirdFilled.includes('《第三行书名》'), '第 3 行的旧书名不动')
assert(
  parseMetadata(titleThirdFilled, 'x.txt', '目录').title === '新名',
  '补入后解析器取第一行书名'
)

// 6) 书名在第 2 行：原位替换，不新增行
const titleSecond = ['第一行', '《旧名》', '正文'].join('\n')
const titleSecondEdit = rewriteHeader(titleSecond, { title: '新名' })
assert(
  titleSecondEdit !== null && titleSecondEdit.start === 4,
  '第 2 行书名原位替换'
)
assert(applied(titleSecond, { title: '新名' }).split('\n')[1] === '《新名》', '第 2 行书名写入正确')

// 7) 空正文补书名：只多出书名行与一个换行
const emptyFilled = applied('', { title: '孤本' })
assert(emptyFilled === '《孤本》\n', '空正文补书名')
assert(parseMetadata(emptyFilled, 'x.txt', '目录').title === '孤本', '空正文补书名后可解析')

// 8) 无变化返回 null（不产生无意义的 dirty）
assert(rewriteHeader(base, { title: '旧名' }) === null, '书名相同返回 null')
assert(rewriteHeader(base, { author: '旧作者' }) === null, '作者相同返回 null')
assert(rewriteHeader(base, { tags: ['旧标签'] }) === null, '标签相同返回 null')

// 9) 只处理前 10 行：第 11 行的作者行不参与匹配
const lines10 = Array.from({ length: 10 }, (_, i) => `第${i + 1}行`)
lines10.push('作者：第十一行')
const longText = lines10.join('\n')
const longFilled = applied(longText, { author: '新的' })
assert(longFilled.startsWith('作者：新的\n第1行'), '前 10 行无作者行时补在最前面')
assert(longFilled.includes('作者：第十一行'), '第 11 行的作者行不改动')

// 10) 10 行头部末尾追加标签：prefix 覆盖全部旧行时不越界、不产生空行
const tailHeader = Array.from({ length: 9 }, (_, i) => `第${i + 1}行`)
tailHeader.push('作者：末尾')
const tailText = [...tailHeader, '第11行', '第12行'].join('\n')
const tailFilled = applied(tailText, { tags: ['新标签'] })
assert(
  tailFilled === [...tailHeader, '主题：新标签', '第11行', '第12行'].join('\n'),
  '标签追加在作者行之后且不留空行'
)

// 11) 书名含 $ 不被当作替换模板（Python 语义：原样插入）
const dollarFilled = applied(base, { title: '价格$&' })
assert(dollarFilled.split('\n')[0] === '《价格$&》', '书名中的 $ 原样保留')

// 12) 写回后解析结果与字段一致；标签不会落到目录兜底
const roundTrip = applied(base, { title: '新名', author: '新作者', tags: ['科幻', '星际'] })
const parsed = parseMetadata(roundTrip, 'x.txt', '目录名')
assert(
  parsed.title === '新名' && parsed.author === '新作者',
  '写回后解析书名/作者一致'
)
assert(parsed.tags.join(' ') === '科幻 星际', '写回后解析标签一致（不回落目录名）')

// 13) 293 行正文改作者：编辑区间仍在头部，不整篇替换
const longBody = ['《长篇》', '作者：旧', ...Array.from({ length: 290 }, (_, i) => `正文${i}`)]
const longBodyText = longBody.join('\n')
const longAuthorEdit = rewriteHeader(longBodyText, { author: '新' })
assert(longAuthorEdit !== null && longAuthorEdit.end < 40, '长正文的编辑区间仍只在头部')
assert(
  applyTextEdit(longBodyText, longAuthorEdit!).split('\n').slice(2).join('\n') ===
    longBody.slice(2).join('\n'),
  '长正文其余部分逐字不变'
)

console.log('\nmetadataWriter 全部通过')
