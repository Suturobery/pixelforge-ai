/**
 * PixelForge AI — approval center (v3.1 §5.2 Task 11, minimal core).
 *
 * PAID tools never relay directly: the MCP server parks the call here,
 * pushes an approval-request to the editor (the human's UI), and only a
 * human click resumes it. Decisions are audited server-side; the agent has
 * NO tool to approve its own spend — respond_approval does not exist on the
 * MCP surface by design.
 *
 * In-memory v1: pending requests survive editor reconnects (re-shared on
 * hello) but not server restarts — the caller gets approval_timeout and
 * retries. Good enough for a single-user studio; persist when the desktop
 * job queue lands.
 */

import { randomUUID } from 'node:crypto';
import type { EditorLink } from './editor-link';

export const APPROVAL_TIMEOUT_SEC = 300; // 5 minutes for a human to decide

export type ApprovalDecision = 'approved' | 'denied' | 'timeout';

export interface ApprovalRequestInfo {
  id: string;
  tool: string;
  clientId: string;
  clientName: string;
  requestedAt: string;
  timeoutSec: number;
  /** short human-readable summary of what would be spent (prompt etc.) */
  summary: string;
}

interface PendingEntry {
  info: ApprovalRequestInfo;
  resolve: (d: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DecisionRecord {
  id: string;
  tool: string;
  clientName: string;
  decision: ApprovalDecision;
  at: string;
  summary: string;
}

export class ApprovalCenter {
  private pending = new Map<string, PendingEntry>();
  private decisions: DecisionRecord[] = [];
  private link: EditorLink | null = null;

  attach(link: EditorLink): void {
    this.link = link;
    // a (re)connected editor must see everything still pending
    link.onHello(() => this.reshare());
    link.onApprovalResponse(({ id, approve }) => this.respond(id, approve));
  }

  /** Park a paid call until the human decides. Resolves the decision. */
  request(info: Omit<ApprovalRequestInfo, 'id' | 'requestedAt' | 'timeoutSec'>): Promise<ApprovalDecision> {
    const id = randomUUID();
    const full: ApprovalRequestInfo = {
      ...info,
      id,
      requestedAt: new Date().toISOString(),
      timeoutSec: APPROVAL_TIMEOUT_SEC,
    };
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.record(full, 'timeout');
        resolve('timeout');
      }, APPROVAL_TIMEOUT_SEC * 1000);
      this.pending.set(id, { info: full, resolve, timer });
      this.push(full);
    });
  }

  respond(id: string, approve: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    const decision: ApprovalDecision = approve ? 'approved' : 'denied';
    this.record(entry.info, decision);
    entry.resolve(decision);
    return true;
  }

  list(): { pending: ApprovalRequestInfo[]; recent: DecisionRecord[] } {
    return {
      pending: [...this.pending.values()].map((e) => e.info),
      recent: this.decisions.slice(0, 20),
    };
  }

  /** Re-push every pending request (fresh editor page after reload). */
  private reshare(): void {
    for (const entry of this.pending.values()) this.push(entry.info);
  }

  private push(info: ApprovalRequestInfo): void {
    if (!this.link) return;
    this.link.send({
      type: 'approval-request',
      id: info.id,
      tool: info.tool,
      args: { summary: info.summary },
      clientId: info.clientId,
      clientName: info.clientName,
      requestedAt: info.requestedAt,
      timeoutSec: info.timeoutSec,
    });
  }

  private record(info: ApprovalRequestInfo, decision: ApprovalDecision): void {
    this.decisions.unshift({
      id: info.id,
      tool: info.tool,
      clientName: info.clientName,
      decision,
      at: new Date().toISOString(),
      summary: info.summary,
    });
    if (this.decisions.length > 50) this.decisions.length = 50;
  }
}
