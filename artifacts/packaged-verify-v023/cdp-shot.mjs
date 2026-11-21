// Screenshot the packaged app's Reference panel (scroll to candidates) via CDP.
const CDP_PORT = 9224
const OUT = 'C:/Users/Client/Downloads/workspace-d4993187-40f7-4cb0-9f1f-152ba77cb10c/artifacts/packaged-verify-v023/reference-panel.png'

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && t.title === 'PixelForge AI')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws error')) })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return r.result.value
}
await send('Page.enable')
await evaluate(`(() => {
  const el = document.querySelector('[data-testid="reference-creator"]');
  el?.scrollIntoView({ block: 'start' });
  const panel = document.querySelector('[data-testid="reference-creator"]');
  panel?.scrollBy(0, 400);
})()`)
await new Promise((r) => setTimeout(r, 400))
const shot = await send('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
console.log('screenshot written:', OUT)
ws.close()
process.exit(0)
