/**
 * PixelForge AI — provider adapters for the desktop job runner (Task 9).
 *
 * PURE construction: every adapter takes its transport as a parameter, so
 * bun tests drive them with fake fetch/SDK modules. The service wiring
 * (service.ts) passes the real Node fetch.
 *
 * Capability honesty (plan §3.1 + user rule "verify model capabilities"):
 * adapters carry the capability flags from the shared contract semantics and
 * REJECT requests they cannot serve instead of silently degrading.
 */

import { AiJobError, JOB_TIMEOUT_MS } from './job-queue';
import type { AiAdapter } from './types';

/** Structural fetch (Node 18+/Electron global) — injectable for tests. */
export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface OpenAiAdapterOptions {
  providerId: string;
  providerLabel: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** n>1 support (gpt-image-1 yes; dall-e-3 no — callers fan out instead) */
  supportsN?: boolean;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * OpenAI-compatible /images/generations adapter (OpenAI, Gemini OpenAI
 * dialect, OpenRouter, local servers). Parses b64_json and https-url
 * responses; url downloads are bounded and https-only.
 */
export function createOpenAiCompatibleAdapter(opts: OpenAiAdapterOptions): AiAdapter {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? JOB_TIMEOUT_MS;
  const kind: AiAdapter['kind'] = opts.providerId === 'openai' ? 'openai' : 'custom';
  return {
    providerId: opts.providerId,
    providerLabel: opts.providerLabel,
    model: opts.model,
    kind,
    supportsN: opts.supportsN ?? kind === 'openai',
    async generate({ fullPrompt, requestSize, count, signal }) {
      if (!opts.apiKey) throw new AiJobError('config_error', 'API key is missing (Settings → AI).');
      const base = opts.baseUrl.trim().replace(/\/+$/, '');
      if (!base) throw new AiJobError('config_error', 'Base URL is not configured (Settings → AI).');
      const body: Record<string, unknown> = {
        model: opts.model || 'gpt-image-1',
        prompt: fullPrompt,
        size: requestSize,
      };
      const n = Math.max(1, Math.min(4, count));
      if (n > 1) {
        if (!this.supportsN) {
          // callers fan out; reaching here is a programming error — fail loud
          throw new AiJobError('n_unsupported', `Provider "${opts.providerId}" does not support n>1.`);
        }
        body['n'] = n;
      }
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await doFetch(`${base}/images/generations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        throw new Error(`network error: ${err instanceof Error ? err.message : 'request failed'}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
      }
      const payload = (await res.json()) as { data?: Array<{ b64_json?: unknown; url?: unknown }> };
      const data = Array.isArray(payload?.data) ? payload.data : [];
      const images: string[] = [];
      const urls: string[] = [];
      for (const item of data) {
        if (typeof item?.b64_json === 'string' && item.b64_json) images.push(item.b64_json);
        else if (typeof item?.url === 'string' && /^https:\/\//.test(item.url)) urls.push(item.url);
      }
      for (const url of urls) {
        const imgRes = await doFetch(url, { method: 'GET', headers: {}, body: '', signal: AbortSignal.timeout(30_000) });
        if (!imgRes.ok) throw new Error(`image download HTTP ${imgRes.status}`);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        images.push(buf.toString('base64'));
      }
      if (images.length === 0) throw new AiJobError('bad_response', 'Provider response contained no images.');
      return images;
    },
  };
}

// ------------------------------------------------------------------ Z.AI

/** Structural shape of the z-ai-web-dev-sdk images API (no compile dep). */
interface ZaiImagesClient {
  images: {
    generations: {
      create(args: { prompt: string; size: string }): Promise<{ data?: Array<{ base64?: string }> }>;
    };
  };
}

export interface ZaiAdapterOptions {
  providerLabel?: string;
  /** injectable loader for tests; default = lazy require of the SDK */
  loadClient?: () => Promise<ZaiImagesClient>;
}

/**
 * Z.AI built-in adapter. The SDK is required LAZILY: a desktop build that
 * ships without it yields a structured provider_unavailable error instead of
 * crashing the main process. No seed/n/mask — the capability flags say so.
 */
export function createZaiAdapter(opts: ZaiAdapterOptions = {}): AiAdapter {
  const load =
    opts.loadClient ??
    (async (): Promise<ZaiImagesClient> => {
      try {
        // lazy CommonJS require of the optional SDK — allowed here by the
        // eslint config exception below (main-process only, never bundled)
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        const mod = require('z-ai-web-dev-sdk') as { default?: { create(): Promise<ZaiImagesClient> } } & { create?(): Promise<ZaiImagesClient> };
        const factory = (mod.default ?? mod) as { create(): Promise<ZaiImagesClient> };
        return await factory.create();
      } catch (err) {
        throw new AiJobError(
          'provider_unavailable',
          `The built-in Z.AI service is unavailable in this build (${err instanceof Error ? err.message : 'load failed'}). Configure an OpenAI-compatible provider in Settings → AI.`,
        );
      }
    });
  return {
    providerId: 'zai',
    providerLabel: opts.providerLabel ?? 'Z.AI (built-in)',
    model: 'auto',
    kind: 'zai',
    supportsN: false,
    async generate({ fullPrompt, requestSize, count, signal }) {
      void count; // n unsupported → the manager fans out; adapter always does 1
      if (signal.aborted) throw newDOMAbort();
      let client: ZaiImagesClient;
      try {
        client = await load();
      } catch (err) {
        if (err instanceof AiJobError) throw err;
        throw new AiJobError(
          'provider_unavailable',
          `The built-in Z.AI service is unavailable in this build (${err instanceof Error ? err.message : 'load failed'}). Configure an OpenAI-compatible provider in Settings → AI.`,
        );
      }
      try {
        const res = await client.images.generations.create({
          prompt: fullPrompt,
          size: requestSize,
        });
        const images = (res?.data ?? []).map((d) => d.base64 ?? '').filter((b) => b.length > 0);
        if (images.length === 0) throw new AiJobError('bad_response', 'Z.AI returned no image data.');
        return images;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        if (err instanceof AiJobError) throw err;
        throw new Error(`Z.AI generation failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    },
  };
}

// ------------------------------------------------------------------ mock

export interface MockAdapterOptions {
  providerId?: string;
  /** deterministic pattern seed so smokes can assert exact bytes */
  seedBytes?: number;
  delayMs?: number;
}

/**
 * Deterministic mock adapter for smokes/tests (PF_AI_MOCK=1): emits a tiny
 * valid PNG built from a fixed pattern — NO network, NO cost. Used to verify
 * the full desktop pipeline without touching a real provider.
 */
export function createMockAdapter(opts: MockAdapterOptions = {}): AiAdapter {
  // 8×8 PNG, all opaque, deterministic checker in two colors + PNG signature
  const pngBase64 = (): string => {
    const w = 8;
    const h = 8;
    const raw: number[] = [];
    for (let y = 0; y < h; y++) {
      raw.push(0); // filter none
      for (let x = 0; x < w; x++) {
        const on = ((x + y) % 2 === 0) !== ((opts.seedBytes ?? 0) % 2 === 1);
        raw.push(on ? 20 : 200, on ? 160 : 60, on ? 120 : 90);
      }
    }
    return encodeMinimalPng(w, h, raw);
  };
  const img = pngBase64();
  return {
    providerId: opts.providerId ?? 'mock',
    providerLabel: 'Mock (offline)',
    model: 'mock-pattern',
    kind: 'custom',
    supportsN: true,
    async generate({ count, signal }) {
      if (opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, opts.delayMs);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(newDOMAbort());
          }, { once: true });
        });
      }
      if (signal.aborted) throw newDOMAbort();
      return Array.from({ length: Math.max(1, Math.min(4, count)) }, () => img);
    },
  };
}

function newDOMAbort(): Error {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

/** Minimal deterministic PNG encoder (CRC32 + zlib stored blocks) for the mock. */
function encodeMinimalPng(w: number, h: number, raw: number[]): string {
  const crcTable = (() => {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (bytes: number[]): number => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: number[]): number[] => {
    const len = data.length;
    const out = [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255];
    const typeBytes = [...type].map((ch) => ch.charCodeAt(0));
    const body = [...typeBytes, ...data];
    const crc = crc32(body);
    return [...out, ...body, (crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
  };
  const ihdr = [
    (w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255,
    (h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255,
    8, 2, 0, 0, 0, // 8-bit RGB
  ];
  // zlib: stored (uncompressed) deflate blocks
  const zlib: number[] = [0x78, 0x01];
  const blocks: number[] = [];
  for (let i = 0; i < raw.length; i += 65535) {
    const slice = raw.slice(i, i + 65535);
    const final = i + 65535 >= raw.length ? 1 : 0;
    blocks.push(final, slice.length & 255, (slice.length >>> 8) & 255, (~slice.length & 0xffff) & 255, ((~slice.length & 0xffff) >>> 8) & 255, ...slice);
  }
  const adler = (() => {
    let a = 1, b = 0;
    for (const byte of raw) {
      a = (a + byte) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  })();
  zlib.push(...blocks, (adler >>> 24) & 255, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255);

  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', zlib),
    ...chunk('IEND', []),
  ];
  return Buffer.from(bytes).toString('base64');
}
