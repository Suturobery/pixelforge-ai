// PixelForge AI — Reference & Offline PNG Import panel.
//
// Cleans external PNGs (e.g. sprites produced by external AI IDEs or models)
// so they match an approved reference sprite and project style rules:
//   pick/import the reference (saved with the project via Style Lock) → import
//   a local PNG (fully offline) → grid-snap + palette-map + background cleanup
//   via core normalize-v2 → review original vs cleaned beside the reference →
//   add the cleaned candidate to the canvas as one editable layer (one undoable
//   op). Supports 16×16 and 32×32 targets.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  cloneStyleProfile,
  composeFrameRgba,
  decodePng,
  defaultStyleProfile,
  encodePng,
  buildReferenceCandidate,
  STYLE_CAMERA_ANGLES,
  type ReferenceCandidate,
  type StyleCameraAngle,
  type StyleCheck,
  type StyleProfile,
} from '@pixelforge/core'
import { getActiveClip, getActiveFrame, useEditor } from '@/lib/pixelforge/store'
import { buildSketchPack } from '@/lib/pixelforge/sketch-pack'
import { downloadData } from '@/lib/pixelforge/export'
import { createProject, slugify } from '@/lib/pixelforge/factory'
import { drawSpritePreview } from './sprite-preview'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { CheckCircle2, ImagePlus, Info, TriangleAlert, Upload, Wand2 } from 'lucide-react'

const MAX_CANDIDATES = 4

interface ResolvedReference {
  label: string
  width: number
  height: number
  /** Composed RGBA preview pixels. */
  buffer: Uint8ClampedArray
  /** PNG bytes of the stored reference. */
  png: Uint8Array
}

/** Decode the saved reference (embedded PNG or project frame) into pixels. */
function useResolvedReference(profile: StyleProfile, project: ReturnType<typeof useEditor.getState>['project']) {
  const ref = profile.references[0] ?? null
  const key = ref ? (ref.pngBase64 ? `png:${ref.width}:${ref.label}` : `frame:${ref.clipId}:${ref.frameId}`) : 'none'
  const [state, setState] = useState<{ key: string; value: ResolvedReference | null }>({ key: '', value: null })
  if (state.key !== key) {
    setState({ key, value: null })
  }
  useEffect(() => {
    if (!ref) return
    let cancelled = false
    if (ref.pngBase64) {
      const bin = atob(ref.pngBase64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      void decodePng(bytes).then((img) => {
        if (!cancelled) setState({ key, value: { label: ref.label, width: img.width, height: img.height, buffer: img.rgba, png: bytes } })
      }).catch(() => {
        if (!cancelled) setState({ key, value: null })
      })
      return () => {
        cancelled = true
      }
    }
    const clip = project.clips.find((c) => c.id === ref.clipId)
    const frame = clip?.frames.find((f) => f.id === ref.frameId) ?? clip?.frames[0]
    if (!clip || !frame) return
    try {
      const rgba = composeFrameRgba(project, clip, frame)
      void encodePng(project.width, project.height, rgba).then((png) => {
        if (!cancelled) setState({ key, value: { label: ref.label, width: project.width, height: project.height, buffer: rgba, png } })
      }).catch(() => {
        if (!cancelled) setState({ key, value: null })
      })
    } catch {
      /* composition failure (dangling clip) — reference stays unavailable */
    }
    return () => {
      cancelled = true
    }
  }, [key, project, ref])
  return state.value
}

function CheckRow({ check }: { check: StyleCheck }) {
  const tone =
    check.status === 'pass'
      ? 'bg-emerald-500/10 text-emerald-300'
      : check.status === 'warning'
        ? 'bg-amber-500/10 text-amber-300'
        : 'bg-zinc-800/60 text-zinc-400'
  return (
    <li className={`flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug ${tone}`}>
      {check.status === 'pass' ? (
        <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
      ) : check.status === 'warning' ? (
        <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
      ) : (
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
      )}
      <span>
        <span className="font-medium">{check.label}</span>
        <span className="block text-[10px] opacity-80">{check.detail}</span>
      </span>
    </li>
  )
}

/** Fit large sources in the panel and show an integer zoom for small sprites. */
function SpritePair({ rgba, width, height, caption }: {
  rgba: Uint8ClampedArray | null
  width: number
  height: number
  caption: string
}) {
  const primary = useRef<HTMLCanvasElement | null>(null)
  const enlarged = useRef<HTMLCanvasElement | null>(null)
  const longestSide = Math.max(width, height)
  const scale = Math.min(1, 96 / longestSide)
  const zoom = Math.floor(96 / longestSide)
  useEffect(() => {
    drawSpritePreview(primary.current, rgba, width, height)
    drawSpritePreview(enlarged.current, rgba, width, height)
  }, [rgba, width, height])
  return (
    <figure className="min-w-0 max-w-full text-center">
      <div className="flex flex-wrap items-end justify-center gap-1.5">
        <canvas
          ref={primary}
          className="h-auto max-w-full rounded border border-zinc-800"
          style={{ imageRendering: 'pixelated', width: width * scale }}
          aria-label={`${caption} preview`}
        />
        {zoom > 1 && (
          <canvas
            ref={enlarged}
            className="h-auto max-w-full rounded border border-zinc-700"
            style={{ imageRendering: 'pixelated', width: width * zoom }}
            aria-label={`${caption} at ${zoom}× zoom`}
          />
        )}
      </div>
      <figcaption className="mt-0.5 text-[10px] text-zinc-500">
        {caption} · {width}×{height}{zoom > 1 && ` · ${zoom}× zoom`}
      </figcaption>
    </figure>
  )
}

export function ReferenceCreator() {
  const projectKey = useEditor((s) => `${s.loadEpoch}-${s.project.width}x${s.project.height}`)
  return <ReferencePanel key={projectKey} />
}

type Sketch = ReferenceCandidate['original']
type ReviewedCandidate = ReferenceCandidate & { sketch: Sketch | null }

function ReferencePanel() {
  const project = useEditor((s) => s.project)
  const docVersion = useEditor((s) => s.docVersion)
  const setStyleProfile = useEditor((s) => s.setStyleProfile)
  const importCandidateAsLayer = useEditor((s) => s.importCandidateAsLayer)
  const referenceDraft = useEditor((s) => s.referenceDraft)
  const { toast } = useToast()

  const profile: StyleProfile = project.settings.styleProfile ?? defaultStyleProfile()
  const resolvedRef = useResolvedReference(profile, project)

  const [brief, setBrief] = useState('')
  const [candidates, setCandidates] = useState<ReviewedCandidate[]>([])
  const [sketch, setSketch] = useState<Sketch | null>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importedName, setImportedName] = useState<string | null>(null)

  const briefRef = useRef<HTMLTextAreaElement | null>(null)
  const candidateFileRef = useRef<HTMLInputElement | null>(null)
  const referenceFileRef = useRef<HTMLInputElement | null>(null)

  const [adoptedRefDraft, setAdoptedRefDraft] = useState<string | null>(null)
  if (referenceDraft && adoptedRefDraft !== referenceDraft) {
    setAdoptedRefDraft(referenceDraft)
    setBrief(referenceDraft)
  }

  const guidedNoRefRef = useRef(false)
  useEffect(() => {
    if (adoptedRefDraft && !profile.references[0] && !guidedNoRefRef.current) {
      guidedNoRefRef.current = true
      toast({
        title: 'No approved reference yet',
        description: 'Import a 16×16/32×32 PNG or pick a clip frame in section 2 — the label stays prefilled.',
      })
    }
  }, [adoptedRefDraft, profile.references])

  const targetSize = useMemo(
    () => (project.width === project.height && (project.width === 16 || project.width === 32) ? project.width : null),
    [project.width, project.height, docVersion],
  )

  const patchProfile = (patch: Partial<StyleProfile>) => {
    setStyleProfile({ ...cloneStyleProfile(profile), ...patch })
  }

  // --- reference import (embedded with the project) --------------------------
  const importReference = async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const img = await decodePng(bytes)
      if (img.width !== img.height || (img.width !== 16 && img.width !== 32)) {
        toast({
          title: 'Unsupported reference size',
          description: `This release supports square 16×16 and 32×32 references (got ${img.width}×${img.height}).`,
          variant: 'destructive',
        })
        return
      }
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      const b64 = btoa(bin)
      patchProfile({
        references: [{ clipId: '', frameId: '', label: file.name.slice(0, 80), pngBase64: b64, width: img.width, height: img.height }],
      })
      toast({ title: 'Reference saved', description: `"${file.name}" (${img.width}×${img.height}) is stored with the project style.` })
    } catch {
      toast({ title: 'Could not read that PNG', description: 'Import failed — is the file a valid PNG?', variant: 'destructive' })
    }
  }

  const pickReferenceFromClips = (clipId: string) => {
    const clip = project.clips.find((c) => c.id === clipId)
    const frame = clip?.frames[0]
    if (!clip || !frame) return
    patchProfile({ references: [{ clipId: clip.id, frameId: frame.id, label: clip.name }] })
    toast({ title: 'Reference set', description: `"${clip.name}" frame 1 is now the approved reference.` })
  }

  const clearReference = () => {
    patchProfile({ references: [] })
    toast({ title: 'Reference cleared' })
  }

  // --- offline PNG import & cleanup ------------------------------------------
  const exportSketch = async () => {
    if (!targetSize || busy) return
    setBusy(true)
    setError(null)
    try {
      const editor = useEditor.getState()
      const clip = getActiveClip(editor)
      const frame = getActiveFrame(editor)
      const buffer = composeFrameRgba(editor.project, clip, frame)
      const zip = await buildSketchPack({
        buffer, targetSize, brief, profile, palette: project.palette, referencePng: resolvedRef?.png,
      })
      downloadData(new Blob([new Uint8Array(zip)], { type: 'application/zip' }), `${slugify(brief || clip.name) || 'sprite'}-sketch.zip`)
      setSketch({ buffer, width: targetSize, height: targetSize })
      toast({ title: 'Sketch pack ready', description: 'Unzip it and give the PNG files and prompt to your image tool.' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export the active frame.')
    } finally {
      setBusy(false)
    }
  }

  const pushCandidate = (candidate: ReviewedCandidate) => {
    setCandidates((list) => [candidate, ...list].slice(0, MAX_CANDIDATES))
    setSelectedIdx(0)
    setError(null)
  }

  const runImportCandidate = async (file: File) => {
    if (!targetSize) return
    setBusy(true)
    setError(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const candidate = await buildReferenceCandidate({
        brief: brief.trim() || file.name.replace(/\.png$/i, ''),
        providerId: 'import',
        model: 'local-png',
        providerPng: bytes,
        reference: resolvedRef
          ? { buffer: resolvedRef.buffer, width: resolvedRef.width, height: resolvedRef.height }
          : { buffer: new Uint8ClampedArray(targetSize * targetSize * 4), width: targetSize, height: targetSize },
        palette: [...project.palette],
        profile,
        targetSize,
      })
      pushCandidate({ ...candidate, sketch })
      toast({ title: 'Sprite cleaned', description: 'Grid-snapped, palette-mapped, and checked — review it below.' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // --- commit -----------------------------------------------------------------
  const selected = candidates[selectedIdx] ?? null

  const addToCanvas = () => {
    if (!selected) return
    const name = slugify(selected.brief || 'imported-asset')
    const result = importCandidateAsLayer(selected.cleaned.buffer, name)
    if (result) {
      toast({ title: 'Added to canvas', description: `"${name}" is a new editable layer in the current clip (one undo step).` })
    }
  }

  const importAnother = () => {
    setBrief('')
    setSelectedIdx(0)
    briefRef.current?.focus()
    toast({ title: 'Ready for next PNG', description: 'The reference and project style rules stay applied.' })
  }

  const startNewProject = async (size: 16 | 32) => {
    if (
      useEditor.getState().dirty &&
      !(await confirmDialog({
        title: 'Discard unsaved changes?',
        message: `Starting a ${size}×${size} project will lose your unsaved changes.`,
        confirmLabel: 'Discard & Create',
        destructive: true,
      }))
    )
      return
    useEditor.getState().newProject(
      createProject({ name: useEditor.getState().project.name, width: size, height: size, palette: [...project.palette] }),
    )
    toast({ title: `New ${size}×${size} project`, description: 'Palette kept — import your reference again if needed.' })
  }

  return (
    <div className="pixelforge-scroll mx-auto h-full min-h-0 w-full max-w-[520px] space-y-3 overflow-y-auto p-3" data-testid="reference-creator">
      {/* ---------------------------- style ---------------------------- */}
      <section aria-label="Project style" className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-3">
        <header className="mb-2.5 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-500/15 text-[10px] font-semibold text-teal-300">1</span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Project style</span>
          </span>
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
            <Switch
              checked={profile.enabled}
              onCheckedChange={(v) => patchProfile({ enabled: v })}
              aria-label="Style Lock enabled"
              className="scale-90"
            />
            {profile.enabled ? 'ON' : 'off'}
          </label>
        </header>
        <div className="grid min-w-0 grid-cols-1 gap-2 @min-[340px]:grid-cols-2">
          <div className="min-w-0">
            <Label className="text-[11px] font-medium text-zinc-400">Camera angle</Label>
            <Select
              value={profile.cameraAngle ?? 'side view'}
              onValueChange={(v) => patchProfile({ cameraAngle: v as StyleCameraAngle })}
            >
              <SelectTrigger className="h-7 w-full text-xs" aria-label="Camera angle"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STYLE_CAMERA_ANGLES.map((a) => (
                  <SelectItem key={a} value={a} className="text-xs">{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0">
            <Label className="text-[11px] font-medium text-zinc-400">Lighting</Label>
            <Select value={profile.lighting} onValueChange={(v) => patchProfile({ lighting: v as StyleProfile['lighting'] })}>
              <SelectTrigger className="h-7 w-full text-xs" aria-label="Lighting"><SelectValue /></SelectTrigger>
              <SelectContent>
                {['top-left', 'top', 'front', 'flat'].map((l) => (
                  <SelectItem key={l} value={l} className="text-xs">{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0">
            <Label className="text-[11px] font-medium text-zinc-400">Outline</Label>
            <Select value={profile.outline} onValueChange={(v) => patchProfile({ outline: v as StyleProfile['outline'] })}>
              <SelectTrigger className="h-7 w-full text-xs" aria-label="Outline"><SelectValue /></SelectTrigger>
              <SelectContent>
                {['dark-1px', 'light-1px', 'none'].map((o) => (
                  <SelectItem key={o} value={o} className="text-xs">{o}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0">
            <Label className="text-[11px] font-medium text-zinc-400">Palette policy</Label>
            <Select value={profile.paletteMode} onValueChange={(v) => patchProfile({ paletteMode: v as StyleProfile['paletteMode'] })}>
              <SelectTrigger className="h-7 w-full text-xs" aria-label="Palette policy"><SelectValue /></SelectTrigger>
              <SelectContent>
                {['enforce', 'prefer', 'none'].map((m) => (
                  <SelectItem key={m} value={m} className="text-xs">{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">
          Saved with the project · {project.width}×{project.height} canvas · {project.palette.length} palette colors
        </p>
      </section>

      {/* ---------------------------- reference ---------------------------- */}
      <section aria-label="Approved reference" className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-3">
        <header className="mb-2.5 flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-500/15 text-[10px] font-semibold text-teal-300">2</span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Approved reference</span>
        </header>
        {targetSize === null && (
          <p className="mb-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-300">
            Offline reference cleanup supports 16×16 and 32×32 canvases — this project is {project.width}×{project.height}. Start a
            matching project (unsaved changes are confirmed first; your palette is kept):
            <span className="mt-1.5 flex gap-1.5">
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => void startNewProject(16)}>
                New 16×16
              </Button>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => void startNewProject(32)}>
                New 32×32
              </Button>
            </span>
          </p>
        )}
        {resolvedRef ? (
          <div className="mb-2 flex flex-wrap items-start gap-3">
            <SpritePair rgba={resolvedRef.buffer} width={resolvedRef.width} height={resolvedRef.height} caption="reference" />
            <div className="min-w-0 min-w-[160px] flex-1">
              <p className="truncate text-xs font-medium text-zinc-200">{resolvedRef.label}</p>
              <p className="text-[10px] text-zinc-500">
                {resolvedRef.width}×{resolvedRef.height} · stored with the project
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[10px]" onClick={() => referenceFileRef.current?.click()}>
                  <Upload className="h-3 w-3" /> Replace PNG…
                </Button>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-zinc-400" onClick={clearReference}>
                  Clear
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="mb-2 space-y-2">
            <p className="text-[11px] leading-snug text-zinc-500">
              Optionally import an approved sprite (16×16 or 32×32 PNG) or pick a frame from the project to compare
              imported PNGs side-by-side.
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" className="h-7 gap-1 rounded-md bg-teal-600 px-2.5 text-xs font-medium hover:bg-teal-500" onClick={() => referenceFileRef.current?.click()}>
                <ImagePlus className="h-3.5 w-3.5" /> Import reference PNG…
              </Button>
              {project.clips.length > 0 && (
                <Select onValueChange={pickReferenceFromClips}>
                  <SelectTrigger className="h-7 w-[170px] text-xs" aria-label="Pick a project frame as reference">
                    <SelectValue placeholder="…or pick a clip frame" />
                  </SelectTrigger>
                  <SelectContent className="max-h-48">
                    {project.clips.map((c) => (
                      <SelectItem key={c.id} value={c.id} className="text-xs">
                        {c.name} ({c.frames.length}f)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        )}
        <input
          ref={referenceFileRef}
          type="file"
          accept="image/png"
          className="hidden"
          aria-label="Import reference PNG file"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void importReference(file)
            e.target.value = ''
          }}
        />
      </section>

      {/* ---------------------------- offline PNG import ---------------------------- */}
      <section aria-label="Import and clean PNG" className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-3">
        <header className="mb-2.5 flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-500/15 text-[10px] font-semibold text-teal-300">3</span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Import &amp; clean PNG</span>
        </header>
        <textarea
          ref={briefRef}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder='Layer name or brief (optional) — e.g. "forest-mage"'
          aria-label="Asset label"
          className="min-h-[48px] w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600"
          spellCheck={false}
        />
        <div className="mt-2 space-y-2">
          <Button size="sm" variant="outline" className="w-full text-xs"
            disabled={busy || !targetSize}
            onClick={() => void exportSketch()}>
            Export active frame as sketch pack
          </Button>
          <p className="text-[10px] leading-snug text-zinc-500">
            Give your image tool the sketch, silhouette and shading study, and prompt from the ZIP. Import the result below.
          </p>
          {sketch && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SpritePair width={sketch.width} height={sketch.height} rgba={sketch.buffer} caption="Sketch for next import" />
              <Button size="sm" variant="ghost" onClick={() => setSketch(null)}>Clear sketch</Button>
            </div>
          )}
          <Button
            className="h-8 w-full gap-1.5 rounded-md bg-teal-600 text-xs font-medium text-white hover:bg-teal-500"
            onClick={() => candidateFileRef.current?.click()}
            disabled={busy || !targetSize}
            aria-label="Import PNG to clean"
          >
            <Upload className="h-3.5 w-3.5 shrink-0" /> Import PNG (offline · grid-snap)
          </Button>
        </div>
        <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">
          Fully offline: pick any PNG from an external AI tool or IDE — PixelForge detects its pixel grid, removes the
          background, maps to your project palette, and checks sizing locally.
        </p>
        <input
          ref={candidateFileRef}
          type="file"
          accept="image/png"
          className="hidden"
          aria-label="Import candidate PNG file"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file && targetSize) {
              setImportedName(file.name)
              void runImportCandidate(file)
            }
            e.target.value = ''
          }}
        />
        {error && (
          <p role="alert" className="mt-2 rounded-md bg-red-950/40 px-2 py-1.5 text-[11px] leading-snug text-red-300">
            {error}
          </p>
        )}
        {importedName && (
          <p className="mt-1.5 truncate text-[10px] text-zinc-500">Last imported: {importedName}</p>
        )}
      </section>

      {/* ---------------------------- candidates ---------------------------- */}
      {candidates.length > 0 && (
        <section aria-label="Candidates" className="rounded-xl border border-teal-800/50 bg-teal-950/10 p-3">
          <header className="mb-2.5 flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-500/15 text-[10px] font-semibold text-teal-300">4</span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Cleaned imports</span>
            </span>
            <span className="font-mono text-[10px] text-zinc-500">
              {candidates.length} kept · offline
            </span>
          </header>
          <div className="mb-2.5 flex flex-wrap gap-1">
            {candidates.map((c, i) => (
              <button
                key={i}
                type="button"
                aria-pressed={i === selectedIdx}
                onClick={() => setSelectedIdx(i)}
                className={`max-w-[150px] truncate rounded-md border px-2 py-1 text-[10px] ${
                  i === selectedIdx ? 'border-teal-500/60 bg-teal-950/40 text-teal-200' : 'border-zinc-800 bg-zinc-950/60 text-zinc-400'
                }`}
                title={c.brief}
              >
                {c.brief || 'import'} · {c.cleaned.width}×{c.cleaned.height}
              </button>
            ))}
          </div>
          {selected && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-start gap-3 rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2.5">
                {selected.sketch && <SpritePair width={selected.sketch.width} height={selected.sketch.height} rgba={selected.sketch.buffer} caption="sketch" />}
                {resolvedRef && <SpritePair rgba={resolvedRef.buffer} width={resolvedRef.width} height={resolvedRef.height} caption="reference" />}
                <SpritePair rgba={selected.original.buffer} width={selected.original.width} height={selected.original.height} caption="original" />
                <SpritePair rgba={selected.cleaned.buffer} width={selected.cleaned.width} height={selected.cleaned.height} caption="cleaned" />
                <p className="w-full self-center text-[11px] leading-snug text-zinc-500">
                  Original vs cleaned — catch lost detail before approving. Cleaned is palette-mapped
                  ({selected.stats.colorsOut} colors), background removed ({selected.stats.bgRemoved} px), fitted to{' '}
                  {selected.cleaned.width}×{selected.cleaned.height}.
                </p>
              </div>
              <ul className="space-y-1" aria-label="Technical checks">
                {selected.checks.map((c) => (
                  <CheckRow key={c.id} check={c} />
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button
                  className="h-8 min-w-0 flex-1 whitespace-normal rounded-md bg-teal-600 text-xs font-medium text-white hover:bg-teal-500"
                  onClick={addToCanvas}
                  aria-label="Add candidate to canvas"
                >
                  <ImagePlus className="h-3.5 w-3.5 shrink-0" /> Add &ldquo;{(selected.brief || 'import').slice(0, 24)}&rdquo; to Canvas
                </Button>
                <Button
                  variant="outline"
                  className="h-8 min-w-0 flex-1 whitespace-normal gap-1.5 rounded-md border-zinc-700 text-xs"
                  onClick={importAnother}
                  aria-label="Import another PNG"
                >
                  <Wand2 className="h-3.5 w-3.5 shrink-0" /> Import Another
                </Button>
              </div>
              <p className="text-center text-[10px] leading-snug text-zinc-500">
                One undoable layer · source artwork untouched · checks are technical — approval is yours
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
