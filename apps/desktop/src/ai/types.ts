/**
 * PixelForge AI — desktop AI job types (v3.1 Plan §3.1; Task 9).
 *
 * The Electron MAIN process owns the job manager: the queue, timeouts,
 * retries, cancellation, the result cache and the spend meter all live here,
 * away from the renderer. Provider credentials are resolved in-process from
 * the Task-13a vault (SettingsStore.revealApiKey) and NEVER cross the bridge.
 *
 * This module is PURE (no electron imports) so bun tests exercise every
 * rule with fake adapters/clocks (the service wiring lives in service.ts).
 */

export type AiJobStatus = 'queued' | 'generating' | 'done' | 'error' | 'cancelled';

/** What the renderer submits over the bridge (NO key material, ever). */
export interface AiJobRequest {
  prompt: string;
  /** provider profile id from settings (e.g. 'zai', 'openai', 'custom') */
  providerId: string;
  /** target sprite size — the job request size derives from the aspect */
  width: number;
  height: number;
  /** candidate count 1..4 (fanned out when the provider lacks `n`) */
  count?: number;
  /** optional seed — honored only when the provider supports seeds */
  seed?: number;
  /** optional client correlation id (echoed in events) */
  clientId?: string;
}

/** A finished image candidate (base64, no data-url wrapper). */
export interface AiJobImage {
  base64: string;
}

/** Renderer-safe job view: provenance + status, never credentials. */
export interface AiJobView {
  jobId: string;
  clientId: string | null;
  status: AiJobStatus;
  prompt: string;
  providerId: string;
  providerLabel: string;
  model: string;
  requestSize: string;
  count: number;
  seed: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** ESTIMATE from the price table; null = unknown (never an exact charge) */
  costEstimateUsd: number | null;
  cacheHit: boolean;
  error: { code: string; message: string } | null;
  images: AiJobImage[];
  /** queue position when still queued (0 = next) */
  queuePosition: number | null;
}

/** Provider adapter the job manager calls. Implementations own transport. */
export interface AiAdapter {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly model: string;
  readonly kind: 'zai' | 'openai' | 'custom';
  /** resolved capability set (contract from @pixelforge/core semantics) */
  readonly supportsN: boolean;
  /** Run one generation request. Must honor the abort signal. */
  generate(args: {
    fullPrompt: string;
    requestSize: string;
    count: number;
    seed?: number;
    signal: AbortSignal;
  }): Promise<string[]>;
}

/** Injectable clock/sleep for deterministic tests. */
export interface JobClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const REAL_CLOCK: JobClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) {
        const onAbort = () => {
          clearTimeout(t);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    }),
};

/** Injectable usage persistence (main writes JSON to userData in service.ts). */
export interface UsageRecord {
  jobId: string;
  providerId: string;
  providerLabel: string;
  model: string;
  promptLength: number;
  requestSize: string;
  count: number;
  status: AiJobStatus;
  cacheHit: boolean;
  durationMs: number | null;
  costEstimateUsd: number | null;
  finishedAt: string;
}

export interface UsageStore {
  load(): UsageRecord[];
  append(record: UsageRecord): void;
}
