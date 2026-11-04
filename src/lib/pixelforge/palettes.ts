// PixelForge AI — built-in palettes

export interface PalettePreset {
  id: string
  name: string
  colors: string[]
  notes?: string
  author?: string
}

export const PALETTES: PalettePreset[] = [
  {
    id: 'forge16',
    name: 'Forge 16',
    colors: [
      '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070',
      '#38b764', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86',
      '#333c57', '#2ce8f5', '#14b8a6', '#0d9488',
    ],
  },
  {
    id: 'pico8',
    name: 'PICO-8',
    colors: [
      '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f',
      '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436',
      '#29adff', '#83769c', '#ff77a8', '#ffccaa',
    ],
  },
  {
    id: 'sweetie16',
    name: 'Sweetie 16',
    colors: [
      '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070',
      '#38b764', '#257179', '#29366f', '#3b5dc9', '#41a6f6', '#73eff7',
      '#f4f4f4', '#94b0c2', '#566c86', '#333c57',
    ],
  },
  {
    id: 'gray8',
    name: 'Grayscale 8',
    colors: [
      '#000000', '#242424', '#484848', '#6d6d6d', '#919191', '#b6b6b6',
      '#dadada', '#ffffff',
    ],
  },
]

export const DEFAULT_PALETTE = PALETTES[0].colors

/**
 * The full named-palette library (classic consoles + Lospec most-downloaded,
 * with author + notes provenance). Loaded lazily on first use — the ~1.1 MB
 * JSON lands in its own chunk instead of the startup bundle.
 */
export async function loadLibrary(): Promise<PalettePreset[]> {
  const lib = (await import('./palette-library.json')).default as {
    presets: Record<string, { name: string; author?: string; size: number; notes?: string; colors: string[] }>
  }
  return Object.entries(lib.presets)
    .map(([id, p]) => ({ id, name: p.name, colors: p.colors, notes: p.notes, author: p.author }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
