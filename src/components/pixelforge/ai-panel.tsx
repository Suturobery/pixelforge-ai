'use client'

import { useCallback, useState } from 'react'
import type { PixelGrid, Rig } from '@/lib/pixelforge/types'
import { autoRig } from '@/lib/pixelforge/rig'
import { validateRig } from '@/lib/pixelforge/rig'
import { base64ToImageData, normalizeToGrid } from '@/lib/pixelforge/normalize'
import { useEditor } from '@/lib/pixelforge/store'

const EXAMPLES = [
  'green slime knight with a tiny sword',
  'brave knight with sword and shield, side view',
  'cute forest wizard with pointed hat',
  'small red dragon standing',
]

type Phase = 'idle' | 'generating' | 'normalizing' | 'ready'

/**
 * PixelForge AI panel — text prompt → AI image → normalized pixel sprite.
 * The SDK call happens server-side (/api/generate); this component only
 * fetches the result and runs the client-side Normalize v2.1 pipeline.
 */
export function AiPanel() {
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState<32 | 48>(32)
  const [phase, setPhase] = useState<Phase>('idle')
  const [rawPreview, setRawPreview] = useState<string | null>(null)
  const [pixelPreview, setPixelPreview] = useState<string | null>(null)
  const [pending, setPending] = useState<{ grid: PixelGrid; rig: Rig } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [spriteInfo, setSpriteInfo] = useState<string | null>(null)

  const busy = phase === 'generating' || phase === 'normalizing'

  const generate = useCallback(async () => {
    const p = prompt.trim()
    if (p.length < 3 || busy) return
    setError(null)
    setRawPreview(null)
    setPixelPreview(null)
    setPending(null)
    setSpriteInfo(null)
    setPhase('generating')
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: p }),
      })
      const json = (await res.json()) as { image?: string; error?: string }
      if (!res.ok || !json.image) {
        throw new Error(json.error ?? `Generation failed (${res.status})`)
      }
      setRawPreview(`data:image/png;base64,${json.image}`)
      setPhase('normalizing')

      // Normalize v2.1: downscale → key background → quantize → threshold → despeckle
      const imageData = await base64ToImageData(json.image)
      const grid = normalizeToGrid(imageData, { size, paletteSize: 16 })
      const rig = autoRig(grid)
      setPending({ grid, rig })

      // Pixelated preview (image-rendering handled by canvas draw)
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (ctx) {
        const out = ctx.createImageData(size, size)
        out.data.set(grid.data)
        ctx.putImageData(out, 0, 0)
        setPixelPreview(canvas.toDataURL())
      }

      const validation = validateRig(rig, grid)
      const opaque = grid.data.reduce((n, v, i) => (i % 4 === 3 && v > 0 ? n + 1 : n), 0)
      setSpriteInfo(
        `${opaque} px · rig: ${rig.parts.length} parts${validation.warnings.length ? ` · ${validation.warnings.length} rig warning(s)` : ' · rig ok'}`
      )
      setPhase('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed')
      setPhase('idle')
    }
  }, [prompt, size, busy])

  const loadToCanvas = useCallback(() => {
    if (!pending) return
    useEditor.getState().loadGrid(pending.grid, pending.rig)
  }, [pending])

  return (
    <section
      aria-label="PixelForge AI generation"
      data-testid="ai-panel"
      className="rounded-lg border border-emerald-200 bg-gradient-to-b from-emerald-50/80 to-white p-3"
    >
      <div className="mb-2 flex items-center gap-1.5">
        <span aria-hidden className="text-emerald-600">✦</span>
        <h2 className="text-xs font-bold uppercase tracking-wide text-emerald-800">
          PixelForge AI — Generate
        </h2>
      </div>

      <label htmlFor="ai-prompt" className="sr-only">Sprite description prompt</label>
      <textarea
        id="ai-prompt"
        data-testid="ai-prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe a sprite… e.g. brave knight with sword, side view"
        rows={2}
        maxLength={600}
        disabled={busy}
        className="w-full resize-none rounded-md border border-stone-300 bg-white px-2.5 py-2 text-xs leading-snug placeholder:text-stone-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-60"
      />

      <div className="mt-2 flex items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-stone-300" role="group" aria-label="Sprite size">
          {([32, 48] as const).map((s) => (
            <button
              key={s}
              type="button"
              data-testid={`ai-size-${s}`}
              onClick={() => setSize(s)}
              disabled={busy}
              aria-pressed={size === s}
              className={`px-2.5 py-1.5 text-xs font-medium ${
                size === s ? 'bg-emerald-600 text-white' : 'bg-white text-stone-700 hover:bg-stone-100'
              }`}
            >
              {s}×{s}
            </button>
          ))}
        </div>
        <button
          type="button"
          data-testid="ai-generate"
          onClick={generate}
          disabled={busy || prompt.trim().length < 3}
          className="ml-auto flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {phase === 'generating' && (
            <span
              aria-hidden
              className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white"
            />
          )}
          {phase === 'generating' ? 'Generating…' : phase === 'normalizing' ? 'Pixelizing…' : 'Generate sprite'}
        </button>
      </div>

      {!busy && phase === 'idle' && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setPrompt(ex)}
              className="max-w-full truncate rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[10px] text-stone-600 hover:border-emerald-300 hover:text-emerald-700"
              title={ex}
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" data-testid="ai-error" className="mt-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {phase === 'ready' && pixelPreview && (
        <div data-testid="ai-result" className="mt-3 flex items-start gap-3">
          <div className="flex flex-col items-center gap-1">
            <img
              src={pixelPreview}
              alt={`Generated pixel sprite: ${prompt.trim()}`}
              width={96}
              height={96}
              className="rounded border border-stone-200 bg-[repeating-conic-gradient(#e5e5e5_0%_25%,#ffffff_0%_50%)] bg-[length:12px_12px]"
              style={{ imageRendering: 'pixelated' }}
            />
            <span className="text-[10px] font-medium text-emerald-700">pixel sprite</span>
          </div>
          {rawPreview && (
            <div className="hidden flex-col items-center gap-1 sm:flex">
              <img
                src={rawPreview}
                alt="Raw AI output before normalization"
                width={64}
                height={64}
                className="rounded border border-stone-200"
              />
              <span className="text-[10px] text-stone-400">raw AI output</span>
            </div>
          )}
          <div className="ml-auto flex min-w-0 flex-1 flex-col items-stretch gap-1.5">
            <p className="text-[11px] leading-snug text-stone-500" data-testid="ai-sprite-info">
              {size}×{size} · {spriteInfo}
            </p>
            <button
              type="button"
              data-testid="ai-load"
              onClick={loadToCanvas}
              className="rounded-md bg-stone-800 px-3 py-2 text-xs font-semibold text-white transition hover:bg-stone-900"
            >
              Load to canvas →
            </button>
            <p className="text-[10px] leading-snug text-stone-400">
              Auto-rigged. Adjust part rects in the rig editor for better motion.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}
