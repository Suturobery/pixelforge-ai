/**
 * Shared animation playback engine (v3.1 §12 Task 6 "Shared Animation
 * Playback Engine"). Pure TypeScript — no DOM, no React, no rAF — so the
 * SAME timing math runs under core unit tests, the timeline transport and
 * the floating preview (the renderer adds only a thin rAF driver).
 *
 * Semantics (v3.1 §2.6 / C3):
 *  - Clip FPS is the fallback frame duration: `durationMs: 0` inherits it.
 *  - `loop: false` = play once through, stopping on the LAST frame of the
 *    mode's direction (forward → last frame, reverse/pingpong → frame 0).
 *  - pingpong never duplicates the turning-point frames: one full loop cycle
 *    is 0..n-1..1 (forward pass + backward pass that skips both endpoints).
 *
 * All intervals are clamped to ≥ 1 ms, so no mode can produce a zero-length
 * playback interval regardless of the stored `durationMs` values.
 */
import type { Clip, Frame, LoopMode } from '../types/document';
/** One scheduled play step: which frame, for how long (≥ 1 ms). */
export interface PlaybackEntry {
    /** Frame index within clip.frames (display order position). */
    frame: number;
    /** Effective duration in ms (≥ 1). */
    ms: number;
}
/** A flattened playback schedule for one clip. */
export interface PlaybackCycle {
    /** Ordered steps. The clock wraps at `entries.length` when looping. */
    entries: PlaybackEntry[];
    /** Sum of all entry durations (≥ entries.length ms). */
    totalMs: number;
    /** False = play the pass once and stop on the final entry. */
    loop: boolean;
    /** The clip's mode (informational; already baked into `entries`). */
    mode: LoopMode;
}
/**
 * Effective frame duration: explicit per-frame override, else 1000/fps.
 * Never returns 0 — degenerate values clamp to 1 ms so playback intervals
 * always advance (Task 6 §2 "avoid invalid or zero-length intervals").
 */
export declare function effectiveFrameMs(frame: Frame, clipFps: number): number;
/**
 * Flatten a clip into a playback schedule according to its loop mode:
 *  - forward:   0, 1, …, n-1
 *  - reverse:   n-1, …, 1, 0
 *  - pingpong:  0, 1, …, n-1, n-2, …, 1  (looping — no duplicated turns)
 *               0, 1, …, n-1, n-2, …, 0  (play once — ends on frame 0)
 */
export declare function buildPlaybackCycle(clip: Clip): PlaybackCycle;
export interface ClockTick {
    /** Frame index to display after this tick. */
    frame: number;
    /** Position inside the cycle (0..totalMs) — drives scrub markers. */
    posMs: number;
    /** True when the frame index changed during this tick. */
    changed: boolean;
    /** True when a non-looping pass reached its end (play-once stop). */
    stopped: boolean;
}
/**
 * Stateful playback clock over a `PlaybackCycle`. `tick(deltaMs)` advances
 * real elapsed time and reports the frame to display; loop modes wrap,
 * play-once modes stop and clamp on the final entry. The renderer wraps
 * this in a rAF driver — timeline and preview share ONE implementation.
 */
export declare class PlaybackClock {
    private cycle;
    private pos;
    constructor(cycle: PlaybackCycle, startPosMs?: number);
    getCycle(): PlaybackCycle;
    get positionMs(): number;
    /** Replace the schedule (clip edited / switched) keeping the position. */
    setCycle(cycle: PlaybackCycle): void;
    /** Rewind to the start of the cycle. */
    reset(): void;
    /** Current frame index without advancing time. */
    currentFrame(): number;
    /**
     * Advance by real elapsed time. Large deltas (tab throttling) are handled
     * by modulo against the cycle length when looping, and clamp when playing
     * once — playback never silently freezes.
     */
    tick(deltaMs: number): ClockTick;
    /** Jump to an absolute position in the cycle (clamped, never wraps). */
    scrubTo(posMs: number): ClockTick;
    /** Jump to the FIRST occurrence of a frame in the cycle (scrub by frame). */
    scrubToFrame(frameIndex: number): ClockTick;
}
/** Frame displayed at `posMs` of a cycle (end position → last entry). */
export declare function frameAtPosition(cycle: PlaybackCycle, posMs: number): PlaybackEntry;
