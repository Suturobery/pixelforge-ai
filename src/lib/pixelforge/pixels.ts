// PixelForge AI — deterministic pixel operations.
// Task 5a: the implementations live in @pixelforge/core (single source of
// truth for deterministic pixel math — identical code runs in tests, the
// renderer, and Electron); this module re-exports the surface the renderer
// consumes.

export {
  clearBufferInPlace,
  clearRegionInPlace,
  clampRect,
  drawEllipsePixels,
  drawLinePixels,
  drawRectPixels,
  extractRegion,
  floodFill,
  getPixel,
  inBounds,
  moveBuffer,
  pasteRegionInPlace,
  stampBrush,
  stampCustomBuffer,
  flipRegionHInPlace,
  flipRegionVInPlace,
  rotateRegionCWInPlace,
  rotateRegionCCWInPlace,
  type PixelRect,
} from '@pixelforge/core'
