#!/usr/bin/env node
// CDP 截图工具：Page.captureScreenshot → 存 PNG（视觉验收用）
const out = process.argv[2] ?? '/tmp/yueduo-shot.png'

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
  ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }))
})
ws.close()

if (!result?.data) {
  console.error('截图失败:', JSON.stringify(result).slice(0, 200))
  process.exit(1)
}
const { writeFileSync } = await import('fs')
writeFileSync(out, Buffer.from(result.data, 'base64'))
console.log('已保存', out, Buffer.from(result.data, 'base64').length, 'bytes')
