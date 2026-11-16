// native 模块验证：以 Electron 的 Node 模式真实 require better-sqlite3
// 成功判据是 Electron 进程内建表插入查询全通（不看 rebuild 命令输出）
const db = require('better-sqlite3')(':memory:')
db.exec('CREATE TABLE t (a INTEGER)')
db.prepare('INSERT INTO t VALUES (?)').run(42)
const row = db.prepare('SELECT a FROM t').get()
if (row.a !== 42) {
  console.error('native FAIL: 期望 42，实际', row.a)
  process.exit(1)
}
console.log('native OK: better-sqlite3', require('better-sqlite3/package.json').version,
  '在 Electron', process.versions.electron, '(Node ABI', process.versions.modules, ') 内加载并执行成功')
