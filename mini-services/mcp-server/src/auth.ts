/**
 * PixelForge AI — authentication & rate-limiting primitives (v3.1 §5.5).
 *
 * Real authentication, not a static header:
 *   • pairing credentials are 6-word one-time tokens (~49.85 bits of CSPRNG
 *     entropy from a 317-word list — unbiased selection, see below),
 *     valid for PAIRING_TTL_MS, single-use, tier-bound at generation time;
 *   • clients authenticate with `Authorization: Bearer <pfm_…>` — 32 random
 *     bytes; only the SHA-256 of each token is persisted;
 *   • revocation is immediate (the store is the single source of truth);
 *   • expired/revoked/unknown tokens are audited as security events, and the
 *     HTTP layer throttles failed authentication attempts (brute-force cap).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { WORDS } from './words';
import { TIER_RATE_LIMITS, type PendingPairing, type Tier } from './types';

export const PAIRING_TTL_MS = 15 * 60 * 1000;

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 6-word pairing credential, e.g. "amber-otter-lunar-pixel-forge-tide".
 *
 * Task 13a entropy correction: the original implementation drew ONE byte per
 * word and applied `% WORDS.length` (317) — but a byte only spans 0–255, so
 * indices 256–316 were unreachable and the real entropy was 6 × log2(256) =
 * 48 bits, NOT ≈50 as claimed. The fix draws 2 bytes with rejection sampling
 * over the full 317-word list → uniform, unbiased selection and
 * 6 × log2(317) ≈ 49.85 bits of entropy (the "≈50 bits" claim is now true).
 */
export function generatePairingToken(): string {
  const words: string[] = [];
  const n = WORDS.length;
  const max = Math.floor(65536 / n) * n; // largest multiple of n within 2 bytes
  for (let i = 0; i < 6; i++) {
    let draw = 0;
    do {
      draw = randomBytes(2).readUInt16BE(0);
    } while (draw >= max); // rejection sampling kills the modulo bias
    words.push(WORDS[draw % n]);
  }
  return words.join('-');
}

/** Persistent client credential: 256-bit CSPRNG, prefix-tagged. */
export function generateClientToken(): string {
  return `pfm_${randomBytes(32).toString('base64url')}`;
}

export function generateClientId(): string {
  return `pfc_${randomBytes(8).toString('hex')}`;
}

export function newPendingPairing(tier: Tier): { token: string; pairing: PendingPairing } {
  const token = generatePairingToken();
  const now = Date.now();
  return {
    token,
    pairing: {
      tokenHash: sha256Hex(token),
      tier,
      createdAt: now,
      expiresAt: now + PAIRING_TTL_MS,
      used: false,
    },
  };
}

export function pairingUsable(p: PendingPairing, now = Date.now()): boolean {
  return !p.used && now < p.expiresAt;
}

/** Constant-time comparison of two hex digests. */
export function hashesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// rate limiting — fixed one-minute windows, per client id (§5.5: 60/30 rpm)
// ---------------------------------------------------------------------------

interface Window {
  startedAt: number;
  count: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();

  /**
   * Returns true when the action is allowed, false when the per-minute
   * budget for `key` is exhausted. Callers pass the client's TIER limit.
   */
  allow(key: string, tier: Tier): boolean {
    const now = Date.now();
    const limit = TIER_RATE_LIMITS[tier];
    let w = this.windows.get(key);
    if (!w || now - w.startedAt >= 60_000) {
      w = { startedAt: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    return w.count <= limit;
  }

  reset(): void {
    this.windows.clear();
  }

  /** Used count + seconds until the sliding window resets, for one key. */
  usage(key: string): { used: number; resetInSec: number } | null {
    const w = this.windows.get(key);
    if (!w) return null;
    return { used: w.count, resetInSec: Math.max(0, Math.ceil((w.startedAt + 60_000 - Date.now()) / 1000)) };
  }
}
