// Debug: dump UI state of the running PixelForge app (desktop or browser).
const CDP_PORT = process.env.CDP_PORT ?? '9226'
const URLMATCH = process.env.PF_URL_MATCH ?? ''
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = targets.find(
  (t) =>
    t.type === 'page' &&
    /PixelForge AI/.test(t.title) &&
    !/Starting/.test(t.title) &&
    (!URLMATCH || (t.url ?? '').includes(URLMATCH)),
)
if (!page) throw new Error('page not found: ' + JSON.stringify(targets.map((t) => t.title + '|' + t.url)))
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
console.log('url:', page.url)
console.log('dialogs:', await ev(`[...document.querySelectorAll('[role="dialog"]')].map((d) => d.textContent.slice(0, 80))`))
console.log('agent buttons:', await ev(`[...document.querySelectorAll('button')].filter((b) => /Agent/.test(b.textContent)).map((b) => b.textContent.trim())`))
console.log('tabs:', await ev(`[...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim())`))
console.log('pf-nl:', await ev(`!!document.querySelector('#pf-nl')`))
console.log('body snippet:', await ev(`document.body.textContent.slice(0, 260)`))
ws.close()
process.exit(0)
