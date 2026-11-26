// PixelForge AI — "the artist watches the agent work" auto-follow.
//
// When an IDE agent edits a clip/frame the user is NOT looking at, move the
// editor view to that target so the live AI overlay is actually visible.
// View-state only (active clip / frame / layer) — never touches the document.

import { isAiAutoFollow } from './ai-live-activity'
import { useEditor } from './store'

export function followCommandTarget(payload: unknown, opts?: { force?: boolean }): void {
  if (!opts?.force && !isAiAutoFollow()) return
  const p = payload as { clipId?: unknown; frameId?: unknown } | null
  if (!p || typeof p.clipId !== 'string') return
  const st = useEditor.getState()
  const clip = st.project.clips.find((c) => c.id === p.clipId)
  if (!clip) return

  const sameClip = st.activeClipId === clip.id
  // While the user is playing an animation the playhead owns the frame index.
  if (sameClip && st.playing) return

  let frameIndex = sameClip ? st.activeFrameIndex : st.activeFrameIndex
  if (typeof p.frameId === 'string') {
    const idx = clip.frames.findIndex((f) => f.id === p.frameId)
    if (idx >= 0) frameIndex = idx
  }
  frameIndex = Math.min(Math.max(0, frameIndex), clip.frames.length - 1)

  if (sameClip && frameIndex === st.activeFrameIndex) return
  useEditor.setState({
    activeClipId: clip.id,
    activeFrameIndex: frameIndex,
    ...(sameClip ? {} : { activeLayerId: clip.layers.at(-1)?.id ?? st.activeLayerId }),
  })
}
