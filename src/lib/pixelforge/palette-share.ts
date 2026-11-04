// PixelForge AI — palette share codes (PF1-…).
// Compact, clipboard-friendly encoding of a palette:
//   PF1-<base64url of concatenated 6-hex RGB colors, '#' stripped>
// Version prefix (PF1) lets the format evolve. No server — codes travel
// through chat/email like the rest of the app's sharing.

export function encodePaletteCode(colors: string[]): string {
  const hex = colors
    .filter((c) => /^#[0-9a-f]{6}$/i.test(c))
    .map((c) => c.slice(1))
    .join('')
    .toLowerCase()
  if (!hex) throw new Error('no valid colors to encode')
  const b64 = Buffer.from(hex, 'utf8').toString('base64url')
  return `PF1-${b64}`
}

export function decodePaletteCode(code: string): string[] {
  const m = /^PF1-([A-Za-z0-9_-]+)$/.exec(code.trim())
  if (!m) throw new Error('not a PixelForge palette code (expected PF1-…)')
  const hex = Buffer.from(m[1], 'base64url').toString('utf8')
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 6 !== 0) {
    throw new Error('corrupted palette code')
  }
  const colors: string[] = []
  for (let i = 0; i < hex.length; i += 6) {
    colors.push(`#${hex.slice(i, i + 6)}`)
  }
  return colors
}
