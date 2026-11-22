// Agent-panel acceptance smoke on the fresh 0.2.5 build (DOM-driven).
// Launch the exe with --remote-debugging-port=9226 first. Checks:
//  1. "add 4 frames" → clarify (empty vs copies), no edit until chosen
//  2. "Add 4 empty frames" → one undoable batch (frames +4, single undo)
//  3. "Create 4 empty frames" quick action → same batch path
//  4. "Preview Idle Animation" opens Motion
//  5. Review Result block: before/after + exact target + local runner label
// Usage: node agent-smoke-025.mjs
const CDP_PORT = process.env.CDP_PORT ?? '9226'
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && /PixelForge AI/.test(t.title) && !/Starting/.test(t.title))
if (!page) throw new Error('PixelForge AI page not found: ' + JSON.stringify(targets.map((t) => t.title)))
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
// Click a button by exact visible text (first match), via real DOM click.
async function clickText(text) {
  return evalJs(`(() => {
    const els = [...document.querySelectorAll('button')]
    const el = els.find((b) => b.textContent.trim() === ${JSON.stringify(text)})
    if (!el) return false
    el.click()
    return true
  })()`)
}
async function clickAria(label) {
  return evalJs(`(() => {
    const el = document.querySelector('[aria-label=${JSON.stringify(label)}]')
    if (!el) return false
    el.click()
    return true
  })()`)
}
const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + String(detail).slice(0, 160) : ''}`)
}
const frameOf = async () => {
  const t = await evalJs(`document.querySelector('[aria-valuetext^="Frame "]')?.getAttribute('aria-valuetext') ?? ''`)
  const m = / of (\d+)/.exec(t ?? '')
  return m ? Number(m[1]) : 0
}

// ---- open the Agent tab and expand "Manual tools" (collapsed by default)
await clickText('Agent')
await sleep(400)
await clickText('Manual tools')
let nlReady = false
for (let i = 0; i < 12; i++) {
  nlReady = await evalJs(`!!document.querySelector('#pf-nl')`)
  if (nlReady) break
  await clickText('Manual tools')
  await sleep(400)
}
check('Agent tab opens with NL input', nlReady)

// ---- 1) ambiguous "add 4 frames" must clarify BEFORE any edit
const before = await frameOf()
await evalJs(`(() => {
  const inp = document.querySelector('#pf-nl')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(inp, 'add 4 frames')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await sleep(100)
await clickText('Map')
await sleep(300)
const clarifyText = await evalJs(`document.body.textContent.includes('empty or copies of the current frame')`)
const interpretedShown = await evalJs(`document.body.textContent.includes('Interpreted action')`)
check('ambiguous "add 4 frames" asks empty-vs-copies', clarifyText, 'clarify UI text')
check('ambiguous command runs nothing yet', (await frameOf()) === before)

// ---- 2) pick "Add 4 empty frames" → interpreted preview, Run → ONE undoable batch
const picked = await clickText('Add 4 empty frames')
check('clarify option button present', picked)
await sleep(300)
const batchPreview = await evalJs(`document.body.textContent.includes('ONE undoable operation')`)
check('interpreted preview shows one-undoable batch', batchPreview)
await clickText('Run tool')
await sleep(1200)
const after4 = await frameOf()
check('4 empty frames added', after4 === before + 4, `frames ${before} → ${after4}`)
// single undo rolls the whole batch back
await clickAria('Undo')
await sleep(700)
const afterUndo = await frameOf()
check('one undo reverts the whole batch', afterUndo === before, `frames ${after4} → ${afterUndo}`)

// ---- 3) "Create 4 empty frames" quick action (same batch path)
await clickText('Create 4 empty frames')
await sleep(300)
await clickText('Run tool')
await sleep(1200)
const qa = await frameOf()
check('quick action "Create 4 empty frames" adds 4', qa === before + 4, `frames ${before} → ${qa}`)
await clickAria('Undo')
await sleep(700)
check('quick action batch undoable', (await frameOf()) === before)

// ---- 4) Preview Idle Animation opens Motion
await clickAria('Preview Idle Animation')
await sleep(500)
const motionOpen = await evalJs(`document.body.textContent.includes('Motion')`)
check('"Preview Idle Animation" opens Motion workflow', motionOpen)
await clickText('Agent')
await sleep(300)

// ---- 5) Review Result: run a real local edit, then open review
await evalJs(`(() => {
  const inp = document.querySelector('#pf-nl')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(inp, 'flip h')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await sleep(100)
await clickText('Map')
await sleep(300)
await clickText('Run tool')
await sleep(1200)
const hasReviewBtn = await clickAria('Review Result')
check('"Review Result" action present', hasReviewBtn)
await sleep(400)
const review = await evalJs(`(() => {
  const blocks = [...document.querySelectorAll('[aria-label="Review Result"]')]
  const block = blocks.find((b) => /performed by/.test(b.textContent)) ?? null
  if (!block) return null
  const text = block.textContent
  return {
    target: /clip "/.test(text) || /frame \\d/.test(text),
    before: /before · 1×/.test(text),
    after: /after · 1×/.test(text),
    runner: /local runner/.test(text),
    canvases: block.querySelectorAll('canvas').length,
  }
})()`)
check('review shows exact target', !!review && review.target, JSON.stringify(review))
check('review shows before/after', !!review && review.before && review.after, `canvases=${review?.canvases}`)
check('review labels the runner (local runner)', !!review && review.runner)

// ---- undo the flip so the smoke leaves no lasting edit
await clickAria('Undo')
await sleep(500)

const pass = results.every((r) => r.ok)
console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL')
ws.close()
process.exit(pass ? 0 : 1)
