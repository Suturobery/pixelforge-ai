/**
 * PixelForge AI — MCP server shared types (v3.1 §5).
 *
 * Permission tiers (v3.1 §5.2): L0 read · L1 undoable writes ·
 * L2 destructive/disk · L3 paid AI (generate_sprite, approval-gated).
 * Task 11 registered the L2/L3 set — the paid tool parks on the approval
 * center until the human approves; tier + rate limits still apply.
 */

export type Tier = 'L0' | 'L1' | 'L2' | 'L3';

export const TIER_RANK: Record<Tier, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

/** True when `held` grants access to a tool of tier `needed`. */
export function tierGrants(held: Tier, needed: Tier): boolean {
  return TIER_RANK[held] >= TIER_RANK[needed];
}

export const TIER_RATE_LIMITS: Record<Tier, number> = {
  L0: 60, // requests per minute (§5.5)
  L1: 120, // raised from 30: sprite imports batch whole frames per call —
           // 30 starved legitimate draw flows; the 2 MB body cap + auth
           // remain the real guards against abuse
  L2: 60, // destructive ops — deliberate pace
  L3: 20, // paid generation — hard-capped
};

/** A paired, allowlisted client. The token is stored ONLY as a SHA-256 hash. */
export interface PairedClient {
  clientId: string;
  name: string;
  tier: Tier;
  /** sha256 hex of the bearer token — the plaintext never touches disk. */
  tokenHash: string;
  createdAt: string;
  lastSeen: string | null;
  revoked: boolean;
}

/** A one-time pairing credential (Settings → Connect AI Assistant). */
export interface PendingPairing {
  /** sha256 of the 6-word token. */
  tokenHash: string;
  tier: Tier;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export interface AuditEntry {
  ts: string;
  kind: 'tool' | 'auth' | 'pair' | 'ctrl' | 'security';
  clientId: string | null;
  clientName: string;
  /** Tool name — or the security event code for non-tool entries. */
  tool: string;
  tier: Tier | null;
  /** SHA-256 of the JSON-stringified args (params are never stored raw, §5.5). */
  argsHash: string | null;
  ok: boolean;
  errorCode: string | null;
  durationMs: number;
  summary: string | null;
}

/** Structured tool envelope (v3.1 §5.3 output contract). */
export interface ToolEnvelope {
  ok: boolean;
  error?: { code: string; message: string; hint?: string };
  data?: unknown;
  undoable?: boolean;
  stateHash?: string | null;
  summary?: string | null;
}

/** Messages the SERVER sends to the editor over the bridge WebSocket. */
export type EditorOutbound =
  | { type: 'hello-ok'; server: EditorServerStatus }
  | { type: 'pong' }
  | { type: 'tool-request'; id: string; tool: string; args: unknown; clientId: string; clientName: string; tier: Tier }
  | { type: 'approval-request'; id: string; tool: string; args: unknown; clientId: string; clientName: string; requestedAt: string; timeoutSec: number }
  | { type: 'ctrl-result'; id: string; ok: boolean; data?: unknown; error?: { code: string; message: string } }
  | { type: 'status'; server: EditorServerStatus };

/** Messages the EDITOR (renderer bridge) sends to the server. */
export interface EditorInbound {
  type:
    | 'hello'
    | 'ping'
    | 'tool-result'
    | 'approval-response'
    | 'ctrl-request'
    | 'status-update'
    | 'event';
  // hello
  bridgeVersion?: number;
  appVersion?: string;
  origin?: string;
  /** shared editor secret — see editor-auth.ts (hello is rejected without it) */
  editorKey?: string;
  /** fresh page claims the slot from a stale holder (sent after repeated rejects) */
  takeover?: boolean;
  // tool-result
  id?: string;
  ok?: boolean;
  data?: unknown;
  error?: { code: string; message: string; hint?: string };
  undoable?: boolean;
  stateHash?: string | null;
  summary?: string | null;
  // approval-response
  approve?: boolean;
  // ctrl-request
  ctrl?: CtrlRequest;
  // status-update
  mcpEnabled?: boolean;
  // event
  event?: EditorEvent;
}

export type CtrlRequest =
  | { kind: 'status' }
  | { kind: 'pair-generate'; tier: Tier }
  | { kind: 'pair-cancel'; token: string }
  | { kind: 'clients-list' }
  | { kind: 'client-revoke'; clientId: string }
  /** Remove a client record only after it has been revoked. */
  | { kind: 'client-remove'; clientId: string }
  | { kind: 'ops-recent'; limit?: number }
  | { kind: 'approvals-list' }
  | { kind: 'brain-push'; tasks: Array<{ title: string; detail: string; idempotencyKey?: string }>; replacePending?: boolean; planId?: string }
  | { kind: 'brain-tasks' }
  | { kind: 'brain-clear' }
  | { kind: 'brain-retry'; id?: string }
  /** editor-side cancel — the human may cancel ANY unfinished task */
  | { kind: 'brain-cancel'; id: string }
  /** dormant: broadcast tools/list_changed when the catalog ever becomes dynamic */
  | { kind: 'tools-changed' };

export interface EditorEvent {
  type: 'projectChanged' | 'editorStatus';
  stateHash?: string | null;
  name?: string | null;
  dirty?: boolean;
}

export interface EditorServerStatus {
  mcpEnabled: boolean;
  endpoint: string;
  clientsPaired: number;
  clientsConnected: number;
  editorConnected: boolean;
  lastStateHash: string | null;
  startedAt: string;
}

export const BRIDGE_PROTOCOL_VERSION = 1;
