// PixelForge AI — open/save performance benchmark (v3.1 §9.1 protocol).
//
// Measures the CORE persistence path with the approved protocol's core
// rules: median of 10 runs, warm cache (one untimed warm-up first). This
// sandbox is NOT the reference hardware (4-core mid-range laptop), so the
// numbers are recorded as relative baselines, not absolute compliance —
// per C16, CI asserts relative regression against this kind of baseline.
//
// What is measured for a 256×256 × 24-frame single-layer project:
//   • buildArchive  — serialize + PNG-encode every cel + ZIP (the save path)
//   • open          — read container + verify checksums + PNG-decode ALL cels
//                     (core's current EAGER strategy; §9.1's lazy-cel note
//                     describes the planned optimization — gap documented)
//   • autosave      — saveAutosave to an in-memory fs (atomic write path)
//
// Run: bun scripts/bench-open.ts

import {
  MemoryFs,
  buildArchive,
  loadPixelforgeproj,
  saveAutosave,
  createProject,
  createFrame,
  createLayer,
  type Project,
} from '../packages/core/src/index'

function makeBenchProject(): Project {
  const project = createProject({ name: 'bench', width: 256, height: 256, fps: 12 })
  const clip = project.clips[0]
  const layer = createLayer('art')
  clip.layers = [layer]
  clip.frames = []
  for (let f = 0; f < 24; f++) {
    const frame = createFrame(256, 256, [layer])
    const cel = frame.cels[layer.id]
    // pseudo-random blobs (compressible-but-real content: gradients + noise)
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4
        cel.buffer[i] = (x + f * 4) & 0xff
        cel.buffer[i + 1] = (y + f * 2) & 0xff
        cel.buffer[i + 2] = (x ^ y) & 0x3f
        cel.buffer[i + 3] = (x + y) % 7 === 0 ? 255 : ((x * y) & 0x80) + 120
      }
    }
    clip.frames.push(frame)
  }
  return project
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function bench() {
  const project = makeBenchProject()
  const fs = new MemoryFs()
  const path = '/bench.pixelforgeproj'

  // warm-up (untimed) — warm cache per protocol
  const warm = await buildArchive(project)
  await fs.writeFile(path, warm.bytes)
  await loadPixelforgeproj(fs, path)

  const buildMs: number[] = []
  const openMs: number[] = []
  const autosaveMs: number[] = []
  let bytes = 0

  for (let i = 0; i < 10; i++) {
    let t0 = performance.now()
    const built = await buildArchive(project)
    buildMs.push(performance.now() - t0)
    bytes = built.bytes.length

    await fs.writeFile(path, built.bytes)
    t0 = performance.now()
    const loaded = await loadPixelforgeproj(fs, path)
    openMs.push(performance.now() - t0)
    if (loaded.project.clips[0].frames.length !== 24) throw new Error('load sanity failed')

    t0 = performance.now()
    await saveAutosave(fs, path, project)
    autosaveMs.push(performance.now() - t0)
  }

  const r = (n: number) => Math.round(n * 10) / 10
  console.log('[bench] 256×256 × 24 frames, single layer')
  console.log(`[bench] archive bytes: ${bytes} (${r(bytes / 1024 / 1024)} MB)`)
  console.log(`[bench] buildArchive (save path): median ${r(median(buildMs))} ms  (min ${r(Math.min(...buildMs))} / max ${r(Math.max(...buildMs))})`)
  console.log(`[bench] open (zip+checksums+decode ALL cels): median ${r(median(openMs))} ms  (min ${r(Math.min(...openMs))} / max ${r(Math.max(...openMs))})  — §9.1 target < 300 ms`)
  console.log(`[bench] autosave (encode all cels — dirty-cel optimization NOT yet implemented): median ${r(median(autosaveMs))} ms  — §9.1 target < 100 ms off-UI-thread`)
  const clip = project.clips[0]
  const celCount = clip.frames.reduce((a, f) => a + Object.keys(f.cels).length, 0)
  console.log(`[bench] cels decoded at open: ${celCount} (eager) vs ~40 (lazy plan §9.1)`)
}

await bench()
