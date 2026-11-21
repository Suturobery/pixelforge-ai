// PixelForge AI — Help & feedback dialog (Tools rail).
//
// Zero-backend reporting for the tester phase: builds a report with optional
// auto-diagnostics, then either opens the maintainer's mail client (mailto:)
// or copies it to the clipboard. Works offline — mail sends when the user is
// back online; copy always works. Upgrade path: swap mailto for a form
// service key without touching the dialog.

'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEditor, getActiveClip } from '@/lib/pixelforge/store'
import { copyText, isDesktop, desktopLogsTail } from '@/lib/pixelforge/desktop-bridge'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Bug, Check, Copy, HelpCircle, Lightbulb, MessageCircle, Send, X } from 'lucide-react'

/** Where tester reports land. Single knob — change here only. */
export const FEEDBACK_EMAIL = 'alvarezdelgado07@gmail.com'

const TYPES = [
  { id: 'bug', label: 'Bug report', icon: Bug },
  { id: 'idea', label: 'Idea', icon: Lightbulb },
  { id: 'question', label: 'Question', icon: MessageCircle },
] as const

type FeedbackType = (typeof TYPES)[number]['id']

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
  const typeLabel = TYPES.find((t) => t.id === type)?.label ?? 'Feedback'

  // fetch the desktop log tail once per dialog open (kept in state so the
  // report memo stays synchronous)
  useEffect(() => {
    if (!open || !desktop) return
    setLogTail(null)
    void desktopLogsTail().then((r) => setLogTail(r ? r.text : null))
  }, [open, desktop])

  const report = useMemo(() => {
    const lines = [
      `Type: ${typeLabel}`,
      '',
      'Message:',
      message.trim() || '(empty)',
    ]
    if (withDiag) {
      lines.push(
        '',
        '--- diagnostics (auto) ---',
        `project: ${project.name} (${project.width}×${project.height})`,
        `clip: ${activeClip?.name ?? '?'} · frame ${activeClip?.frames.length ?? '?'} · tool: ${tool}`,
        `url: ${typeof location !== 'undefined' ? location.href : ''}`,
        `ua: ${typeof navigator !== 'undefined' ? navigator.userAgent : ''}`,
        `sent: ${new Date().toISOString()}`,
      )
    }
    if (withLogs && logTail) {
      lines.push('', '--- app log tail (last lines) ---', logTail)
    }
    return lines.join('\n')
  }, [typeLabel, message, withDiag, withLogs, logTail, project.name, project.width, project.height, activeClip, tool])

  if (!open || typeof document === 'undefined') return null

  // Email clients commonly reject very long URLs. Keep the copyable report
  // complete, but bound the mail body so Send via email always opens the OS
  // mail app even when the optional log tail is large.
  const emailReport = report.length > 12_000
    ? `${report.slice(0, 12_000)}\n\n--- report truncated for email; use Copy report for the full diagnostics ---`
    : report
  const mailto = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(`PixelForge AI — ${typeLabel}`)}&body=${encodeURIComponent(emailReport)}`

  const copyReport = async () => {
    try {
      await copyText(report)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
      toast({ title: 'Report copied', description: `Paste it into an email to ${FEEDBACK_EMAIL}.` })
    } catch {
      toast({ title: 'Copy failed', description: 'Clipboard unavailable — select the text manually.', variant: 'destructive' })
    }
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

        <label htmlFor="pf-feedback-msg" className="mt-2.5 block font-mono text-[10px] text-zinc-400">
          Message
        </label>
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
          <Button asChild size="sm" className="h-7 flex-1 bg-teal-600 text-white hover:bg-teal-500">
            <a href={mailto} target="_blank" rel="noreferrer" aria-label={`Send ${typeLabel} via email`}>
              <Send className="h-3.5 w-3.5" /> Send via email
            </a>
          </Button>
          <Button size="sm" variant="outline" className="h-7 flex-1 border-zinc-800 text-zinc-300 hover:bg-zinc-800" onClick={copyReport}>
            {copied ? <Check className="h-3.5 w-3.5 text-teal-400" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy report'}
          </Button>
        </div>

        <p className="mt-2 font-mono text-[10px] leading-tight text-zinc-500">
          Opens your mail app with everything prefilled — nothing is uploaded. Works offline too; the
          email sends when you&apos;re back online. No mail app? Use Copy report.
        </p>
      </div>
    </div>
    </>,
    document.body,
  )
}
