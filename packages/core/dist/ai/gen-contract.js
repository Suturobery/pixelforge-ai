"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZAI_SUPPORTED_SIZES = exports.CapabilityError = exports.PRICE_TABLE = exports.RECIPE_PRESETS = exports.GENERATION_TASK_SKILLS = exports.SIZE_PRESETS = exports.PROVIDER_CAPABILITIES = void 0;
exports.capabilitiesFor = capabilitiesFor;
exports.isGenerationTaskSkill = isGenerationTaskSkill;
exports.generationTaskStyleTags = generationTaskStyleTags;
exports.buildFullPrompt = buildFullPrompt;
exports.requestSizeFor = requestSizeFor;
exports.estimateCostUsd = estimateCostUsd;
exports.priceBasisFor = priceBasisFor;
exports.cacheKeyFor = cacheKeyFor;
exports.planOpenAiImagesRequest = planOpenAiImagesRequest;
exports.parseOpenAiImagesResponse = parseOpenAiImagesResponse;
const digest_1 = require("../persist/digest");
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
exports.PROVIDER_CAPABILITIES = {
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
function capabilitiesFor(kind) {
    return exports.PROVIDER_CAPABILITIES[kind];
}
// ----------------------------------------------------------------- recipes
/** Sprite dimension presets offered in the Generate panel. */
exports.SIZE_PRESETS = [
    { label: '16×16', w: 16, h: 16 },
    { label: '24×24', w: 24, h: 24 },
    { label: '32×32', w: 32, h: 32 },
    { label: '48×48', w: 48, h: 48 },
    { label: '64×64', w: 64, h: 64 },
    { label: '96×96', w: 96, h: 96 },
    { label: '128×128', w: 128, h: 128 },
];
/**
 * The two provider-backed tasks PixelForge can honestly offer today.
 *
 * `variation` deliberately creates a fresh concept from text. It is not
 * presented as image-to-image editing because not every supported provider
 * has a verified edits API wired into PixelForge yet.
 */
exports.GENERATION_TASK_SKILLS = [
    {
        id: 'create',
        label: 'Create',
        description: 'Make a new sprite from your prompt.',
        styleTags: [],
    },
    {
        id: 'variation',
        label: 'Concept variation',
        description: 'Make a fresh alternate concept from the same prompt; this does not edit an existing image.',
        styleTags: [
            'create a distinct but style-consistent alternate concept',
            'change the visual interpretation while keeping the requested subject readable',
            'this is a fresh composition, not an edit of an existing image',
        ],
    },
];
/** Use a narrow allowlist at every caller boundary; unknown task ids become Create. */
function isGenerationTaskSkill(value) {
    return typeof value === 'string' && exports.GENERATION_TASK_SKILLS.some((skill) => skill.id === value);
}
/** Deterministic, bounded tags for a provider-backed task. */
function generationTaskStyleTags(skillId) {
    return [...(exports.GENERATION_TASK_SKILLS.find((skill) => skill.id === skillId)?.styleTags ?? [])];
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
exports.RECIPE_PRESETS = [
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
function buildFullPrompt(prompt, styleTags) {
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
function requestSizeFor(width, height) {
    const aspect = width / height;
    if (aspect > 1.2)
        return '1344x768';
    if (aspect < 0.83)
        return '768x1344';
    return '1024x1024';
}
/**
 * Documented price APPROXIMATIONS for cost pre-flight estimates (plan §3.2
 * "pre-flight estimate"). These are the publicly listed list prices at
 * implementation time; they are ESTIMATES and are always rendered with "≈"
 * in the UI. Providers without a known price → null (shown as "cost: n/a").
 */
exports.PRICE_TABLE = {
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
function estimateCostUsd(providerKind, model, images) {
    if (providerKind === 'zai')
        return null; // built-in sandbox service — no public pricing
    const entry = exports.PRICE_TABLE[model.trim().toLowerCase()];
    if (!entry)
        return null;
    return entry.usdPerImage * Math.max(1, images);
}
function priceBasisFor(model) {
    return exports.PRICE_TABLE[model.trim().toLowerCase()]?.basis ?? null;
}
// ------------------------------------------------------------------ cache
/**
 * Deterministic cache key for a generation (plan §3.2: hash(recipe + seed +
 * model + prompt) → hits cost nothing). Sha256 over the canonical field
 * list; the seed participates ONLY when the provider actually honors seeds
 * (otherwise two "same" requests with different seeds must share the cache
 * entry — the provider cannot distinguish them anyway).
 */
async function cacheKeyFor(input) {
    const kind = capabilitiesFor(input.providerKind);
    const parts = [
        input.providerId,
        input.providerKind,
        input.model,
        input.prompt,
        input.requestSize,
        kind.seed && input.seed !== undefined ? String(input.seed) : '',
    ];
    return (0, digest_1.sha256Hex)(new TextEncoder().encode(parts.join('\u0000')));
}
class CapabilityError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
exports.CapabilityError = CapabilityError;
/**
 * Plan a request against an OpenAI-compatible /images/generations endpoint,
 * VALIDATED against the provider's declared capabilities (the user
 * requirement: verify model capabilities rather than assuming). Throws
 * CapabilityError for anything the provider cannot do.
 */
function planOpenAiImagesRequest(input) {
    const caps = capabilitiesFor(input.kind);
    if (!caps.imageGeneration) {
        throw new CapabilityError('image_generation_unsupported', `Provider kind "${input.kind}" has no image-generation API.`);
    }
    const base = input.baseUrl.trim().replace(/\/+$/, '');
    if (!base)
        throw new CapabilityError('config_error', 'Provider base URL is not configured.');
    if (!input.apiKey)
        throw new CapabilityError('config_error', 'Provider API key is missing (store it in Settings).');
    // "auto" (or blank) means the provider's own default. OpenAI's images API
    // has no default — send gpt-image-1. Z.AI rejects "auto" and a null model
    // alike (HTTP 400 code 1211 / 500 NPE): its verified image model is
    // cogview-4-250304, so default to that. A user-picked code always wins.
    const requestedModel = (input.model ?? '').trim();
    const auto = !requestedModel || requestedModel.toLowerCase() === 'auto';
    const effectiveModel = auto
        ? (input.kind === 'openai' ? 'gpt-image-1' : input.kind === 'zai' ? 'cogview-4-250304' : '')
        : requestedModel;
    const body = {
        prompt: input.fullPrompt,
        size: input.requestSize,
    };
    if (effectiveModel)
        body['model'] = effectiveModel;
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
/**
 * Parse an OpenAI-compatible images response. Accepts b64_json payloads and
 * https(s) URLs (URL form is returned in `urlImages` — the caller fetches;
 * here we only extract). Throws on malformed payloads so errors are
 * structured, never silent.
 */
function parseOpenAiImagesResponse(payload) {
    const data = payload?.data;
    if (!Array.isArray(data) || data.length === 0) {
        throw new CapabilityError('bad_response', 'Image response contained no data array.');
    }
    const images = [];
    const urlImages = [];
    let revisedPrompt = null;
    for (const item of data) {
        if (typeof item !== 'object' || item === null)
            continue;
        const rec = item;
        if (typeof rec['revised_prompt'] === 'string' && !revisedPrompt)
            revisedPrompt = rec['revised_prompt'];
        if (typeof rec['b64_json'] === 'string' && rec['b64_json'].length > 0) {
            images.push(rec['b64_json']);
        }
        else if (typeof rec['url'] === 'string' && /^https:\/\//.test(rec['url'])) {
            urlImages.push(rec['url']);
        }
    }
    if (images.length === 0 && urlImages.length === 0) {
        throw new CapabilityError('bad_response', 'Image response contained neither b64_json nor an https url.');
    }
    return { images, urlImages, revisedPrompt };
}
/** The exact aspect→request-size mapping exposed to tests. */
exports.ZAI_SUPPORTED_SIZES = [
    '1024x1024',
    '768x1344',
    '864x1152',
    '1344x768',
    '1152x864',
    '1440x720',
    '720x1440',
];
