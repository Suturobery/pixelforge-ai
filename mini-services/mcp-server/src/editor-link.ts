/**
 * PixelForge AI — editor link (v3.1 §5.1 "in-process Command Bus" leg).
 *
 * The CommandBus lives in the PixelForge renderer (web testbed AND the
 * Electron dev renderer both run the same Next.js UI). This module is the
 * single, authenticated channel between the MCP server and that renderer:
 *
 *   tool call (MCP client) → auth/tier/rate checks → tool-request over this
 *   link → the renderer executes it on the REAL bus → tool-result → MCP.
 *
 * There is no second editor state on this side: if no editor is connected,
 * every document tool returns the structured `editor_not_connected` error.
 */

import { randomUUID } from 'node:crypto';
import type { EditorEvent, EditorInbound, EditorOutbound, EditorServerStatus, ToolEnvelope } from './types';

export interface EditorSocket {
  /** Must serialize to an EditorInbound/EditorOutbound JSON message. */
  send(json: string): void;
  close(code: number, reason: string): void;
}

export interface AttachResult {
  ok: boolean;
  reason?: 'editor_already_connected' | 'hello_timeout';
}

const TOOL_TIMEOUT_MS = 30_000;
const HELLO_TIMEOUT_MS = 5_000;
/** bridge pings every 15 s — a holder silent longer than this looks dead */
const EDITOR_FRESH_MS = 25_000;

interface PendingCall {
  resolve: (envelope: ToolEnvelope) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EditorLink {
  private socket: EditorSocket | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  /** a second connection awaiting its hello (takeover or reject) */
  private candidate: { socket: EditorSocket; timer: ReturnType<typeof setTimeout> } | null = null;
  private pending = new Map<string, PendingCall>();
  private eventListeners = new Set<(evt: EditorEvent) => void>();
  private approvalListeners = new Set<(msg: { id: string; approve: boolean }) => void>();
  private helloListeners = new Set<() => void>();
  /** last sign of life from the attached editor (hello or ping) */
  private lastAliveAt = 0;

  appVersion: string | null = null;
  bridgeVersion: number | null = null;
  origin: string | null = null;
  connectedAt: string | null = null;
  lastStateHash: string | null = null;
  lastProjectName: string | null = null;
  lastDirty: boolean | null = null;

  get connected(): boolean {
    return this.socket !== null;
  }

  onEvent(fn: (evt: EditorEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /** Human approval decisions from the editor UI (approval center). */
  onApprovalResponse(fn: (msg: { id: string; approve: boolean }) => void): () => void {
    this.approvalListeners.add(fn);
    return () => this.approvalListeners.delete(fn);
  }

  /** Fired after a (re)connect hello — pending approvals are re-shared. */
  onHello(fn: () => void): () => void {
    this.helloListeners.add(fn);
    return () => this.helloListeners.delete(fn);
  }

  /**
   * Accept a freshly opened socket. A HEALTHY holder keeps the slot: the
   * editor bridge pings every 15 s, so any holder that signaled life within
   * EDITOR_FRESH_MS is alive and a newcomer is rejected — two app pages (or
   * a stale tab running old bridge code) must never steal the slot from each
   * other in a 4005 war. Replace happens only when the holder looks dead
   * (pings stopped — page reload the server has not noticed yet).
   * The socket must send `hello` within HELLO_TIMEOUT_MS.
   */
  attach(socket: EditorSocket): AttachResult {
    if (this.socket && this.socket !== socket) {
      const fresh = Date.now() - this.lastAliveAt < EDITOR_FRESH_MS;
      if (!fresh) {
        // holder went silent (page reload the server has not noticed) — take over
        const stale = this.socket
        this.socket = null
        if (this.helloTimer) {
          clearTimeout(this.helloTimer)
          this.helloTimer = null
        }
        console.error(`[pf-mcp] editor REPLACED at ${new Date().toISOString()} — previous editor went quiet (${Date.now() - this.lastAliveAt}ms)`)
        try {
          stale.close(4005, 'replaced by a newer editor')
        } catch {
          /* already gone */
        }
      } else {
        // healthy holder keeps the slot; the newcomer stays connected only
        // until its hello — a takeover flag flips ownership, anything else
        // is rejected. Two live editors can no longer steal from each other.
        console.error(`[pf-mcp] editor candidate at ${new Date().toISOString()} — healthy holder present, awaiting hello (takeover?)`)
        this.clearCandidate();
        this.candidate = { socket, timer: setTimeout(() => this.rejectCandidate(socket), HELLO_TIMEOUT_MS) };
        return { ok: true }
      }
    }
    this.socket = socket
    this.lastAliveAt = Date.now()
    console.error(`[pf-mcp] editor attached at ${new Date().toISOString()}`)
    this.startHelloTimer(socket)
    return { ok: true }
  }

  private startHelloTimer(socket: EditorSocket): void {
    if (this.helloTimer) clearTimeout(this.helloTimer)
    this.helloTimer = setTimeout(() => {
      if (this.socket === socket) {
        this.detach(socket)
        socket.close(4001, 'hello timeout')
      }
    }, HELLO_TIMEOUT_MS)
  }

  private clearCandidate(): void {
    if (this.candidate) {
      clearTimeout(this.candidate.timer)
      this.candidate = null
    }
  }

  private rejectCandidate(socket: EditorSocket): void {
    if (this.candidate?.socket !== socket) return
    this.candidate = null
    console.error(`[pf-mcp] editor REJECTED at ${new Date().toISOString()} — healthy editor already connected`)
    try {
      socket.close(4000, 'another editor is connected')
    } catch {
      /* already gone */
    }
  }

  /** True when the given socket is the current editor owner. */
  isEditor(socket: EditorSocket): boolean {
    return this.socket === socket
  }

  detach(socket: EditorSocket): void {
    if (this.candidate?.socket === socket) this.clearCandidate();
    if (this.socket !== socket) return;
    this.socket = null;
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
    this.appVersion = null;
    this.bridgeVersion = null;
    this.origin = null;
    this.connectedAt = null;
    // fail every in-flight call so clients get structured errors, not hangs
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.resolve({
        ok: false,
        error: {
          code: 'editor_disconnected',
          message: 'The PixelForge editor disconnected while the tool was running.',
          hint: 'Re-open the editor and retry.',
        },
      });
      this.pending.delete(id);
    }
  }

  /** Handle one inbound message from the editor. `fromSocket` identifies the
   *  sender — required to arbitrate hello/takeover between two connections.
   *  All errors resolve pending calls with structured envelopes, not hangs. */
  handleInbound(msg: EditorInbound, fromSocket?: EditorSocket): void {
    const from = fromSocket ?? this.socket ?? undefined;
    if (msg.type !== 'hello' && from && from !== this.socket) {
      return; // only the current editor can drive tools/events/state
    }
    switch (msg.type) {
      case 'hello': {
        if (from && from !== this.socket) {
          this.clearCandidate();
          if (msg.takeover === true) {
            // lock-holding fresh page claims the slot from a stale holder
            const stale = this.socket;
            try {
              stale?.close(4005, 'replaced by editor takeover');
            } catch {
              /* already gone */
            }
            this.socket = from;
            this.lastAliveAt = Date.now();
            console.error(`[pf-mcp] editor TAKEOVER at ${new Date().toISOString()} — new editor claimed the slot from the stale holder`);
          } else {
            console.error(`[pf-mcp] editor REJECTED at ${new Date().toISOString()} — healthy editor already connected (candidate sent no takeover)`);
            try {
              from.close(4000, 'another editor is connected');
            } catch {
              /* already gone */
            }
            return;
          }
        } else {
          this.lastAliveAt = Date.now();
        }
        this.appVersion = msg.appVersion ?? null;
        this.bridgeVersion = msg.bridgeVersion ?? null;
        this.origin = msg.origin ?? null;
        this.connectedAt = new Date().toISOString();
        this.lastAliveAt = Date.now();
        if (this.helloTimer) {
          clearTimeout(this.helloTimer);
          this.helloTimer = null;
        }
        for (const fn of this.helloListeners) fn();
        break;
      }
      case 'ping': {
        this.lastAliveAt = Date.now();
        this.send({ type: 'pong' });
        break;
      }
      case 'approval-response': {
        if (typeof msg.id !== 'string' || !msg.id) return;
        const approve = msg.approve === true;
        for (const fn of this.approvalListeners) fn({ id: msg.id, approve });
        break;
      }
      case 'tool-result': {
        if (!msg.id) return;
        const call = this.pending.get(msg.id);
        if (!call) return;
        clearTimeout(call.timer);
        this.pending.delete(msg.id);
        call.resolve({
          ok: msg.ok === true,
          data: msg.data,
          error: msg.error,
          undoable: msg.undoable,
          stateHash: msg.stateHash ?? null,
          summary: msg.summary ?? null,
        });
        break;
      }
      case 'event': {
        if (!msg.event) return;
        if (msg.event.type === 'projectChanged') {
          if (msg.event.stateHash !== undefined) this.lastStateHash = msg.event.stateHash;
          if (msg.event.name !== undefined) this.lastProjectName = msg.event.name;
          if (msg.event.dirty !== undefined) this.lastDirty = msg.event.dirty;
        }
        for (const fn of this.eventListeners) fn(msg.event);
        break;
      }
      default:
        break;
    }
  }

  send(msg: EditorOutbound): void {
    if (!this.socket) return;
    try {
      this.socket.send(JSON.stringify(msg));
    } catch {
      /* socket raced a close — detach happens via the close handler */
    }
  }

  status(base: { mcpEnabled: boolean; endpoint: string; clientsPaired: number; clientsConnected: number; startedAt: string }): EditorServerStatus {
    return {
      mcpEnabled: base.mcpEnabled,
      endpoint: base.endpoint,
      clientsPaired: base.clientsPaired,
      clientsConnected: base.clientsConnected,
      editorConnected: this.connected,
      lastStateHash: this.lastStateHash,
      startedAt: base.startedAt,
    };
  }

  /**
   * Relay one tool call to the editor. Rejects ONLY on transport-level
   * problems (no editor / busy server state) — document-level validation
   * errors arrive as ToolEnvelope.ok=false.
   */
  requestTool(req: {
    tool: string;
    args: unknown;
    clientId: string;
    clientName: string;
    tier: import('./types').Tier;
  }): Promise<ToolEnvelope> {
    if (!this.socket) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'editor_not_connected',
          message: 'No PixelForge editor is connected to the MCP server.',
          hint: 'Open the PixelForge AI app and enable MCP in Settings → MCP.',
        },
      });
    }
    const id = randomUUID();
    return new Promise<ToolEnvelope>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          error: {
            code: 'editor_timeout',
            message: `The editor did not answer the "${req.tool}" call within ${TOOL_TIMEOUT_MS / 1000} s.`,
            hint: 'Check that the app is responsive, then retry.',
          },
        });
      }, TOOL_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.send({ type: 'tool-request', id, tool: req.tool, args: req.args, clientId: req.clientId, clientName: req.clientName, tier: req.tier });
    });
  }

}
