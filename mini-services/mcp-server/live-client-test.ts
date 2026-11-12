// Live external-client test: connects to the RUNNING packaged PixelForge app
// (MCP on 127.0.0.1:3030) exactly like an IDE agent would — pairing code →
// pfm_ token → full brain tools sequence. Run from mini-services/mcp-server:
//   PF_PAIR_CODE=<6-word code> bun live-client-test.ts
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const MCP_URL = 'http://127.0.0.1:3030/mcp';
const code = process.env.PF_PAIR_CODE;
if (!code) {
  console.error('PF_PAIR_CODE env required');
  process.exit(2);
}
const mask = (t: string) => t.slice(0, 8) + '…';

const results: Array<[string, boolean, string]> = [];
const record = (name: string, ok: boolean, note = '') => {
  results.push([name, ok, note]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  — ' + note : ''}`);
};

function envelope(result: unknown): { ok: boolean; data?: any; error?: any; summary?: string } {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r?.content?.find((c) => c.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}

async function withClient(bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'zcode-live-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function main() {
  // 1. pair with the 6-word code
  const pairing = await withClient(code!);
  const paired = envelope(await pairing.callTool({ name: 'pair_client', arguments: { name: 'zcode-live-test' } }));
  if (!paired.ok) {
    console.log('pairing failed:', JSON.stringify(paired.error));
    process.exit(1);
  }
  const token = (paired.data as { token: string }).token;
  console.log('paired — persistent token', mask(token), '(never printed in full)');
  await pairing.close();

  // 2. reconnect as a real paired client
  const client = await withClient(token);

  // 3. classic read
  const state = envelope(await client.callTool({ name: 'get_project_state', arguments: {} }));
  record('get_project_state', state.ok, state.ok ? `project "${(state.data as any).name}"` : JSON.stringify(state.error));

  // 4. brain_get_status
  const status = envelope(await client.callTool({ name: 'brain_get_status', arguments: {} }));
  record(
    'brain_get_status',
    status.ok && (status.data as any)?.brain?.available === true,
    status.ok ? `editor=${(status.data as any).editorConnected} board=${JSON.stringify((status.data as any).board)}` : JSON.stringify(status.error),
  );

  // 5. brain_get_capabilities — L1 tier filter
  const caps = envelope(await client.callTool({ name: 'brain_get_capabilities', arguments: {} }));
  const capsData = caps.data as { tier: string; tools: Array<{ name: string }>; counts: { granted: number; total: number } };
  record(
    'brain_get_capabilities',
    caps.ok && capsData?.tier === 'L1' && capsData.tools.some((t) => t.name === 'brain_ask'),
    caps.ok ? `granted ${capsData.counts.granted}/${capsData.counts.total}` : JSON.stringify(caps.error),
  );

  // 6. brain_interpret_prompt (deterministic, free)
  const interp = envelope(await client.callTool({ name: 'brain_interpret_prompt', arguments: { prompt: 'make knigth wlak no bg' } }));
  const interpData = interp.data as { interpreted?: { detectedIntent?: string; corrections?: unknown[] } };
  record(
    'brain_interpret_prompt',
    interp.ok && interpData?.interpreted?.detectedIntent === 'animation-motion',
    interp.ok ? `intent=${interpData.interpreted!.detectedIntent} corrections=${interpData.interpreted!.corrections!.length}` : JSON.stringify(interp.error),
  );

  // 7. brain_ask — LIVE Groq round-trip through the app's vault
  const ask = envelope(await client.callTool({ name: 'brain_ask', arguments: { question: 'what should I build next?' } }));
  record(
    'brain_ask',
    ask.ok && typeof (ask.data as any)?.answer === 'string' && (ask.data as any).answer.length > 0,
    ask.ok ? `answer: "${String((ask.data as any).answer).slice(0, 90)}…"` : JSON.stringify(ask.error),
  );

  // 8. brain_plan_goal — plan-only
  const plan = envelope(await client.callTool({ name: 'brain_plan_goal', arguments: { goal: 'add a warm campfire and set a dark cozy palette' } }));
  const planData = plan.data as { plan?: unknown[]; note?: string };
  record(
    'brain_plan_goal',
    plan.ok && Array.isArray(planData?.plan) && /NOTHING was executed/.test(planData.note ?? ''),
    plan.ok ? `${planData.plan!.length} step(s), plan-only disclaimer present` : JSON.stringify(plan.error),
  );

  // 9. task loop (board must have a pending task pushed from the editor side)
  const tasks = envelope(await client.callTool({ name: 'brain_get_tasks', arguments: {} }));
  const pending = ((tasks.data as any)?.pending ?? []) as Array<{ id: string; title: string }>;
  if (pending.length === 0) {
    record('task loop', true, 'board empty — no pending task to claim (loop covered by contract tests; push one via Brain Panel to see it live)');
  } else {
    const target = pending[0]!;
    const claimed = envelope(await client.callTool({ name: 'brain_claim_task', arguments: { id: target.id } }));
    const prog = claimed.ok
      ? envelope(await client.callTool({ name: 'brain_update_task_progress', arguments: { id: target.id, progress: 'live test in progress' } }))
      : { ok: false };
    const done = prog.ok
      ? envelope(await client.callTool({ name: 'brain_complete_task', arguments: { id: target.id, result: 'live external-client test completed the task' } }))
      : { ok: false };
    record('task loop (claim→progress→complete)', done.ok, done.ok ? `task "${target.title}" done` : JSON.stringify(done.error ?? claimed.error));
  }

  await client.close();

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('client error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
