import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Upstream services (the sprite-generation engine in particular) answer with
// Chinese error text; surfaces that toast raw messages must stay English.
const CJK_RE = /[\u3000-\u9fff\uf900-\ufaff\uff01-\uffee]/
const TRANSIENT_ZH = /网络错误|请稍后|超时|繁忙|重试|限流|频率/

export function friendlyError(err: unknown): string {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Unknown error"
  if (!CJK_RE.test(msg)) return msg
  console.error("[pixelforge] non-English service error:", msg)
  if (TRANSIENT_ZH.test(msg)) {
    return "The image service had a temporary network error — your connection is fine. Try again in a moment."
  }
  return "The image service rejected the request (its error message was not in English). Try rephrasing the prompt or check Settings → AI. Full details are in the browser console."
}
