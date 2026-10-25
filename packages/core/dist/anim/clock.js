"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlaybackClock = void 0;
exports.effectiveFrameMs = effectiveFrameMs;
exports.buildPlaybackCycle = buildPlaybackCycle;
exports.frameAtPosition = frameAtPosition;
/**
 * Effective frame duration: explicit per-frame override, else 1000/fps.
 * Never returns 0 — degenerate values clamp to 1 ms so playback intervals
 * always advance (Task 6 §2 "avoid invalid or zero-length intervals").
 */
function effectiveFrameMs(frame, clipFps) {
    if (frame.durationMs > 0)
        return Math.max(1, Math.round(frame.durationMs));
    const fps = Math.min(60, Math.max(1, Math.round(clipFps || 8)));
    return Math.max(1, Math.round(1000 / fps));
}
/**
 * Flatten a clip into a playback schedule according to its loop mode:
 *  - forward:   0, 1, …, n-1
 *  - reverse:   n-1, …, 1, 0
 *  - pingpong:  0, 1, …, n-1, n-2, …, 1  (looping — no duplicated turns)
 *               0, 1, …, n-1, n-2, …, 0  (play once — ends on frame 0)
 */
function buildPlaybackCycle(clip) {
    const n = clip.frames.length;
    const msOf = (i) => effectiveFrameMs(clip.frames[i], clip.fps);
    const entries = [];
    const mode = clip.loopMode ?? 'forward';
    if (mode === 'reverse') {
        for (let i = n - 1; i >= 0; i--)
            entries.push({ frame: i, ms: msOf(i) });
    }
    else if (mode === 'pingpong') {
        for (let i = 0; i < n; i++)
            entries.push({ frame: i, ms: msOf(i) });
        // backward pass: skip the forward turn (n-1 already the last entry);
        // when looping also skip frame 0 (it opens the next cycle).
        const stop = clip.loop ? 1 : 0;
        for (let i = n - 2; i >= stop; i--)
            entries.push({ frame: i, ms: msOf(i) });
    }
    else {
        for (let i = 0; i < n; i++)
            entries.push({ frame: i, ms: msOf(i) });
    }
    // Degenerate safety: a clip always has ≥ 1 frame (model invariant), but a
    // defensive fallback keeps the clock totalMs > 0 no matter what.
    if (entries.length === 0)
        entries.push({ frame: 0, ms: 100 });
    const totalMs = entries.reduce((sum, e) => sum + e.ms, 0);
    return { entries, totalMs, loop: !!clip.loop, mode };
}
/**
 * Stateful playback clock over a `PlaybackCycle`. `tick(deltaMs)` advances
 * real elapsed time and reports the frame to display; loop modes wrap,
 * play-once modes stop and clamp on the final entry. The renderer wraps
 * this in a rAF driver — timeline and preview share ONE implementation.
 */
class PlaybackClock {
    cycle;
    pos = 0;
    constructor(cycle, startPosMs = 0) {
        this.cycle = cycle;
        this.pos = clampPos(startPosMs, cycle);
    }
    getCycle() {
        return this.cycle;
    }
    get positionMs() {
        return this.pos;
    }
    /** Replace the schedule (clip edited / switched) keeping the position. */
    setCycle(cycle) {
        this.cycle = cycle;
        this.pos = clampPos(this.pos, cycle);
    }
    /** Rewind to the start of the cycle. */
    reset() {
        this.pos = 0;
    }
    /** Current frame index without advancing time. */
    currentFrame() {
        return frameAtPosition(this.cycle, this.pos).frame;
    }
    /**
     * Advance by real elapsed time. Large deltas (tab throttling) are handled
     * by modulo against the cycle length when looping, and clamp when playing
     * once — playback never silently freezes.
     */
    tick(deltaMs) {
        const { totalMs, loop } = this.cycle;
        const before = this.currentFrame();
        if (deltaMs > 0) {
            if (loop && totalMs > 0) {
                this.pos = (this.pos + deltaMs) % totalMs;
            }
            else {
                this.pos = Math.min(totalMs, this.pos + deltaMs);
            }
        }
        const at = frameAtPosition(this.cycle, this.pos);
        // Play-once: sitting exactly ON totalMs means the final interval has
        // fully elapsed → stop. Looping wraps the position before we get here.
        const stopped = !loop && this.pos >= totalMs;
        if (stopped) {
            const last = this.cycle.entries[this.cycle.entries.length - 1];
            return { frame: last.frame, posMs: this.pos, changed: before !== last.frame, stopped };
        }
        return { frame: at.frame, posMs: this.pos, changed: before !== at.frame, stopped: false };
    }
    /** Jump to an absolute position in the cycle (clamped, never wraps). */
    scrubTo(posMs) {
        this.pos = clampPos(posMs, this.cycle);
        const at = frameAtPosition(this.cycle, this.pos);
        return { frame: at.frame, posMs: this.pos, changed: true, stopped: false };
    }
    /** Jump to the FIRST occurrence of a frame in the cycle (scrub by frame). */
    scrubToFrame(frameIndex) {
        const at = this.cycle.entries.findIndex((e) => e.frame === frameIndex);
        const idx = at >= 0 ? at : 0;
        let pos = 0;
        for (let i = 0; i < idx; i++)
            pos += this.cycle.entries[i].ms;
        return this.scrubTo(pos);
    }
}
exports.PlaybackClock = PlaybackClock;
/** Frame displayed at `posMs` of a cycle (end position → last entry). */
function frameAtPosition(cycle, posMs) {
    const pos = clampPos(posMs, cycle);
    let acc = 0;
    for (const entry of cycle.entries) {
        acc += entry.ms;
        if (pos < acc)
            return entry;
    }
    return cycle.entries[cycle.entries.length - 1];
}
function clampPos(pos, cycle) {
    if (!Number.isFinite(pos) || pos <= 0)
        return 0;
    return Math.min(cycle.totalMs, pos);
}
