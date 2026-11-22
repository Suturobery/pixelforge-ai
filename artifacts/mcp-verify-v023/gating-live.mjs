// Live A/B project-gating acceptance with a REAL MCP client (ZCode path).
// The dev editor runs in a plain browser (no desktop bridge → no file/db
// identities), so unsaved identities are used; the file/db identity variants
// are covered by the server-side unit tests (brain-plan-board.test.ts).
//   1. pair L1 via the dev editor's Settings→MCP UI
//   2. on project A: queue T1 (claimed → allowed) and T2 (left pending)
//   3. switch to Project B:
//        claim T2        → BLOCKED (mismatch; error names both projects)
//        progress on T1  → BLOCKED (continuation gated)
//        complete on T1  → BLOCKED (task requeued)
//   4. queue T3 from B (stamped B) → claim + complete → ALLOWED
// Prereq: dev app localhost:3000 (window.__pf probe), MCP :3030, CDP 9228.
const { Client, StreamableHTTPClientTransport } = await import(
  'file:///C:/Users/Client/Downloads/workspace-d4993187-40f7-4cb0-9f1f-152ba77cb10c/mini-services/mcp-server/node_modules/@modelcontextprotocol/client/dist/index.mjs'
);

const CDP_PORT = process.env.CDP_PORT ?? '9228'
const MCP = process.env.PF_MCP_URL ?? 'http://127.0.0.1:3030/mcp'

// ---------------- CDP helpers ----------------
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && /PixelForge AI/.test(t.title) && !/Starting/.test(t.title))
if (!page) throw new Error('dev editor page not found')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let mid0 = 0
const pendingCdp = new Map()
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++mid0
    pendingCdp.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pendingCdp.has(msg.id)) {
    const { resolve, reject } = pendingCdp.get(msg.id)
    pendingCdp.delete(msg.id)
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

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + String(detail).slice(0, 220) : ''}`)
}

// ---------------- MCP client helpers ----------------
function env(result) {
  const text = result.content?.[0]?.text ?? ''
  try { return JSON.parse(text) } catch { return { ok: false, error: { message: text.slice(0, 240) } } }
}
async function withClient(bearer, fn) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  })
  const client = new Client({ name: 'ZCode', version: '1.0.0' })
  await client.connect(transport)
  try { return await fn(client) } finally { await client.close().catch(() => {}) }
}
async function editorPush(tasks) {
  return evaluate(`(async () => {
    const res = await window.__pfMcp.mcpCtrl({ kind: 'brain-push', tasks: ${JSON.stringify(tasks)} })
    return res
  })()`)
}
async function switchProject(name) {
  await evaluate(`(() => {
    const pf = window.__pf
    const st = pf.useEditor.getState()
    st.newProject({ ...st.project, id: null, name: ${JSON.stringify(name)} })
    return true
  })()`)
  await sleep(1500)
  return evaluate(`window.__pf.useEditor.getState().project.name`)
}

// ---------------- 1) pair L1 via the editor UI ----------------
// wait for the editor bridge to reconnect after the page load (Generate is
// disabled until bridge.status === 'connected')
for (let i = 0; i < 40; i++) {
  const st = await evaluate(`(async () => { const m = window.__pfMcp; return m ? (await m.getBridgeState()).status : null })()`)
  if (st === 'connected') break
  await sleep(500)
}
// dismiss the onboarding tour if it popped up (it blocks Settings)
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
check('pairing code generated (L1)', !!code)
if (!code) {
  console.log('ABORT: no pairing code (bridge likely not connected yet).')
  ws.close()
  process.exit(1)
}
await realClick(`Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Close' || b.textContent.trim() === 'Close')`)
await sleep(300)

const token = await withClient(code, async (c) => {
  const paired = env(await c.callTool({ name: 'pair_client', arguments: { name: 'ZCode' } }))
  check('pair_client as ZCode (L1)', paired.ok && typeof paired.data?.token === 'string')
  return paired.data.token
})

// ---------------- 2) project A: queue + claim ----------------
const nameA = await evaluate(`window.__pf.useEditor.getState().project.name`)
await sleep(1200) // projectChanged settle
const pushT1 = await editorPush([{ title: 'AB gating T1 (claimed on A)', detail: 'gate probe' }])
const pushT2 = await editorPush([{ title: 'AB gating T2 (pending for A)', detail: 'gate probe' }])
const T1 = pushT1?.data?.tasks?.[0]
const T2 = pushT2?.data?.tasks?.[0]
check('T1/T2 queued stamped for A', !!T1?.targetProjectKey && T1?.targetProjectName === nameA && !!T2?.targetProjectKey && T2?.targetProjectName === nameA, `${T1?.targetProjectKey}(${T1?.targetProjectName}) / ${T2?.targetProjectKey}(${T2?.targetProjectName})`)

const claimT1 = await withClient(token, async (c) =>
  env(await c.callTool({ name: 'brain_claim_task', arguments: { id: T1.id } })))
check('claim T1 allowed on project A', claimT1.ok === true, claimT1.error?.message)

// ---------------- 3) switch to Project B — A tasks must be gated ----------------
const nowB = await switchProject('Project B')
check('editor now on Project B', nowB === 'Project B', nowB)

const claimT2Blocked = await withClient(token, async (c) =>
  env(await c.callTool({ name: 'brain_claim_task', arguments: { id: T2.id } })))
check('claim of A-task BLOCKED from project B', claimT2Blocked.ok === false, claimT2Blocked.error?.message)
const blockMsg = claimT2Blocked.error?.message ?? ''
check('block error names both projects', blockMsg.includes(nameA) && blockMsg.includes('Project B'), blockMsg)

const progressBlocked = await withClient(token, async (c) =>
  env(await c.callTool({ name: 'brain_update_task_progress', arguments: { id: T1.id, progress: 'sneaky from B' } })))
check('progress on claimed A-task BLOCKED from B', progressBlocked.ok === false, progressBlocked.error?.message)

const completeBlocked = await withClient(token, async (c) =>
  env(await c.callTool({ name: 'brain_complete_task', arguments: { id: T1.id, result: 'from wrong project' } })))
check('complete on claimed A-task BLOCKED from B', completeBlocked.ok === false, completeBlocked.error?.message)

// after the blocked completion the task must be BACK on the board (requeued)
const t1After = await withClient(token, async (c) =>
  env(await c.callTool({ name: 'brain_get_task', arguments: { id: T1.id } })))
check('blocked complete requeued T1 for project A', t1After?.data?.task?.status === 'pending', t1After?.data?.task?.status)

// ---------------- 4) tasks stamped for B work while on B ----------------
const pushT3 = await editorPush([{ title: 'AB gating T3 (for B)', detail: 'gate probe' }])
const T3 = pushT3?.data?.tasks?.[0]
check('T3 queued stamped for B', (T3?.targetProjectKey ?? '').includes('Project B'), T3?.targetProjectKey)
const claimT3 = await withClient(token, async (c) =>
  env(await c.callTool({ name: 'brain_claim_task', arguments: { id: T3.id } })))
check('claim of B-task allowed while on B', claimT3.ok === true, claimT3.error?.message)
await withClient(token, async (c) => {
  await c.callTool({ name: 'brain_complete_task', arguments: { id: T3.id, result: 'B-side gating verified' } })
})

const failed = results.filter((r) => !r.ok)
console.log(`\nA/B gating live test: ${results.length - failed.length}/${results.length} passed`)
ws.close()
process.exit(failed.length ? 1 : 0)
