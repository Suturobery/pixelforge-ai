/**
 * Task 9 — provider adapter contract tests (mocked transport, NO network).
 *
 * Covers the user rule "verify model capabilities rather than assuming":
 * the OpenAI-compatible adapter builds capability-checked requests, parses
 * b64_json AND https-url responses, maps HTTP failures to structured errors,
 * and the Z.AI adapter degrades to a structured provider_unavailable when
 * the SDK is absent. The mock adapter is byte-deterministic (smoke use).
 */

import { describe, expect, test } from 'bun:test';

import { createMockAdapter, createOpenAiCompatibleAdapter, createZaiAdapter, type FetchLike } from '../src/ai/adapters';
import { AiJobError } from '../src/ai/job-queue';

function jsonRes(status: number, body: unknown): FetchLike {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  })) as unknown as FetchLike;
}

const SIGNAL = new AbortController().signal;

describe('openai-compatible adapter', () => {
  test('b64_json responses parse into base64 images; request carries model/prompt/size/n', async () => {
    let captured: { url: string; init: { method: string; headers: Record<string, string>; body: string } } | null = null;
    const fetchMock: FetchLike = (url, init) => {
      captured = { url, init };
      return jsonRes(200, { data: [{ b64_json: 'AAA' }, { b64_json: 'BBB' }] })();
    };
    const adapter = createOpenAiCompatibleAdapter({
      providerId: 'openai',
      providerLabel: 'OpenAI · GPT',
      model: 'gpt-image-1',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      fetch: fetchMock,
    });
    const images = await adapter.generate({ fullPrompt: 'a sprite', requestSize: '1024x1024', count: 2, signal: SIGNAL });
    expect(images).toEqual(['AAA', 'BBB']);
    expect(captured!.url).toBe('https://api.openai.com/v1/images/generations');
    expect(captured!.init.headers['Authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(captured!.init.body) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-image-1');
    expect(body['prompt']).toBe('a sprite');
    expect(body['size']).toBe('1024x1024');
    expect(body['n']).toBe(2);
  });

  test('n>1 is refused for adapters without n support (callers fan out)', async () => {
    const adapter = createOpenAiCompatibleAdapter({
      providerId: 'custom',
      providerLabel: 'Local',
      model: 'local',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'k',
      supportsN: false,
      fetch: jsonRes(200, { data: [] }),
    });
    expect(adapter.supportsN).toBe(false);
    try {
      await adapter.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 3, signal: SIGNAL });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AiJobError);
      expect((err as AiJobError).code).toBe('n_unsupported');
    }
  });

  test('local or plain-http provider URLs are refused before a request is made', async () => {
    let called = false;
    const adapter = createOpenAiCompatibleAdapter({
      providerId: 'custom', providerLabel: 'Custom', model: 'model',
      baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'k',
      fetch: (async () => { called = true; return jsonRes(200, { data: [] })(); }) as FetchLike,
    });
    await expect(adapter.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 1, signal: SIGNAL })).rejects.toThrow(AiJobError);
    expect(called).toBe(false);
  });

  test('https url responses are downloaded (https-only) and converted to base64', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
    const fetchMock: FetchLike = (url) => {
      if (String(url).endsWith('/images/generations')) {
        return jsonRes(200, { data: [{ url: 'https://cdn.example/x.png' }] })();
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => 'binary',
        json: async () => ({}),
        arrayBuffer: async () => pngBytes,
      });
    };
    const adapter = createOpenAiCompatibleAdapter({
      providerId: 'openai', providerLabel: 'OpenAI · GPT', model: 'dall-e-3',
      baseUrl: 'https://api.openai.com/v1', apiKey: 'sk', fetch: fetchMock,
    });
    const images = await adapter.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 1, signal: SIGNAL });
    expect(images).toHaveLength(1);
    expect(Buffer.from(images[0]!, 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  test('http (non-https) result urls are refused — no arbitrary-URL downgrade', async () => {
    const adapter = createOpenAiCompatibleAdapter({
      providerId: 'openai', providerLabel: 'OpenAI', model: 'm',
      baseUrl: 'https://api.openai.com/v1', apiKey: 'sk',
      fetch: jsonRes(200, { data: [{ url: 'http://insecure.example/x.png' }] }),
    });
    try {
      await adapter.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 1, signal: SIGNAL });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AiJobError);
      expect((err as AiJobError).code).toBe('bad_response');
    }
  });

  test('HTTP errors and network failures map to retryable errors (not AiJobError)', async () => {
    const httpErr = createOpenAiCompatibleAdapter({
      providerId: 'openai', providerLabel: 'x', model: 'm',
      baseUrl: 'https://api.openai.com/v1', apiKey: 'sk',
      fetch: (async () => ({ ok: false, status: 502, text: async () => 'upstream', json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as FetchLike,
    });
    try {
      await httpErr.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 1, signal: SIGNAL });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).not.toBeInstanceOf(AiJobError); // generic → retryable
      expect((err as Error).message).toContain('502');
    }
    const netErr = createOpenAiCompatibleAdapter({
      providerId: 'openai', providerLabel: 'x', model: 'm',
      baseUrl: 'https://api.openai.com/v1', apiKey: 'sk',
      fetch: (async () => { throw new Error('fetch failed'); }) as unknown as FetchLike,
    });
    await expect(netErr.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 1, signal: SIGNAL })).rejects.toThrow(/network error/);
  });

  test('missing credentials/config fail FAST with structured config errors', async () => {
    const noKey = createOpenAiCompatibleAdapter({ providerId: 'openai', providerLabel: 'x', model: 'm', baseUrl: 'https://x/v1', apiKey: '', fetch: jsonRes(200, {}) });
    await expect(noKey.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 1, signal: SIGNAL })).rejects.toThrow(AiJobError);
    const noUrl = createOpenAiCompatibleAdapter({ providerId: 'openai', providerLabel: 'x', model: 'm', baseUrl: '', apiKey: 'k', fetch: jsonRes(200, {}) });
    await expect(noUrl.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 1, signal: SIGNAL })).rejects.toThrow(AiJobError);
  });
});

describe('zai adapter', () => {
  test('a missing SDK yields the structured provider_unavailable error', async () => {
    const adapter = createZaiAdapter({ loadClient: async () => { throw new Error('module not found'); } });
    await expect(adapter.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 1, signal: SIGNAL })).rejects.toThrow(AiJobError);
    expect(adapter.providerId).toBe('zai');
    expect(adapter.supportsN).toBe(false);
  });

  test('a working SDK client returns image payloads; empty payload is a structured error', async () => {
    const ok = createZaiAdapter({ loadClient: async () => ({ images: { generations: { create: async () => ({ data: [{ base64: 'WlYx' }] }) } } }) });
    const images = await ok.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 1, signal: SIGNAL });
    expect(images).toEqual(['WlYx']);
    const empty = createZaiAdapter({ loadClient: async () => ({ images: { generations: { create: async () => ({ data: [] }) } } }) });
    await expect(empty.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 1, signal: SIGNAL })).rejects.toThrow(AiJobError);
  });
});

describe('mock adapter (PF_AI_MOCK / smokes)', () => {
  test('is byte-deterministic across calls and validates the PNG signature', async () => {
    const a = createMockAdapter();
    const [x] = await a.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 1, signal: SIGNAL });
    const [y] = await a.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 1, signal: SIGNAL });
    expect(x).toBe(y);
    const head = Buffer.from(x!, 'base64').subarray(0, 8);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // count is honored (1..4)
    const four = await a.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 4, signal: SIGNAL });
    expect(four).toHaveLength(4);
  });

  test('honors the abort signal during the delay window', async () => {
    const ctrl = new AbortController();
    const a = createMockAdapter({ delayMs: 5_000 });
    const p = a.generate({ fullPrompt: 'x', requestSize: '1024x1024', count: 1, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
