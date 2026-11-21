// CDP verification driver for the packaged 0.2.3 app (offline import flow).
// Blocks all non-loopback requests (simulates internet-blocked) and drives
// the Create-from-Reference flow with real file inputs via DOM.setFileInputFiles.
const CDP_PORT = 9224
const FIXTURES = 'C:/Users/Client/Downloads/workspace-d4993187-40f7-4cb0-9f1f-152ba77cb10c/artifacts/reference-fixtures'

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && t.title === 'PixelForge AI')
if (!page) throw new Error('main page not found: ' + JSON.stringify(targets.map((t) => t.title)))

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

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails))
  return r.result.value
}
async function sleep(ms) { await new Promise((r) => setTimeout(r, ms)) }

// ---- block all non-loopback requests (internet blocked; loopback app services allowed)
await send('Fetch.enable', { patterns: [{ urlPattern: 'http://*', requestStage: 'Request' }, { urlPattern: 'https://*', requestStage: 'Request' }] })
const blockedUrls = []
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.method === 'Fetch.requestPaused') {
    const { requestId, request } = msg.params
    const url = request.url
    const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)
    if (isLoopback) {
      send('Fetch.continueRequest', { requestId })
    } else {
      blockedUrls.push(url)
      send('Fetch.failRequest', { requestId, reason: 'BlockedByClient' })
    }
  }
})

// ---- flow: reference tab → import potion reference → brief → import key candidate → add to canvas
await send('DOM.enable')
await send('Page.enable')

const out = {}

// open the Reference tab
await evaluate(`(() => {
  const tabBtn = Array.from(document.querySelectorAll('button[role="tab"]')).find(b => b.textContent.trim() === 'Reference');
  if (!tabBtn) throw new Error('Reference tab not found');
  tabBtn.click();
})()`)
await sleep(500)

async function setFileInput(ariaLabel, filePath) {
  const doc = await send('DOM.getDocument', {})
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `input[aria-label="${ariaLabel}"]` })
  if (!node.nodeId) throw new Error('file input not found: ' + ariaLabel)
  await send('DOM.setFileInputFiles', { files: [filePath], nodeId: node.nodeId })
}

await setFileInput('Import reference PNG file', `${FIXTURES}/potion-32.png`)
await sleep(900)
out.reference = await evaluate(`(() => {
  const sp = window.__pfUseEditorRef?.() ?? null;
  const el = document.querySelector('[data-testid="reference-creator"]');
  const text = el?.textContent ?? '';
  return { hasPotion: text.includes('potion-32.png'), styleSaved: text.includes('stored with the project') };
})()`)

// brief + candidate import (offline)
await evaluate(`(() => {
  const ta = document.querySelector('textarea[aria-label="Asset brief"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, 'a brass key');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
})()`)
await setFileInput('Import candidate PNG file', `${FIXTURES}/key-32.png`)
await sleep(1200)
out.candidate = await evaluate(`(() => {
  const el = document.querySelector('[data-testid="reference-creator"]');
  const checks = Array.from(el.querySelectorAll('ul[aria-label="Technical checks"] li')).map(li => li.textContent.slice(0, 50));
  const hasAdd = !!document.querySelector('button[aria-label="Add candidate to canvas"]');
  return { checks: checks.slice(0, 6), hasAdd };
})()`)

// add to canvas
await evaluate(`(() => { document.querySelector('button[aria-label="Add candidate to canvas"]')?.click(); })()`)
await sleep(700)
out.layers = await evaluate(`(() => {
  const tabBtn = Array.from(document.querySelectorAll('button[role="tab"]')).find(b => b.textContent.trim() === 'Layers');
  tabBtn.click();
  return 'clicked';
})()`)
await sleep(500)
out.layersText = await evaluate(`(() => {
  const panels = Array.from(document.querySelectorAll('[role="tabpanel"]')).filter(p => !p.hidden);
  const text = panels.map(p => p.textContent).join(' ');
  return { hasKey: text.includes('a-brass-key'), fourLayers: ['Body', 'Outfit', 'Head', 'Item'].every(n => text.includes(n)) || text.includes('a-brass-key') };
})()`)

out.blockedExternalRequests = blockedUrls
console.log(JSON.stringify(out, null, 1))
ws.close()
process.exit(0)
