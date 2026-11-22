// One-shot: drive the running PixelForge UI to generate an L1 pairing code and
// print it (consumed by zcode-live-verify.mjs).
const CDP_PORT = process.env.CDP_PORT ?? '9226'
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && /PixelForge AI/.test(t.title) && !/Starting/.test(t.title))
if (!page) throw new Error('app page not found')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let mid0 = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++mid0
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('page exception: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails))
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
// dismiss onboarding tour
for (let i = 0; i < 12; i++) {
  const isTour = await evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]')
    return d ? /Welcome to PixelForge AI/.test(d.textContent) : false
  })()`)
  if (!isTour) break
  const skipped = await evaluate(`(() => {
    const d = document.querySelector('[role="dialog"]')
    const skip = [...d.querySelectorAll('button')].find((b) => /skip|finish|done|got it/i.test(b.textContent))
    if (skip) { skip.click(); return 'skip' }
    return null
  })()`)
  if (!skipped) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }
  await sleep(400)
}
const dialogOpen = await evaluate(`(() => ({ open: !!document.querySelector('[role="dialog"]'), mcpActive: (() => { const a = document.querySelector('[role="dialog"]')?.querySelector('[role="tabpanel"]:not([hidden])'); return a?.textContent?.includes('editor link') ?? false })() }))()`)
if (!dialogOpen.open) {
  await realClick(`document.querySelector('button[aria-label="Settings"]')`)
  await sleep(500)
}
if (!dialogOpen.mcpActive) {
  await realClick(`Array.from(document.querySelector('[role="dialog"]').querySelectorAll('[role="tab"]')).find(t => t.textContent.trim() === 'MCP')`)
  await sleep(500)
}
const hasCancel = await evaluate(`(() => !!document.querySelector('[role="dialog"]')?.querySelector('[aria-label="Cancel pairing code"]'))()`)
if (hasCancel) {
  await realClick(`document.querySelector('[role="dialog"]').querySelector('[aria-label="Cancel pairing code"]')`)
  await sleep(400)
}
await realClick(`document.querySelector('[role="dialog"]').querySelector('[aria-label="Pairing permission tier"]')`)
await sleep(400)
await realClick(`Array.from(document.querySelectorAll('[role="option"]')).find(o => o.textContent.includes('L1 —'))`)
await sleep(300)
await realClick(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Generate pairing code'))`)
await sleep(900)
const code = await evaluate(`document.querySelector('[aria-label="Pairing code"]')?.textContent?.trim() ?? null`)
console.log(code ?? '')
ws.close()
process.exit(code ? 0 : 1)
