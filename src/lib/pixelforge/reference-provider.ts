// PixelForge AI — Create-from-Reference provider adapter (renderer side).
//
// One online provider (Google Gemini image generation) behind a small adapter
// so it can be swapped later. Capability verified from the official docs
// before choosing it: Gemini image models accept REFERENCE IMAGES as input
// (aistudio.google.com/docs/image-generation — "Nano Banana models allow you
// to mix up to 14 reference images"; input image blocks carry base64 data).
//
// The provider HTTP call runs in the ELECTRON MAIN process via the bridge
// (`referenceGen.generate`) — the stored API key is decrypted and used inside
// main and never crosses to the renderer (C13 vault discipline). Web mode has
// no bridge: generation reports desktop-only; PNG import stays offline.

import { getBridge } from './desktop-bridge';

export const REFERENCE_PROVIDER_ID = 'gemini-image';
export const REFERENCE_PROVIDER_LABEL = 'Gemini image (online)';
export const REFERENCE_PROVIDER_DOCS = 'https://ai.google.dev/gemini-api/docs/image-generation';
export const REFERENCE_GEN_MODEL = 'gemini-2.5-flash-image';

export interface ProviderKeyStatus {
  desktop: boolean;
  hasKey: boolean;
}

export interface ReferenceGenRequest {
  /** Composed brief + style tags (buildReferencePrompt output). */
  prompt: string;
  /** Approved reference sprite PNG bytes. */
  referencePng: Uint8Array;
}

export interface ReferenceGenSuccess {
  ok: true;
  png: Uint8Array;
  model: string;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Generate one candidate image. Throws plain-language errors. */
export async function generateReferenceCandidate(req: ReferenceGenRequest): Promise<ReferenceGenSuccess> {
  const bridge = getBridge();
  if (!bridge) {
    throw new Error('Online generation requires the desktop app — use the offline PNG import here.');
  }
  const res = await bridge.referenceGen.generate({
    prompt: req.prompt,
    referencePngBase64: toBase64(req.referencePng),
  });
  if (!res.ok) throw new Error(res.error);
  return { ok: true, png: fromBase64(res.pngBase64), model: res.model };
}

/** Vault state for the provider (web mode ⇒ desktop-only note). */
export async function referenceProviderKeyStatus(): Promise<ProviderKeyStatus> {
  const bridge = getBridge();
  if (!bridge) return { desktop: false, hasKey: false };
  try {
    return { desktop: true, hasKey: await bridge.settings.hasKey(REFERENCE_PROVIDER_ID) };
  } catch {
    return { desktop: true, hasKey: false };
  }
}

/** Store the provider key in the desktop credential vault (write-only). */
export async function storeReferenceProviderKey(
  plaintext: string,
): Promise<{ ok: boolean; sessionOnly?: boolean; error?: string }> {
  const bridge = getBridge();
  if (!bridge) return { ok: false, error: 'API keys require the desktop app.' };
  try {
    const res = await bridge.settings.setApiKey(REFERENCE_PROVIDER_ID, plaintext);
    return { ok: true, sessionOnly: res.sessionOnly };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function removeReferenceProviderKey(): Promise<boolean> {
  const bridge = getBridge();
  if (!bridge) return false;
  try {
    return await bridge.settings.removeKey(REFERENCE_PROVIDER_ID);
  } catch {
    return false;
  }
}
