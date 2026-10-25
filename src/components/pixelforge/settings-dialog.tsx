// PixelForge AI — app settings dialog.
// Layout: everything fits in the viewport — no inner scrolling ("view freely").
// General: autosave timing, undo depth, editor view defaults.
// Canvas: defaults used by the New project dialog and new clips.
// AI: provider connections (Z.AI, GPT, Claude, Gemini, custom), each with a
//     curated latest/popular model dropdown (+ Custom…). DESKTOP (Task 13a):
//     keys are write-only — set/replace/remove via the C13 vault in the
//     Electron main process; the renderer only ever sees hasKey booleans.
// MCP: Task 8 MCP Connections (server status, pairing, clients, ops log) —
//      implemented in mcp-settings.tsx; the master switch rides agentApiEnabled.
// Keys: keyboard shortcut cheat sheet.

'use client'

import { useEffect, useState } from 'react'
import {
  useAppSettings,
  DEFAULT_SETTINGS,
  MODEL_PRESETS,
  saveApiKeySecure,
  removeApiKeySecure,
  type AIProviderConfig,
} from '@/lib/pixelforge/settings'
import { isDesktop } from '@/lib/pixelforge/desktop-bridge'
import { AGENT_FETCH_HEADERS } from '@/lib/pixelforge/agent-headers'
import { describeApiErrorInline } from '@/lib/pixelforge/api-error'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  RotateCcw,
  PlugZap,
  Loader2,
  Check,
  Copy,
  Eye,
  EyeOff,
  Bot,
  KeyRound,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react'
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
const CUSTOM_MODEL = '__custom__'

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

/**
 * MODEL field: a dropdown of curated latest/popular models for known
 * providers, plus a "Custom…" escape hatch (free-text input) so any model id
 * can be used. Custom endpoints get a plain text field with popular examples.
 */
function ModelPicker({
  provider,
  onUpdate,
}: {
  provider: AIProviderConfig
  onUpdate: (patch: Partial<AIProviderConfig>) => void
}) {
  const presets = MODEL_PRESETS[provider.id]
  const known = presets?.some((m) => m.id === provider.model) ?? false
  const [editing, setEditing] = useState(!known)

  if (!presets) {
    return (
      <Input
        value={provider.model}
        onChange={(e) => onUpdate({ model: e.target.value })}
        placeholder="e.g. llama3.2, qwen2.5, gemini-2.5-flash-image…"
        className="h-6 border-zinc-800 bg-zinc-950 px-2 font-mono text-[11px]"
        aria-label={`${provider.label} model`}
        spellCheck={false}
      />
    )
  }

  const selectValue = known && !editing ? provider.model : CUSTOM_MODEL
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <Select
        value={selectValue}
        onValueChange={(v) => {
          if (v === CUSTOM_MODEL) {
            setEditing(true)
          } else {
            setEditing(false)
            onUpdate({ model: v })
          }
        }}
      >
        <SelectTrigger
          className="h-6 w-full border-zinc-800 bg-zinc-950 px-2 font-mono text-[11px]"
          aria-label={`${provider.label} model`}
        >
          <SelectValue placeholder="pick a model" />
        </SelectTrigger>
        <SelectContent className="max-h-64 border-zinc-800 bg-zinc-950">
          {presets.map((m) => (
            <SelectItem key={m.id} value={m.id} className="font-mono text-[11px] text-zinc-200">
              {m.label}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_MODEL} className="font-mono text-[11px] text-zinc-200">
            Custom… (type any model id)
          </SelectItem>
        </SelectContent>
      </Select>
      {(editing || !known) && (
        <Input
          value={provider.model}
          onChange={(e) => onUpdate({ model: e.target.value })}
          placeholder="type model id"
          className="h-6 border-zinc-800 bg-zinc-950 px-2 font-mono text-[11px]"
          aria-label={`${provider.label} custom model id`}
          spellCheck={false}
        />
      )}
    </div>
  )
}

interface TestResult {
  ok: boolean
  text: string
}

/**
 * Secure key editor (Task 13a, desktop only). The plaintext is submitted
 * ONCE to the Electron main process (safeStorage → settings file) and kept
 * as a session-only runtime copy for the interim generation path. The
 * renderer can never read a stored key back — only hasKey booleans.
 */
function SecureKeyEditor({
  provider,
  hasKey,
  sessionOnly,
  onSaved,
}: {
  provider: AIProviderConfig
  hasKey: boolean
  sessionOnly: boolean
  onSaved: (ok: boolean, message: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const hasSessionKey = provider.apiKey.trim() !== ''

  const save = async () => {
    if (!draft.trim()) return
    setSaving(true)
    const res = await saveApiKeySecure(provider.id, draft.trim())
    setSaving(false)
    if (res.ok) {
      setDraft('')
      setEditing(false)
      onSaved(true, res.sessionOnly ? 'Key saved — session only (OS keyring unavailable)' : 'Key saved — encrypted via the OS keyring')
    } else {
      onSaved(false, res.error ?? 'Could not store the key')
    }
  }

  const remove = async () => {
    const removed = await removeApiKeySecure(provider.id)
    onSaved(removed, removed ? 'Stored key removed' : 'Nothing to remove')
  }

  return (
    <div className="mt-1.5 space-y-1">
      {/* status row — never shows key material */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-zinc-400">
          <KeyRound className={`h-3 w-3 shrink-0 ${hasKey ? 'text-teal-400' : 'text-zinc-600'}`} aria-hidden />
          {hasKey ? (
            <>
              <span className="text-zinc-300">●●●●●●●●</span>
              <span className="truncate">{sessionOnly ? 'stored — session only' : 'stored — encrypted'}</span>
            </>
          ) : (
            'no key stored'
          )}
          {!hasKey && hasSessionKey && (
            <span className="shrink-0 rounded bg-amber-500/10 px-1 font-mono text-[9px] text-amber-300">entered — unsaved</span>
          )}
          {hasKey && !hasSessionKey && (
            <span className="shrink-0 rounded bg-zinc-800 px-1 font-mono text-[9px] text-zinc-300">locked until re-entered</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 font-mono text-[10px] text-zinc-300 hover:text-teal-300"
            onClick={() => {
              setEditing((v) => !v)
              setDraft('')
            }}
            aria-label={hasKey ? `Replace ${provider.label} API key` : `Set ${provider.label} API key`}
          >
            {hasKey ? 'Replace' : 'Set key'}
          </Button>
          {hasKey && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 font-mono text-[10px] text-zinc-400 hover:text-red-300"
              onClick={remove}
              aria-label={`Remove ${provider.label} API key`}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </span>
      </div>
      {editing && (
        <div className="flex items-center gap-1">
          <Input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="paste the API key — it is sent to the OS keyring and never stored in plain text"
            className="h-6 border-zinc-800 bg-zinc-950 px-2 font-mono text-[11px]"
            aria-label={`${provider.label} new API key`}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-6 border-zinc-800 px-1.5 font-mono text-[10px] text-teal-300"
            disabled={saving || !draft.trim()}
            onClick={() => void save()}
            aria-label="Save API key"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 font-mono text-[10px] text-zinc-400"
            onClick={() => setEditing(false)}
            aria-label="Cancel API key edit"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  )
}

function ProviderCard({
  provider,
  isActive,
  wide,
  secureMode,
  onUpdate,
  onSetActive,
}: {
  provider: AIProviderConfig
  isActive: boolean
  wide?: boolean
  secureMode: boolean
  onUpdate: (patch: Partial<AIProviderConfig>) => void
  onSetActive: () => void
}) {
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<TestResult | null>(null)

  const isBuiltin = provider.kind === 'zai'
  const isAnthropic = provider.kind === 'anthropic'
  const canGenerate = !isAnthropic // Claude has no image API
  // "Use" is one-click: it enables the provider and makes it the engine.
  // Desktop: a session key (entered this session) is required — a stored-
  // but-locked key cannot drive the interim generation path (Task 9 moves
  // generation in-process and retires that limitation).
  const keyStatus = useAppSettings((s) => s.keyStatus[provider.id])
  const hasSessionKey = isBuiltin || provider.apiKey.trim() !== ''
  const canBeEngine = canGenerate && hasSessionKey

  const runTest = async () => {
    setTesting(true)
    setTest(null)
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...AGENT_FETCH_HEADERS },
        body: JSON.stringify({
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model,
        }),
      })
      const json = (await res.json()) as { ok: boolean; latencyMs?: number; note?: string; error?: unknown }
      setTest({
        ok: json.ok,
        text: json.ok
          ? `${json.note ?? 'Connection OK'} · ${json.latencyMs ?? 0} ms`
          : describeApiErrorInline(json.error, 'Connection failed'),
      })
    } catch (err) {
      setTest({ ok: false, text: err instanceof Error ? err.message : 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900/50 p-2 ${wide ? 'sm:col-span-2' : ''}`}>
      {/* header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
              provider.enabled ? 'bg-teal-400' : 'bg-zinc-600'
            }`}
            aria-hidden
          />
          <span className="truncate font-mono text-xs text-zinc-100">{provider.label}</span>
          <span className="shrink-0 rounded border border-zinc-800 bg-zinc-950 px-1 py-px font-mono text-[9px] uppercase tracking-wider text-zinc-400">
            {provider.kind === 'custom' ? 'openai-compat' : provider.kind}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isActive ? (
            <span className="rounded bg-teal-600/20 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-teal-300">
              engine
            </span>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 font-mono text-[10px] text-zinc-400 hover:text-teal-300"
              disabled={!canBeEngine}
              onClick={onSetActive}
              title={
                isAnthropic
                  ? 'Claude has no image API — Generate uses the built-in engine'
                  : secureMode && !hasSessionKey
                    ? 'Enter the key for this session to use this provider'
                    : undefined
              }
            >
              Use
            </Button>
          )}
          <Switch
            checked={provider.enabled}
            onCheckedChange={(v) => onUpdate({ enabled: v })}
            aria-label={`${provider.label} enabled`}
          />
        </div>
      </div>

      {isBuiltin ? (
        <p className="mt-1 font-mono text-[10px] leading-tight text-zinc-400">
          Built into this app — no API key needed. Handles sprite generation out of the box.
        </p>
      ) : (
        <>
          <div className="mt-1.5 space-y-1">
            <label className="flex items-center gap-1.5">
              <span className="w-16 shrink-0 font-mono text-[10px] text-zinc-400">BASE URL</span>
              <Input
                value={provider.baseUrl}
                onChange={(e) => onUpdate({ baseUrl: e.target.value })}
                placeholder="https://api.example.com/v1"
                className="h-6 border-zinc-800 bg-zinc-950 px-2 font-mono text-[11px]"
                aria-label={`${provider.label} base URL`}
                spellCheck={false}
              />
            </label>
            {secureMode ? (
              <div className="pl-[4.5rem]">
                <SecureKeyEditor
                  provider={provider}
                  hasKey={keyStatus?.hasKey ?? false}
                  sessionOnly={keyStatus?.sessionOnly ?? false}
                  onSaved={(ok, message) =>
                    setTest({ ok, text: message })
                  }
                />
              </div>
            ) : (
              <label className="flex items-center gap-1.5">
                <span className="w-16 shrink-0 font-mono text-[10px] text-zinc-400">API KEY</span>
                <div className="relative min-w-0 flex-1">
                  <Input
                    type={showKey ? 'text' : 'password'}
                    value={provider.apiKey}
                    onChange={(e) => onUpdate({ apiKey: e.target.value })}
                    placeholder="sk-…"
                    className="h-6 border-zinc-800 bg-zinc-950 px-2 pr-7 font-mono text-[11px]"
                    aria-label={`${provider.label} API key`}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200"
                    aria-label={showKey ? 'Hide API key' : 'Show API key'}
                  >
                    {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </label>
            )}
            <label className="flex items-center gap-1.5">
              <span className="w-16 shrink-0 font-mono text-[10px] text-zinc-400">MODEL</span>
              <ModelPicker provider={provider} onUpdate={onUpdate} />
            </label>
          </div>
          {isAnthropic && (
            <p className="mt-1 font-mono text-[10px] leading-tight text-amber-400/90">
              Claude is chat/agent-only (no image API) — Generate keeps using the built-in engine.
            </p>
          )}
          {secureMode && !hasSessionKey && keyStatus?.hasKey && (
            <p className="mt-1 font-mono text-[10px] leading-tight text-zinc-500">
              Key stored securely — re-enter it once to unlock this session. (The AI engine moves
              in-process in Task 9, removing this step.)
            </p>
          )}
        </>
      )}
      <div className="mt-1.5 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-6 border-zinc-800 px-2 font-mono text-[10px] text-zinc-200 hover:text-teal-300"
          onClick={runTest}
          disabled={testing || (!isBuiltin && !provider.apiKey.trim())}
          title={!isBuiltin && !provider.apiKey.trim() ? 'Enter the key for this session to test the connection' : undefined}
        >
          {testing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <PlugZap className="mr-1 h-3 w-3" />}
          Test connection
        </Button>
        {test && (
          <span
            className={`min-w-0 flex-1 truncate font-mono text-[10px] ${test.ok ? 'text-emerald-400' : 'text-red-400'}`}
            role="status"
          >
            {test.ok ? '✓ ' : '✗ '}
            {test.text}
          </span>
        )}
      </div>
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
  const secureMode = isDesktop() && s.secureMode

  const updateProvider = (id: string, patch: Partial<AIProviderConfig>) => {
    setSetting(
      'aiProviders',
      s.aiProviders.map((p) => (p.id === id ? { ...p, ...patch } : p))
    )
  }

  const setEngine = (id: string) => {
    setSetting(
      'aiProviders',
      s.aiProviders.map((p) => (p.id === id ? { ...p, enabled: true } : p))
    )
    setSetting('activeProviderId', id)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto border-zinc-800 bg-zinc-950 p-4 text-zinc-100 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between font-mono">
            Settings
            <Button
              variant="ghost"
              size="sm"
              /* mr clears the DialogContent built-in ✕ (absolute right-4 top-4) —
                 without it the two hit-areas overlap (audit bug #4) */
              className="mr-8 h-7 px-2 font-mono text-[10px] text-zinc-400 hover:text-zinc-200"
              onClick={resetSettings}
              aria-label="Reset settings to defaults"
            >
              <RotateCcw className="mr-1 h-3 w-3" /> Reset
            </Button>
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-zinc-400">
            Preferences are saved automatically in this browser.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general">
          <TabsList className="grid w-full grid-cols-5 bg-zinc-900">
            <TabsTrigger value="general" className="font-mono text-[11px]">General</TabsTrigger>
            <TabsTrigger value="canvas" className="font-mono text-[11px]">Canvas</TabsTrigger>
            <TabsTrigger value="ai" className="font-mono text-[11px]">AI</TabsTrigger>
            <TabsTrigger value="mcp" className="font-mono text-[11px]">MCP</TabsTrigger>
            <TabsTrigger value="shortcuts" className="font-mono text-[11px]">Keys</TabsTrigger>
          </TabsList>

          {/* ---------------------------------------------------- general */}
          <TabsContent value="general" className="space-y-4 pt-3">
            <Row label="Autosave delay" hint="How long to wait after a change before auto-saving">
              <Select
                value={String(s.autosaveDelay)}
                onValueChange={(v) => setSetting('autosaveDelay', parseInt(v, 10))}
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
          <TabsContent value="canvas" className="space-y-4 pt-3">
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

          {/* ---------------------------------------------------- AI & MCP */}
          <TabsContent value="ai" className="pt-2">
            {/* 2-column grid so all providers fit the viewport — no scrolling */}
            <p className="mb-1.5 font-mono text-[10px] leading-tight text-zinc-400">
              {secureMode
                ? 'Keys are stored encrypted by the desktop app (OS keyring) and never written in plain text. The app can only store them — never read them back.'
                : 'Keys are stored only in this browser and sent only to the endpoints you configure.'}
            </p>
            {s.encryptionWarning && (
              <div
                className="mb-1.5 flex items-start gap-1.5 rounded-lg border border-amber-800/60 bg-amber-950/30 p-2"
                role="alert"
              >
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
                <p className="font-mono text-[10px] leading-tight text-amber-200">{s.encryptionWarning}</p>
              </div>
            )}
            <div className="grid gap-1.5 sm:grid-cols-2">
              {s.aiProviders.map((p) => (
                <ProviderCard
                  key={p.id}
                  provider={p}
                  isActive={s.activeProviderId === p.id}
                  wide={p.kind === 'zai'}
                  secureMode={secureMode}
                  onUpdate={(patch) => updateProvider(p.id, patch)}
                  onSetActive={() => setEngine(p.id)}
                />
              ))}

              {/* MCP pointer — the real MCP lives in the dedicated tab (Task 8) */}
              <div className="rounded-lg border border-teal-900/60 bg-teal-950/20 p-2 sm:col-span-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Bot className="h-3.5 w-3.5 shrink-0 text-teal-400" />
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-zinc-100">Agent API (MCP)</p>
                      <p className="font-mono text-[10px] leading-tight text-zinc-400">
                        This toggle is the MCP master switch — pairing, clients and the operation
                        log live in the <span className="text-teal-300">MCP</span> tab. The old REST
                        tool endpoint (<span className="text-zinc-300">/api/mcp/run</span>) was
                        retired in favor of the real MCP server.
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={s.agentApiEnabled}
                    onCheckedChange={(v) => setSetting('agentApiEnabled', v)}
                    aria-label="Enable Agent API"
                  />
                </div>
              </div>

              {/* Task 9: spending limits (ESTIMATE-based hard stop + warning) */}
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2 sm:col-span-2">
                <p className="mb-1 font-mono text-xs text-zinc-100">Spending limits</p>
                <p className="mb-2 font-mono text-[10px] leading-tight text-zinc-400">
                  Cost figures are ESTIMATES from the provider price table — never exact charges.
                  The monthly cap hard-stops new paid generations; cache hits are always free.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Row label="Monthly cap (USD)" hint="0 = unlimited">
                    <input
                      value={String(s.aiMonthlyLimitUsd)}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        setSetting('aiMonthlyLimitUsd', Number.isFinite(v) ? Math.max(0, Math.min(10000, v)) : 0)
                      }}
                      inputMode="decimal"
                      aria-label="Monthly spending cap in US dollars"
                      className="h-7 w-20 rounded border border-zinc-700 bg-zinc-900 px-2 font-mono text-xs text-zinc-200"
                    />
                  </Row>
                  <Row label="Warn at (USD)" hint="one warning per month">
                    <input
                      value={String(s.aiWarnUsd)}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        setSetting('aiWarnUsd', Number.isFinite(v) ? Math.max(0, Math.min(10000, v)) : 0)
                      }}
                      inputMode="decimal"
                      aria-label="Spending warning threshold in US dollars"
                      className="h-7 w-20 rounded border border-zinc-700 bg-zinc-900 px-2 font-mono text-xs text-zinc-200"
                    />
                  </Row>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* --------------------------------------------------------- MCP */}
          <TabsContent value="mcp" className="pt-2">
            <McpConnections />
          </TabsContent>

          {/* -------------------------------------------------- shortcuts */}
          <TabsContent value="shortcuts" className="pt-3">
            <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
              <div className="space-y-2">
                <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">Tools</p>
                <ShortcutItem action="Pencil / Eraser / Fill" keys={['B', 'E', 'F']} />
                <ShortcutItem action="Line / Rect / Eyedropper" keys={['L', 'R', 'I']} />
                <ShortcutItem action="Move layer" keys={['M']} />
                <ShortcutItem action="Brush size" keys={['1', '–', '8']} />
              </div>
              <div className="space-y-2">
                <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">View</p>
                <ShortcutItem action="Toggle grid / onion skin" keys={['G', 'O']} />
                <ShortcutItem action="Zoom in / out" keys={['+', '–']} />
                <ShortcutItem action="Pan canvas" keys={['Space', 'drag']} />
                <p className="pt-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400">Project</p>
                <ShortcutItem action="Undo / Redo" keys={['Ctrl+Z', 'Ctrl+Shift+Z']} />
                <ShortcutItem action="Save" keys={['Ctrl+S']} />
                <ShortcutItem action="Swap colors" keys={['tool', 'button']} />
                <ShortcutItem action="Swatch → secondary color" keys={['right-click']} />
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
