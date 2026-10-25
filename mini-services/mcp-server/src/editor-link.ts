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

interface PendingCall {
  resolve: (envelope: ToolEnvelope) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EditorLink {
  private socket: EditorSocket | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, PendingCall>();
  private eventListeners = new Set<(evt: EditorEvent) => void>();

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

  /**
   * Accept a freshly opened socket. When an editor is already attached, the
   * NEWEST one takes over (the old socket is closed) — a page reload must
   * never be blocked by a zombie connection the server has not noticed yet.
   * The socket must send `hello` within HELLO_TIMEOUT_MS.
   */
  attach(socket: EditorSocket): AttachResult {
    if (this.socket && this.socket !== socket) {
      // take over: kill the stale holder first
      const stale = this.socket
      this.socket = null
      if (this.helloTimer) {
        clearTimeout(this.helloTimer)
        this.helloTimer = null
      }
      try {
        stale.close(4005, 'replaced by a newer editor')
      } catch {
        /* already gone */
      }
    }
    this.socket = socket
    this.helloTimer = setTimeout(() => {
      if (this.socket === socket) {
        this.detach(socket)
        socket.close(4001, 'hello timeout')
      }
    }, HELLO_TIMEOUT_MS)
    return { ok: true }
  }

  detach(socket: EditorSocket): void {
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

  /** Handle one inbound message from the editor. Returns nothing; all
   *  errors resolve pending calls with structured envelopes. */
  handleInbound(msg: EditorInbound): void {
    switch (msg.type) {
      case 'hello': {
        this.appVersion = msg.appVersion ?? null;
        this.bridgeVersion = msg.bridgeVersion ?? null;
        this.origin = msg.origin ?? null;
        this.connectedAt = new Date().toISOString();
        if (this.helloTimer) {
          clearTimeout(this.helloTimer);
          this.helloTimer = null;
        }
        break;
      }
      case 'ping': {
        this.send({ type: 'pong' });
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
