/**
 * PixelForge AI — Create-from-Reference provider generation (MAIN process).
 *
 * The provider HTTP call runs here so the stored API key is decrypted and
 * used INSIDE main and never crosses to the renderer (C13 discipline: keys
 * are write-only over the bridge). Capability verified from the official
 * Gemini image-generation docs before choosing the provider: reference
 * images are supported (aistudio.google.com/docs/image-generation — "Nano
 * Banana models allow you to mix up to 14 reference images"). This module
 * uses the long-stable :generateContent REST surface with inline_data parts;
 * swap this one file to swap providers.
 */

import { ipcMain } from 'electron';

import type { Logger } from '../logger';
import type { SettingsStore } from '../settings/store';
import {
  REFERENCE_GEN_MAX_PNG_BASE64,
  REFERENCE_GEN_MAX_PROMPT,
  REFERENCE_GEN_MODEL,
  REFERENCE_PROVIDER_ID,
  type BridgeReferenceGenInput,
  type BridgeReferenceGenResult,
} from '../shared/bridge-types';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiResponseShape {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
  }>;
}

export function registerReferenceGenHandlers(store: SettingsStore, logger: Logger): void {
  ipcMain.handle('pf:reference-generate', async (_event, raw: unknown): Promise<BridgeReferenceGenResult> => {
    const input = raw as Partial<BridgeReferenceGenInput> | undefined;
    if (
      !input ||
      typeof input.prompt !== 'string' ||
      input.prompt.length === 0 ||
      input.prompt.length > REFERENCE_GEN_MAX_PROMPT ||
      typeof input.referencePngBase64 !== 'string' ||
      input.referencePngBase64.length === 0 ||
      input.referencePngBase64.length > REFERENCE_GEN_MAX_PNG_BASE64 ||
      !/^[A-Za-z0-9+/=]+$/.test(input.referencePngBase64)
    ) {
      failInput(logger);
      return { ok: false, error: 'Invalid generation request.' };
    }

    const apiKey = store.revealApiKey(REFERENCE_PROVIDER_ID);
    if (!apiKey) {
      return { ok: false, error: 'No Gemini API key stored — add one in Create from Reference first.' };
    }

    try {
      const res = await fetch(`${GEMINI_ENDPOINT}/${REFERENCE_GEN_MODEL}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: input.prompt },
                { inline_data: { mime_type: 'image/png', data: input.referencePngBase64 } },
              ],
            },
          ],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
      });
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        logger.warn('referenceGen.auth', { status: res.status });
        return { ok: false, error: 'Gemini rejected the request — the API key may be missing or invalid.' };
      }
      if (res.status === 429) {
        return { ok: false, error: 'Gemini rate limit reached — try again shortly.' };
      }
      if (!res.ok) {
        logger.warn('referenceGen.http', { status: res.status });
        return { ok: false, error: `Gemini request failed (HTTP ${res.status}).` };
      }
      const json = (await res.json()) as GeminiResponseShape;
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      const imgPart = parts.find((p) => p.inlineData?.data);
      if (!imgPart?.inlineData?.data) {
        return { ok: false, error: 'Gemini returned no image for this brief — try rewording the brief.' };
      }
      return { ok: true, pngBase64: imgPart.inlineData.data, model: REFERENCE_GEN_MODEL };
    } catch (err) {
      logger.warn('referenceGen.network', { message: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: 'Could not reach Gemini — check your connection or use the offline import.' };
    }
  });
}

function failInput(logger: Logger): void {
  logger.warn('referenceGen.invalid-input');
}
