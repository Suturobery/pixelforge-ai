"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"

export type ConfirmOptions = {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

type ConfirmRequest = ConfirmOptions & { resolve: (v: boolean) => void }

// window event bus: Turbopack can duplicate this module across chunks, so a
// module-level handler would pair ask/host instances that never meet
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent<ConfirmRequest>("pf:confirm", { detail: { ...options, resolve } }),
    )
  })
}

export function ConfirmDialogHost() {
  const [state, setState] = React.useState<ConfirmRequest | null>(null)

  React.useEffect(() => {
    const onAsk = (e: Event) => setState((e as CustomEvent<ConfirmRequest>).detail)
    window.addEventListener("pf:confirm", onAsk)
    return () => window.removeEventListener("pf:confirm", onAsk)
  }, [])

  const settle = (v: boolean) => {
    state?.resolve(v)
    setState(null)
  }

  return (
    <Dialog open={!!state} onOpenChange={(open) => { if (!open) settle(false) }}>
      <DialogContent
        showCloseButton={false}
        className="gap-3 rounded-2xl border-white/10 bg-zinc-900/90 p-5 backdrop-blur-2xl sm:max-w-xs"
      >
        <DialogTitle className="text-center text-[15px] font-semibold text-zinc-100">
          {state?.title}
        </DialogTitle>
        {state?.message && (
          <DialogDescription className="whitespace-pre-line text-center text-[13px] text-zinc-400">
            {state.message}
          </DialogDescription>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button
            variant="ghost"
            className="h-8 rounded-lg bg-zinc-800/60 px-4 text-[13px] text-zinc-200 hover:bg-zinc-800"
            onClick={() => settle(false)}
          >
            {state?.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            autoFocus
            className={`h-8 rounded-lg px-4 text-[13px] text-white ${
              state?.destructive ? "bg-red-500/90 hover:bg-red-500" : "bg-teal-600 hover:bg-teal-500"
            }`}
            onClick={() => settle(true)}
          >
            {state?.confirmLabel ?? "OK"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
