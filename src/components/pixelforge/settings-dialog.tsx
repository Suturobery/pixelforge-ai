// PixelForge AI — settings dialog.
// General: autosave, history, UI prefs. Canvas: new-project defaults.
// Agents: subscription-only note (Z.AI IDE connects via MCP — no in-app
// image generation, no API-key settings). MCP: server status, pairing,
// clients, ops log (mcp-settings.tsx). Keys: shortcut cheat sheet.

'use client'

import { useEffect, useState } from 'react'
import { useAppSettings } from '@/lib/pixelforge/settings'
import { useEditor } from '@/lib/pixelforge/store'
import { PALETTES } from '@/lib/pixelforge/palettes'
import { McpConnections } from '@/components/pixelforge/mcp-settings'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SoftwareUpdatesCard } from '@/components/pixelforge/software-updates-card'
import { Button } from '@/components/ui/button'
import { isDesktop } from '@/lib/pixelforge/desktop-bridge'
import { RotateCcw, Bot, Brain } from 'lucide-react'
import type { ReactNode } from 'react'

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="font-mono text-xs text-zinc-200">{label}</p>
        {hint && <p className="font-mono text-[10px] leading-tight text-zinc-400">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}


const SIZE_PRESETS = [16, 24, 32, 48, 64, 96, 128]
const FPS_PRESETS = [4, 6, 8, 12, 24]

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
      {children}
    </kbd>
  )
}

function ShortcutItem({ keys, action }: { keys: string[]; action: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="font-mono text-[11px] text-zinc-300">{action}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
    </div>
  )
}


export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const s = useAppSettings()
  const setSetting = useAppSettings((st) => st.setSetting)
  const resetSettings = useAppSettings((st) => st.resetSettings)
  const autosave = useEditor((st) => st.autosave)
  const setAutosave = useEditor((st) => st.setAutosave)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !isDesktop()) return
    let alive = true
    void window.pixelforge?.app.getInfo()
      .then((info) => {
        if (alive) setAppVersion(info.version)
      })
      .catch(() => {
        if (alive) setAppVersion(null)
      })
    return () => { alive = false }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88dvh] w-[calc(100%-2rem)] flex-col gap-3 overflow-hidden border-zinc-800 bg-zinc-950 p-4 text-zinc-100 sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center justify-between font-mono">
            <span className="flex items-center gap-2">
              Settings
              {appVersion && <span className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-normal text-zinc-300">v{appVersion}</span>}
            </span>
            <Button
              variant="ghost"
              size="sm"
              /* mr clears the DialogContent built-in close button (absolute
                 right-4 top-4) — without it the two hit-areas overlap */
              className="mr-8 h-7 px-2 font-mono text-[10px] text-zinc-400 hover:text-zinc-200"
              onClick={resetSettings}
              aria-label="Reset settings to defaults"
            >
              <RotateCcw className="mr-1 h-3 w-3" /> Reset
            </Button>
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-zinc-400">
            {isDesktop() ? 'Preferences are saved locally on this device.' : 'Preferences are saved automatically in this browser.'}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <TabsList className="grid w-full shrink-0 grid-cols-5 bg-zinc-900">
            <TabsTrigger value="general" className="font-mono text-[11px]">General</TabsTrigger>
            <TabsTrigger value="canvas" className="font-mono text-[11px]">Canvas</TabsTrigger>
            <TabsTrigger value="ai" className="font-mono text-[11px]">Agents</TabsTrigger>
            <TabsTrigger value="mcp" className="font-mono text-[11px]">MCP</TabsTrigger>
            <TabsTrigger value="shortcuts" className="font-mono text-[11px]">Keys</TabsTrigger>
          </TabsList>

          {/* ---------------------------------------------------- general */}
<TabsContent value="general" className="pixelforge-scroll min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden pr-1 pt-3">
            <SoftwareUpdatesCard />
            <Row label="Autosave" hint="Save the open project automatically after changes">
              <Switch checked={autosave} onCheckedChange={setAutosave} aria-label="Autosave" />
            </Row>
            <Row label="Autosave delay" hint="How long to wait after a change before auto-saving">
              <Select
                value={String(s.autosaveDelay)}
                onValueChange={(v) => setSetting('autosaveDelay', parseInt(v, 10))}
                disabled={!autosave}
              >
                <SelectTrigger className="h-8 w-24 border-zinc-800 bg-zinc-900 font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1000" className="font-mono text-xs">1 s</SelectItem>
                  <SelectItem value="2500" className="font-mono text-xs">2.5 s</SelectItem>
                  <SelectItem value="5000" className="font-mono text-xs">5 s</SelectItem>
                  <SelectItem value="10000" className="font-mono text-xs">10 s</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label="History budget" hint="Tile-diff memory kept for undo/redo (v2 core)">
              <Select
                value={String(s.historyLimit)}
                onValueChange={(v) => setSetting('historyLimit', parseInt(v, 10))}
              >
                <SelectTrigger className="h-8 w-24 border-zinc-800 bg-zinc-900 font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="20" className="font-mono text-xs">16 MB</SelectItem>
                  <SelectItem value="40" className="font-mono text-xs">32 MB</SelectItem>
                  <SelectItem value="100" className="font-mono text-xs">64 MB</SelectItem>
                  <SelectItem value="200" className="font-mono text-xs">128 MB</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label="Interface text" hint="Make compact labels easier to read across the studio">
              <Select
                value={s.uiTextScale}
                onValueChange={(v) => setSetting('uiTextScale', v === 'large' ? 'large' : 'normal')}
              >
                <SelectTrigger className="h-8 w-24 border-zinc-800 bg-zinc-900 font-mono text-xs" aria-label="Interface text size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal" className="font-mono text-xs">Normal</SelectItem>
                  <SelectItem value="large" className="font-mono text-xs">Large</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label="Show grid on load" hint="Pixel grid when the studio opens">
              <Switch
                checked={s.showGridDefault}
                onCheckedChange={(v) => setSetting('showGridDefault', v)}
                aria-label="Show grid on load"
              />
            </Row>
            <Row label="Onion skin on load" hint="Ghost previous/next frames on open">
              <Switch
                checked={s.onionSkinDefault}
                onCheckedChange={(v) => setSetting('onionSkinDefault', v)}
                aria-label="Onion skin on load"
              />
            </Row>
            <Row label="Floating buttons" hint="Size of the collapsed Preview / View pills">
              <div className="flex items-center gap-1" role="group" aria-label="Floating buttons size">
                {(['sm', 'md', 'lg'] as const).map((sz) => (
                  <Button
                    key={sz}
                    variant={s.floatBtnSize === sz ? 'secondary' : 'ghost'}
                    size="sm"
                    className={`h-7 w-9 px-0 font-mono text-[11px] ${
                      s.floatBtnSize === sz
                        ? 'bg-teal-500/15 text-teal-300 ring-1 ring-teal-500/40'
                        : 'text-zinc-300'
                    }`}
                    onClick={() => setSetting('floatBtnSize', sz)}
                    aria-label={`Floating buttons size ${sz === 'sm' ? 'small' : sz === 'md' ? 'medium' : 'large'}`}
                    aria-pressed={s.floatBtnSize === sz}
                  >
                    {sz.toUpperCase()}
                  </Button>
                ))}
              </div>
            </Row>
          </TabsContent>

          {/* ----------------------------------------------------- canvas */}
          
          {/* ---------------------------------------------------- canvas */}
<TabsContent value="canvas" className="pixelforge-scroll min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden pr-1 pt-3">
            <Row label="Default canvas size" hint="Preselected in the New project dialog">
              <Select
                value={String(s.defaultSize)}
                onValueChange={(v) => setSetting('defaultSize', parseInt(v, 10))}
              >
                <SelectTrigger className="h-8 w-24 border-zinc-800 bg-zinc-900 font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIZE_PRESETS.map((n) => (
                    <SelectItem key={n} value={String(n)} className="font-mono text-xs">
                      {n} × {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Default clip FPS" hint="Playback speed for new clips">
              <Select
                value={String(s.defaultClipFps)}
                onValueChange={(v) => setSetting('defaultClipFps', parseInt(v, 10))}
              >
                <SelectTrigger className="h-8 w-24 border-zinc-800 bg-zinc-900 font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FPS_PRESETS.map((n) => (
                    <SelectItem key={n} value={String(n)} className="font-mono text-xs">
                      {n} fps
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Default palette" hint="Preselected for new projects">
              <Select
                value={s.defaultPaletteId}
                onValueChange={(v) => setSetting('defaultPaletteId', v)}
              >
                <SelectTrigger className="h-8 w-28 border-zinc-800 bg-zinc-900 font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PALETTES.map((p) => (
                    <SelectItem key={p.id} value={p.id} className="font-mono text-xs">
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          </TabsContent>

          
          {/* -------------------------------------------- agents (subscription-only) */}
          <TabsContent value="ai" className="pixelforge-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pr-1 pt-2">
            <div className="rounded-lg border border-sky-900/60 bg-sky-950/20 p-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <Bot className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
                <div className="min-w-0">
                  <p className="font-mono text-xs text-zinc-100">Agents use your IDE subscription</p>
                  <p className="mt-1 break-words font-mono text-[10px] leading-relaxed text-zinc-400">
                    PixelForge does not ship provider API keys or in-app image generation. Connect your
                    coding agent (Z.AI IDE, Cursor, Claude Code, Codex — any MCP client) to the local
                    MCP server below and it drives the same editor tools an artist would use: pixels,
                    layers, animation presets and deterministic procedural VFX. Nothing is billed
                    behind your back; the only cost is your existing IDE subscription.
                  </p>
                </div>
              </div>
            </div>
            <div className="mt-2 rounded-lg border border-teal-900/60 bg-teal-950/20 p-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <Brain className="mt-0.5 h-4 w-4 shrink-0 text-teal-400" />
                <div className="min-w-0">
                  <p className="font-mono text-xs text-zinc-100">Deterministic Brain features stay in-app</p>
                  <p className="mt-1 break-words font-mono text-[10px] leading-relaxed text-zinc-400">
                    The Brain Panel interpreter, auto-enhance, learned preferences and agent task
                    board run entirely on this machine — no model, no key, no cost. Planning-style
                    reasoning is available by asking your connected IDE agent; it reads the project
                    and proposes work through the same task board.
                  </p>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* --------------------------------------------------------- MCP */}
          <TabsContent value="mcp" className="pixelforge-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pr-1 pt-2">
            <McpConnections />
          </TabsContent>

          {/* -------------------------------------------------- shortcuts */}
<TabsContent value="shortcuts" className="pixelforge-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pr-1 pt-3">
            <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
              <div className="space-y-2">
                <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">Tools</p>
                <ShortcutItem action="Pencil / Eraser / Fill" keys={['B', 'E', 'F']} />
                <ShortcutItem action="Line / Rect / Ellipse" keys={['L', 'R', 'C']} />
                <ShortcutItem action="Select / Eyedropper" keys={['S', 'I']} />
                <ShortcutItem action="Move layer" keys={['M']} />
                <p className="pt-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400">Brush</p>
                <ShortcutItem action="Brush size (direct)" keys={['1', '–', '8']} />
                <ShortcutItem action="Brush size − / + (Aseprite-style)" keys={['[', ']']} />
                <ShortcutItem action="Scroll on brush button" keys={['wheel']} />
                <p className="pt-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400">Colors</p>
                <ShortcutItem action="Swap colors" keys={['X']} />
                <ShortcutItem action="Symmetry (mirror X)" keys={['Y']} />
                <ShortcutItem action="Dither fill" keys={['D']} />
                <ShortcutItem action="Swatch → secondary color" keys={['right-click']} />
                <p className="pt-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400">Tilemap</p>
                <ShortcutItem action="Tile snap on / off" keys={['K']} />
                <ShortcutItem action="Tile stamp on / off (snap on)" keys={['Shift+K']} />
                <p className="pt-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400">Animation</p>
                <ShortcutItem action="Play / pause" keys={['Space']} />
                <ShortcutItem action="Prev / next frame" keys={[',', '.']} />
                <ShortcutItem action="New frame" keys={['Alt+N']} />
              </div>
              <div className="space-y-2">
                <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">View</p>
                <ShortcutItem action="Toggle grid / onion skin" keys={['G', 'O']} />
                <ShortcutItem action="Toggle palette panel" keys={['P']} />
                <ShortcutItem action="Collapse frames strip" keys={['T']} />
                <ShortcutItem action="Zoom in / out" keys={['+', '–']} />
                <ShortcutItem action="Pan canvas" keys={['middle', 'or right drag']} />
                <p className="pt-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400">Project</p>
                <ShortcutItem action="Undo / Redo" keys={['Ctrl+Z', 'Ctrl+Shift+Z / Ctrl+Y']} />
                <ShortcutItem action="Save" keys={['Ctrl+S']} />
                <ShortcutItem action="Deselect" keys={['Esc']} />
                <ShortcutItem action="Delete selection" keys={['Del', 'Backspace']} />
                <ShortcutItem action="Nudge selection" keys={['arrow keys']} />
                <ShortcutItem action="Copy / Cut / Paste" keys={['Ctrl+C', 'Ctrl+X', 'Ctrl+V']} />
                <p className="pt-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400">Selection scale</p>
                <ShortcutItem action="Scale ×2 / ×3 / ÷2" keys={['toolbar', 'buttons']} />
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
