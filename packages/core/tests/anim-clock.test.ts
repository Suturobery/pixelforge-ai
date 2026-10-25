/**
 * Task 6 — shared playback engine (packages/core/src/anim/clock.ts):
 * per-frame durations, loop modes, play-once stops, scrubbing, and the
 * `settings.setOnion` CommandBus command (undoable document settings).
 */

import { describe, expect, test } from 'bun:test';
import {
  CommandBus,
  CommandError,
  PlaybackClock,
  buildPlaybackCycle,
  createProject,
  effectiveFrameMs,
  frameAtPosition,
  type Clip,
} from '../src';
import { createFrame, createLayer } from '../src/doc/factory';
import { projectEquals } from './helpers';

// ---------------------------------------------------------------- helpers

function makeClip(opts: {
  frames?: number;
  fps?: number;
  loop?: boolean;
  loopMode?: Clip['loopMode'];
  durations?: number[];
}): Clip {
  const layer = createLayer('L');
  const n = opts.frames ?? 4;
  const clip: Clip = {
    id: 'cl-test',
    name: 'test',
    fps: opts.fps ?? 8,
    loop: opts.loop ?? true,
    loopMode: opts.loopMode ?? 'forward',
    layers: [layer],
    parts: [],
    frames: [],
    tags: [],
  };
  for (let i = 0; i < n; i++) {
    const f = createFrame(4, 4, [layer]);
    f.durationMs = opts.durations?.[i] ?? 0;
    clip.frames.push(f);
  }
  return clip;
}

// ------------------------------------------------------- effectiveFrameMs

describe('effectiveFrameMs', () => {
  test('durationMs 0 inherits the clip fps', () => {
    const f = makeClip({ frames: 1 }).frames[0];
    expect(effectiveFrameMs(f, 8)).toBe(125); // 1000/8
    expect(effectiveFrameMs(f, 10)).toBe(100);
    expect(effectiveFrameMs(f, 60)).toBe(17); // 1000/60 → 16.67 rounds to 17
  });

  test('explicit durationMs overrides fps', () => {
    const f = makeClip({ frames: 1, durations: [250] }).frames[0];
    expect(effectiveFrameMs(f, 8)).toBe(250);
  });

  test('never returns a zero-length interval', () => {
    const zero = makeClip({ frames: 1, durations: [0] }).frames[0];
    expect(effectiveFrameMs(zero, 60)).toBeGreaterThan(0);
    // A stored duration of exactly 1 ms stays 1 ms (min clamp).
    const one = makeClip({ frames: 1, durations: [1] }).frames[0];
    expect(effectiveFrameMs(one, 8)).toBe(1);
  });
});

// ------------------------------------------------------ buildPlaybackCycle

describe('buildPlaybackCycle', () => {
  test('forward mode lists frames in order with fps-inherited durations', () => {
    const c = buildPlaybackCycle(makeClip({ frames: 3, fps: 10 }));
    expect(c.entries.map((e) => e.frame)).toEqual([0, 1, 2]);
    expect(c.entries.every((e) => e.ms === 100)).toBe(true);
    expect(c.totalMs).toBe(300);
    expect(c.loop).toBe(true);
  });

  test('reverse mode lists frames backwards', () => {
    const c = buildPlaybackCycle(makeClip({ frames: 3, loopMode: 'reverse' }));
    expect(c.entries.map((e) => e.frame)).toEqual([2, 1, 0]);
  });

  test('pingpong loop walks 0..n-1..1 without duplicating turning points', () => {
    const c = buildPlaybackCycle(makeClip({ frames: 4, loopMode: 'pingpong', loop: true }));
    expect(c.entries.map((e) => e.frame)).toEqual([0, 1, 2, 3, 2, 1]);
  });

  test('pingpong play-once ends on frame 0', () => {
    const c = buildPlaybackCycle(makeClip({ frames: 4, loopMode: 'pingpong', loop: false }));
    expect(c.entries.map((e) => e.frame)).toEqual([0, 1, 2, 3, 2, 1, 0]);
    expect(c.loop).toBe(false);
  });

  test('per-frame durations are respected in the schedule', () => {
    const c = buildPlaybackCycle(makeClip({ frames: 3, fps: 8, durations: [0, 500, 0] }));
    expect(c.entries.map((e) => e.ms)).toEqual([125, 500, 125]);
    expect(c.totalMs).toBe(750);
  });

  test('loop disabled marks a play-once cycle', () => {
    const c = buildPlaybackCycle(makeClip({ frames: 2, loop: false }));
    expect(c.loop).toBe(false);
  });

  test('single-frame clips produce one entry in every mode', () => {
    for (const mode of ['forward', 'reverse', 'pingpong'] as const) {
      const c = buildPlaybackCycle(makeClip({ frames: 1, loopMode: mode }));
      expect(c.entries).toHaveLength(1);
      expect(c.entries[0].frame).toBe(0);
      expect(c.totalMs).toBeGreaterThan(0);
    }
    // pingpong once on a single frame: backward pass contributes nothing
    const once = buildPlaybackCycle(makeClip({ frames: 1, loopMode: 'pingpong', loop: false }));
    expect(once.entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------- PlaybackClock

describe('PlaybackClock', () => {
  test('ticks through frames at fps-derived intervals (forward)', () => {
    const clock = new PlaybackClock(buildPlaybackCycle(makeClip({ frames: 3, fps: 10 })));
    // t=50 → frame 0; t=100 → frame 1; t=250 → frame 2; t=350 → wraps to 0
    expect(clock.tick(50).frame).toBe(0);
    expect(clock.tick(50).frame).toBe(1);
    expect(clock.tick(150).frame).toBe(2);
    expect(clock.tick(100).frame).toBe(0); // wrapped
    expect(clock.positionMs).toBe(50); // 50 ms into the new cycle
  });

  test('reports changed only when the frame index moves', () => {
    const clock = new PlaybackClock(buildPlaybackCycle(makeClip({ frames: 2, fps: 10 })));
    const t1 = clock.tick(50);
    expect(t1.changed).toBe(false);
    const t2 = clock.tick(50);
    expect(t2.changed).toBe(true);
    expect(t2.frame).toBe(1);
  });

  test('reverse playback steps backwards and stops on frame 0 when play-once', () => {
    const clock = new PlaybackClock(
      buildPlaybackCycle(makeClip({ frames: 3, fps: 10, loopMode: 'reverse', loop: false }))
    );
    expect(clock.tick(1).frame).toBe(2);
    clock.tick(99); // entry 0 done
    expect(clock.tick(1).frame).toBe(1);
    clock.tick(99);
    expect(clock.tick(1).frame).toBe(0);
    const end = clock.tick(100); // final interval fully elapsed
    expect(end.stopped).toBe(true);
    expect(end.frame).toBe(0); // last frame of the reverse direction
  });

  test('play-once forward stops on the last frame and stays there', () => {
    const clock = new PlaybackClock(
      buildPlaybackCycle(makeClip({ frames: 3, fps: 10, loop: false }))
    );
    clock.tick(250);
    const end = clock.tick(50); // reaches totalMs
    expect(end.stopped).toBe(true);
    expect(end.frame).toBe(2);
    // ticking again after the stop keeps the clamp (no wrap, no freeze)
    const again = clock.tick(500);
    expect(again.stopped).toBe(true);
    expect(again.frame).toBe(2);
  });

  test('pingpong loop cycles forward then backward repeatedly', () => {
    const clock = new PlaybackClock(
      buildPlaybackCycle(makeClip({ frames: 3, fps: 10, loopMode: 'pingpong', loop: true }))
    );
    // cycle: 0(100) 1(100) 2(100) 1(100) → 400 ms
    expect(clock.tick(50).frame).toBe(0);
    expect(clock.tick(50).frame).toBe(1);
    expect(clock.tick(100).frame).toBe(2);
    expect(clock.tick(100).frame).toBe(1);
    expect(clock.tick(99).frame).toBe(1);
    expect(clock.tick(1).frame).toBe(0); // new cycle
    expect(clock.tick(25).frame).toBe(0);
  });

  test('pingpong play-once ends on frame 0 after the backward pass', () => {
    const clock = new PlaybackClock(
      buildPlaybackCycle(makeClip({ frames: 3, fps: 10, loopMode: 'pingpong', loop: false }))
    );
    // cycle: 0,1,2,1,0 → 500 ms
    clock.tick(450);
    const end = clock.tick(50);
    expect(end.stopped).toBe(true);
    expect(end.frame).toBe(0);
  });

  test('single-frame looping clip holds frame 0 across any delta', () => {
    const clock = new PlaybackClock(
      buildPlaybackCycle(makeClip({ frames: 1, fps: 10, loop: true }))
    );
    expect(clock.tick(10_000).frame).toBe(0);
    expect(clock.tick(10_000).stopped).toBe(false);
  });

  test('single-frame play-once clip stops after one interval', () => {
    const clock = new PlaybackClock(
      buildPlaybackCycle(makeClip({ frames: 1, fps: 10, loop: false }))
    );
    expect(clock.tick(99).stopped).toBe(false);
    expect(clock.tick(1).stopped).toBe(true);
    expect(clock.tick(1).frame).toBe(0);
  });

  test('scrubTo jumps to the frame under the position', () => {
    const clock = new PlaybackClock(
      buildPlaybackCycle(makeClip({ frames: 4, fps: 10, durations: [0, 400, 0, 0] }))
    );
    expect(clock.scrubTo(150).frame).toBe(1);
    expect(clock.scrubTo(500).frame).toBe(2); // 100+400 → 500 is entry 2
    expect(clock.scrubTo(999_999).frame).toBe(3); // clamped to the end
    expect(clock.scrubTo(-5).frame).toBe(0);
  });

  test('scrubToFrame positions at the first occurrence (pingpong turn)', () => {
    const clock = new PlaybackClock(
      buildPlaybackCycle(makeClip({ frames: 3, fps: 10, loopMode: 'pingpong', loop: true }))
    );
    clock.scrubToFrame(2);
    expect(clock.currentFrame()).toBe(2);
    expect(clock.positionMs).toBe(200);
    // Out-of-range frames clamp to the cycle start.
    clock.scrubToFrame(99);
    expect(clock.positionMs).toBe(0);
  });

  test('setCycle preserves the position (clamped) when the clip is edited', () => {
    const clock = new PlaybackClock(buildPlaybackCycle(makeClip({ frames: 4, fps: 10 })));
    clock.scrubTo(350); // frame 3
    clock.setCycle(buildPlaybackCycle(makeClip({ frames: 2, fps: 10 })));
    expect(clock.positionMs).toBe(200); // clamped to the shorter cycle
    expect(clock.currentFrame()).toBe(1);
  });

  test('frameAtPosition maps boundaries to the right entries', () => {
    const cycle = buildPlaybackCycle(makeClip({ frames: 2, fps: 10 }));
    expect(frameAtPosition(cycle, 0).frame).toBe(0);
    expect(frameAtPosition(cycle, 99).frame).toBe(0);
    expect(frameAtPosition(cycle, 100).frame).toBe(1);
    expect(frameAtPosition(cycle, 200).frame).toBe(1); // end clamps to last
  });
});

// --------------------------------------------------- settings.setOnion bus

describe('settings.setOnion (CommandBus)', () => {
  function makeBus(): { bus: CommandBus; before: Clip } {
    const bus = new CommandBus(createProject({ width: 8, height: 8 }));
    return { bus, before: bus.getProject().clips[0] };
  }

  test('sets prev/next within 0..3 and records undoable history', () => {
    const { bus } = makeBus();
    bus.execute('settings.setOnion', { prev: 3, next: 2 }, 'ui');
    expect(bus.getProject().settings.onion).toEqual({ prev: 3, next: 2 });
    expect(bus.historyStats().undoDepth).toBe(1);
    expect(bus.undo().ok).toBeTrue();
    expect(bus.getProject().settings.onion).toEqual({ prev: 1, next: 0 });
    expect(bus.redo().ok).toBeTrue();
    expect(bus.getProject().settings.onion).toEqual({ prev: 3, next: 2 });
  });

  test('partial patches keep the other field', () => {
    const { bus } = makeBus();
    bus.execute('settings.setOnion', { next: 3 }, 'ui');
    expect(bus.getProject().settings.onion).toEqual({ prev: 1, next: 3 });
  });

  test('rejects out-of-range and non-integer values without mutating', () => {
    const { bus } = makeBus();
    const before = bus.getProject();
    for (const bad of [{ prev: -1 }, { next: 4 }, { prev: 1.5 }, { next: 'x' }, {}]) {
      expect(() =>
        bus.execute('settings.setOnion', bad as Record<string, unknown>, 'ui')
      ).toThrow(CommandError);
    }
    expect(projectEquals(bus.getProject(), before)).toBe(true);
  });
});
