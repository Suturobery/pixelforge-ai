// PixelForge AI — shared sprite preview canvas helper (checkerboard + pixels).

/** Draw a dark checkerboard (transparency indicator) + RGBA buffer at native size. */
export function drawSpritePreview(canvas: HTMLCanvasElement | null, rgba: Uint8ClampedArray | null, size: number): void {
  if (!canvas) return
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  for (let y = 0; y < size; y += 4) {
    for (let x = 0; x < size; x += 4) {
      ctx.fillStyle = ((x >> 2) + (y >> 2)) % 2 === 0 ? '#27272a' : '#18181b'
      ctx.fillRect(x, y, 4, 4)
    }
  }
  if (rgba) ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0)
}
