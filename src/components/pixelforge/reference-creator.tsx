// PixelForge AI — Create from Reference panel.
//
// Static pixel-art assets that belong with an approved reference sprite:
//   pick/import the reference (saved with the project via Style Lock) → type
//   a brief → generate candidates from an online provider (Gemini, optional;
//   fetch runs main-side, disclosed before sending) OR import a local PNG
//   (fully offline) → review original vs cleaned beside the reference → add
//   the cleaned candidate to the canvas as one editable layer (one undoable
//   op) → Create Another in This Style reuses the same reference + rules.
//
// The candidate pipeline reuses core normalize-v2 (resize, palette mapping,
// transparency cleanup). Technical checks are shown SEPARATELY from the
// artist's visual approval. Supports 16×16 and 32×32 targets.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  cloneStyleProfile,
  composeFrameRgba,
  decodePng,
  defaultStyleProfile,
  encodePng,
  buildReferenceCandidate,
  buildReferencePrompt,
  STYLE_CAMERA_ANGLES,
  type ReferenceCandidate,
  type StyleCameraAngle,
  type StyleCheck,
  type StyleProfile,
} from '@pixelforge/core'
import { useEditor } from '@/lib/pixelforge/store'
import { createProject, slugify } from '@/lib/pixelforge/factory'
import {
  REFERENCE_PROVIDER_DOCS,
  REFERENCE_PROVIDER_LABEL,
  generateReferenceCandidate,
  referenceProviderKeyStatus,
  removeReferenceProviderKey,
  storeReferenceProviderKey,
} from '@/lib/pixelforge/reference-provider'
import { drawSpritePreview } from './sprite-preview'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  /** PNG bytes sent to the provider. */
  png: Uint8Array
}

/** Decode the saved reference (embedded PNG or project frame) into pixels. */
function useResolvedReference(profile: StyleProfile, project: ReturnType<typeof useEditor.getState>['project']) {
  const ref = profile.references[0] ?? null
  // identity of the current reference — resets the value during render when it
  // changes (render-time adjustment; async decode lands in callbacks only)
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

/** Sprite preview pair at actual size + integer zoom (checkerboard backdrop). */
function SpritePair({ rgba, size, caption }: { rgba: Uint8ClampedArray | null; size: number; caption: string }) {
  const ref1x = useRef<HTMLCanvasElement | null>(null)
  const zoom = Math.max(1, Math.floor(96 / size))
  const refZoom = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    drawSpritePreview(ref1x.current, rgba, size)
    drawSpritePreview(refZoom.current, rgba, size)
  }, [rgba, size])
  return (
    <figure className="shrink-0 text-center">
      <div className="flex items-end gap-1.5">
        <canvas
          ref={ref1x}
          className="rounded border border-zinc-800"
          style={{ imageRendering: 'pixelated', width: size, height: size }}
          aria-label={`${caption} at actual pixel size`}
        />
        <canvas
          ref={refZoom}
          className="rounded border border-zinc-700"
          style={{ imageRendering: 'pixelated', width: size * zoom, height: size * zoom }}
          aria-label={`${caption} at ${zoom}× zoom`}
        />
      </div>
      <figcaption className="mt-0.5 text-[10px] text-zinc-500">
        {caption} · 1× · {zoom}×
      </figcaption>
    </figure>
  )
}

export function ReferenceCreator() {
  const project = useEditor((s) => s.project)
  const docVersion = useEditor((s) => s.docVersion)
  const setStyleProfile = useEditor((s) => s.setStyleProfile)
  const importCandidateAsLayer = useEditor((s) => s.importCandidateAsLayer)
  const referenceDraft = useEditor((s) => s.referenceDraft)
  const { toast } = useToast()

  const profile: StyleProfile = project.settings.styleProfile ?? defaultStyleProfile()
  const resolvedRef = useResolvedReference(profile, project)

  const [brief, setBrief] = useState('')
  const [provider, setProvider] = useState<'import' | 'gemini'>('import')
  const [candidates, setCandidates] = useState<ReferenceCandidate[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [keyStatus, setKeyStatus] = useState<{ desktop: boolean; hasKey: boolean }>({ desktop: false, hasKey: false })
  const [keyInput, setKeyInput] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [importedName, setImportedName] = useState<string | null>(null)
  const disclosedRef = useRef(false)

  const briefRef = useRef<HTMLTextAreaElement | null>(null)
  const candidateFileRef = useRef<HTMLInputElement | null>(null)
  const referenceFileRef = useRef<HTMLInputElement | null>(null)

  // provider key state (vault booleans only — the key itself never returns)
  useEffect(() => {
    void referenceProviderKeyStatus().then(setKeyStatus)
  }, [])

  // Adopt a brief handed over from the Brain panel (Open in Reference), once
  // per draft — render-time adjustment on LOCAL state only (no store writes
  // during render: React 19 warns about cross-component updates mid-render)
  const [adoptedRefDraft, setAdoptedRefDraft] = useState<string | null>(null)
  if (referenceDraft && adoptedRefDraft !== referenceDraft) {
    setAdoptedRefDraft(referenceDraft)
    setBrief(referenceDraft)
  }

  // one-time guidance when a handed-over brief arrives without a reference
  const guidedNoRefRef = useRef(false)
  useEffect(() => {
    if (adoptedRefDraft && !profile.references[0] && !guidedNoRefRef.current) {
      guidedNoRefRef.current = true
      toast({
        title: 'No approved reference yet',
        description: 'Import a 16×16/32×32 PNG or pick a clip frame in section 2 — the brief stays prefilled.',
      })
    }
  }, [adoptedRefDraft, profile.references])

  // target size: this release supports 16×16 and 32×32 square canvases
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

  // --- candidate generation ---------------------------------------------------
  const pushCandidate = (candidate: ReferenceCandidate) => {
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
      pushCandidate(candidate)
      toast({ title: 'Candidate ready', description: 'Cleaned, palette-mapped, and checked — review it below.' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const runGeminiCandidate = async () => {
    if (!targetSize) return
    if (!resolvedRef) {
      toast({ title: 'No reference yet', description: 'Import or pick an approved reference sprite first.', variant: 'destructive' })
      return
    }
    // disclosure before the first online send of this session
    if (!disclosedRef.current) {
      const ok = await confirmDialog({
        title: `Send to ${REFERENCE_PROVIDER_LABEL}?`,
        message: `Your brief and the approved reference image will be sent to Google Gemini (${REFERENCE_PROVIDER_DOCS}) over the internet. The API key stays in the desktop vault. Continue?`,
        confirmLabel: 'Send to Gemini',
      })
      if (!ok) return
      disclosedRef.current = true
    }
    setBusy(true)
    setError(null)
    try {
      const prompt = buildReferencePrompt(brief, profile, targetSize)
      const gen = await generateReferenceCandidate({ prompt, referencePng: resolvedRef.png })
      const candidate = await buildReferenceCandidate({
        brief: brief.trim() || 'reference asset',
        providerId: 'gemini',
        model: gen.model,
        providerPng: gen.png,
        reference: { buffer: resolvedRef.buffer, width: resolvedRef.width, height: resolvedRef.height },
        palette: [...project.palette],
        profile,
        targetSize,
      })
      pushCandidate(candidate)
      toast({ title: 'Candidate ready', description: 'Generated, cleaned, and checked — review it below.' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const generate = () => {
    if (provider === 'gemini') void runGeminiCandidate()
    else candidateFileRef.current?.click()
  }

  // --- commit -----------------------------------------------------------------
  const selected = candidates[selectedIdx] ?? null

  const addToCanvas = () => {
    if (!selected) return
    const name = slugify(selected.brief || 'reference-asset')
    const result = importCandidateAsLayer(selected.cleaned.buffer, name)
    if (result) {
      toast({ title: 'Added to canvas', description: `"${name}" is a new editable layer in the current clip (one undo step).` })
    }
  }

  const createAnother = () => {
    setBrief('')
    setSelectedIdx(0)
    briefRef.current?.focus()
    toast({ title: 'Same style, new brief', description: 'The reference and project rules stay applied — type the next brief.' })
  }

  // --- key management ----------------------------------------------------------
  const saveKey = async () => {
    if (!keyInput.trim() || keyBusy) return
    setKeyBusy(true)
    const res = await storeReferenceProviderKey(keyInput.trim())
    setKeyBusy(false)
    setKeyInput('')
    if (res.ok) {
      const st = await referenceProviderKeyStatus()
      setKeyStatus(st)
      toast({ title: 'API key stored', description: res.sessionOnly ? 'Held for this session only (keyring unavailable).' : 'Encrypted in the desktop credential vault.' })
    } else {
      toast({ title: 'Could not store the key', description: res.error, variant: 'destructive' })
    }
  }

  const removeKey = async () => {
    await removeReferenceProviderKey()
    const st = await referenceProviderKeyStatus()
    setKeyStatus(st)
    toast({ title: 'API key removed' })
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
    toast({ title: `New ${size}×${size} project`, description: 'Reference and style stay applied — import your reference again.' })
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
            This release supports 16×16 and 32×32 canvases — this project is {project.width}×{project.height}. Start a
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
            <SpritePair rgba={resolvedRef.buffer} size={resolvedRef.width} caption="reference" />
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
              Import the approved sprite (16×16 or 32×32 PNG) or pick a frame from the project — it is saved with the
              project style and anchors every candidate.
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

      {/* ---------------------------- brief & generate ---------------------------- */}
      <section aria-label="Brief and generate" className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-3">
        <header className="mb-2.5 flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-500/15 text-[10px] font-semibold text-teal-300">3</span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Brief &amp; generate</span>
        </header>
        <textarea
          ref={briefRef}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder='Describe the asset — e.g. "a brass key"'
          aria-label="Asset brief"
          className="min-h-[56px] w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600"
          spellCheck={false}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 gap-1 rounded-lg bg-zinc-800/60 p-0.5" role="radiogroup" aria-label="Candidate source">
            <button
              type="button"
              role="radio"
              aria-checked={provider === 'import'}
              onClick={() => setProvider('import')}
              className={`min-w-0 flex-1 truncate rounded-md px-2 py-1 text-[11px] font-medium ${provider === 'import' ? 'bg-teal-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              title="Import PNG · offline"
            >
              Import PNG · offline
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={provider === 'gemini'}
              onClick={() => setProvider('gemini')}
              className={`min-w-0 flex-1 truncate rounded-md px-2 py-1 text-[11px] font-medium ${provider === 'gemini' ? 'bg-teal-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              title="Gemini · online"
            >
              Gemini · online
            </button>
          </div>
          <Button
            className="h-8 flex-1 min-w-0 gap-1.5 whitespace-normal rounded-md bg-teal-600 text-xs font-medium text-white hover:bg-teal-500"
            onClick={generate}
            disabled={busy || !targetSize || (provider === 'gemini' && !keyStatus.hasKey)}
            aria-label="Generate candidate"
          >
            <Wand2 className="h-3.5 w-3.5 shrink-0" /> {busy ? 'Working…' : 'Generate candidate'}
          </Button>
        </div>
        {provider === 'import' && (
          <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">
            Fully offline: pick any PNG, PixelForge cleans and palette-maps it locally.
          </p>
        )}
        {provider === 'gemini' && (
          <div className="mt-2 space-y-1.5 rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2.5">
            <p className="text-[10px] leading-snug text-zinc-500">
              Sends your brief + reference image to Google Gemini over the internet (disclosed before the first send).
              The key lives in the desktop credential vault — it is used inside the app and never displayed.
            </p>
            {keyStatus.desktop ? (
              keyStatus.hasKey ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-emerald-300">API key stored (vault)</span>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-zinc-400" onClick={() => void removeKey()}>
                    Remove
                  </Button>
                </div>
              ) : (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="Paste Gemini API key…"
                    aria-label="Gemini API key"
                    className="h-7 min-w-0 flex-1 border-zinc-800 bg-zinc-900 font-mono text-[11px]"
                  />
                  <Button size="sm" className="h-7 px-2 text-[10px]" onClick={() => void saveKey()} disabled={!keyInput.trim() || keyBusy}>
                    Save to vault
                  </Button>
                </div>
              )
            ) : (
              <p className="text-[10px] text-amber-300/90">Online generation needs the desktop app (credential vault).</p>
            )}
          </div>
        )}
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
        {importedName && provider === 'import' && (
          <p className="mt-1.5 truncate text-[10px] text-zinc-500">Last imported: {importedName}</p>
        )}
      </section>

      {/* ---------------------------- candidates ---------------------------- */}
      {candidates.length > 0 && (
        <section aria-label="Candidates" className="rounded-xl border border-teal-800/50 bg-teal-950/10 p-3">
          <header className="mb-2.5 flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-500/15 text-[10px] font-semibold text-teal-300">4</span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Candidates</span>
            </span>
            <span className="font-mono text-[10px] text-zinc-500">
              {candidates.length} kept · {selected.providerId}
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
                {c.brief || c.providerId} · {c.cleaned.width}×{c.cleaned.height}
              </button>
            ))}
          </div>
          {selected && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-start gap-3 rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2.5">
                {resolvedRef && <SpritePair rgba={resolvedRef.buffer} size={resolvedRef.width} caption="reference" />}
                <SpritePair rgba={selected.original.buffer} size={selected.original.width} caption="original" />
                <SpritePair rgba={selected.cleaned.buffer} size={selected.cleaned.width} caption="cleaned" />
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
                  <ImagePlus className="h-3.5 w-3.5 shrink-0" /> Add &ldquo;{(selected.brief || 'candidate').slice(0, 24)}&rdquo; to Canvas
                </Button>
                <Button
                  variant="outline"
                  className="h-8 min-w-0 flex-1 whitespace-normal gap-1.5 rounded-md border-zinc-700 text-xs"
                  onClick={createAnother}
                  aria-label="Create another in this style"
                >
                  <Wand2 className="h-3.5 w-3.5 shrink-0" /> Create Another in This Style
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
