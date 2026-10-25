/**
 * PixelForge AI — stdio proxy (v3.1 §5.1: "stdio proxy for spawn-based
 * clients", ~80 LOC). Bridges a process-based MCP client (stdin/stdout
 * JSON-RPC lines) to the PixelForge Streamable-HTTP endpoint on 127.0.0.1.
 *
 * Env:
 *   PF_MCP_URL    default http://127.0.0.1:3030/mcp
 *   PF_MCP_TOKEN  required — the paired client token (Bearer)
 *
 * The proxy is auth-transparent: it forwards one JSON-RPC message per line
 * and prefers JSON responses (Accept: application/json), tracking the
 * Mcp-Session-Id across the initialize handshake. Notifications (no id)
 * received from the server are printed to stderr for observability.
 */

const URL_ = process.env.PF_MCP_URL ?? 'http://127.0.0.1:3030/mcp';
const TOKEN = process.env.PF_MCP_TOKEN;

if (!TOKEN) {
  console.error('[pf-mcp-proxy] PF_MCP_TOKEN is required (the paired client token)');
  process.exit(2);
}

let sessionId: string | null = null;

async function post(body: string): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // spec: Streamable-HTTP clients MUST accept BOTH content types
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(URL_, { method: 'POST', headers, body });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  return res;
}

interface RpcMessage {
  id?: string | number | null;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}

function handleServerMessage(msg: RpcMessage): void {
  // notifications / server requests have no id echo — surface on stderr
  if (msg.id === undefined || msg.id === null) {
    process.stderr.write(`[pf-mcp-proxy] notification: ${JSON.stringify(msg)}\n`);
    return;
  }
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: RpcMessage;
  try {
    msg = JSON.parse(trimmed) as RpcMessage;
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
    return;
  }
  try {
    const res = await post(trimmed);
    if (!res.ok) {
      const text = await res.text();
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: `HTTP ${res.status}: ${text.slice(0, 300)}` } }) + '\n'
      );
      return;
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      // SSE: extract the JSON payload that answers THIS request id
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const rawLine = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!rawLine.startsWith('data:')) continue;
          const payload = rawLine.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as RpcMessage;
            if (parsed.id === undefined || parsed.id === null || parsed.id === msg.id) {
              handleServerMessage(parsed);
              if (parsed.id !== undefined && parsed.id !== null) {
                await reader.cancel().catch(() => {});
                return;
              }
            }
          } catch {
            /* keep reading */
          }
        }
      }
      return;
    }
    const text = await res.text();
    if (text.trim()) {
      try {
        handleServerMessage(JSON.parse(text) as RpcMessage);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: 'Invalid JSON from server' } }) + '\n');
      }
    }
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message: `Proxy transport error: ${err instanceof Error ? err.message : 'unknown'}` } }) + '\n'
    );
  }
}

const decoder = new TextDecoder();
let pending = '';
process.stdin.on('data', (chunk: Uint8Array) => {
  pending += decoder.decode(chunk, { stream: true });
  let idx: number;
  while ((idx = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, idx);
    pending = pending.slice(idx + 1);
    void handleLine(line);
  }
});
process.stdin.on('end', () => {
  if (pending.trim()) void handleLine(pending);
});
process.stdin.on('error', (err) => {
  console.error('[pf-mcp-proxy] stdin error:', err);
  process.exit(1);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
