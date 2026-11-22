// Debug: dump open dialogs + settings tabs on the dev editor page.
const CDP_PORT = process.env.CDP_PORT ?? '9228'
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && (t.url ?? '').includes('localhost:3000'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws error')) })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.value
}
console.log('dialogs:', await ev(`[...document.querySelectorAll('[role=\"dialog\"]')].map((d) => d.textContent.slice(0, 120))`))
console.log('tabs:', await ev(`[...document.querySelectorAll('[role=\"dialog\"] [role=\"tab\"]')].map((t) => t.textContent.trim())`))
console.log('settings button:', await ev(`!!document.querySelector('button[aria-label=\"Settings\"]')`))
ws.close()
process.exit(0)
