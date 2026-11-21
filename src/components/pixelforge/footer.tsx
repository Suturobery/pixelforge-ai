// PixelForge AI — status footer (sticky bottom via parent flex layout)

'use client'

import { useEffect, useState } from 'react'

import { isDesktop } from '@/lib/pixelforge/desktop-bridge'
import { useEditor, getActiveClip } from '@/lib/pixelforge/store'
import type { ToolId } from '@/lib/pixelforge/types'

// Browser fallback. Electron replaces this with app.getVersion(), so the
// installed app always identifies its actual packaged version.
const RELEASE_VERSION = '0.1.27'

const TOOL_LABEL: Record<ToolId, string> = {
  pencil: 'pencil',
  eraser: 'eraser',
  fill: 'fill',
  line: 'line',
  rect: 'rect',
  ellipse: 'ellipse',
  marquee: 'select',
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
  const [appVersion, setAppVersion] = useState(RELEASE_VERSION)
  useEffect(() => {
    if (!isDesktop()) return
    let alive = true
    void window.pixelforge?.app.getInfo()
      .then((info) => {
        if (alive) setAppVersion(info.version)
      })
      .catch(() => undefined)
    return () => { alive = false }
  }, [])
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
      <span aria-hidden className="hidden shrink-0 text-zinc-700 lg:inline">|</span>
      <span className="hidden shrink-0 lg:inline">v{appVersion} · desktop + MCP + AI</span>
    </footer>
  )
}
