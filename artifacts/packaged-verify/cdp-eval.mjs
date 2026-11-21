// CDP driver for packaged-app verification: evaluates an expression in the
// packaged app's renderer page and prints the JSON result.
// Usage: node cdp-eval.mjs "<expression>"  (Node >=22, native WebSocket)
const expr = process.argv[2]
const res = await fetch('http://127.0.0.1:9223/json/list')
const targets = await res.json()
const page = targets.find((t) => t.type === 'page' && /PixelForge/.test(t.title))
if (!page) throw new Error('page target not found: ' + JSON.stringify(targets.map((t) => t.title)))

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
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
}
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = (e) => reject(new Error('ws error'))
})

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) {
    throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails, null, 1))
  }
  return r.result.value
}

try {
  const out = await evaluate(expr)
  console.log(typeof out === 'string' ? out : JSON.stringify(out))
} finally {
  ws.close()
  process.exit(0)
}
