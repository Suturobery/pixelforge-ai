// Composite driver: real-input pairing flow on the installed build.
// Usage: node cdp-flow.mjs <tier>   (L0|L1|L2|L3)
// Cancels any live pairing, selects <tier>, generates a fresh code, clicks
// "IDE guide" (OS clipboard), prints the code.
const CDP_PORT = process.env.CDP_PORT ?? '9226'
const tier = (process.argv[2] ?? 'L1').toUpperCase()

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails))
  return r.result.value
}
async function centerOf(selectorOrFn) {
  const r = await evaluate(`(() => {
    const el = ${selectorOrFn};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })()`)
  if (!r) throw new Error('element not found: ' + selectorOrFn)
  return r
}
async function realClick(selectorOrFn) {
  const { x, y } = await centerOf(selectorOrFn)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(300)
}

// ---- open Settings → MCP tab (if not already)
const dialogOpen = await evaluate(`(() => ({ open: !!document.querySelector('[role=\"dialog\"]'), mcpActive: (() => { const a = document.querySelector('[role=\"dialog\"]')?.querySelector('[role=\"tabpanel\"]:not([hidden])'); return a?.textContent?.includes('editor link') ?? false; })() }))()`)
if (!dialogOpen.open) {
  await realClick(`document.querySelector('button[aria-label=\"Settings\"]')`)
  await sleep(500)
}
if (!dialogOpen.mcpActive) {
  await realClick(`Array.from(document.querySelector('[role=\"dialog\"]').querySelectorAll('[role=\"tab\"]')).find(t => t.textContent.trim() === 'MCP')`)
  await sleep(500)
}

// ---- cancel any live pairing so the tier select is back
const hasCancel = await evaluate(`(() => !!document.querySelector('[role=\"dialog\"]').querySelector('[aria-label=\"Cancel pairing code\"]'))()`)
if (hasCancel) {
  await realClick(`document.querySelector('[role=\"dialog\"]').querySelector('[aria-label=\"Cancel pairing code\"]')`)
  await sleep(400)
}

// ---- select the tier (Radix select: open, then click the option)
await realClick(`document.querySelector('[role=\"dialog\"]').querySelector('[aria-label=\"Pairing permission tier\"]')`)
await sleep(400)
await realClick(`Array.from(document.querySelectorAll('[role=\"option\"]')).find(o => o.textContent.includes('${tier} —'))`)
await sleep(300)

// ---- generate the pairing code
await realClick(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Generate pairing code'))`)
await sleep(900)

// ---- read the code + click IDE guide (copies to OS clipboard)
const code = await evaluate(`(() => {
  const el = document.querySelector('[aria-label=\"Pairing code\"]');
  return el?.textContent?.trim() ?? null;
})()`)
if (!code) throw new Error('pairing code did not appear')
await realClick(`document.querySelector('button[aria-label=\"Copy IDE connection guide\"]')`)
await sleep(400)

console.log(JSON.stringify({ tier, code }))
ws.close()
process.exit(0)
