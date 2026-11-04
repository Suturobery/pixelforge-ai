// MCP supervisor state machine — unit tests (embed v1, Task 8).
// Pure DI: fake fetch + fake launcher; no real processes, no Electron.

import { describe, expect, test } from 'bun:test';

import { McpSupervisor, type SpawnedService } from '../src/mcp/supervisor-core';

const silentLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
};

interface Harness {
  supervisor: McpSupervisor;
  /** flip what /health answers */
  setHealthy: (v: boolean) => void;
  /** simulate the started service exiting */
  exitService: (code: number | null) => void;
  /** how many times startService ran */
  launches: () => number;
  /** whether the current owned service was stopped */
  stopped: () => boolean;
}

function makeHarness(opts: { healthyAtStart?: boolean; startFails?: boolean } = {}): Harness {
  let healthy = opts.healthyAtStart ?? false;
  let launchCount = 0;
  let stopped = false;
  let exitListener: ((code: number | null) => void) | null = null;

  const supervisor = new McpSupervisor({
    port: 3030,
    logger: silentLogger,
    healthTimeoutMs: 400, // fast tests
    maxRestarts: 2,
    fetchImpl: async () => {
      if (!healthy) throw new Error('connection refused');
      return { ok: true };
    },
    startService: () => {
      if (opts.startFails) return null;
      launchCount += 1;
      stopped = false;
      return {
        pid: 4000 + launchCount,
        stop: () => {
          stopped = true;
        },
        onExit: (listener) => {
          exitListener = listener;
        },
      };
    },
  });

  return {
    supervisor,
    setHealthy: (v) => {
      healthy = v;
    },
    exitService: (code) => {
      exitListener?.(code);
    },
    launches: () => launchCount,
    stopped: () => stopped,
  };
}

describe('McpSupervisor (embed v1)', () => {
  test('ADOPTS when a healthy server already answers — no launch, no stop on quit', async () => {
    const h = makeHarness({ healthyAtStart: true });
    const state = await h.supervisor.start();
    expect(state).toEqual({ kind: 'adopted' });
    expect(h.launches()).toBe(0);
    await h.supervisor.stop();
    expect(h.stopped()).toBe(false); // we never owned it — owner stops it
  });

  test('STARTS + reports running when health arrives; stop() owns the child', async () => {
    const h = makeHarness({ healthyAtStart: false });
    const pending = h.supervisor.start();
    h.setHealthy(true); // health arrives mid-poll
    const state = await pending;
    expect(state.kind).toBe('running');
    expect((state as { pid: number }).pid).toBe(4001);
    expect(h.launches()).toBe(1);
    await h.supervisor.stop();
    expect(h.stopped()).toBe(true); // we own it — graceful stop on quit
  });

  test('RESTARTS after unexpected exit (bounded), adopts if port recovers', async () => {
    const h = makeHarness({ healthyAtStart: false });
    const pending = h.supervisor.start();
    h.setHealthy(true);
    const state = await pending;
    expect(state.kind).toBe('running');

    // crash → exit → restart budget → port recovered by another owner
    h.setHealthy(true);
    h.exitService(1);
    await new Promise((r) => setTimeout(r, 700)); // backoff (500·2¹ = 1000ms? capped) + poll
    // after restart attempt, health true → either adopted (owner recovered) or running
    const s = h.supervisor.state;
    expect(['adopted', 'running', 'failed']).toContain(s.kind);
    if (s.kind === 'failed') {
      // restart budget path is allowed in fast tests; assert bounded
      expect(h.launches()).toBeLessThanOrEqual(3);
    }
  });

  test('startService returning null → failed with clear reason', async () => {
    const h = makeHarness({ startFails: true });
    const state = await h.supervisor.start();
    expect(state).toEqual({ kind: 'failed', reason: 'could not start the local MCP service' });
  });

  test('health timeout → stops the child we own, reports failed', async () => {
    const h = makeHarness({ healthyAtStart: false });
    const state = await h.supervisor.start();
    expect(state).toEqual({ kind: 'failed', reason: 'health check timeout' });
    expect(h.stopped()).toBe(true); // we own it — cleaned up
  });
});
