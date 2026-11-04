// PixelForge AI — MCP edit visibility.
//
// The MCP executor runs in the editor tab (the bridge holder), so its edits
// CAN be watched live — but only if the view is looking at the target clip.
// This helper moves the editor's active clip/frame/layer to the command's
// target BEFORE the command executes, so an assistant drawing into a
// background clip shows its strokes landing in real time.

import { useEditor } from './store'

export function followCommandTarget(payload: unknown): void {
  const p = payload as { clipId?: unknown; frameId?: unknown } | null
  if (!p || typeof p.clipId !== 'string') return
  const st = useEditor.getState()
  if (st.activeClipId === p.clipId) return
  const clip = st.project.clips.find((c) => c.id === p.clipId)
  if (!clip) return
  let frameIndex = Math.min(Math.max(0, st.activeFrameIndex), clip.frames.length - 1)
  if (typeof p.frameId === 'string') {
    const idx = clip.frames.findIndex((f) => f.id === p.frameId)
    if (idx >= 0) frameIndex = idx
  }
  useEditor.setState({
    activeClipId: clip.id,
    activeFrameIndex: frameIndex,
    activeLayerId: clip.layers.at(-1)?.id ?? st.activeLayerId,
  })
}
