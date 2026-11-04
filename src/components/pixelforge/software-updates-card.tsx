// PixelForge AI — software updates card (Settings → General, General tab).
// Desktop-only surface: reads the guarded UpdateService through the bridge.
// Web renders nothing (updates are a desktop concern).

'use client'

import { useEffect, useState } from 'react'
import { isDesktop, getBridge } from '@/lib/pixelforge/desktop-bridge'
import { Button } from '@/components/ui/button'
import { Loader2, RefreshCw, Rocket } from 'lucide-react'

interface UpdateView {
  state: 'no-feed' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  info?: string
  version?: string
  progress?: number
}

export function SoftwareUpdatesCard() {
  const [view, setView] = useState<UpdateView | null>(null)
  const [busy, setBusy] = useState(false)
  const desktop = typeof window !== 'undefined' && isDesktop()

  useEffect(() => {
    if (!desktop) return
    const bridge = getBridge()
    if (!bridge) return
    let alive = true
    void bridge.updates.status().then((s) => {
      if (alive) setView(s)
    })
    const off = bridge.updates.onStatus((s) => {
      if (alive) setView(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [desktop])

  if (!desktop) return null

  const check = async () => {
    const bridge = getBridge()
    if (!bridge) return
    setBusy(true)
    try {
      setView(await bridge.updates.check())
    } finally {
      setBusy(false)
    }
  }

  const install = () => {
    void getBridge()?.updates.install()
  }

  const canInstall = view?.state === 'downloaded'
  const stateLine =
    view?.state === 'downloading'
      ? `Downloading… ${view.progress ?? 0}%`
      : view?.info ?? view?.state ?? 'unknown'

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-xs text-zinc-100">Software updates</p>
          <p className="font-mono text-[10px] leading-tight text-zinc-400">{stateLine}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canInstall ? (
            <Button size="sm" className="h-7 bg-teal-600 text-white hover:bg-teal-500" onClick={install}>
              <Rocket className="mr-1 h-3.5 w-3.5" /> Restart to update
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-zinc-800 px-2.5 font-mono text-[10px] text-zinc-200"
              onClick={() => void check()}
              disabled={busy || view?.state === 'checking' || view?.state === 'downloading'}
            >
              {busy || view?.state === 'checking' ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3 w-3" />
              )}
              Check for updates
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
