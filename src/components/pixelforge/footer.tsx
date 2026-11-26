// PixelForge AI — status footer (sticky bottom via parent flex layout)

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Rocket } from 'lucide-react'

import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/hooks/use-toast'
import { desktopConfirm, getBridge, isDesktop, notifyInBackground } from '@/lib/pixelforge/desktop-bridge'
import { useEditor, getActiveClip } from '@/lib/pixelforge/store'
import type { ToolId } from '@/lib/pixelforge/types'

// Browser fallback. Electron replaces this with app.getVersion(), so the
// installed app always identifies its actual packaged version.
const RELEASE_VERSION = '0.7.2'

interface UpdateState {
  state: 'no-feed' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  info?: string
  version?: string
  progress?: number
}

const TOOL_LABEL: Record<ToolId, string> = {
  pencil: 'pencil',
  eraser: 'eraser',
  shade: 'shade',
  fill: 'fill',
  gradient: 'gradient',
  line: 'line',
  rect: 'rect',
  ellipse: 'ellipse',
  vector: 'vector',
  marquee: 'select',
  wand: 'wand',
  eyedropper: 'eyedropper',
  move: 'move',
}

export function Footer() {
  const project = useEditor((s) => s.project)
  const activeClipId = useEditor((s) => s.activeClipId)
  const activeFrameIndex = useEditor((s) => s.activeFrameIndex)
  const zoom = useEditor((s) => s.zoom)
  const hover = useEditor((s) => s.hover)
  const tool = useEditor((s) => s.tool)
  const dirty = useEditor((s) => s.dirty)
  const savedAt = useEditor((s) => s.savedAt)
  const { toast } = useToast()
  const [appVersion, setAppVersion] = useState(RELEASE_VERSION)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const notifiedRef = useRef<{ available?: string; downloaded?: string }>({})

  const installUpdate = useCallback(async () => {
    const bridge = getBridge()
    if (!bridge) return
    if (useEditor.getState().dirty) {
      const ok = await desktopConfirm(
        'Restart PixelForge AI to install update?',
        'You have unsaved changes. Cancel to save first, or restart now.',
      )
      if (!ok) return
    }
    void bridge.updates.install()
  }, [])

  useEffect(() => {
    if (!isDesktop()) return
    const bridge = getBridge()
    if (!bridge) return
    let alive = true

    void window.pixelforge?.app.getInfo()
      .then((info) => {
        if (alive) setAppVersion(info.version)
      })
      .catch(() => undefined)

    const handleUpdate = (s: UpdateState) => {
      if (!alive) return
      setUpdate(s)
      const tag = s.version ?? 'latest'
      if (s.state === 'available' && notifiedRef.current.available !== tag) {
        notifiedRef.current.available = tag
        toast({
          title: `Update available${s.version ? ` (v${s.version})` : ''}`,
          description: 'Downloading in the background…',
        })
      } else if (s.state === 'downloaded' && notifiedRef.current.downloaded !== tag) {
        notifiedRef.current.downloaded = tag
        const label = s.version ? `v${s.version}` : 'New update'
        notifyInBackground('PixelForge AI update ready', `${label} is ready — restart to install.`)
        toast({
          title: `Update ready (${label})`,
          description: 'Restart PixelForge AI to install the latest version.',
          duration: 15_000,
          action: (
            <ToastAction altText="Restart to update" onClick={() => void installUpdate()}>
              Restart
            </ToastAction>
          ),
        })
      }
    }

    void bridge.updates.status().then(handleUpdate).catch(() => undefined)
    const off = bridge.updates.onStatus(handleUpdate)
    return () => {
      alive = false
      off()
    }
  }, [installUpdate, toast])
  // reactive activeClipId read — a plain getState() here missed clip switches
  // (footer kept showing the previous clip until an unrelated re-render)
  const clip = getActiveClip({ project, activeClipId })
  const frameIndex = Math.min(activeFrameIndex, clip.frames.length - 1)

  return (
    <footer className="mt-auto flex h-7 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-zinc-800/80 bg-zinc-950/70 px-3 font-mono text-[10px] text-zinc-400 backdrop-blur-xl">
      <span className="shrink-0 text-teal-400/90">PixelForge AI</span>
      <span aria-hidden className="shrink-0 text-zinc-700">|</span>
      <span className="shrink-0">
        {project.width}×{project.height}
      </span>
      <span aria-hidden className="hidden shrink-0 text-zinc-700 sm:inline">|</span>
      <span className="hidden shrink-0 sm:inline">{Math.round(zoom * 100)}%</span>
      <span aria-hidden className="hidden shrink-0 text-zinc-700 md:inline">|</span>
      <span className="hidden shrink-0 md:inline">{hover ? `x:${hover.x} y:${hover.y}` : '—'}</span>
      <span aria-hidden className="hidden shrink-0 text-zinc-700 md:inline">|</span>
      <span className="hidden shrink-0 md:inline">tool: {TOOL_LABEL[tool]}</span>
      <span aria-hidden className="shrink-0 text-zinc-700">|</span>
      <span className="min-w-0 truncate">
        clip: {clip.name} · frame {frameIndex + 1}/{clip.frames.length} · {clip.fps}fps
      </span>
      <span aria-hidden className="shrink-0 text-zinc-700">|</span>
      <span className="ml-auto shrink-0">
        {dirty ? '● unsaved' : savedAt ? `✓ saved ${new Date(savedAt).toLocaleTimeString()}` : '· new project'}
      </span>
      {update?.state === 'downloading' && (
        <>
          <span aria-hidden className="shrink-0 text-zinc-700">|</span>
          <span className="shrink-0 text-teal-300/90">
            ↓ updating {update.progress ?? 0}%
          </span>
        </>
      )}
      {update?.state === 'downloaded' && (
        <>
          <span aria-hidden className="shrink-0 text-zinc-700">|</span>
          <button
            type="button"
            onClick={() => void installUpdate()}
            title="Restart PixelForge AI to install the downloaded update"
            className="inline-flex shrink-0 items-center gap-1 rounded border border-teal-500/40 bg-teal-500/15 px-1.5 py-0.5 text-[10px] font-medium text-teal-200 transition-colors hover:bg-teal-500/25"
          >
            <Rocket className="h-2.5 w-2.5" aria-hidden />
            {update.version ? `v${update.version} ready` : 'Update ready'} · Restart
          </button>
        </>
      )}
      <span aria-hidden className="hidden shrink-0 text-zinc-700 lg:inline">|</span>
      <span className="hidden shrink-0 lg:inline">v{appVersion} · desktop + MCP + AI</span>
    </footer>
  )
}
