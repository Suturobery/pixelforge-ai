// PixelForge AI — shared animation playback engine (Task 6 §6).
//
// ONE playback-clock implementation for the whole studio: the pure
// `PlaybackClock` from @pixelforge/core holds all timing math (per-frame
// durations, loop modes, play-once stops, scrubbing); this module is the
// thin renderer bridge that drives it with requestAnimationFrame and keeps
// the zustand playhead in sync. The timeline transport, the canvas and the
// floating preview ALL read the same playhead while playing — there is no
// second timing loop for editor playback.
//
// The floating preview's independent mini-loop (shown while the editor is
// paused) reuses the SAME PlaybackClock class with its own instance — see
// preview-overlay.tsx — so timing logic is never duplicated.

'use client'

import { PlaybackClock, buildPlaybackCycle } from '@pixelforge/core'
import { useEditor, getActiveClip } from '@/lib/pixelforge/store'

type PositionListener = (posMs: number, totalMs: number) => void

class EditorPlaybackController {
  private clock: PlaybackClock | null = null
  private raf = 0
  private last = 0
  private unsubscribe: (() => void) | null = null
  private listeners = new Set<PositionListener>()
  /** Signature of the schedule the clock was last built from. */
  private sig = ''

  constructor() {
    if (typeof window !== 'undefined') this.attach()
  }

  // ------------------------------------------------------------ store sync

  /**
   * Rebuild the clock whenever the active clip's schedule could change:
   * clip switch, frame count, fps, loop, mode, or any frame duration.
   * Structural edits (add/delete/reorder) also change frame ids.
   */
  private attach(): void {
    this.unsubscribe = useEditor.subscribe((s) => {
      const clip = getActiveClip(s)
      const nextSig = [
        s.activeClipId,
        clip.fps,
        clip.loop ? 1 : 0,
        clip.loopMode,
        clip.frames.length,
        clip.frames.map((f) => f.durationMs).join(','),
      ].join('|')
      if (nextSig !== this.sig) {
        this.sig = nextSig
        if (this.clock) this.clock.setCycle(buildPlaybackCycle(clip))
        else this.clock = new PlaybackClock(buildPlaybackCycle(clip))
        this.emitPosition() // scrub marker follows clip edits/switches
      }
      // The store's `playing` flag is the single source of truth: ANY path
      // that flips it true (transport, keyboard, tests) starts the rAF
      // driver; flipping false lets the loop self-terminate on its next tick.
      if (s.playing && this.raf === 0) {
        // Re-anchor the clock to the current playhead first — the position
        // may be stale after manual setPlayhead / a finished play-once pass.
        this.clock?.scrubToFrame(s.activeFrameIndex)
        this.startRaf()
      }
    })
  }

  // ------------------------------------------------------------- transport

  isPlaying(): boolean {
    return useEditor.getState().playing
  }

  play(): void {
    const st = useEditor.getState()
    if (st.playing) return
    const clip = getActiveClip(st)
    if (clip.frames.length < 1) return
    // Start the clock at the current playhead's position in the schedule.
    if (!this.clock) {
      this.sig = '' // force rebuild on next subscription fire
      this.clock = new PlaybackClock(buildPlaybackCycle(clip))
    }
    this.clock.scrubToFrame(Math.min(st.activeFrameIndex, clip.frames.length - 1))
    st.setSelection(null) // ghosts/ants off during playback
    st.setPlaying(true)
    this.last = performance.now()
    this.startRaf()
  }

  pause(): void {
    const st = useEditor.getState()
    if (!st.playing) return
    st.setPlaying(false)
    this.stopRaf()
  }

  toggle(): void {
    if (this.isPlaying()) this.pause()
    else this.play()
  }

  /** Stop: pause AND rewind the playhead to frame 0. */
  stop(): void {
    this.pause()
    const st = useEditor.getState()
    st.setPlayhead(0)
    if (this.clock) {
      this.clock.reset()
      this.emitPosition()
    }
  }

  /** Restart: jump to frame 0; keeps playing if currently playing. */
  restart(): void {
    const st = useEditor.getState()
    st.setPlayhead(0)
    if (this.clock) {
      this.clock.reset()
      this.emitPosition()
    }
    if (!st.playing) this.play()
  }

  /** Step one frame (pauses playback first — deterministic stepping). */
  step(dir: 1 | -1): void {
    this.pause()
    const st = useEditor.getState()
    const clip = getActiveClip(st)
    const cur = Math.min(st.activeFrameIndex, clip.frames.length - 1)
    const next = Math.min(clip.frames.length - 1, Math.max(0, cur + dir))
    st.setPlayhead(next)
    if (this.clock) {
      this.clock.scrubToFrame(next)
      this.emitPosition()
    }
  }

  /** Scrub to an absolute position inside the cycle (scrubber bar drag). */
  scrubToMs(posMs: number): void {
    const st = useEditor.getState()
    if (!this.clock) {
      const clip = getActiveClip(st)
      this.sig = ''
      this.clock = new PlaybackClock(buildPlaybackCycle(clip))
    }
    const t = this.clock.scrubTo(posMs)
    st.setPlayhead(t.frame)
    this.emitPosition()
  }

  // ------------------------------------------------------------- rAF loop

  private startRaf(): void {
    this.stopRaf()
    this.last = performance.now()
    const tick = (now: number) => {
      const st = useEditor.getState()
      // Loop exits MUST clear this.raf — the subscription restarts the
      // driver only when it reads 0 (a consumed rAF id is non-zero forever).
      if (!st.playing || !this.clock) {
        this.raf = 0
        return
      }
      const delta = Math.min(now - this.last, 1000) // clamp huge gaps (tab throttle)
      this.last = now
      const t = this.clock.tick(delta)
      if (t.changed) st.setPlayhead(t.frame)
      this.emitPosition()
      if (t.stopped) {
        // play-once finished — hold the final frame
        st.setPlaying(false)
        this.raf = 0
        return
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  private stopRaf(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
  }

  // ----------------------------------------------------- position events

  /** Subscribe to cycle-position updates (scrubber marker). Returns unsub. */
  onPosition(cb: PositionListener): () => void {
    this.listeners.add(cb)
    cb(this.clock?.positionMs ?? 0, this.clock?.getCycle().totalMs ?? 0)
    return () => this.listeners.delete(cb)
  }

  private emitPosition(): void {
    if (!this.clock || this.listeners.size === 0) return
    const pos = this.clock.positionMs
    const total = this.clock.getCycle().totalMs
    for (const cb of this.listeners) cb(pos, total)
  }

  /** Dev/test hook: read the live clock (null before first use). */
  __clock(): PlaybackClock | null {
    return this.clock
  }
}

/** Studio-wide singleton (module scope — one engine per renderer). */
export const editorPlayback = new EditorPlaybackController()
