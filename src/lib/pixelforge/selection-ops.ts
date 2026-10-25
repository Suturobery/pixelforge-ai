// PixelForge AI — selection & clipboard operations (Task 5a).
//
// Architecture contract (v3.1 §2.8): the selection is VIEW state (a rect +
// session clipboard in the store — never part of the document, never in
// history). Committed selection operations go through the SAME sanctioned
// mutation paths as every other tool:
//   • interactive drags / nudges / cut / delete / paste → stroke flow
//     (beginStroke → mutate the handed-out working buffer → endStroke) which
//     the bus converts into ONE tile-diff history entry and a journalable
//     setBuffer record;
//   • selection-scoped flips/rotations → `pixels.applyOp` commands with a
//     rect (deterministic, journal-replayable, undoable).
// No code path mutates the document buffers directly.

import {
  clearRegionInPlace,
  extractRegion,
  pasteRegionInPlace,
  type PixelRect,
} from '@pixelforge/core'
import type { ClipboardContent, SelectionRect } from './types'

export type { PixelRect }

/**
 * Compose a selection move into a working stroke buffer: restore the
 * pre-move snapshot, erase the original rect, stamp the extracted content
 * at its new offset. Pixels pushed outside the canvas are clipped away
 * (content is lost — canvas boundaries are respected, mandate §4).
 */
export function composeSelectionMove(
  working: Uint8ClampedArray,
  snapshot: Uint8ClampedArray,
  W: number,
  H: number,
  rect: SelectionRect,
  dx: number,
  dy: number
): void {
  working.set(snapshot)
  const r: PixelRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
  const content = extractRegion(snapshot, W, H, r)
  clearRegionInPlace(working, W, H, r)
  pasteRegionInPlace(working, W, H, content, r.w, r.h, r.x + dx, r.y + dy)
}

/** Extract clipboard content from a full-cel buffer at the given rect. */
export function extractClipboard(
  source: Uint8ClampedArray,
  W: number,
  H: number,
  rect: SelectionRect
): ClipboardContent {
  const r = clampToCanvas(rect, W, H) ?? { x: 0, y: 0, w: 1, h: 1 }
  const buffer = extractRegion(source, W, H, { x: r.x, y: r.y, w: r.w, h: r.h })
  return { buffer, w: r.w, h: r.h, x: r.x, y: r.y }
}

/** Clamp a selection rect to the canvas; returns null when fully outside. */
export function clampToCanvas(rect: SelectionRect, W: number, H: number): SelectionRect | null {
  const x0 = Math.max(0, Math.min(rect.x, W))
  const y0 = Math.max(0, Math.min(rect.y, H))
  const x1 = Math.max(0, Math.min(rect.x + rect.w, W))
  const y1 = Math.max(0, Math.min(rect.y + rect.h, H))
  if (x1 <= x0 || y1 <= y0) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Normalize two drag points into a 1×1-minimal rect (may be unclamped). */
export function rectFromPoints(
  x0: number,
  y0: number,
  x1: number,
  y1: number
): SelectionRect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0) + 1,
    h: Math.abs(y1 - y0) + 1,
  }
}

/** True when (x, y) is inside the selection. */
export function pointInSelection(rect: SelectionRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
}

/** Shift a rect by (dx, dy), clamped so it stays fully on-canvas. */
export function shiftRectClamped(
  rect: SelectionRect,
  dx: number,
  dy: number,
  W: number,
  H: number
): SelectionRect {
  const x = Math.max(0, Math.min(rect.x + dx, W - rect.w))
  const y = Math.max(0, Math.min(rect.y + dy, H - rect.h))
  return { ...rect, x, y }
}
