/**
 * PixelForge AI — desktop AI job manager (v3.1 Plan §3.1; Task 9).
 *
 * queue `queued → generating → done|error|cancelled` with:
 *   • concurrency 1 per provider (FIFO overall)
 *   • per-job timeout (plan: 120 s, verified needed)
 *   • retry ×3 with backoff for TRANSIENT failures only (timeouts/network;
 *     structured capability/config errors fail fast)
 *   • cancellation through AbortController at any stage
 *   • result cache: sha256(provider|model|prompt|size|seed) → hits cost
 *     nothing and skip the adapter entirely (plan §3.2)
 *   • spend meter: pre-flight ESTIMATE + monthly cap with hard stop +
 *     warning threshold; cache hits are always $0
 *   • usage records for the meter/history (injected persistence)
 *
 * PURE orchestration: adapters, clock and usage persistence are injected;
 * the cache key is a SYNC sha256 (node:crypto — the manager runs in the
 * Electron main process) so the pre-flight cache probe and spend gate are
 * race-free.
 */

import { createHash } from 'node:crypto';

import {
  REAL_CLOCK,
  type AiAdapter,
  type AiJobRequest,
  type AiJobStatus,
  type AiJobView,
  type JobClock,
  type UsageRecord,
  type UsageStore,
} from './types';

export const JOB_TIMEOUT_MS = 120_000; // plan §3.1 (verified needed)
export const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1_500, 3_000];
const CACHE_CAP = 50;

export class AiJobError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Transient errors are retried; everything else fails fast. */
function isTransient(err: unknown): boolean {
  if (err instanceof AiJobError) return false;
  if (err instanceof Error) {
    if (err.name === 'AbortError') return false; // cancellation is not retried
    return /timeout|timed out|network|fetch failed|ECONN|socket|HTTP 5\d\d|HTTP 429/i.test(err.message);
  }
  return false;
}

interface CacheEntry {
  images: string[];
  model: string;
  createdAt: number;
}

interface InternalJob {
  id: string;
  request: AiJobRequest;
  status: AiJobStatus;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  costEstimateUsd: number | null;
  cacheHit: boolean;
  error: { code: string; message: string } | null;
  images: string[];
  abort: AbortController | null;
  adapter: AiAdapter | null;
  /** set by the deadline timer — distinguishes timeout from user cancel */
  timedOut: boolean;
}

export interface JobManagerOptions {
  /** Resolve the adapter for a provider id, or null when unknown/locked. */
  resolveAdapter(providerId: string): AiAdapter | null;
  clock?: JobClock;
  usage?: UsageStore;
  /** Monthly spending cap in USD (0 = unlimited). Hard stop before submit. */
  monthlyLimitUsd?: number;
  /** Warning threshold in USD (fires a spend_warning event once crossed). */
  warnUsd?: number;
  /** Milliseconds of a "month" for the spend window (default 30d). */
  monthMs?: number;
  /** Per-job deadline (default JOB_TIMEOUT_MS = plan §3.1's 120 s). */
  timeoutMs?: number;
}

/** Deterministic SYNC sha256 for cache keys (node:crypto; main process). */
function sha256HexSync(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export class AiJobManager {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly order: string[] = [];
  private readonly cache = new Map<string, CacheEntry>();
  private readonly running = new Set<string>();
  private readonly opts: Required<Pick<JobManagerOptions, 'resolveAdapter'>> & JobManagerOptions;
  private readonly clock: JobClock;
  private seq = 0;
  private warnedThisMonth = false;
  private monthAnchor = 0;

  /** Subscribers receive every job-view change + spend warnings. */
  private readonly listeners = new Set<(event: AiManagerEvent) => void>();

  constructor(opts: JobManagerOptions) {
    this.opts = opts;
    this.clock = opts.clock ?? REAL_CLOCK;
    this.monthAnchor = this.monthStart(this.clock.now());
  }

  // ------------------------------------------------------------------ events

  onEvent(listener: (event: AiManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AiManagerEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        /* listener errors never break the queue */
      }
    }
  }

  private emitJob(job: InternalJob): void {
    this.emit({ type: 'job', job: this.toView(job) });
  }

  // ------------------------------------------------------------------ submit

  /**
   * Submit a generation request. Pre-flight checks run synchronously:
   * config → cache probe (hits are free) → spend cap. Returns the job id.
   * Throws AiJobError ONLY for pre-flight rejections.
   */
  submit(request: AiJobRequest): string {
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
    if (!prompt) throw new AiJobError('invalid_request', 'Prompt is required.');
    if (prompt.length > 600) throw new AiJobError('invalid_request', 'Prompt too long (max 600 chars).');
    const w = Math.floor(request.width);
    const h = Math.floor(request.height);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 8 || h < 8 || w > 512 || h > 512) {
      throw new AiJobError('invalid_request', 'Sprite dimensions must be integers in [8, 512].');
    }
    const count = Math.max(1, Math.min(4, Math.floor(request.count ?? 1)));

    const adapter = this.opts.resolveAdapter(request.providerId);
    if (!adapter) {
      throw new AiJobError(
        'provider_unavailable',
        `Provider "${request.providerId}" is not configured with a usable key. Add it in Settings → AI.`,
      );
    }

    // cache probe (plan §3.2: hits cost nothing) — SYNC, so a cache hit
    // genuinely bypasses the spend gate ($0 ⇒ within any cap)
    const cacheKey = this.computeCacheKey(adapter, prompt, w, h, request.seed);
    const cacheHitAtSubmit = this.cache.has(cacheKey);

    // spend cap (estimates only — never presented as exact charges)
    this.rollMonth();
    const estimate = this.estimate(adapter, count);
    const limit = this.opts.monthlyLimitUsd ?? 0;
    if (limit > 0 && estimate !== null && !cacheHitAtSubmit) {
      const spent = this.monthSpend();
      if (spent + estimate > limit) {
        throw new AiJobError(
          'spend_limit',
          `Estimated $${estimate.toFixed(3)} would exceed the monthly cap of $${limit.toFixed(2)} (used ≈ $${spent.toFixed(2)}). Raise or disable the cap in Settings → AI.`,
        );
      }
      const warn = this.opts.warnUsd ?? 0;
      if (warn > 0 && !this.warnedThisMonth && spent + estimate >= warn) {
        this.warnedThisMonth = true;
        this.emit({ type: 'spend_warning', spentUsd: spent + estimate, warnUsd: warn, limitUsd: limit });
      }
    }

    this.seq += 1;
    const job: InternalJob = {
      id: `job-${Date.now().toString(36)}-${this.seq}`,
      request: { ...request, prompt, width: w, height: h, count },
      status: 'queued',
      queuedAt: this.clock.now(),
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      costEstimateUsd: estimate,
      cacheHit: false,
      error: null,
      images: [],
      abort: null,
      adapter,
      timedOut: false,
    };
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.emitJob(job);
    void this.pump();
    return job.id;
  }

  /** Cancel a queued or running job. Returns true when something was cancelled. */
  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.error = { code: 'cancelled', message: 'Cancelled by the user.' };
      job.finishedAt = this.clock.now();
      this.recordUsage(job);
      this.emitJob(job);
      return true;
    }
    if (job.status === 'generating') {
      job.abort?.abort();
      return true; // completion path marks it cancelled
    }
    return false;
  }

  get(jobId: string): AiJobView | null {
    const job = this.jobs.get(jobId);
    return job ? this.toView(job) : null;
  }

  list(): AiJobView[] {
    return this.order
      .slice(-100)
      .map((id) => this.jobs.get(id))
      .filter((j): j is InternalJob => !!j)
      .map((j) => this.toView(j))
      .reverse();
  }

  /** Recent usage records (renderer meter/history; no credentials inside). */
  usage(): UsageRecord[] {
    return this.opts.usage?.load() ?? [];
  }

  /** Sum of ESTIMATED spend in the current month window (cache hits are $0). */
  monthSpend(): number {
    this.rollMonth();
    let sum = 0;
    for (const r of this.opts.usage?.load() ?? []) {
      if (r.cacheHit) continue;
      if (r.costEstimateUsd === null) continue;
      const t = Date.parse(r.finishedAt);
      if (!Number.isFinite(t) || t < this.monthAnchor) continue;
      sum += r.costEstimateUsd;
    }
    return sum;
  }

  /** Cache entries (diagnostics; images not exposed). */
  cacheSize(): number {
    return this.cache.size;
  }

  // -------------------------------------------------------------------- pump

  private async pump(): Promise<void> {
    for (;;) {
      const runningForProvider = new Set<string>();
      for (const id of this.running) {
        const j = this.jobs.get(id);
        if (j) runningForProvider.add(j.request.providerId);
      }
      const nextId = this.order.find((id) => {
        const j = this.jobs.get(id);
        return j && j.status === 'queued' && !runningForProvider.has(j.request.providerId);
      });
      if (!nextId) return;
      const job = this.jobs.get(nextId)!;
      if (job.status !== 'queued') continue;
      void this.runJob(job);
      // one provider at a time: wait for THIS job to leave the queue slot
      await this.waitForNotGenerating(job.id);
    }
  }

  private waitForNotGenerating(jobId: string): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        const j = this.jobs.get(jobId);
        if (!j || j.status !== 'generating') resolve();
        else setTimeout(check, 25);
      };
      check();
    });
  }

  private async runJob(job: InternalJob): Promise<void> {
    const adapter = job.adapter!;
    job.status = 'generating';
    job.startedAt = this.clock.now();
    job.abort = new AbortController();
    this.running.add(job.id);
    this.emitJob(job);

    // deadline (plan §3.1: 120 s timeout — verified needed). Fires only when
    // the user did not cancel first; mapped to a structured timeout error.
    const deadline = setTimeout(() => {
      job.timedOut = true;
      job.abort?.abort();
    }, this.opts.timeoutMs ?? JOB_TIMEOUT_MS);

    try {
      // cache short-circuit (plan §3.2: hits cost nothing)
      const key = this.computeCacheKey(adapter, job.request.prompt, job.request.width, job.request.height, job.request.seed);
      const hit = this.cache.get(key);
      if (hit) {
        job.images = hit.images;
        job.cacheHit = true;
        job.costEstimateUsd = 0;
        job.status = 'done';
        job.finishedAt = this.clock.now();
        job.durationMs = job.finishedAt - (job.startedAt ?? job.queuedAt);
        this.touchCache(key, hit);
        this.recordUsage(job);
        this.emitJob(job);
        return;
      }

      const images = await this.generateWithRetry(job, adapter);
      this.cache.set(key, { images, model: adapter.model, createdAt: this.clock.now() });
      this.trimCache();
      job.images = images;
      job.status = 'done';
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (job.timedOut) {
          const limitS = Math.round((this.opts.timeoutMs ?? JOB_TIMEOUT_MS) / 1000);
          job.status = 'error';
          job.error = { code: 'timeout', message: `Generation exceeded the ${limitS} s limit and was stopped.` };
        } else {
          job.status = 'cancelled';
          job.error = { code: 'cancelled', message: 'Cancelled by the user.' };
        }
      } else if (err instanceof AiJobError) {
        job.status = 'error';
        job.error = { code: err.code, message: err.message };
      } else {
        job.status = 'error';
        job.error = {
          code: 'generation_failed',
          message: err instanceof Error ? err.message : 'Generation failed',
        };
      }
    } finally {
      clearTimeout(deadline);
      this.running.delete(job.id);
      job.finishedAt = this.clock.now();
      job.durationMs = job.finishedAt - (job.startedAt ?? job.queuedAt);
      this.recordUsage(job);
      this.emitJob(job);
    }
  }

  private async generateWithRetry(job: InternalJob, adapter: AiAdapter): Promise<string[]> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      if (job.abort!.signal.aborted) throw newDOMAbort();
      try {
        const fullPrompt = this.fullPrompt(job.request.prompt);
        const images = await adapter.generate({
          fullPrompt,
          requestSize: this.requestSize(job.request.width, job.request.height),
          count: job.request.count ?? 1,
          seed: job.request.seed,
          signal: job.abort!.signal,
        });
        if (images.length === 0) throw new AiJobError('bad_response', 'Provider returned no images.');
        return images;
      } catch (err) {
        lastErr = err;
        if (err instanceof Error && err.name === 'AbortError') throw err;
        if (!isTransient(err) || attempt === RETRY_ATTEMPTS - 1) break;
        await this.clock.sleep(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]!, job.abort!.signal);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Generation failed');
  }

  // ------------------------------------------------------------- helpers

  /** Sprite-oriented prompt engineering — identical to the verified web route. */
  private fullPrompt(prompt: string): string {
    return [
      prompt,
      'pixel art sprite, retro 16-bit game asset style',
      'crisp clean pixels, sharp edges, limited color palette',
      'single centered subject, full body visible',
      'plain solid white background, no shadow, no text',
      'high quality',
    ].join(', ');
  }

  private requestSize(w: number, h: number): string {
    const aspect = w / h;
    if (aspect > 1.2) return '1344x768';
    if (aspect < 0.83) return '768x1344';
    return '1024x1024';
  }

  private computeCacheKey(adapter: AiAdapter, prompt: string, w: number, h: number, seed?: number): string {
    // seed participates only when the provider honors seeds (structural
    // contract — mirrors @pixelforge/core's cacheKeyFor)
    const seedPart = adapter.kind === 'zai' || seed === undefined ? '' : String(seed);
    const parts = [adapter.providerId, adapter.kind, adapter.model, this.fullPrompt(prompt), this.requestSize(w, h), seedPart];
    return sha256HexSync(parts.join('\u0000'));
  }

  private touchCache(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private trimCache(): void {
    while (this.cache.size > CACHE_CAP) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private estimate(adapter: AiAdapter, count: number): number | null {
    const table: Record<string, number> = {
      'gpt-image-1': 0.027,
      'gpt-image-1-mini': 0.005,
      'dall-e-3': 0.04,
      'dall-e-2': 0.02,
      'gemini-2.5-flash-image': 0.03,
    };
    const per = table[adapter.model.trim().toLowerCase()];
    if (per === undefined) return null;
    return per * Math.max(1, count);
  }

  private rollMonth(): void {
    const now = this.clock.now();
    const start = this.monthStart(now);
    if (start !== this.monthAnchor) {
      this.monthAnchor = start;
      this.warnedThisMonth = false;
    }
  }

  private monthStart(now: number): number {
    const ms = this.opts.monthMs ?? 30 * 24 * 3600_000;
    return Math.floor(now / ms) * ms;
  }

  private recordUsage(job: InternalJob): void {
    if (!this.opts.usage) return;
    try {
      this.opts.usage.append({
        jobId: job.id,
        providerId: job.request.providerId,
        providerLabel: job.adapter?.providerLabel ?? job.request.providerId,
        model: job.adapter?.model ?? '',
        promptLength: job.request.prompt.length,
        requestSize: this.requestSize(job.request.width, job.request.height),
        count: job.request.count ?? 1,
        status: job.status,
        cacheHit: job.cacheHit,
        durationMs: job.durationMs,
        costEstimateUsd: job.cacheHit ? 0 : job.costEstimateUsd,
        finishedAt: new Date(job.finishedAt ?? this.clock.now()).toISOString(),
      });
    } catch {
      /* usage bookkeeping must never break the job */
    }
  }

  private toView(job: InternalJob): AiJobView {
    const runningForProvider = [...this.running].filter((id) => {
      const j = this.jobs.get(id);
      return j && j.request.providerId === job.request.providerId;
    }).length;
    const queuedAhead = this.order.filter((id) => {
      const j = this.jobs.get(id);
      return j && j.status === 'queued' && j.request.providerId === job.request.providerId && id !== job.id;
    }).length;
    return {
      jobId: job.id,
      clientId: job.request.clientId ?? null,
      status: job.status,
      prompt: job.request.prompt,
      providerId: job.request.providerId,
      providerLabel: job.adapter?.providerLabel ?? job.request.providerId,
      model: job.adapter?.model ?? '',
      requestSize: this.requestSize(job.request.width, job.request.height),
      count: job.request.count ?? 1,
      seed: job.request.seed ?? null,
      queuedAt: new Date(job.queuedAt).toISOString(),
      startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      durationMs: job.durationMs,
      costEstimateUsd: job.cacheHit ? 0 : job.costEstimateUsd,
      cacheHit: job.cacheHit,
      error: job.error,
      images: job.status === 'done' ? job.images.map((base64) => ({ base64 })) : [],
      queuePosition: job.status === 'queued' ? Math.max(0, queuedAhead - (runningForProvider > 0 ? 1 : 0)) : null,
    };
  }
}

function newDOMAbort(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

export type AiManagerEvent =
  | { type: 'job'; job: AiJobView }
  | { type: 'spend_warning'; spentUsd: number; warnUsd: number; limitUsd: number };
