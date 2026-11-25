// PixelForge AI — global keyboard shortcuts (Task 5a set + Task 6 transport:
// Enter play/pause · , previous frame · . next frame · Alt+N new frame).
// Canvas shortcuts never fire while typing in input fields (guarded below)
// and Enter never double-fires on focused buttons — mandate §7.

'use client'

import { useEffect } from 'react'
import { useEditor } from '@/lib/pixelforge/store'
import { editorPlayback } from '@/lib/pixelforge/playback-controller'
import type { ToolId } from '@/lib/pixelforge/types'

const TOOL_KEYS: Record<string, ToolId> = {
  b: 'pencil',
  e: 'eraser',
  h: 'shade',
  f: 'fill',
  l: 'line',
  r: 'rect',
  c: 'ellipse',
  s: 'marquee',
  i: 'eyedropper',
  m: 'move',
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false
  return (
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable
  )
}

/** Buttons/links: Enter should activate THEM, not the transport (§7). */
function isButtonLikeTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false
  if (t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'SUMMARY') return true
  const role = t.getAttribute('role')
  return role === 'button' || role === 'link' || role === 'option'
}

export function useKeyboardShortcuts(onSave: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      const st = useEditor.getState()

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        onSave()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) st.redo()
        else st.undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        st.redo()
        return
      }

      // --- selection clipboard & edit keys (Task 5a) ---
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        st.selectionCopy()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
        e.preventDefault()
        st.selectionCut()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        st.selectionPaste()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (st.selection) {
          e.preventDefault()
          st.selectionDelete()
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        st.cancelStroke() // no-op when no stroke is in progress
        if (st.selection) st.deselect()
        return
      }
      if (e.key.startsWith('Arrow') && st.selection) {
        e.preventDefault() // nudge the selection instead of scrolling
        const step = e.shiftKey ? 4 : 1
        if (e.key === 'ArrowLeft') st.selectionNudge(-step, 0)
        else if (e.key === 'ArrowRight') st.selectionNudge(step, 0)
        else if (e.key === 'ArrowUp') st.selectionNudge(0, -step)
        else if (e.key === 'ArrowDown') st.selectionNudge(0, step)
        return
      }

      // --- animation transport (Task 6 §7) ---
      if (e.key === ' ') {
        if (!isButtonLikeTarget(e.target)) {
          e.preventDefault()
          editorPlayback.toggle()
        }
        return
      }
      if (e.key === ',') {
        e.preventDefault()
        editorPlayback.step(-1)
        return
      }
      if (e.key === '.') {
        e.preventDefault()
        editorPlayback.step(1)
        return
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        st.addFrame(false)
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return

      const k = e.key.toLowerCase()
      if (TOOL_KEYS[k]) {
        st.setTool(TOOL_KEYS[k])
        return
      }
      if (k === 'x') {
        st.swapColors()
        return
      }
      if (e.shiftKey && k === 'y') {
        st.setMirrorY(!st.mirrorY)
        return
      }
      if (k === 'y') {
        st.setMirrorX(!st.mirrorX)
        return
      }
      if (k === 'd') {
        st.setDither(!st.dither)
        return
      }
      // Task 10b tilemap: Shift+K stamp (checked first — same letter as snap)
      if (e.shiftKey && k === 'k') {
        st.setTileStamp(!st.tileStamp)
        return
      }
      if (k === 'k') {
        st.setTileSnap(!st.tileSnap)
        return
      }
      if (k === 'w') {
        st.setTiledWrap(!st.tiledWrap)
        return
      }
      if (k >= '1' && k <= '8') {
        st.setBrushSize(parseInt(k, 10))
        return
      }
      if (e.key === '[' || e.key === ']') {
        st.setBrushSize(st.brushSize + (e.key === ']' ? 1 : -1))
        return
      }
      if (k === 'p') {
        st.setPaletteOpen(!st.paletteOpen)
        return
      }
      if (k === 'g') {
        st.setShowGrid(!st.showGrid)
        return
      }
      if (k === 'o') {
        st.setOnionSkin(!st.onionSkin)
        return
      }
      if (k === 't') {
        st.setTimelineOpen(!st.timelineOpen)
        return
      }
      // NOTE: no clip-delete key on purpose — D is dither, and destroying a
      // whole clip on one letter was an accidental-loss footgun (the Keys tab
      // used to advertise a binding that was unreachable dead code). Clips
      // are deleted from the timeline UI instead.
      if (e.key === '+' || e.key === '=') {
        st.setZoom(st.zoom * 1.25)
        return
      }
      if (e.key === '-') {
        st.setZoom(st.zoom / 1.25)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSave])
}
