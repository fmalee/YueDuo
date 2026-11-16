#!/usr/bin/env node
// CDP evaluate 工具：node 24 原生 WebSocket 连 9222 的页面，执行 JS 返回结果
// 用法：node scripts/cdp-eval.mjs "表达式"
const expr = process.argv[2]
if (!expr) {
  console.error('用法: node scripts/cdp-eval.mjs "表达式"')
  process.exit(2)
}

const list = await (await fetch('http://localhost:9222/json/list')).json()
const page = list.find((p) => p.type === 'page')
if (!page) {
  console.error('无可用页面')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('ws 连接失败'))
})

const result = await new Promise((resolve) => {
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data))
    if (msg.id === 1) resolve(msg.result)
  }
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true }
    })
  )
})
ws.close()

if (result.exceptionDetails) {
  console.error('页面异常:', JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails))
  process.exit(1)
}
console.log(JSON.stringify(result.result?.value, null, 0))
