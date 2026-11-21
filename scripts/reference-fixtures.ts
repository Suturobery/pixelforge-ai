// Dev tool: render the Create-from-Reference fixture sprites to PNGs.
// Usage: bun scripts/reference-fixtures.ts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodePng } from '@pixelforge/core'

const outDir = process.argv[2] ?? 'artifacts/reference-fixtures'
mkdirSync(outDir, { recursive: true })

type Put = [y: number, x: number, s: string]

interface Grid {
  size: number
  palette: Record<string, string>
  puts: Put[]
}

function render(grid: Grid): Uint8ClampedArray {
  const { size: w } = grid
  const buf = new Uint8ClampedArray(w * w * 4)
  const rows: string[][] = Array.from({ length: grid.size }, () => Array.from({ length: w }, () => '.'))
  for (const [y, x, s] of grid.puts) {
    const row = rows[y]
    for (let i = 0; i < s.length; i++) if (s[i] !== ' ') row[x + i] = s[i]
  }
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x]
      if (ch === '.' || !grid.palette[ch]) continue
      const hex = grid.palette[ch]
      const o = (y * w + x) * 4
      buf[o] = parseInt(hex.slice(1, 3), 16)
      buf[o + 1] = parseInt(hex.slice(3, 5), 16)
      buf[o + 2] = parseInt(hex.slice(5, 7), 16)
      buf[o + 3] = 255
    }
  }
  return buf
}

// ---- cozy RPG set (Forge-16 palette) — dark-1px outline, top-left light
const potion: Grid = {
  size: 32,
  palette: { O: '#1a1c2c', g: '#38b764', L: '#a7f070', C: '#73eff7', M: '#94b0c2', m: '#f4f4f4' },
  puts: [
    [4, 11, 'OPPPO'],
    [5, 11, 'OmMMmO'],
    [6, 11, 'OmMMmO'],
    [7, 11, 'OmMMmO'],
    [7, 10, 'O'],
    [7, 16, 'O'],
    [8, 9, 'OOOOOOOO'],
    [9, 8, 'OCCCCCCCCO'],
    [10, 8, 'OCLgCCCCgO'],
    [11, 7, 'OCLggCCggCO'],
    [12, 7, 'OCggCCgggCO'],
    [13, 7, 'OCgggggggCO'],
    [14, 7, 'OCgggggggCO'],
    [15, 7, 'OCgggggggCO'],
    [16, 7, 'OCgggggggCO'],
    [17, 7, 'OCgggggggCO'],
    [18, 8, 'OCCggggCCO'],
    [19, 9, 'OOOOOOOO'],
  ],
}

const key: Grid = {
  size: 32,
  palette: { O: '#1a1c2c', Y: '#ffcd75', r: '#ef7d57' },
  puts: [
    [5, 7, 'OOOOO'],
    [6, 6, 'OYYYYYO'],
    [7, 6, 'OYOYOYO'],
    [8, 6, 'OYOYOYO'],
    [9, 6, 'OYYYYYO'],
    [10, 7, 'OOYOO'],
    [11, 8, 'OYO'],
    [12, 8, 'OYO'],
    [13, 8, 'OYO'],
    [13, 8, 'OYOO'],
    [14, 8, 'OYOYO'],
    [15, 8, 'OYOYO'],
    [16, 8, 'OYOO'],
    [17, 8, 'OrO'],
    [18, 8, 'OrO'],
    [19, 8, 'O'],
  ],
}

const mushroom: Grid = {
  size: 32,
  palette: { O: '#1a1c2c', R: '#b13e53', r: '#ef7d57', W: '#f4f4f4', S: '#ffcd75', s: '#ef7d57' },
  puts: [
    [4, 10, 'OOOOOO'],
    [5, 8, 'OORRRRRROO'],
    [6, 7, 'ORrWWRRrRRO'],
    [7, 6, 'ORrRRWWWRRRO'],
    [8, 6, 'ORRRrRRRrWRO'],
    [9, 6, 'ORRWWWRRrRRO'],
    [10, 7, 'OORRRRRRRO'],
    [11, 8, 'OOWWWWWWOO'],
    [12, 8, 'OSSWSSSWSSO'.replace('O', 'O')],
    [13, 8, 'OSSWSSSWSSO'],
    [14, 8, 'OSSWSSSWSSO'],
    [15, 8, 'OssWsssWsso'],
    [16, 9, 'OOOOOOOOO'],
  ],
}

const coin: Grid = {
  size: 32,
  palette: { O: '#1a1c2c', Y: '#ffcd75', r: '#ef7d57', m: '#f4f4f4' },
  puts: [
    [5, 11, 'OOOOOO'],
    [6, 10, 'OYYYYYYO'],
    [7, 9, 'OYmYYYYYYO'],
    [8, 8, 'OYmYYYYYYO'],
    [9, 8, 'OYmYYYYYYO'],
    [10, 8, 'OYYYYYYYO'],
    [11, 8, 'OYYYYYYrO'],
    [12, 8, 'OYYYYYrrO'],
    [13, 8, 'OYYYYYrrO'],
    [14, 9, 'OYYYYrO'],
    [15, 10, 'OYYYYO'],
    [16, 11, 'OOOOOO'],
  ],
}

// ---- monochrome 16×16 token (second style)
const mono: Grid = {
  size: 16,
  palette: { O: '#1a1c2c', W: '#f4f4f4' },
  puts: [
    [1, 4, 'OOOOOOOO'],
    [2, 3, 'OWWWWWWWWO'],
    [3, 2, 'OWWOOWWOOWWO'],
    [4, 2, 'OWWOWWWOWWOW'],
    [5, 2, 'OWWWWWWWWWWO'],
    [6, 2, 'OWOWOWOWOWWO'],
    [7, 2, 'OWWWWWWWWWWO'],
    [8, 2, 'OWWOWOOWOWWO'],
    [9, 2, 'OWWWWWWWWWWO'],
    [10, 2, 'OWOWWWWWWOWO'],
    [11, 2, 'OWWWWWWWWWWO'],
    [12, 3, 'OWWWWWWWWO'],
    [13, 4, 'OOOOOOOO'],
  ],
}

async function main(): Promise<void> {
  const fixtures: Array<[string, Grid]> = [
    ['potion-32.png', potion],
    ['key-32.png', key],
    ['mushroom-32.png', mushroom],
    ['coin-32.png', coin],
    ['token-mono-16.png', mono],
  ]
  for (const [name, grid] of fixtures) {
    const rgba = render(grid)
    const bytes = new Uint8Array(rgba)
    writeFileSync(join(outDir, name), await encodePng(grid.size, grid.size, bytes))
    console.log(`wrote ${outDir}/${name} (${grid.size}×${grid.size})`)
  }
}

await main()
