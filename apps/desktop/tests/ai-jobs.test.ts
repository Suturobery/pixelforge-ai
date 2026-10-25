/**
 * Task 9 — desktop AI job manager tests (pure modules, fake adapters).
 *
 * Covers the plan §3.1 job-manager contract: queue → generating → done,
 * concurrency 1 per provider, cancellation (queued + running), the 120 s
 * deadline (injectable in tests), transient-failure retry, the result cache
 * (hits cost nothing), the spend cap hard stop + warning, and usage records.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { AiJobError, AiJobManager } from '../src/ai/job-queue';
import type { AiAdapter, UsageRecord } from '../src/ai/types';

function makeAdapter(over: Partial<AiAdapter> & { generate?: AiAdapter['generate'] } = {}): AiAdapter {
  return {
    providerId: over.providerId ?? 'openai',
    providerLabel: over.providerLabel ?? 'OpenAI · GPT',
    model: over.model ?? 'gpt-image-1',
    kind: over.kind ?? 'openai',
    supportsN: over.supportsN ?? true,
    generate:
      over.generate ??
      (async ({ count }) => Array.from({ length: Math.max(1, count) }, () => 'aW1n')),
  };
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Harness {
  mgr: AiJobManager;
  calls: number[];
  usage: UsageRecord[];
  setAdapter(providerId: string, adapter: AiAdapter | null): void;
  events: Array<{ type: string; status?: string; error?: string }>;
}

function makeHarness(over: { monthlyLimitUsd?: number; warnUsd?: number; timeoutMs?: number } = {}): Harness {
  const adapters = new Map<string, AiAdapter | null>();
  const calls: number[] = [];
  const events: Harness['events'] = [];
  const usage: UsageRecord[] = [];
  const mgr = new AiJobManager({
    resolveAdapter: (id) => adapters.get(id) ?? null,
    usage: { load: () => [...usage], append: (r) => usage.push(r) },
    monthlyLimitUsd: over.monthlyLimitUsd,
    warnUsd: over.warnUsd,
    timeoutMs: over.timeoutMs,
  });
  mgr.onEvent((e) => {
    if (e.type === 'job') events.push({ type: 'job', status: e.job.status, error: e.job.error?.code });
    else events.push({ type: e.type });
  });
  return {
    mgr,
    calls,
    usage,
    events,
    setAdapter: (id, adapter) => {
      if (adapter) {
        adapters.set(id, {
          ...adapter,
          generate: async (args) => {
            calls.push(Date.now());
            return adapter.generate(args);
          },
        });
      } else adapters.set(id, null);
    },
  };
}

describe('job manager: queue + concurrency', () => {
  test('done jobs carry images, provenance and an ESTIMATE (or null)', async () => {
    const h = makeHarness();
    h.setAdapter('openai', makeAdapter());
    const id = h.mgr.submit({ prompt: 'a cat', providerId: 'openai', width: 32, height: 32, count: 1 });
    await waitFor(() => h.mgr.get(id)?.status === 'done');
    const view = h.mgr.get(id)!;
    expect(view.status).toBe('done');
    expect(view.images).toHaveLength(1);
    expect(view.model).toBe('gpt-image-1');
    expect(view.costEstimateUsd).toBeCloseTo(0.027, 6);
    expect(view.durationMs).toBeGreaterThanOrEqual(0);
    expect(view.error).toBeNull();
  });

  test('concurrency is 1 per provider (second job waits; different providers run in parallel)', async () => {
    const h = makeHarness();
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    let aStarts = 0;
    let bStarts = 0;
    h.setAdapter('openai', makeAdapter({ providerId: 'openai', generate: async () => { aStarts++; await gate; return ['img']; } }));
    h.setAdapter('custom', makeAdapter({ providerId: 'custom', kind: 'custom', model: 'local', generate: async () => { bStarts++; return ['img2']; } }));

    const j1 = h.mgr.submit({ prompt: 'a', providerId: 'openai', width: 32, height: 32 });
    const j2 = h.mgr.submit({ prompt: 'b', providerId: 'openai', width: 32, height: 32 });
    const j3 = h.mgr.submit({ prompt: 'c', providerId: 'custom', width: 32, height: 32 });

    await waitFor(() => aStarts === 1 && bStarts === 1);
    expect(h.mgr.get(j1)!.status).toBe('generating');
    expect(h.mgr.get(j2)!.status).toBe('queued'); // same provider → waits
    expect(h.mgr.get(j3)!.status).toBe('generating'); // other provider → parallel
    releaseFirst!();
    await waitFor(() => h.mgr.get(j1)!.status === 'done' && h.mgr.get(j2)!.status === 'done' && h.mgr.get(j3)!.status === 'done');
  });

  test('invalid requests are rejected pre-flight with structured errors', () => {
    const h = makeHarness();
    h.setAdapter('openai', makeAdapter());
    expect(() => h.mgr.submit({ prompt: '  ', providerId: 'openai', width: 32, height: 32 })).toThrow(AiJobError);
    expect(() => h.mgr.submit({ prompt: 'x'.repeat(601), providerId: 'openai', width: 32, height: 32 })).toThrow(/too long/);
    expect(() => h.mgr.submit({ prompt: 'x', providerId: 'openai', width: 4, height: 32 })).toThrow(/dimensions/);
    expect(() => h.mgr.submit({ prompt: 'x', providerId: 'missing', width: 32, height: 32 })).toThrow(/not configured/);
  });
});

describe('job manager: cancellation', () => {
  test('cancelling a QUEUED job resolves it as cancelled without adapter calls', async () => {
    const h = makeHarness();
    let started = 0;
    h.setAdapter('openai', makeAdapter({ generate: async () => { started++; return ['img']; } }));
    const j1 = h.mgr.submit({ prompt: 'first', providerId: 'openai', width: 32, height: 32 });
    const j2 = h.mgr.submit({ prompt: 'second', providerId: 'openai', width: 32, height: 32 });
    await waitFor(() => h.mgr.get(j1)!.status === 'generating');
    expect(h.mgr.cancel(j2)).toBe(true);
    expect(h.mgr.get(j2)!.status).toBe('cancelled');
    expect(h.mgr.get(j2)!.error?.code).toBe('cancelled');
    void j1;
    await waitFor(() => started === 1); // j1 still runs
  });

  test('cancelling a RUNNING job aborts the adapter signal', async () => {
    const h = makeHarness();
    let aborted = false;
    h.setAdapter('openai', makeAdapter({
      generate: ({ signal }) =>
        new Promise<string[]>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    }));
    const id = h.mgr.submit({ prompt: 'x', providerId: 'openai', width: 32, height: 32 });
    await waitFor(() => h.mgr.get(id)!.status === 'generating');
    h.mgr.cancel(id);
    await waitFor(() => h.mgr.get(id)!.status === 'cancelled' && aborted);
  });
});

describe('job manager: timeout + retry', () => {
  test('a job exceeding the deadline fails with a structured timeout error', async () => {
    const h = makeHarness({ timeoutMs: 60 });
    h.setAdapter('openai', makeAdapter({
      generate: ({ signal }) =>
        new Promise<string[]>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    }));
    const id = h.mgr.submit({ prompt: 'slow', providerId: 'openai', width: 32, height: 32 });
    await waitFor(() => h.mgr.get(id)!.status === 'error', 5000);
    expect(h.mgr.get(id)!.error?.code).toBe('timeout');
  });

  test('transient failures retry ×3 then succeed; capability errors fail fast', async () => {
    const h = makeHarness({ timeoutMs: 10_000 });
    let attempts = 0;
    h.setAdapter('openai', makeAdapter({
      generate: async () => {
        attempts++;
        if (attempts < 3) throw new Error('HTTP 502: bad gateway');
        return ['ok'];
      },
    }));
    const id = h.mgr.submit({ prompt: 'flaky', providerId: 'openai', width: 32, height: 32 });
    await waitFor(() => h.mgr.get(id)!.status === 'done', 15_000);
    expect(attempts).toBe(3);

    let attempts2 = 0;
    h.setAdapter('custom', makeAdapter({ providerId: 'custom', kind: 'custom', generate: async () => { attempts2++; throw new AiJobError('bad_response', 'no images'); } }));
    const id2 = h.mgr.submit({ prompt: 'bad', providerId: 'custom', width: 32, height: 32 });
    await waitFor(() => h.mgr.get(id2)!.status === 'error');
    expect(attempts2).toBe(1); // AiJobError is NOT retried
    expect(h.mgr.get(id2)!.error?.code).toBe('bad_response');
  });
});

describe('job manager: cache', () => {
  test('identical recipes hit the cache: $0, no second adapter call', async () => {
    const h = makeHarness();
    let calls = 0;
    h.setAdapter('openai', makeAdapter({ generate: async () => { calls++; return ['img']; } }));
    const j1 = h.mgr.submit({ prompt: 'cached cat', providerId: 'openai', width: 32, height: 32 });
    await waitFor(() => h.mgr.get(j1)!.status === 'done');
    expect(calls).toBe(1);

    const j2 = h.mgr.submit({ prompt: 'cached cat', providerId: 'openai', width: 32, height: 32 });
    await waitFor(() => h.mgr.get(j2)!.status === 'done');
    expect(calls).toBe(1); // cache short-circuit
    const v2 = h.mgr.get(j2)!;
    expect(v2.cacheHit).toBe(true);
    expect(v2.costEstimateUsd).toBe(0);
    expect(v2.images).toHaveLength(1);

    // a different prompt misses
    const j3 = h.mgr.submit({ prompt: 'a dog', providerId: 'openai', width: 32, height: 32 });
    await waitFor(() => h.mgr.get(j3)!.status === 'done');
    expect(calls).toBe(2);
    expect(h.mgr.get(j3)!.cacheHit).toBe(false);
  });
});

describe('job manager: spend controls', () => {
  test('the monthly cap hard-stops pre-flight with spend_limit', async () => {
    const h = makeHarness({ monthlyLimitUsd: 0.05 });
    h.setAdapter('openai', makeAdapter()); // gpt-image-1 ≈ $0.027/image
    const j1 = h.mgr.submit({ prompt: 'a', providerId: 'openai', width: 32, height: 32 });
    expect(h.mgr.get(j1)).not.toBeNull();
    await waitFor(() => h.mgr.get(j1)!.status === 'done'); // usage lands at terminal
    // 0.027 (spent) + 0.027 (estimate) = 0.054 > 0.05 → rejected
    expect(() => h.mgr.submit({ prompt: 'b', providerId: 'openai', width: 32, height: 32 })).toThrow(/cap/);
  });

  test('crossing the warning threshold emits exactly one spend_warning per month', async () => {
    const h = makeHarness({ monthlyLimitUsd: 10, warnUsd: 0.02 });
    h.setAdapter('openai', makeAdapter());
    const warnings: number[] = [];
    h.mgr.onEvent((e) => {
      if (e.type === 'spend_warning') warnings.push(e.spentUsd);
    });
    const j1 = h.mgr.submit({ prompt: 'a', providerId: 'openai', width: 32, height: 32 });
    await waitFor(() => h.mgr.get(j1)!.status === 'done');
    expect(warnings.length).toBe(1); // 0.027 ≥ 0.02 → warn once
    const j2 = h.mgr.submit({ prompt: 'b', providerId: 'openai', width: 32, height: 32 });
    await waitFor(() => h.mgr.get(j2)!.status === 'done');
    expect(warnings.length).toBe(1); // no repeat within the month window
  });

  test('cache hits never count toward spend', async () => {
    const h = makeHarness({ monthlyLimitUsd: 0.03 });
    let calls = 0;
    h.setAdapter('openai', makeAdapter({ generate: async () => { calls++; return ['img']; } }));
    const j1 = h.mgr.submit({ prompt: 'same', providerId: 'openai', width: 32, height: 32 });
    await waitFor(() => h.mgr.get(j1)!.status === 'done');
    // even at the cap, a cache hit is free and allowed
    const j2 = h.mgr.submit({ prompt: 'same', providerId: 'openai', width: 32, height: 32 });
    await waitFor(() => h.mgr.get(j2)!.status === 'done');
    expect(h.mgr.get(j2)!.cacheHit).toBe(true);
    expect(calls).toBe(1);
    expect(h.mgr.monthSpend()).toBeCloseTo(0.027, 6); // one paid job only
  });
});

describe('job manager: usage records', () => {
  test('every terminal job appends a usage record with provenance fields', async () => {
    const h = makeHarness();
    h.setAdapter('openai', makeAdapter());
    const id = h.mgr.submit({ prompt: 'usage-cat', providerId: 'openai', width: 64, height: 32, count: 2 });
    await waitFor(() => h.mgr.get(id)!.status === 'done');
    const rec = h.usage.find((r) => r.jobId === id);
    expect(rec).toBeDefined();
    expect(rec!.providerId).toBe('openai');
    expect(rec!.model).toBe('gpt-image-1');
    expect(rec!.requestSize).toBe('1344x768'); // 64×32 aspect > 1.2
    expect(rec!.count).toBe(2);
    expect(rec!.status).toBe('done');
    expect(rec!.promptLength).toBe('usage-cat'.length);
    expect(rec!.costEstimateUsd).not.toBeNull();
  });
});
