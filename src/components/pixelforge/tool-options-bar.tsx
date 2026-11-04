// PixelForge AI — contextual tool options bar (Task 5a).
// Floats at the top of the edit stage; shows options for the active tool:
//   • Ellipse → filled toggle (outline = primary, fill = secondary)
//   • Marquee → selection ops (copy/cut/paste/delete/flip/rotate/deselect)
//     + free scale (drag the 8 canvas handles, or type a target W×H)
//     + whole-cel transforms. Buttons disable when inapplicable.

'use client'

import { useState } from 'react'
import { useEditor } from '@/lib/pixelforge/store'
import type { TransformKind } from '@/lib/pixelforge/types'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { StepperInput } from '@/components/pixelforge/stepper-input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Copy,
  ClipboardPaste,
  Scissors,
  Trash2,
  FlipHorizontal,
  FlipVertical,
  RotateCw,
  RotateCcw,
  X,
  Brush,
} from 'lucide-react'

function OptButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-zinc-300 hover:text-zinc-100 disabled:opacity-40"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function transformButtons(
  scope: 'sel' | 'cel'
): Array<{ kind: TransformKind; icon: React.ReactNode; label: string }> {
  const p = scope === 'sel' ? 'Selection' : 'Cel'
  return [
    { kind: 'flipH', icon: <FlipHorizontal className="h-3.5 w-3.5" />, label: `Flip ${p} H` },
    { kind: 'flipV', icon: <FlipVertical className="h-3.5 w-3.5" />, label: `Flip ${p} V` },
    { kind: 'rotateCW', icon: <RotateCw className="h-3.5 w-3.5" />, label: `Rotate ${p} 90° CW` },
    { kind: 'rotateCCW', icon: <RotateCcw className="h-3.5 w-3.5" />, label: `Rotate ${p} 90° CCW` },
  ]
}

/** Nearest-neighbor scale buttons — crisp ×2/×3 upscale + ÷2 downsample. */
function ScaleButtons({ scope }: { scope: 'sel' | 'cel' }) {
  const p = scope === 'sel' ? 'selection' : 'cel'
  const run = (f: number) =>
    scope === 'sel' ? useEditor.getState().selectionScale(f) : useEditor.getState().celScale(f)
  return (
    <>
      {[2, 3, 0.5].map((f) => (
        <OptButton
          key={f}
          icon={
            <span className="font-mono text-[10px] font-bold leading-none">
              {f === 0.5 ? '÷2' : `×${f}`}
            </span>
          }
          label={`Scale ${p} ${f === 0.5 ? '÷2' : `×${f}`} (nearest-neighbor)`}
          onClick={() => run(f)}
        />
      ))}
    </>
  )
}

export function ToolOptionsBar() {
  const tool = useEditor((s) => s.tool)
  const ellipseFilled = useEditor((s) => s.ellipseFilled)
  const setEllipseFilled = useEditor((s) => s.setEllipseFilled)
  const selection = useEditor((s) => s.selection)
  const clipboard = useEditor((s) => s.clipboard)
  const playing = useEditor((s) => s.playing)
  const project = useEditor((s) => s.project)

  // free-scale target size — render-time derived from the live selection;
  // sizeEd overrides while the user is typing a custom target (reset by the
  // selKey mismatch as soon as the selection moves/resizes)
  const [sizeEd, setSizeEd] = useState<{ w: number; h: number; key: string } | null>(null)
  const selKey = selection
    ? `${selection.x},${selection.y},${selection.w},${selection.h}`
    : ''
  const scaleW = sizeEd && sizeEd.key === selKey ? sizeEd.w : selection?.w ?? 1
  const scaleH = sizeEd && sizeEd.key === selKey ? sizeEd.h : selection?.h ?? 1

  if (playing) return null
  if (tool !== 'ellipse' && tool !== 'marquee') return null

  return (
    <TooltipProvider delayDuration={250}>
      <div
        role="toolbar"
        aria-label="Tool options"
        className="absolute inset-x-2 top-3 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/90 px-2 py-1 shadow-xl backdrop-blur"
      >
        {tool === 'ellipse' && (
          <>
            <button
              type="button"
              role="switch"
              aria-checked={ellipseFilled}
              onClick={() => setEllipseFilled(!ellipseFilled)}
              className={`flex items-center gap-2 rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors ${
                ellipseFilled
                  ? 'bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/40'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <span
                className="h-3 w-3 rounded-[2px] border border-current"
                style={{ backgroundColor: ellipseFilled ? 'currentColor' : 'transparent' }}
                aria-hidden
              />
              Filled
            </button>
            <span className="hidden px-1 font-mono text-[10px] text-zinc-400 @[560px]:inline">
              outline = primary · fill = secondary · Shift inverts
            </span>
          </>
        )}

        {/* Task 10b tilemap toggle — the full controls live in the tool rail */}

        {tool === 'marquee' && (
          <>
            {!selection && (
              <span className="px-1.5 font-mono text-[10px] text-zinc-400 hidden @[560px]:inline">
                drag to select — drag inside to move
              </span>
            )}
            {selection && (
              <>
                <Popover>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          className="h-7 gap-1 px-1.5 font-mono text-[10px] font-bold text-zinc-300 hover:text-zinc-100"
                          aria-label={`Scale selection (now ${selection.w}×${selection.h})`}
                        >
                          {selection.w}×{selection.h}
                          <span aria-hidden className="text-zinc-500">⤢</span>
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="font-mono text-xs">
                      Scale selection
                    </TooltipContent>
                  </Tooltip>
                  <PopoverContent side="bottom" align="start" className="w-56 p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                        Scale to
                      </p>
                      <span className="font-mono text-[10px] text-zinc-500">
                        {selection.w}×{selection.h} → {scaleW}×{scaleH}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-1.5">
                      <StepperInput
                        value={scaleW}
                        onChange={(v) =>
                          setSizeEd({ w: Math.min(project.width, Math.max(1, v)), h: scaleH, key: selKey })
                        }
                        min={1}
                        max={project.width}
                        ariaLabel="Target selection width"
                        size="sm"
                        className="flex-1 justify-between"
                      />
                      <span className="font-mono text-[10px] text-zinc-400">×</span>
                      <StepperInput
                        value={scaleH}
                        onChange={(v) =>
                          setSizeEd({ w: scaleW, h: Math.min(project.height, Math.max(1, v)), key: selKey })
                        }
                        min={1}
                        max={project.height}
                        ariaLabel="Target selection height"
                        size="sm"
                        className="flex-1 justify-between"
                      />
                    </div>
                    <Button
                      className="mt-2 h-7 w-full bg-teal-600 font-mono text-xs text-white hover:bg-teal-500"
                      disabled={scaleW === selection.w && scaleH === selection.h}
                      onClick={() =>
                        useEditor
                          .getState()
                          .selectionScaleTo({ x: selection.x, y: selection.y, w: scaleW, h: scaleH })
                      }
                    >
                      Apply scale
                    </Button>
                  </PopoverContent>
                </Popover>
                <Separator orientation="vertical" className="mx-0.5 h-5 bg-zinc-800" />
                <OptButton
                  icon={<Copy className="h-3.5 w-3.5" />}
                  label="Copy (Ctrl+C)"
                  onClick={() => useEditor.getState().selectionCopy()}
                />
                <OptButton
                  icon={<Brush className="h-3.5 w-3.5" />}
                  label="Save selection as brush"
                  onClick={() => useEditor.getState().saveSelectionAsBrush()}
                />
                <OptButton
                  icon={<Scissors className="h-3.5 w-3.5" />}
                  label="Cut (Ctrl+X)"
                  onClick={() => useEditor.getState().selectionCut()}
                />
                <OptButton
                  icon={<ClipboardPaste className="h-3.5 w-3.5" />}
                  label="Paste (Ctrl+V)"
                  onClick={() => useEditor.getState().selectionPaste()}
                  disabled={!clipboard}
                />
                <OptButton
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  label="Delete contents (Del)"
                  onClick={() => useEditor.getState().selectionDelete()}
                />
                <OptButton
                  icon={<X className="h-3.5 w-3.5" />}
                  label="Deselect (Esc)"
                  onClick={() => useEditor.getState().deselect()}
                />
                <Separator orientation="vertical" className="mx-0.5 h-5 bg-zinc-800" />
                {transformButtons('sel').map((b) => (
                  <OptButton
                    key={b.kind}
                    icon={b.icon}
                    label={b.label}
                    onClick={() => useEditor.getState().selectionTransform(b.kind)}
                  />
                ))}
                <ScaleButtons scope="sel" />
                <Separator orientation="vertical" className="mx-0.5 h-5 bg-zinc-800" />
                <span className="px-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400">
                  cel
                </span>
                {transformButtons('cel').map((b) => (
                  <OptButton
                    key={b.kind}
                    icon={b.icon}
                    label={b.label}
                    onClick={() => useEditor.getState().celTransform(b.kind)}
                  />
                ))}
                <ScaleButtons scope="cel" />
              </>
            )}
            </>
          )}
      </div>
    </TooltipProvider>
  )
}
