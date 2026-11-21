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
export declare const PROVIDER_CAPABILITIES: Record<ProviderKind, ProviderCapabilities>;
export declare function capabilitiesFor(kind: ProviderKind): ProviderCapabilities;
/** Sprite dimension presets offered in the Generate panel. */
export declare const SIZE_PRESETS: Array<{
    label: string;
    w: number;
    h: number;
}>;
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
 * The two provider-backed tasks PixelForge can honestly offer today.
 *
 * `variation` deliberately creates a fresh concept from text. It is not
 * presented as image-to-image editing because not every supported provider
 * has a verified edits API wired into PixelForge yet.
 */
export declare const GENERATION_TASK_SKILLS: readonly [{
    readonly id: "create";
    readonly label: "Create";
    readonly description: "Make a new sprite from your prompt.";
    readonly styleTags: readonly [];
}, {
    readonly id: "variation";
    readonly label: "Concept variation";
    readonly description: "Make a fresh alternate concept from the same prompt; this does not edit an existing image.";
    readonly styleTags: readonly ["create a distinct but style-consistent alternate concept", "change the visual interpretation while keeping the requested subject readable", "this is a fresh composition, not an edit of an existing image"];
}];
export type GenerationTaskSkillId = (typeof GENERATION_TASK_SKILLS)[number]['id'];
/** Use a narrow allowlist at every caller boundary; unknown task ids become Create. */
export declare function isGenerationTaskSkill(value: unknown): value is GenerationTaskSkillId;
/** Deterministic, bounded tags for a provider-backed task. */
export declare function generationTaskStyleTags(skillId: GenerationTaskSkillId | undefined): string[];
/**
 * Recipe presets (plan §3.2 "recipe preset: size, palette, style tags, seed,
 * provider"). Deterministic prompt shaping — no hidden randomness.
 *
 * Quality follow-up (Task 9): tags now push for COMPLETE, centered subjects
 * (nothing cropped, margins around the sprite, readable silhouette, clear
 * outline) — the audit's requirement #2. Prompting GUIDES the model; it
 * cannot guarantee complete subjects (the UI says so).
 */
export declare const RECIPE_PRESETS: RecipePreset[];
/**
 * Sprite-oriented prompt engineering (evolved from the prototype's verified
 * base tags + the recipe's style tags; quality follow-up adds anti-clutter
 * and anti-cropping guidance). Deterministic. The user prompt always comes
 * FIRST so it keeps the strongest weight; tags shape, never replace it.
 */
export declare function buildFullPrompt(prompt: string, styleTags: string[]): string;
/** Provider request size for a target sprite aspect (Z.AI-supported sizes). */
export declare function requestSizeFor(width: number, height: number): string;
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
export declare const PRICE_TABLE: Record<string, PriceEntry>;
/**
 * Estimated USD cost for a generation, or null when the price is unknown.
 * NEVER an exact charge — callers must label it as an estimate.
 */
export declare function estimateCostUsd(providerKind: ProviderKind, model: string, images: number): number | null;
export declare function priceBasisFor(model: string): string | null;
/**
 * Deterministic cache key for a generation (plan §3.2: hash(recipe + seed +
 * model + prompt) → hits cost nothing). Sha256 over the canonical field
 * list; the seed participates ONLY when the provider actually honors seeds
 * (otherwise two "same" requests with different seeds must share the cache
 * entry — the provider cannot distinguish them anyway).
 */
export declare function cacheKeyFor(input: {
    providerId: string;
    providerKind: ProviderKind;
    model: string;
    prompt: string;
    requestSize: string;
    seed?: number;
}): Promise<string>;
export interface OpenAiImagesPlan {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
}
export declare class CapabilityError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * Plan a request against an OpenAI-compatible /images/generations endpoint,
 * VALIDATED against the provider's declared capabilities (the user
 * requirement: verify model capabilities rather than assuming). Throws
 * CapabilityError for anything the provider cannot do.
 */
export declare function planOpenAiImagesRequest(input: {
    kind: ProviderKind;
    baseUrl: string;
    apiKey: string;
    model: string;
    fullPrompt: string;
    requestSize: string;
    count: number;
    seed?: number;
    timeoutMs: number;
}): OpenAiImagesPlan;
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
export declare function parseOpenAiImagesResponse(payload: unknown): {
    images: string[];
    urlImages: string[];
    revisedPrompt: string | null;
};
/** The exact aspect→request-size mapping exposed to tests. */
export declare const ZAI_SUPPORTED_SIZES: readonly ["1024x1024", "768x1344", "864x1152", "1344x768", "1152x864", "1440x720", "720x1440"];
