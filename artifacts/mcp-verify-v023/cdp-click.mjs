// Real input click at viewport coordinates via CDP (bypasses React synthetic
// event quirks of programmatic .click() on Radix triggers).
// Usage: node cdp-click.mjs <x> <y>
const CDP_PORT = process.env.CDP_PORT ?? '9226'
const x = Number(process.argv[2])
const y = Number(process.argv[3])

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

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
console.log(`clicked ${x},${y}`)
ws.close()
process.exit(0)
