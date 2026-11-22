// Brain-panel acceptance smoke on the dev server (http://localhost:3000 in
// Edge headless with CDP). Checks:
//  1. Brief "32x32 brass key" → interpret → brief preview opens → Send to
//     Connected Agent queues a task; the board renders the project name on it
//  2. Character shortcut: "Mushroom Knight" brief → Open in Create Character
//  3. Reference shortcut: key brief → Open in Reference carries the brief into
//     the Reference panel
// Usage: node brain-smoke-dev.mjs  (expects browser CDP on 9227)
const CDP_PORT = process.env.CDP_PORT ?? '9227'
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && (t.url ?? '').includes('localhost:3000'))
if (!page) throw new Error('localhost:3000 page not found: ' + JSON.stringify(targets.map((t) => t.title + '|' + t.url)))
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
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r.result?.value
}
async function clickText(text) {
  return evalJs(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})
    if (!el) return false
    el.click()
    return true
  })()`)
}
async function typeInto(selector, text) {
  return evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
}
const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`)
}
await sleep(500)

const projName = await evalJs(`window.__pf?.useEditor.getState().project.name ?? ''`)
check('dev app loaded with project', !!projName, projName)

await clickText('Brain')
await sleep(400)

// ---- 1) brief → interpret → send to board
const typed = await typeInto('[aria-label="Prompt to interpret and enhance"]', '32x32 brass key sprite, shiny gold, one key per frame')
check('Brain prompt input accepts brief', typed)
await sleep(1200)
// interpretation auto-fills the brief fields; composing opens the editable preview
await clickText('Compose brief preview')
await sleep(500)
const briefOpen = await evalJs(`!!document.querySelector('[aria-label="Asset brief text (editable)"]')`)
check('brief preview opens after interpretation', briefOpen)
if (briefOpen) {
  const briefHasKey = await evalJs(`document.body.textContent.toLowerCase().includes('brass key')`)
  check('brief carries the key request', briefHasKey)
  const sent = await clickText('Send to Connected Agent')
  check('"Send to Connected Agent" queues the task', sent)
  await sleep(1200)
  const boardShowsProject = await evalJs(`(() => {
    const tasks = [...document.querySelectorAll('[aria-label^="Cancel task:"]')]
    if (tasks.length === 0) return false
    const row = tasks[tasks.length - 1].closest('[class*="rounded"], div')
    const scope = row?.parentElement?.parentElement ?? document.body
    return scope.textContent.includes(${JSON.stringify(projName)})
  })()`)
  check('queued task displays the target project name', boardShowsProject)
}

// ---- 2) character shortcut
await typeInto('[aria-label="Prompt to interpret and enhance"]', 'mushroom knight with cap and sword')
await sleep(1200)
const charBtn = await clickText('Open in Create Character')
check('"Open in Create Character" shortcut appears for kit briefs', charBtn)
if (charBtn) {
  await sleep(600)
  const createOpen = await evalJs(`!!document.body.textContent.match(/Create Character|Character kit|Kit preset/i)`)
  check('Create Character panel opened from Brain', createOpen)
  await clickText('Brain')
  await sleep(300)
}

// ---- 3) reference shortcut carries the brief
await typeInto('[aria-label="Prompt to interpret and enhance"]', '32x32 brass key sprite, shiny gold')
await sleep(1200)
const refBtn = await clickText('Open in Reference')
check('"Open in Reference" shortcut appears for asset briefs', refBtn)
if (refBtn) {
  await sleep(700)
  const carried = await evalJs(`(() => {
    const t = document.body.textContent.toLowerCase()
    return t.includes('brass key')
  })()`)
  check('Reference panel opened with the brief carried over', carried)
  await clickText('Brain')
  await sleep(300)
}

const pass = results.every((r) => r.ok)
console.log(pass ? 'BRAIN SMOKE PASS' : 'BRAIN SMOKE FAIL')
ws.close()
process.exit(pass ? 0 : 1)
