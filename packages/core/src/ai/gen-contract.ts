/**
 * @pixelforge/core — AI generation contract (v3.1 Plan §3.1/§3.2; Task 9).
 *
 * PURE, runtime-independent pieces of the AI generation system shared by the
 * web API route and the Electron-main job runner:
 *
 *   • provider capability matrix — what each provider KIND actually supports
 *     (verified against the provider APIs; NOTHING is assumed: callers MUST
 *     consult `capabilities()` before sending seeds/n/masks/img2img)
 *   • recipe presets + prompt engineering (sprite-oriented full prompt)
 *   • request planning for the OpenAI-compatible images dialect
 *     (capability-checked) and response parsing (b64_json | url)
 *   • deterministic cache keys (recipe+seed+model+prompt → sha256)
 *   • cost ESTIMATES from a documented price table (null when unknown —
 *     estimates are never presented as exact provider charges)
 *
 * No fetch, no DOM, no Node APIs: transport stays with the caller. This
 * module is unit-tested in packages/core/tests/ai-gen-contract.test.ts.
 */

import { sha256Hex } from '../persist/digest';

// ------------------------------------------------------------------ types

export type ProviderKind = 'zai' | 'openai' | 'custom';

export interface ProviderCapabilities {
  /** text → image generation */
  imageGeneration: boolean;
  /** image → image editing / inpainting */
  img2img: boolean;
  /** deterministic seed parameter honored by the provider */
  seed: boolean;
  /** mask/inpaint parameter */
  mask: boolean;
  /** `n` parameter (multiple images per request) */
  n: boolean;
  /** provider is usable without a user API key */
  builtIn: boolean;
  /** human explanation shown in the UI; updated when verification changes */
  notes: string;
}

/**
 * Capability matrix per provider KIND (v3.1 §3.1 ships Z.AI + OpenAI-compat).
 *
 * Verification status (Task 9, honest record):
 *   • zai          — verified LIVE in this sandbox (images.generations,
 *                    prompt+size only; no documented seed/n/mask support).
 *   • openai       — verified against the public images API contract
 *                    (gpt-image-1: prompt/size/n/quality; NO seed param;
 *                    img2img+mask via the separate edits endpoint — Task 9
 *                    does not call edits). NOT live-tested in this sandbox
 *                    (no API key) — contract tests only, marked below.
 *   • custom       — OpenAI-compatible dialect assumed; capabilities are the
 *                    conservative subset (n unsupported unless configured).
 */
export const PROVIDER_CAPABILITIES: Record<ProviderKind, ProviderCapabilities> = {
  zai: {
    imageGeneration: true,
    img2img: false,
    seed: false,
    mask: false,
    n: false,
    builtIn: true,
    notes: 'Verified live: prompt+size text-to-image. No seed/n/mask support.',
  },
  openai: {
    imageGeneration: true,
    img2img: true,
    seed: false,
    mask: true,
    n: true,
    builtIn: false,
    notes: 'Images API: prompt/size/n/quality. No seed param. img2img+mask via /images/edits (not used by Task 9). Contract-tested, not live-tested.',
  },
  custom: {
    imageGeneration: true,
    img2img: false,
    seed: false,
    mask: false,
    n: false,
    builtIn: false,
    notes: 'OpenAI-compatible /images/generations dialect; conservative capability set.',
  },
};

export function capabilitiesFor(kind: ProviderKind): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[kind];
}

// ----------------------------------------------------------------- recipes

/** Sprite dimension presets offered in the Generate panel. */
export const SIZE_PRESETS: Array<{ label: string; w: number; h: number }> = [
  { label: '16×16', w: 16, h: 16 },
  { label: '24×24', w: 24, h: 24 },
  { label: '32×32', w: 32, h: 32 },
  { label: '48×48', w: 48, h: 48 },
  { label: '64×64', w: 64, h: 64 },
  { label: '96×96', w: 96, h: 96 },
  { label: '128×128', w: 128, h: 128 },
];

/**
 * A generation recipe: everything needed to reproduce a generation
 * (plan §3.2 step 1 + §3.4 provenance). Persisted with candidates.
 */
export interface GenRecipe {
  prompt: string;
  /** target sprite dimensions (normalize output, not the provider size) */
  width: number;
  height: number;
  providerId: string;
  model: string;
  /** provider-side request size (e.g. 1024x1024); picked from the aspect */
  requestSize: string;
  /** optional seed — only sent when capabilitiesFor(kind).seed */
  seed?: number;
  /** candidate count 1..4 — fanned out when the provider lacks `n` */
  count: number;
  /** style tags appended to the prompt (recipe presets own these) */
  styleTags: string[];
}

export interface RecipePreset {
  id: string;
  label: string;
  description: string;
  styleTags: string[];
}

/**
 * Recipe presets (plan §3.2 "recipe preset: size, palette, style tags, seed,
 * provider"). Deterministic prompt shaping — no hidden randomness.
 *
 * Quality follow-up (Task 9): tags now push for COMPLETE, centered subjects
 * (nothing cropped, margins around the sprite, readable silhouette, clear
 * outline) — the audit's requirement #2. Prompting GUIDES the model; it
 * cannot guarantee complete subjects (the UI says so).
 */
export const RECIPE_PRESETS: RecipePreset[] = [
  {
    id: 'character',
    label: 'Character',
    description: 'Full-body game character, front or side view, clean silhouette',
    styleTags: [
      'single character, one subject only',
      'full body visible from head to toe, nothing cropped, no cut-off limbs',
      'centered composition with clear margins around the subject',
      'consistent character proportions',
      'simple readable silhouette',
      'clear dark pixel outline around the sprite',
      'front view',
    ],
  },
  {
    id: 'item',
    label: 'Item / Prop',
    description: 'Inventory-style object centered on transparency-friendly backdrop',
    styleTags: [
      'single object, one subject only',
      'whole object visible, nothing cropped',
      'centered composition with clear margins around the object',
      'inventory item style',
      'simple readable silhouette',
      'clear dark pixel outline around the sprite',
    ],
  },
  {
    id: 'tile',
    label: 'Tile / Terrain',
    description: 'Seamless-friendly terrain or texture tile filling the frame',
    styleTags: [
      'seamless texture tile',
      'pattern fills the entire frame edge to edge',
      'no border vignette',
      'no objects cut off at the borders',
    ],
  },
  {
    id: 'free',
    label: 'Free',
    description: 'Your prompt as-is with only the pixel-art base tags',
    styleTags: [],
  },
];

/**
 * Sprite-oriented prompt engineering (evolved from the prototype's verified
 * base tags + the recipe's style tags; quality follow-up adds anti-clutter
 * and anti-cropping guidance). Deterministic. The user prompt always comes
 * FIRST so it keeps the strongest weight; tags shape, never replace it.
 */
export function buildFullPrompt(prompt: string, styleTags: string[]): string {
  const base = [
    'pixel art sprite',
    'retro 16-bit game asset style',
    'crisp clean pixels, sharp edges, limited color palette',
    'simple readable shapes, minimal clutter',
    'plain solid white background, no shadow, no text, no watermark',
    'no background scenery, no extra objects around the subject',
  ];
  return [prompt.trim(), ...styleTags, ...base].filter(Boolean).join(', ');
}

/** Provider request size for a target sprite aspect (Z.AI-supported sizes). */
export function requestSizeFor(width: number, height: number): string {
  const aspect = width / height;
  if (aspect > 1.2) return '1344x768';
  if (aspect < 0.83) return '768x1344';
  return '1024x1024';
}

// ---------------------------------------------------------------- pricing

export interface PriceEntry {
  /** USD per image for the listed request size class */
  usdPerImage: number;
  basis: string;
}

/**
 * Documented price APPROXIMATIONS for cost pre-flight estimates (plan §3.2
 * "pre-flight estimate"). These are the publicly listed list prices at
 * implementation time; they are ESTIMATES and are always rendered with "≈"
 * in the UI. Providers without a known price → null (shown as "cost: n/a").
 */
export const PRICE_TABLE: Record<string, PriceEntry> = {
  'gpt-image-1': { usdPerImage: 0.027, basis: 'openai list price, medium quality ~1024²' },
  'gpt-image-1-mini': { usdPerImage: 0.005, basis: 'openai list price, medium quality ~1024²' },
  'dall-e-3': { usdPerImage: 0.04, basis: 'openai list price, standard 1024²' },
  'dall-e-2': { usdPerImage: 0.02, basis: 'openai list price, 1024²' },
  'gemini-2.5-flash-image': { usdPerImage: 0.03, basis: 'google list price approximation per image' },
};

/**
 * Estimated USD cost for a generation, or null when the price is unknown.
 * NEVER an exact charge — callers must label it as an estimate.
 */
export function estimateCostUsd(providerKind: ProviderKind, model: string, images: number): number | null {
  if (providerKind === 'zai') return null; // built-in sandbox service — no public pricing
  const entry = PRICE_TABLE[model.trim().toLowerCase()];
  if (!entry) return null;
  return entry.usdPerImage * Math.max(1, images);
}

export function priceBasisFor(model: string): string | null {
  return PRICE_TABLE[model.trim().toLowerCase()]?.basis ?? null;
}

// ------------------------------------------------------------------ cache

/**
 * Deterministic cache key for a generation (plan §3.2: hash(recipe + seed +
 * model + prompt) → hits cost nothing). Sha256 over the canonical field
 * list; the seed participates ONLY when the provider actually honors seeds
 * (otherwise two "same" requests with different seeds must share the cache
 * entry — the provider cannot distinguish them anyway).
 */
export async function cacheKeyFor(input: {
  providerId: string;
  providerKind: ProviderKind;
  model: string;
  prompt: string;
  requestSize: string;
  seed?: number;
}): Promise<string> {
  const kind = capabilitiesFor(input.providerKind);
  const parts = [
    input.providerId,
    input.providerKind,
    input.model,
    input.prompt,
    input.requestSize,
    kind.seed && input.seed !== undefined ? String(input.seed) : '',
  ];
  return sha256Hex(new TextEncoder().encode(parts.join('\u0000')));
}

// ------------------------------------------------- openai-compatible dialect

export interface OpenAiImagesPlan {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export class CapabilityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Plan a request against an OpenAI-compatible /images/generations endpoint,
 * VALIDATED against the provider's declared capabilities (the user
 * requirement: verify model capabilities rather than assuming). Throws
 * CapabilityError for anything the provider cannot do.
 */
export function planOpenAiImagesRequest(input: {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  fullPrompt: string;
  requestSize: string;
  count: number;
  seed?: number;
  timeoutMs: number;
}): OpenAiImagesPlan {
  const caps = capabilitiesFor(input.kind);
  if (!caps.imageGeneration) {
    throw new CapabilityError('image_generation_unsupported', `Provider kind "${input.kind}" has no image-generation API.`);
  }
  const base = input.baseUrl.trim().replace(/\/+$/, '');
  if (!base) throw new CapabilityError('config_error', 'Provider base URL is not configured.');
  if (!input.apiKey) throw new CapabilityError('config_error', 'Provider API key is missing (store it in Settings).');

  const body: Record<string, unknown> = {
    model: input.model || 'gpt-image-1',
    prompt: input.fullPrompt,
    size: input.requestSize,
  };
  const count = Math.max(1, Math.min(4, Math.floor(input.count)));
  if (count > 1) {
    if (!caps.n) {
      throw new CapabilityError('n_unsupported', `Provider "${input.kind}" does not support n>1 — fan out into separate jobs instead.`);
    }
    body['n'] = count;
  }
  if (input.seed !== undefined) {
    if (!caps.seed) {
      throw new CapabilityError('seed_unsupported', `Provider "${input.kind}" does not support seeds — remove the seed or pick a provider that honors it.`);
    }
    body['seed'] = input.seed;
  }

  return {
    url: `${base}/images/generations`,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${input.apiKey}` },
    body,
  };
}

export interface ParsedImagesResponse {
  /** base64-encoded image bytes (may be PNG/JPEG/WebP — decode happens elsewhere) */
  images: string[];
  /** provider-reported revised prompt, when present */
  revisedPrompt: string | null;
}

/**
 * Parse an OpenAI-compatible images response. Accepts b64_json payloads and
 * https(s) URLs (URL form is returned in `urlImages` — the caller fetches;
 * here we only extract). Throws on malformed payloads so errors are
 * structured, never silent.
 */
export function parseOpenAiImagesResponse(payload: unknown): { images: string[]; urlImages: string[]; revisedPrompt: string | null } {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new CapabilityError('bad_response', 'Image response contained no data array.');
  }
  const images: string[] = [];
  const urlImages: string[] = [];
  let revisedPrompt: string | null = null;
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec['revised_prompt'] === 'string' && !revisedPrompt) revisedPrompt = rec['revised_prompt'];
    if (typeof rec['b64_json'] === 'string' && rec['b64_json'].length > 0) {
      images.push(rec['b64_json']);
    } else if (typeof rec['url'] === 'string' && /^https:\/\//.test(rec['url'])) {
      urlImages.push(rec['url']);
    }
  }
  if (images.length === 0 && urlImages.length === 0) {
    throw new CapabilityError('bad_response', 'Image response contained neither b64_json nor an https url.');
  }
  return { images, urlImages, revisedPrompt };
}

/** The exact aspect→request-size mapping exposed to tests. */
export const ZAI_SUPPORTED_SIZES = [
  '1024x1024',
  '768x1344',
  '864x1152',
  '1344x768',
  '1152x864',
  '1440x720',
  '720x1440',
] as const;
