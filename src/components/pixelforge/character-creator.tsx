// PixelForge AI — Create Character panel (bundled character kit, fully local).
//
// Deterministic part workflow — no model call, no MCP agent, no network:
//   Pick a preset (or mix parts) → live preview (1× + 4×) → Style Lock review
//   (palette policy / outline / lighting / approved reference + technical
//   checks) → Add to Canvas (one undoable transaction: clip + 4 editable
//   layers + pre-tagged motion parts for Idle/Walk).
//
// The preview is ALWAYS derived from the live project (palette + canvas) via
// the same pure kit compose the insertion uses — what you preview is exactly
// what lands on the canvas; a palette/project change re-renders it before any
// commit. Style Lock edits persist through the existing project settings path
// (settings.setStyleProfile — one undoable step each).

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CHARACTER_KIT_VERSION,
  KIT_CANVAS,
  KIT_DEFAULT_SELECTION,
  KIT_HEADS,
  KIT_ITEMS,
  KIT_OUTFITS,
  KIT_PRESETS,
  cloneStyleProfile,
  composeFrameRgba,
  composeKitPreviewRgba,
  defaultStyleProfile,
  kitSelectionFromPreset,
  kitSelectionLabel,
  validateStyleCandidate,
  STYLE_LIGHTING,
  STYLE_OUTLINES,
  STYLE_PALETTE_MODES,
  type KitPartDef,
  type KitSelection,
  type StyleCheck,
  type StyleLighting,
  type StyleOutline,
  type StylePaletteMode,
  type StyleProfile,
} from '@pixelforge/core'
import { useEditor } from '@/lib/pixelforge/store'
import { createProject } from '@/lib/pixelforge/factory'
import { drawSpritePreview } from './sprite-preview'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { confirmDialog } from '@/components/ui/confirm-dialog'
import { CheckCircle2, Info, PersonStanding, TriangleAlert, UserPlus, Wand2 } from 'lucide-react'

const ZOOM = 4
const COMPARE_ZOOM = 3

function drawPreview(canvas: HTMLCanvasElement | null, rgba: Uint8ClampedArray | null, size: number): void {
  drawSpritePreview(canvas, rgba, size)
}

function PartThumb({ slot, part, label }: { slot: 'headId' | 'outfitId' | 'itemId'; part: KitPartDef; label: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const palette = useEditor((s) => s.project.palette)
  useEffect(() => {
    // thumb: the full default character with this part swapped into its slot
    drawPreview(
      ref.current,
      composeKitPreviewRgba({ ...KIT_DEFAULT_SELECTION, [slot]: part.id }, palette),
      KIT_CANVAS,
    )
  }, [slot, part.id, palette])
  return (
    <canvas
      ref={ref}
      aria-label={label}
      className="h-8 w-8 shrink-0"
      style={{ imageRendering: 'pixelated' }}
    />
  )
}

function PartRow({
  slot,
  title,
  parts,
  selectedId,
  onPick,
}: {
  slot: 'headId' | 'outfitId' | 'itemId'
  title: string
  parts: readonly KitPartDef[]
  selectedId: string
  onPick: (id: string) => void
}) {
  return (
    <div>
      <Label className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">{title}</Label>
      <div className="mt-1 grid grid-cols-3 gap-1">
        {parts.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={selectedId === p.id}
            onClick={() => onPick(p.id)}
            title={p.label}
            className={`flex min-w-0 flex-col items-center gap-0.5 rounded-lg border p-1 transition-all ${
              selectedId === p.id
                ? 'border-teal-500/60 bg-teal-950/30'
                : 'border-zinc-800 bg-zinc-950/60 hover:border-zinc-700'
            }`}
          >
            <PartThumb slot={slot} part={p} label={p.label} />
            <span className="w-full truncate text-center text-[10px] leading-tight text-zinc-300">{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
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

export function CharacterCreator() {
  const project = useEditor((s) => s.project)
  const docVersion = useEditor((s) => s.docVersion)
  const creatorDraft = useEditor((s) => s.creatorDraft)
  const addCharacterToCanvas = useEditor((s) => s.addCharacterToCanvas)
  const setStyleProfile = useEditor((s) => s.setStyleProfile)
  const requestRightTab = useEditor((s) => s.requestRightTab)
  const { toast } = useToast()

  const [selection, setSelection] = useState<KitSelection>({ ...KIT_DEFAULT_SELECTION })
  const profile: StyleProfile = project.settings.styleProfile ?? defaultStyleProfile()
  const previewRgba = useMemo(
    () => composeKitPreviewRgba(selection, project.palette),
    // selection + palette fully determine the pixels (kit version constant)
    [selection, project.palette, docVersion],
  )

  // Adopt a draft handed over from another surface (Second Brain), once per
  // draft object. Render-time adjustment touches ONLY this component's state —
  // clearing the store draft here would re-render CanvasStage mid-render
  // (React 19 "cannot update a component while rendering" warning). The stale
  // store draft is harmless: every new hand-off writes a fresh object.
  const [adoptedDraft, setAdoptedDraft] = useState<KitSelection | null>(null)
  if (creatorDraft && adoptedDraft !== creatorDraft) {
    setAdoptedDraft(creatorDraft)
    setSelection(creatorDraft)
  }

  // --- previews: actual pixel size (1×) + integer zoom (4×) -----------------
  const preview1xRef = useRef<HTMLCanvasElement | null>(null)
  const previewZoomRef = useRef<HTMLCanvasElement | null>(null)
  const referenceRef = useRef<HTMLCanvasElement | null>(null)
  // palette the visible preview was last painted with (captured in the effect)
  const previewedPaletteRef = useRef('')
  useEffect(() => {
    drawPreview(preview1xRef.current, previewRgba, KIT_CANVAS)
    drawPreview(previewZoomRef.current, previewRgba, KIT_CANVAS)
    previewedPaletteRef.current = project.palette.join(',')
  }, [previewRgba, project.palette])

  // --- technical checks (same validator as the AI pipeline) -----------------
  const checks = useMemo(
    () =>
      validateStyleCandidate({
        buffer: previewRgba,
        width: KIT_CANVAS,
        height: KIT_CANVAS,
        targetWidth: project.width,
        targetHeight: project.height,
        palette: project.palette,
        profile,
      }),
    [previewRgba, project.width, project.height, project.palette, profile],
  )

  // --- approved reference (Style Lock references[0]) ------------------------
  const reference = profile.references[0] ?? null
  const referenceClip = reference ? project.clips.find((c) => c.id === reference.clipId) : undefined
  const referenceFrame = referenceClip?.frames.find((f) => f.id === reference.frameId) ?? referenceClip?.frames[0]
  const referenceRgba = useMemo(() => {
    if (!referenceClip || !referenceFrame) return null
    try {
      return composeFrameRgba(project, referenceClip, referenceFrame)
    } catch {
      return null
    }
  }, [project, referenceClip, referenceFrame])
  useEffect(() => {
    if (!referenceRef.current) return
    if (referenceRgba) {
      referenceRef.current.width = project.width
      referenceRef.current.height = project.height
      referenceRef.current.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(referenceRgba), project.width, project.height), 0, 0)
    } else {
      drawPreview(referenceRef.current, null, KIT_CANVAS)
    }
  }, [referenceRgba, project.width, project.height])

  const setReference = (clipId: string) => {
    const clip = project.clips.find((c) => c.id === clipId)
    const frame = clip?.frames[0]
    if (!clip || !frame) return
    setStyleProfile({ ...cloneStyleProfile(profile), references: [{ clipId, frameId: frame.id, label: clip.name }] })
    toast({ title: 'Reference set', description: `"${clip.name}" frame 1 is now the approved style reference.` })
  }
  const clearReference = () => {
    setStyleProfile({ ...cloneStyleProfile(profile), references: [] })
  }

  const patchProfile = (patch: Partial<StyleProfile>) => {
    setStyleProfile({ ...cloneStyleProfile(profile), ...patch })
  }

  // --- commit ----------------------------------------------------------------
  const kitFitsProject = project.width === KIT_CANVAS && project.height === KIT_CANVAS
  const label = kitSelectionLabel(selection)

  const add = () => {
    if (!kitFitsProject) return
    // capture/refresh semantics: the preview is derived live, so if the
    // palette changed since the last painted frame, repaint before committing
    if (previewedPaletteRef.current !== project.palette.join(',')) {
      drawPreview(preview1xRef.current, previewRgba, KIT_CANVAS)
      drawPreview(previewZoomRef.current, previewRgba, KIT_CANVAS)
      toast({ title: 'Preview refreshed', description: 'The project palette changed — preview repainted before adding.' })
    }
    addCharacterToCanvas(selection)
  }

  const newCharacterProjectAndAdd = async () => {
    if (
      useEditor.getState().dirty &&
      !(await confirmDialog({
        title: 'Discard unsaved changes?',
        message: 'Starting a 32×32 character project will lose your unsaved changes.',
        confirmLabel: 'Discard & Create',
        destructive: true,
      }))
    )
      return
    useEditor.getState().newProject(
      createProject({
        name: `${label} project`,
        width: KIT_CANVAS,
        height: KIT_CANVAS,
        palette: [...project.palette],
      }),
    )
    toast({ title: 'New 32×32 character project', description: `Palette kept (${project.palette.length} colors). Adding the character…` })
    // the store now holds the fresh 32×32 document — insert against it
    useEditor.getState().addCharacterToCanvas(selection)
  }

  return (
    <div className="pixelforge-scroll mx-auto h-full min-h-0 w-full max-w-[520px] space-y-3 overflow-y-auto p-3" data-testid="character-creator">
      {/* ---------------------------- presets ---------------------------- */}
      <section aria-label="Character presets" className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-3">
        <header className="mb-2.5 flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-500/15 text-[10px] font-semibold text-teal-300">1</span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Ready-made characters</span>
          <span className="ml-auto rounded-full bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">{CHARACTER_KIT_VERSION}</span>
        </header>
        <div className="grid grid-cols-3 gap-1">
          {KIT_PRESETS.map((p) => {
            const active = selection.headId === p.headId && selection.outfitId === p.outfitId && selection.itemId === p.itemId
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  const sel = kitSelectionFromPreset(p.id)
                  if (sel) setSelection(sel)
                }}
                className={`rounded-lg border px-1 py-2 text-[11px] font-medium transition-all ${
                  active ? 'border-teal-500/60 bg-teal-950/30 text-teal-200' : 'border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:border-zinc-700'
                }`}
              >
                {p.label}
              </button>
            )
          })}
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-zinc-500">
          32×32 side-view kit · shared body proportions · one foot baseline · mix any head, outfit, and item.
        </p>
      </section>

      {/* ---------------------------- parts ---------------------------- */}
      <section aria-label="Parts" className="space-y-2.5 rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-3">
        <header className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-500/15 text-[10px] font-semibold text-teal-300">2</span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Parts</span>
        </header>
        <PartRow slot="headId" title="Head" parts={KIT_HEADS} selectedId={selection.headId} onPick={(id) => setSelection((s) => ({ ...s, headId: id }))} />
        <PartRow slot="outfitId" title="Outfit" parts={KIT_OUTFITS} selectedId={selection.outfitId} onPick={(id) => setSelection((s) => ({ ...s, outfitId: id }))} />
        <PartRow slot="itemId" title="Held item" parts={KIT_ITEMS} selectedId={selection.itemId} onPick={(id) => setSelection((s) => ({ ...s, itemId: id }))} />
      </section>

      {/* ---------------------------- preview + checks ---------------------------- */}
      <section aria-label="Preview" className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-3">
        <header className="mb-2.5 flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-500/15 text-[10px] font-semibold text-teal-300">3</span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Preview</span>
          <span className="ml-auto font-mono text-[10px] text-zinc-500">1× · {ZOOM}× · transparent</span>
        </header>
        <div className="flex items-start gap-3">
          <figure className="shrink-0 text-center">
            <canvas
              ref={preview1xRef}
              className="rounded-md border border-zinc-800"
              style={{ imageRendering: 'pixelated', width: KIT_CANVAS, height: KIT_CANVAS }}
              aria-label="Character preview at actual pixel size"
            />
            <figcaption className="mt-1 text-[10px] text-zinc-500">1× (32 px)</figcaption>
          </figure>
          <figure className="shrink-0 text-center">
            <canvas
              ref={previewZoomRef}
              className="rounded-md border border-zinc-700"
              style={{ imageRendering: 'pixelated', width: KIT_CANVAS * ZOOM, height: KIT_CANVAS * ZOOM }}
              aria-label="Character preview at 4× zoom"
            />
            <figcaption className="mt-1 text-[10px] text-zinc-500">{ZOOM}× zoom</figcaption>
          </figure>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] leading-snug text-zinc-500">
              Inserted as clip <span className="font-medium text-zinc-300">&ldquo;{label}&rdquo;</span> with editable
              Body / Outfit / Head / Item layers. Parts come pre-tagged — Idle &amp; Walk animate in the Motion panel.
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="mt-1.5 h-6 gap-1 px-1.5 text-[10px] text-frost-300"
              onClick={() => requestRightTab('motion')}
            >
              <PersonStanding className="h-3 w-3" /> Open Motion
            </Button>
          </div>
        </div>
        <ul className="mt-2.5 space-y-1" aria-label="Technical style checks">
          {checks.map((c) => (
            <CheckRow key={c.id} check={c} />
          ))}
        </ul>
      </section>

      {/* ---------------------------- style lock ---------------------------- */}
      <section aria-label="Style Lock" className="rounded-xl border border-zinc-800/80 bg-zinc-900/60 p-3">
        <header className="mb-2.5 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-500/15 text-[10px] font-semibold text-teal-300">4</span>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">Style Lock</span>
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
            <Label className="text-[11px] font-medium text-zinc-400">Palette policy</Label>
            <Select
              value={profile.paletteMode}
              onValueChange={(v) => patchProfile({ paletteMode: v as StylePaletteMode })}
            >
              <SelectTrigger className="h-7 w-full text-xs" aria-label="Palette policy"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STYLE_PALETTE_MODES.map((m) => (
                  <SelectItem key={m} value={m} className="text-xs">
                    {m === 'enforce' ? 'enforce (kit snaps to palette)' : m === 'prefer' ? 'prefer' : 'none'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0">
            <Label className="text-[11px] font-medium text-zinc-400">Outline</Label>
            <Select value={profile.outline} onValueChange={(v) => patchProfile({ outline: v as StyleOutline })}>
              <SelectTrigger className="h-7 w-full text-xs" aria-label="Outline"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STYLE_OUTLINES.map((o) => (
                  <SelectItem key={o} value={o} className="text-xs">{o}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0">
            <Label className="text-[11px] font-medium text-zinc-400">Lighting</Label>
            <Select value={profile.lighting} onValueChange={(v) => patchProfile({ lighting: v as StyleLighting })}>
              <SelectTrigger className="h-7 w-full text-xs" aria-label="Lighting"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STYLE_LIGHTING.map((l) => (
                  <SelectItem key={l} value={l} className="text-xs">{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0">
            <Label className="text-[11px] font-medium text-zinc-400">Reference clip</Label>
            <Select value={reference?.clipId ?? ''} onValueChange={setReference}>
              <SelectTrigger className="h-7 w-full text-xs" aria-label="Approved reference clip">
                <SelectValue placeholder="pick a clip…" />
              </SelectTrigger>
              <SelectContent className="max-h-48">
                {project.clips.map((c) => (
                  <SelectItem key={c.id} value={c.id} className="text-xs">{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
            <Switch
              checked={profile.transparentBackground}
              onCheckedChange={(v) => patchProfile({ transparentBackground: v })}
              aria-label="Transparent background required"
              className="scale-90"
            />
            Transparent background
          </label>
          {reference && (
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px] text-zinc-400" onClick={clearReference}>
              Clear reference
            </Button>
          )}
        </div>

        {/* artist review: new character vs approved reference at the SAME scale */}
        <div className="mt-2.5 flex flex-wrap items-start gap-3 rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2.5">
          <figure className="shrink-0 text-center">
            <CompareCanvas rgba={previewRgba} size={KIT_CANVAS} zoom={COMPARE_ZOOM} label="New character reference view" />
            <figcaption className="mt-1 text-[10px] font-medium text-teal-300/90">new character</figcaption>
          </figure>
          <figure className="shrink-0 text-center">
            <canvas
              ref={referenceRef}
              className="max-w-full rounded-md border border-zinc-800 bg-zinc-950"
              style={{
                imageRendering: 'pixelated',
                width: Math.max(KIT_CANVAS, project.width) * COMPARE_ZOOM,
                height: Math.max(KIT_CANVAS, project.height) * COMPARE_ZOOM,
              }}
              aria-label="Approved reference sprite"
            />
            <figcaption className="mt-1 text-[10px] text-zinc-500">{reference ? reference.label : 'no reference set'}</figcaption>
          </figure>
          <p className="w-full self-center text-[11px] leading-snug text-zinc-500">
            Same-scale review of silhouette, proportions, outline, and lighting. The checks above are technical;
            this side-by-side is the artist call.
          </p>
        </div>
      </section>

      {/* ---------------------------- add ---------------------------- */}
      <section aria-label="Add to canvas" className="rounded-xl border border-teal-800/50 bg-teal-950/10 p-3">
        {kitFitsProject ? (
          <Button
            className="h-9 w-full gap-1.5 whitespace-normal rounded-md bg-teal-600 text-xs font-medium text-white hover:bg-teal-500"
            onClick={add}
            aria-label="Add character to canvas"
          >
            <UserPlus className="h-4 w-4 shrink-0" /> Add &ldquo;{label}&rdquo; to Canvas
          </Button>
        ) : (
          <>
            <p className="mb-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-300">
              This project is {project.width}×{project.height}. The character kit needs a 32×32 canvas — start a
              fresh character project (unsaved changes are confirmed first; your palette is kept).
            </p>
            <Button
              className="h-9 w-full gap-1.5 rounded-md bg-teal-600 text-xs font-medium text-white hover:bg-teal-500"
              onClick={() => void newCharacterProjectAndAdd()}
            >
              <Wand2 className="h-4 w-4" /> New 32×32 project &amp; add
            </Button>
          </>
        )}
        <p className="mt-1.5 text-center text-[10px] leading-snug text-zinc-500">
          One undoable step · fails safe (document untouched on error)
        </p>
      </section>
    </div>
  )
}

/** Small same-scale canvas for the artist review row (checker + pixels). */
function CompareCanvas({ rgba, size, zoom, label }: { rgba: Uint8ClampedArray; size: number; zoom: number; label: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    drawPreview(ref.current, rgba, size)
  }, [rgba, size])
  return (
    <canvas
      ref={ref}
      aria-label={label}
      className="rounded-md border border-zinc-800 bg-zinc-950"
      style={{ imageRendering: 'pixelated', width: size * zoom, height: size * zoom }}
    />
  )
}
