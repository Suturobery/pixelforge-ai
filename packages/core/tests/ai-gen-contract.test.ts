/**
 * Task 9 — AI generation contract tests (v3.1 Plan §3.1/§3.2).
 *
 * Pins the provider capability matrix, prompt engineering, deterministic
 * cache keys, cost ESTIMATION table, and the OpenAI-compatible images
 * dialect planning/parsing — all WITHOUT any network I/O.
 */

import { describe, expect, test } from 'bun:test';

import {
  buildFullPrompt,
  cacheKeyFor,
  CapabilityError,
  capabilitiesFor,
  estimateCostUsd,
  parseOpenAiImagesResponse,
  planOpenAiImagesRequest,
  PRICE_TABLE,
  priceBasisFor,
  RECIPE_PRESETS,
  requestSizeFor,
  SIZE_PRESETS,
} from '../src/index';

describe('gen-contract: capability matrix', () => {
  test('#C1 zai: text-to-image only, no seed/n/mask, built-in', () => {
    const caps = capabilitiesFor('zai');
    expect(caps.imageGeneration).toBe(true);
    expect(caps.img2img).toBe(false);
    expect(caps.seed).toBe(false);
    expect(caps.n).toBe(false);
    expect(caps.builtIn).toBe(true);
  });

  test('#C2 openai: images + n, no seed; img2img via edits only', () => {
    const caps = capabilitiesFor('openai');
    expect(caps.imageGeneration).toBe(true);
    expect(caps.n).toBe(true);
    expect(caps.seed).toBe(false);
    expect(caps.img2img).toBe(true); // /images/edits — NOT used by Task 9
    expect(caps.builtIn).toBe(false);
  });

  test('#C3 anthropic: NO image generation at all (verified)', () => {
    expect(capabilitiesFor('anthropic').imageGeneration).toBe(false);
  });

  test('#C4 custom: conservative subset', () => {
    const caps = capabilitiesFor('custom');
    expect(caps.imageGeneration).toBe(true);
    expect(caps.seed).toBe(false);
    expect(caps.n).toBe(false);
  });
});

describe('gen-contract: prompt engineering', () => {
  test('#P1 full prompt = prompt + style tags + base tags (deterministic order)', () => {
    // v2.1 quality follow-up: base tags now include anti-clutter +
    // anti-cropping guidance and watermark/scene negatives
    const p = buildFullPrompt('knight with sword', ['single character', 'front view']);
    expect(p).toBe(
      'knight with sword, single character, front view, pixel art sprite, ' +
      'retro 16-bit game asset style, crisp clean pixels, sharp edges, limited color palette, ' +
      'simple readable shapes, minimal clutter, ' +
      'plain solid white background, no shadow, no text, no watermark, ' +
      'no background scenery, no extra objects around the subject',
    );
    // quality-follow-up recipe tags push for complete, centered subjects
    const character = RECIPE_PRESETS.find((r) => r.id === 'character')!;
    const tags = character.styleTags.join(' ');
    expect(tags).toContain('full body visible');
    expect(tags).toContain('nothing cropped');
    expect(tags).toContain('centered composition');
  });

  test('#P2 free recipe has no extra tags; every preset carries a description', () => {
    const free = RECIPE_PRESETS.find((r) => r.id === 'free')!;
    expect(free.styleTags).toEqual([]);
    expect(buildFullPrompt('  spaced prompt  ', [])).not.toContain('  ,');
    for (const r of RECIPE_PRESETS) {
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.description.length).toBeGreaterThan(0);
      expect(Array.isArray(r.styleTags)).toBe(true);
    }
  });

  test('#P3 request size follows the sprite aspect', () => {
    expect(requestSizeFor(32, 32)).toBe('1024x1024');
    expect(requestSizeFor(64, 32)).toBe('1344x768');
    expect(requestSizeFor(32, 64)).toBe('768x1344');
    expect(SIZE_PRESETS.length).toBeGreaterThanOrEqual(7);
  });
});

describe('gen-contract: request planning (capability-checked)', () => {
  const base = {
    kind: 'openai' as const,
    baseUrl: 'https://api.openai.com/v1/',
    apiKey: 'sk-test',
    model: 'gpt-image-1',
    fullPrompt: 'a sprite',
    requestSize: '1024x1024',
    count: 1,
    timeoutMs: 120_000,
  };

  test('#R1 plans a canonical request; trailing slash on baseUrl is stripped', () => {
    const plan = planOpenAiImagesRequest(base);
    expect(plan.url).toBe('https://api.openai.com/v1/images/generations');
    expect(plan.body['model']).toBe('gpt-image-1');
    expect(plan.body['prompt']).toBe('a sprite');
    expect(plan.body['size']).toBe('1024x1024');
    expect(plan.headers['Authorization']).toBe('Bearer sk-test');
    expect(plan.body['n']).toBeUndefined(); // count=1 → no n param
  });

  test('#R2 n=4 allowed for openai, rejected for zai/custom (fan out instead)', () => {
    expect(planOpenAiImagesRequest({ ...base, count: 4 }).body['n']).toBe(4);
    expect(() => planOpenAiImagesRequest({ ...base, kind: 'zai', count: 2 })).toThrow(CapabilityError);
    try {
      planOpenAiImagesRequest({ ...base, kind: 'custom', count: 2 });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CapabilityError);
      expect((err as CapabilityError).code).toBe('n_unsupported');
    }
  });

  test('#R3 seed requests are rejected for providers without seed support', () => {
    try {
      planOpenAiImagesRequest({ ...base, seed: 42 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CapabilityError).code).toBe('seed_unsupported');
    }
  });

  test('#R4 anthropic is refused outright (no image API)', () => {
    try {
      planOpenAiImagesRequest({ ...base, kind: 'anthropic' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as CapabilityError).code).toBe('image_generation_unsupported');
    }
  });

  test('#R5 missing config produces structured config errors', () => {
    expect(() => planOpenAiImagesRequest({ ...base, apiKey: '' })).toThrow(/API key/);
    expect(() => planOpenAiImagesRequest({ ...base, baseUrl: '' })).toThrow(/base URL/);
  });

  test('#R6 count is clamped to [1, 4]', () => {
    expect(planOpenAiImagesRequest({ ...base, count: 99 }).body['n']).toBe(4);
  });
});

describe('gen-contract: response parsing', () => {
  test('#X1 b64_json payloads parse; revised prompt surfaces once', () => {
    const r = parseOpenAiImagesResponse({
      data: [
        { b64_json: 'AAA', revised_prompt: 'a better sprite' },
        { b64_json: 'BBB', revised_prompt: 'ignored' },
      ],
    });
    expect(r.images).toEqual(['AAA', 'BBB']);
    expect(r.urlImages).toEqual([]);
    expect(r.revisedPrompt).toBe('a better sprite');
  });

  test('#X2 https urls are extracted for caller-side download', () => {
    const r = parseOpenAiImagesResponse({ data: [{ url: 'https://cdn.example/img.png' }] });
    expect(r.urlImages).toEqual(['https://cdn.example/img.png']);
  });

  test('#X3 malformed payloads throw structured bad_response errors', () => {
    expect(() => parseOpenAiImagesResponse({})).toThrow(/no data/);
    expect(() => parseOpenAiImagesResponse({ data: [] })).toThrow(/no data/);
    expect(() => parseOpenAiImagesResponse({ data: [{ url: 'javascript:alert(1)' }] })).toThrow(/neither b64_json/);
    expect(() => parseOpenAiImagesResponse({ data: ['nope'] })).toThrow(/neither b64_json/);
  });
});

describe('gen-contract: cost estimation (ESTIMATES only)', () => {
  test('#E1 known models price from the table × image count', () => {
    expect(estimateCostUsd('openai', 'gpt-image-1', 1)).toBeCloseTo(PRICE_TABLE['gpt-image-1']!.usdPerImage, 10);
    expect(estimateCostUsd('openai', 'gpt-image-1', 4)).toBeCloseTo(PRICE_TABLE['gpt-image-1']!.usdPerImage * 4, 10);
    expect(estimateCostUsd('openai', 'DALL-E-3', 1)).toBeCloseTo(0.04, 10); // case-insensitive
  });

  test('#E2 unknown models and zai/anthropic → null (never a made-up number)', () => {
    expect(estimateCostUsd('openai', 'mystery-model', 1)).toBeNull();
    expect(estimateCostUsd('zai', 'auto', 1)).toBeNull();
    expect(estimateCostUsd('anthropic', 'claude-sonnet-4-5', 1)).toBeNull();
    expect(priceBasisFor('gpt-image-1-mini')).toContain('openai');
    expect(priceBasisFor('mystery-model')).toBeNull();
  });
});

describe('gen-contract: cache keys', () => {
  test('#K1 deterministic and field-sensitive', async () => {
    const a = await cacheKeyFor({ providerId: 'openai', providerKind: 'openai', model: 'gpt-image-1', prompt: 'cat', requestSize: '1024x1024' });
    const b = await cacheKeyFor({ providerId: 'openai', providerKind: 'openai', model: 'gpt-image-1', prompt: 'cat', requestSize: '1024x1024' });
    expect(a).toBe(b);
    const prompt = await cacheKeyFor({ providerId: 'openai', providerKind: 'openai', model: 'gpt-image-1', prompt: 'cat ', requestSize: '1024x1024' });
    expect(prompt).not.toBe(a);
    const model = await cacheKeyFor({ providerId: 'openai', providerKind: 'openai', model: 'dall-e-3', prompt: 'cat', requestSize: '1024x1024' });
    expect(model).not.toBe(a);
    const provider = await cacheKeyFor({ providerId: 'custom-openai', providerKind: 'openai', model: 'gpt-image-1', prompt: 'cat', requestSize: '1024x1024' });
    expect(provider).not.toBe(a);
  });

  test('#K2 seed participates ONLY for providers that honor seeds', async () => {
    const base = { providerId: 'p', providerKind: 'openai' as const, model: 'm', prompt: 'x', requestSize: '1024x1024' };
    const withSeed = await cacheKeyFor({ ...base, seed: 7 });
    const noSeed = await cacheKeyFor({ ...base });
    expect(withSeed).toBe(noSeed); // openai: seed is not sent → same cache entry

    const zaiBase = { providerId: 'p', providerKind: 'zai' as const, model: 'auto', prompt: 'x', requestSize: '1024x1024' };
    expect(await cacheKeyFor({ ...zaiBase, seed: 7 })).toBe(await cacheKeyFor({ ...zaiBase }));
  });
});
