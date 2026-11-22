// Debug: dump Brain task board rows + bridge state on the dev browser.
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
const selector = '[aria-label^="Cancel task:"]'
console.log('cancel buttons:', await ev(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((b) => b.getAttribute('aria-label'))`))
console.log('rows:', await ev(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((b) => b.parentElement.textContent.trim())`))
console.log('bridge:', JSON.stringify(await ev(`(async () => { const m = window.__pfMcp; return m ? await m.getBridgeState() : null })()`))?.slice(0, 300))
console.log('proj:', await ev(`window.__pf?.useEditor.getState().project.name`))
ws.close()
process.exit(0)
