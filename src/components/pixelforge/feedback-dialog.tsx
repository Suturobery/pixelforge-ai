// PixelForge AI — Help & feedback dialog (Tools rail).
//
// Zero-backend reporting via the community Discord server: builds a clean
// Discord-Markdown report with optional auto-diagnostics and desktop log tail,
// copies it to the clipboard, and opens the official Discord invite. Works
// offline too (Copy report always succeeds).

'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditor, getActiveClip } from '@/lib/pixelforge/store'
import { copyText, isDesktop, desktopLogsTail } from '@/lib/pixelforge/desktop-bridge'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Bug, Check, Copy, ExternalLink, HelpCircle, Lightbulb, MessageCircle, X } from 'lucide-react'

/** Official PixelForge AI community Discord invite. Single knob — change here only. */
export const DISCORD_INVITE_URL = 'https://discord.gg/2f5MvmAqF'

const TYPES = [
  { id: 'bug', label: 'Bug report', channel: '#bug-reports', icon: Bug },
  { id: 'idea', label: 'Idea', channel: '#feature-ideas', icon: Lightbulb },
  { id: 'question', label: 'Question', channel: '#help-and-mcp', icon: MessageCircle },
] as const

type FeedbackType = (typeof TYPES)[number]['id']

function sanitizeFence(text: string): string {
  return text.replace(/```/g, '` ` `')
}

export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useEditor((s) => s.project)
  const tool = useEditor((s) => s.tool)
  const activeClip = getActiveClip(useEditor.getState())
  const { toast } = useToast()

  const [type, setType] = useState<FeedbackType>('bug')
  const [message, setMessage] = useState('')
  const [withDiag, setWithDiag] = useState(true)
  const [withLogs, setWithLogs] = useState(true)
  const [logTail, setLogTail] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const desktop = typeof window !== 'undefined' && isDesktop()
  const activeType = TYPES.find((t) => t.id === type) ?? TYPES[0]
  const typeLabel = activeType.label
  const targetChannel = activeType.channel

  // fetch the desktop log tail once per dialog open (kept in state so the
  // report memo stays synchronous)
  useEffect(() => {
    if (!open || !desktop) return
    setLogTail(null)
    void desktopLogsTail().then((r) => setLogTail(r ? r.text : null))
  }, [open, desktop])

  const report = useMemo(() => {
    const lines = [
      `**[${typeLabel}]**`,
      '',
      message.trim() || '(describe what happened here)',
    ]
    if (withDiag) {
      const diagLines = [
        `runtime: ${desktop ? 'desktop' : 'web'}`,
        `project: ${project.name} (${project.width}×${project.height})`,
        `clip: ${activeClip?.name ?? '?'} · frames: ${activeClip?.frames.length ?? '?'} · tool: ${tool}`,
        `url: ${typeof location !== 'undefined' ? location.href : ''}`,
        `ua: ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`,
        `sent: ${new Date().toISOString()}`,
      ]
      lines.push('', '**Diagnostics**', '```text', ...diagLines, '```')
    }
    if (withLogs && logTail) {
      lines.push('', '**App log tail**', '```log', sanitizeFence(logTail.trimEnd()), '```')
    }
    return lines.join('\n')
  }, [typeLabel, message, withDiag, withLogs, logTail, desktop, project.name, project.width, project.height, activeClip, tool])

  if (!open || typeof document === 'undefined') return null

  const copyReport = async () => {
    try {
      await copyText(report)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
      toast({ title: 'Report copied', description: `Paste it in ${targetChannel} on Discord.` })
    } catch {
      toast({ title: 'Copy failed', description: 'Clipboard unavailable — copy your message manually.', variant: 'destructive' })
    }
  }

  const copyAndOpenDiscord = async () => {
    let didCopy = false
    try {
      await copyText(report)
      didCopy = true
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Still open Discord even if clipboard access is blocked
    }
    window.open(DISCORD_INVITE_URL, '_blank', 'noopener,noreferrer')
    toast(
      didCopy
        ? { title: 'Report copied — opening Discord', description: `Paste it in ${targetChannel} (Ctrl+V).` }
        : { title: 'Opening Discord', description: `Post your report in ${targetChannel}.` },
    )
  }

  // Portal to <body>: the Tools rail has backdrop-blur, which turns it into a
  // containing block for fixed children — without this the dialog renders
  // scaled/clipped inside the 48px rail.
  return createPortal(
    <>
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pf-feedback-title"
        className="w-full max-w-[24rem] rounded-lg border border-zinc-800 bg-zinc-950 p-3 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <p id="pf-feedback-title" className="flex items-center gap-1.5 font-mono text-xs text-teal-300">
            <HelpCircle className="h-3.5 w-3.5" aria-hidden /> Help &amp; feedback
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-2.5 flex gap-1" role="group" aria-label="Report type">
          {TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setType(t.id)}
              aria-pressed={type === t.id}
              className={`flex flex-1 items-center justify-center gap-1 rounded border px-1 py-1.5 font-mono text-[10px] transition-colors ${
                type === t.id
                  ? 'border-teal-500/40 bg-teal-500/10 text-teal-300'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <t.icon className="h-3 w-3" aria-hidden />
              {t.label}
            </button>
          ))}
        </div>

        <div className="mt-2.5 flex items-center justify-between">
          <label htmlFor="pf-feedback-msg" className="font-mono text-[10px] text-zinc-400">
            Message
          </label>
          <span className="font-mono text-[10px] text-zinc-500">
            Channel: <span className="text-teal-400/90">{targetChannel}</span>
          </span>
        </div>
        <textarea
          id="pf-feedback-msg"
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={4_000}
          placeholder="What happened? What did you expect?"
          className="mt-1 w-full resize-none rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-teal-500/50 focus:outline-none"
        />

        <label className="mt-2 flex items-start gap-1.5 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={withDiag}
            onChange={(e) => setWithDiag(e.target.checked)}
            className="mt-0.5 accent-teal-500"
          />
          <span>
            Attach diagnostics{' '}
            <span className="text-zinc-600">
              (build · canvas {project.width}×{project.height} · tool: {tool} · clip {activeClip?.name ?? '?'} · browser)
            </span>
          </span>
        </label>
        {desktop && (
          <label className="mt-1.5 flex items-start gap-1.5 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={withLogs && !!logTail}
              disabled={!logTail}
              onChange={(e) => setWithLogs(e.target.checked)}
              className="mt-0.5 accent-teal-500"
            />
            <span>
              Attach app logs{' '}
              <span className="text-zinc-600">
                {logTail ? '(last 200 lines of the desktop log — speeds up debugging)' : '(log unavailable)'}
              </span>
            </span>
          </label>
        )}

        <div className="mt-3 flex gap-1.5">
          <Button
            size="sm"
            className="h-7 flex-1 bg-teal-600 text-white hover:bg-teal-500"
            onClick={copyAndOpenDiscord}
            aria-label={`Copy ${typeLabel} and open Discord`}
          >
            <ExternalLink className="h-3.5 w-3.5" /> Copy &amp; open Discord
          </Button>
          <Button size="sm" variant="outline" className="h-7 border-zinc-800 text-zinc-300 hover:bg-zinc-800" onClick={copyReport}>
            {copied ? <Check className="h-3.5 w-3.5 text-teal-400" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <p className="mt-2 font-mono text-[10px] leading-tight text-zinc-500">
          Copies a Discord-formatted report and opens our community server — paste it in{' '}
          <span className="text-zinc-400">{targetChannel}</span>. Nothing is uploaded automatically.
        </p>
      </div>
    </div>
    </>,
    document.body,
  )
}
