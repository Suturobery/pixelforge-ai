// PixelForge AI — seed a sample project so the studio opens with real art.
// Draws a 32×32 farmer character (straw hat, green shirt, denim overalls) with
// a 4-frame "idle wave" clip, encodes each frame as a PNG data URL (server-side
// pngjs) and POSTs it to the projects API.
//
// Run: bun scripts/seed-sample.ts   (dev server must be running on :3000)

import { encodePngDataUrl, emptyBuffer } from '../src/lib/pixelforge/server-png'

const W = 32
const H = 32
const API = process.env.PF_API ?? 'http://localhost:3000'

{
  const u = new URL(API)
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1'
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !loopback) {
    console.error(`PF_API must be a loopback http(s) URL, got: ${API}`)
    process.exit(2)
  }
}

// colors from the project's default 16-swatch palette
const C = {
  hat: '#ffcd75',
  hatShade: '#ef7d57',
  band: '#b13e53',
  skin: '#f4f4f4',
  eye: '#1a1c2c',
  mouth: '#b13e53',
  shirt: '#38b764',
  shirtShade: '#257179',
  denim: '#3b5dc9',
  denimShade: '#29366f',
  boot: '#333c57',
  gold: '#ffcd75',
} as const

function hexRgba(hex: string): [number, number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255]
}

interface Painter {
  buf: Uint8ClampedArray
  set(x: number, y: number, hex: string): void
  rect(x0: number, y0: number, x1: number, y1: number, hex: string): void
}

function painter(): Painter {
  const buf = emptyBuffer(W, H)
  const set = (x: number, y: number, hex: string) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const [r, g, b, a] = hexRgba(hex)
    const i = (y * W + x) * 4
    buf[i] = r
    buf[i + 1] = g
    buf[i + 2] = b
    buf[i + 3] = a
  }
  const rect = (x0: number, y0: number, x1: number, y1: number, hex: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, hex)
  }
  return { buf, set, rect }
}

type Pose = { dy: number; arm: 'down' | 'upA' | 'upB' }

/** Draw the farmer for one animation frame. Feet stay planted; the head bobs
 *  (dy) and the right arm waves (upA/upB). */
function drawFarmer({ dy, arm }: Pose): Uint8ClampedArray {
  const p = painter()

  // legs + boots (planted)
  p.rect(12, 22, 15, 26, C.denim)
  p.rect(16, 22, 19, 26, C.denim)
  for (let y = 22; y <= 26; y++) {
    p.set(12, y, C.denimShade)
    p.set(19, y, C.denimShade)
  }
  p.rect(12, 27, 15, 29, C.boot)
  p.rect(16, 27, 19, 29, C.boot)

  // torso — green shirt
  p.rect(11, 15, 20, 21, C.shirt)
  p.rect(11, 15, 11, 21, C.shirtShade)
  p.rect(20, 15, 20, 21, C.shirtShade)
  p.rect(12, 15, 19, 15, C.shirtShade)

  // denim overalls bib + straps + buttons + pocket
  p.rect(13, 16, 18, 21, C.denim)
  p.rect(13, 15, 14, 15, C.denim)
  p.rect(17, 15, 18, 15, C.denim)
  p.set(13, 16, C.gold)
  p.set(18, 16, C.gold)
  p.rect(15, 18, 16, 19, C.denimShade)

  // left arm (resting)
  p.rect(9, 15, 10, 19, C.shirt)
  p.rect(9, 20, 10, 21, C.skin)

  // right arm — waves
  if (arm === 'down') {
    p.rect(21, 15, 22, 19, C.shirt)
    p.rect(21, 20, 22, 21, C.skin)
  } else {
    p.rect(21, 15, 22, 16, C.shirt) // shoulder
    p.rect(22, 11, 23, 15, C.shirt) // raised sleeve
    if (arm === 'upA') {
      p.rect(22, 9, 23, 10, C.skin) // hand up-left
    } else {
      p.rect(23, 11, 24, 11, C.skin) // forearm out
      p.rect(24, 10, 25, 11, C.skin) // hand waving right
    }
  }

  // head (bobs by dy)
  p.rect(12, 9 + dy, 19, 14 + dy, C.skin)
  p.set(14, 11 + dy, C.eye)
  p.set(17, 11 + dy, C.eye)
  p.set(15, 13 + dy, C.mouth)
  p.set(16, 13 + dy, C.mouth)

  // straw hat (bobs with head)
  p.rect(13, 3 + dy, 18, 6 + dy, C.hat)
  p.rect(13, 6 + dy, 18, 6 + dy, C.band)
  p.rect(9, 7 + dy, 22, 7 + dy, C.hat)
  p.rect(9, 8 + dy, 22, 8 + dy, C.hatShade)

  return p.buf
}

const FRAMES: Pose[] = [
  { dy: 0, arm: 'down' },
  { dy: 1, arm: 'down' },
  { dy: 0, arm: 'upA' },
  { dy: 1, arm: 'upB' },
]

const PALETTE = [
  '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070',
  '#38b764', '#257179', '#29366f', '#3b5dc9', '#41a6f6', '#73eff7',
  '#f4f4f4', '#94b0c2', '#566c86', '#333c57',
]

async function main() {
  const frames = FRAMES.map((pose, i) => ({
    id: `fr_sample_${i + 1}`,
    layers: [
      {
        id: `ly_sample_${i + 1}`,
        name: 'farmer',
        visible: true,
        opacity: 1,
        png: encodePngDataUrl(W, H, drawFarmer(pose)),
      },
    ],
  }))

  const project = {
    version: 1 as const,
    name: 'Sample: Farmer',
    width: W,
    height: H,
    palette: PALETTE,
    clips: [
      {
        id: 'cl_sample_wave',
        name: 'idle wave',
        fps: 6,
        loop: true,
        frames,
      },
    ],
  }

  const res = await fetch(`${API}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PixelForge-Agent': '1' },
    body: JSON.stringify({ id: null, project }),
  })
  const json = (await res.json()) as { ok: boolean; id?: string; error?: string }
  if (!json.ok) throw new Error(json.error ?? 'Seed failed')
  console.log(`Seeded sample project "Sample: Farmer" → ${json.id}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
