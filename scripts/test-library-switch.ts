import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LibraryDatabaseManager } from '../electron/services/libraryDatabase'
import { getDatabase, getDatabaseFile } from '../electron/services/database'
import { loadSession, persistSession } from '../electron/services/sessionStore'
import { readDraft, writeDraft } from '../electron/services/draftStore'
import { addBookmark, listBookmarks } from '../electron/services/bookmarkRepository'
import type { SessionSnapshot } from '../shared/types'

/**
 * 2.13 换库流程服务级验收（临时书库，不碰真实书库）：
 * 每库一份数据库、准备阶段旧库仍活动、切换后会话/草稿/书签互不串、切回能恢复、
 * 中止/无效目录时原库仍可用、书库根不可写时回落 userData 且按库根隔离。
 */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`ok - ${message}`)
}

function snapshot(id: string, path: string): SessionSnapshot {
  return {
    activeTabId: id,
    tabs: [
      {
        id,
        path,
        title: path.split('/').pop() ?? path,
        progressLine: 42,
        cursorLine: 43,
        cursorColumn: 2,
        dirty: true,
        lastFocusedAt: 1
      }
    ]
  }
}

const base = realpathSync(mkdtempSync(join(tmpdir(), 'yue-213-switch-')))
const userData = join(base, 'user-data')
const libA = join(base, 'library-a')
const libB = join(base, 'library-b')
mkdirSync(userData)
mkdirSync(libA)
mkdirSync(libB)
writeFileSync(join(libA, 'a.txt'), '《甲书》\n正文', 'utf8')
writeFileSync(join(libB, 'b.txt'), '《乙书》\n正文', 'utf8')

const manager = new LibraryDatabaseManager(userData)
const dbA = join(libA, 'yueduo.db')
const dbB = join(libB, 'yueduo.db')

// 1) 启动：按书库根建库（库文件放书库根，不再共用 userData 一份）
const started = manager.init(libA)
assert(started.root === libA && started.error === '', '启动打开书库 A 且无错误')
assert(getDatabaseFile() === dbA, '活动库文件是 A/yueduo.db')
assert(existsSync(dbA), 'A 的 yueduo.db 已创建')

// A 的会话 + 草稿 + 书签
persistSession(getDatabase(), snapshot('tab-a', join(libA, 'a.txt')))
writeDraft(getDatabase(), 'tab-a', 'A 的未保存草稿正文', null, null)
addBookmark('a.txt', 'a.txt', 7, 'A 书签')
assert(loadSession(getDatabase()).tabs[0].hasDraft, 'A 库有带草稿的会话')

// 2) 准备切到 B：旧库仍活动、可继续写入；新库会话为空
const preparedB = manager.prepare(libB)
assert(preparedB.result.switched, '准备切换 B 返回 switched=true')
assert(preparedB.result.session?.tabs.length === 0, 'B 库初始没有会话（不串 A 的标签）')
assert(getDatabaseFile() === dbA, '准备阶段活动库仍是 A（存档旧会话的前提）')
assert(loadSession(getDatabase()).tabs[0].id === 'tab-a', '准备阶段仍能读到 A 的会话')

// 存档动作（渲染层退化成一次写库）：A 的会话仍写进 A
persistSession(getDatabase(), snapshot('tab-a', join(libA, 'a.txt')))
manager.commit()
assert(getDatabaseFile() === dbB, '提交后活动库切到 B/yueduo.db')
assert(loadSession(getDatabase()).tabs.length === 0, '切到 B 后读不到 A 的会话')
assert(readDraft(getDatabase(), 'tab-a') === null, 'B 库没有 A 标签的草稿')
assert(listBookmarks('a.txt').length === 0, 'B 库没有 A 书的书签')

// B 自己的会话/草稿/书签
persistSession(getDatabase(), snapshot('tab-b', join(libB, 'b.txt')))
writeDraft(getDatabase(), 'tab-b', 'B 的草稿正文', null, null)
addBookmark('b.txt', 'b.txt', 11, 'B 书签')
assert(readDraft(getDatabase(), 'tab-b')?.text === 'B 的草稿正文', 'B 库写入自己的草稿')
assert(listBookmarks('b.txt')[0].line === 11, 'B 库写入自己的书签')

// 3) 切回 A：会话/草稿/书签原样恢复，B 的数据不串过来
const preparedA = manager.prepare(libA)
assert(preparedA.result.switched, '切回 A 返回 switched=true')
assert(preparedA.result.session?.tabs.length === 1, 'A 库会话仍在（1 个标签）')
assert(preparedA.result.session?.tabs[0].hasDraft === true, 'A 会话标记带草稿')
manager.commit()
assert(getDatabaseFile() === dbA, '提交后活动库回到 A')
assert(loadSession(getDatabase()).tabs[0].id === 'tab-a', 'A 的标签恢复')
assert(readDraft(getDatabase(), 'tab-a')?.text === 'A 的未保存草稿正文', 'A 的草稿全文恢复')
assert(listBookmarks('a.txt')[0].note === 'A 书签', 'A 的书签恢复')
assert(listBookmarks('b.txt').length === 0, 'A 库看不到 B 的书签')
assert(readDraft(getDatabase(), 'tab-b') === null, 'A 库看不到 B 的草稿')

// 4) 中止：准备了 B 但存档失败 → abort 后 A 仍是活动库且可继续写
const pendingB = manager.prepare(libB)
assert(pendingB.result.switched, '再次准备 B 成功')
manager.abort()
assert(manager.currentRoot() === libA && getDatabaseFile() === dbA, '中止后活动库仍是 A')
assert(readDraft(getDatabase(), 'tab-a')?.text === 'A 的未保存草稿正文', '中止后 A 的草稿仍可读')
addBookmark('a.txt', 'a.txt', 20, '中止后新增')
persistSession(getDatabase(), snapshot('tab-a', join(libA, 'a.txt')))
assert(listBookmarks('a.txt').length === 2, '中止后 A 库仍可正常写入')

// 5) 目录无效：准备直接失败，原库不受影响
let threw = false
try {
  manager.prepare(join(base, 'no-such-library'))
} catch {
  threw = true
}
assert(threw, '无效书库目录准备失败')
assert(manager.currentRoot() === libA && getDatabaseFile() === dbA, '失败后 A 仍是活动库')
assert(listBookmarks('a.txt').length === 2, '失败后 A 的数据完好')

// 6) 书库根不可写：数据库回落 userData，并按书库根隔离
const readonlyRoot = join(base, 'library-readonly')
mkdirSync(readonlyRoot)
writeFileSync(join(readonlyRoot, 'r.txt'), '《只读库》\n正文', 'utf8')
chmodSync(readonlyRoot, 0o555)
try {
  const preparedReadonly = manager.prepare(readonlyRoot)
  assert(preparedReadonly.result.fallback === true, '只读书库根回落 userData')
  assert(!existsSync(join(readonlyRoot, 'yueduo.db')), '只读书库根不产生库文件')
  manager.commit()
  const fallbackFile = getDatabaseFile()
  assert(
    fallbackFile.startsWith(join(userData, 'library-db')),
    `回落库位于 userData/library-db（实际 ${fallbackFile}）`
  )
  persistSession(getDatabase(), snapshot('tab-r', join(readonlyRoot, 'r.txt')))
  manager.close()
  const restarted = new LibraryDatabaseManager(userData)
  const state = restarted.init(readonlyRoot)
  assert(state.root === realpathSync(readonlyRoot) && state.fallback, '重启后仍回落同一书库')
  assert(getDatabaseFile() === fallbackFile, '重启后回落库文件不变（按库根哈希隔离）')
  assert(loadSession(getDatabase()).tabs[0].id === 'tab-r', '回落库的会话可恢复')
  restarted.close()
} finally {
  chmodSync(readonlyRoot, 0o755)
}

rmSync(base, { recursive: true, force: true })
console.log('ALL OK')
