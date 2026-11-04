/**
 * PixelForge AI — desktop AI service (v3.1 Plan §3.1/§8.2; Task 9).
 *
 * Owns the MAIN-process AI lifecycle and its IPC surface:
 *   • one AiJobManager for the app lifetime;
 *   • provider adapters resolved from the settings file + the C13 vault —
 *     `revealApiKey` runs IN-PROCESS ONLY; plaintext never crosses IPC,
 *     never reaches the renderer, never appears in logs;
 *   • usage records persisted to <userData>/ai-usage.json (capped);
 *   • job + spend-warning events pushed to ALL windows via 'pf:ai-event'.
 *
 * PF_AI_MOCK=1 (smoke/dev): a deterministic offline mock adapter serves the
 * 'mock' provider id so the full pipeline is verifiable with NO network and
 * NO cost. Real providers are untouched by this flag.
 */

import { ipcMain, type WebContents } from 'electron';

import { createMockAdapter, createOpenAiCompatibleAdapter, createZaiAdapter, safeExternalHttpsBase, type FetchLike } from './adapters';
import { AiJobManager, AiJobError } from './job-queue';
import type { Logger } from '../logger';
import type { SettingsStore } from '../settings/store';
import type { AiJobRequest, AiJobView, AiAdapter, UsageRecord } from './types';

const USAGE_CAP = 500;

interface UsageFile {
  version: 1;
  records: UsageRecord[];
}

export interface AiServiceOptions {
  settings: SettingsStore;
  logger: Logger;
  usageFile: string;
  fs: {
    existsSync(path: string): boolean;
    readFileSync(path: string, encoding: 'utf8'): string;
    writeFileSync(path: string, data: string): void;
    renameSync(from: string, to: string): void;
  };
  /** injectable transport (tests); default = global fetch */
  fetch?: FetchLike;
  /** injectable now() for tests */
  now?: () => number;
}

export interface AiConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  note?: string;
  error?: string;
}

export class AiService {
  private readonly manager: AiJobManager;
  private readonly settings: SettingsStore;
  private readonly logger: Logger;
  private readonly usagePath: string;
  private readonly fs: AiServiceOptions['fs'];
  private readonly fetchImpl?: FetchLike;
  private usageCache: UsageFile | null = null;

  constructor(opts: AiServiceOptions) {
    this.settings = opts.settings;
    this.logger = opts.logger;
    this.usagePath = opts.usageFile;
    this.fs = opts.fs;
    this.fetchImpl = opts.fetch;

    this.manager = new AiJobManager({
      resolveAdapter: (providerId) => this.resolveAdapter(providerId, opts.fetch),
      usage: {
        load: () => this.loadUsage().records,
        append: (r) => this.appendUsage(r),
      },
      monthlyLimitUsd: this.settings.getInternal().ai.monthlyLimitUsd,
      warnUsd: this.settings.getInternal().ai.warnUsd,
    });
  }

  /** Wire IPC + event push. Called once from main after settings load. */
  register(webContentsOf: () => WebContents[]): void {
    const validateRequest = (raw: unknown): AiJobRequest => {
      if (typeof raw !== 'object' || raw === null) throw new AiJobError('invalid_request', 'AI job request must be an object.');
      const r = raw as Record<string, unknown>;
      if (typeof r['prompt'] !== 'string') throw new AiJobError('invalid_request', 'prompt is required.');
      if (typeof r['providerId'] !== 'string' || r['providerId'].length === 0 || r['providerId'].length > 64) {
        throw new AiJobError('invalid_request', 'providerId is required.');
      }
      if (typeof r['width'] !== 'number' || typeof r['height'] !== 'number') {
        throw new AiJobError('invalid_request', 'width/height are required.');
      }
      const out: AiJobRequest = {
        prompt: r['prompt'],
        providerId: r['providerId'],
        width: r['width'],
        height: r['height'],
      };
      if (typeof r['count'] === 'number') out.count = r['count'];
      if (typeof r['seed'] === 'number') out.seed = r['seed'];
      if (typeof r['clientId'] === 'string' && r['clientId'].length <= 128) out.clientId = r['clientId'];
      return out;
    };

    ipcMain.handle('pf:ai-submit', (_event, raw: unknown): { jobId: string } => {
      const request = validateRequest(raw);
      const jobId = this.manager.submit(request);
      this.logger.info('ai.job.submitted', {
        jobId,
        providerId: request.providerId,
        count: request.count ?? 1,
        promptLength: request.prompt.length,
      });
      return { jobId };
    });

    ipcMain.handle('pf:ai-cancel', (_event, rawJobId: unknown): boolean => {
      if (typeof rawJobId !== 'string' || rawJobId.length === 0 || rawJobId.length > 128) return false;
      const ok = this.manager.cancel(rawJobId);
      this.logger.info('ai.job.cancel', { jobId: rawJobId, ok });
      return ok;
    });

    ipcMain.handle('pf:ai-status', (_event, rawJobId: unknown): AiJobView | null => {
      if (typeof rawJobId !== 'string' || rawJobId.length === 0 || rawJobId.length > 128) return null;
      return this.manager.get(rawJobId);
    });

    ipcMain.handle('pf:ai-list', (): AiJobView[] => this.manager.list());

    ipcMain.handle('pf:ai-usage', (): { records: UsageRecord[]; monthSpendUsd: number } => {
      return { records: this.manager.usage().slice(-100).reverse(), monthSpendUsd: this.manager.monthSpend() };
    });

    // This must run in MAIN: the renderer intentionally cannot read a vault
    // key, so a web-route probe made saved Z.AI credentials look missing.
    ipcMain.handle('pf:ai-test-connection', async (_event, rawProviderId: unknown): Promise<AiConnectionTestResult> => {
      if (typeof rawProviderId !== 'string' || rawProviderId.length === 0 || rawProviderId.length > 64) {
        return { ok: false, latencyMs: 0, error: 'Invalid provider.' };
      }
      return this.testConnection(rawProviderId);
    });

    // push events to every live window (renderer subscribes via preload)
    this.manager.onEvent((event) => {
      let targets: WebContents[];
      try {
        targets = webContentsOf().filter((w) => !w.isDestroyed());
      } catch {
        return;
      }
      for (const w of targets) {
        try {
          w.send('pf:ai-event', event);
        } catch {
          /* window died mid-send */
        }
      }
    });

    this.logger.info('ai.service.registered', {
      channels: ['pf:ai-submit', 'pf:ai-cancel', 'pf:ai-status', 'pf:ai-list', 'pf:ai-usage', 'pf:ai-test-connection'],
      mock: process.env.PF_AI_MOCK === '1',
    });
  }

  /** Direct access for the smoke harness (no IPC round-trip needed). */
  getManager(): AiJobManager {
    return this.manager;
  }

  /** Read-only authenticated probe; the API key never leaves MAIN. */
  private async testConnection(providerId: string): Promise<AiConnectionTestResult> {
    const startedAt = Date.now();
    const finish = (result: Omit<AiConnectionTestResult, 'latencyMs'>): AiConnectionTestResult => ({
      ...result,
      latencyMs: Date.now() - startedAt,
    });
    const profile = this.settings.getInternal().aiProviders.find((p) => p.id === providerId);
    if (!profile || !profile.enabled) return finish({ ok: false, error: 'Enable this provider first.' });
    const key = this.settings.revealApiKey(providerId);
    if (!key) return finish({ ok: false, error: 'Save an API key in Settings → AI first.' });

    const configuredBase = profile.kind === 'zai' ? profile.baseUrl || 'https://api.z.ai/api/paas/v4' : profile.baseUrl;
    let parsedUrl: URL;
    try {
      const baseUrl = safeExternalHttpsBase(configuredBase);
      parsedUrl = new URL(baseUrl);
    } catch {
      return finish({ ok: false, error: 'Base URL must be a public HTTPS URL.' });
    }

    try {
      // Google's OpenAI-compat image endpoint is correct for generation, but
      // its no-cost model discovery lives at the native /v1beta/models route.
      const google = profile.id === 'gemini' || parsedUrl.hostname === 'generativelanguage.googleapis.com';
      const endpoint = google ? `${parsedUrl.origin}/v1beta/models` : `${parsedUrl.toString().replace(/\/+$/, '')}/models`;
      const headers: Record<string, string> = google ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` };
      const response = await fetch(endpoint, {
        headers,
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!response.ok) return finish({ ok: false, error: `HTTP ${response.status}` });
      this.logger.info('ai.connection_test', { providerId, ok: true });
      return finish({ ok: true, note: `${profile.model || profile.label} reachable` });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed.';
      this.logger.warn('ai.connection_test', { providerId, ok: false, error: message.slice(0, 160) });
      return finish({ ok: false, error: /timeout|aborted/i.test(message) ? 'Timed out after 10 seconds.' : message });
    }
  }

  // ------------------------------------------------------------- adapters

  /**
   * Resolve a provider id → adapter. Credentials come from the vault via
   * revealApiKey (IN-PROCESS ONLY — never logged, never returned). The
   * 'mock' provider exists only under PF_AI_MOCK=1.
   */
  private resolveAdapter(providerId: string, fetchImpl?: FetchLike): AiAdapter | null {
    if (providerId === 'mock' && process.env.PF_AI_MOCK === '1') {
      return createMockAdapter();
    }
    const file = this.settings.getInternal();
    const profile = file.aiProviders.find((p) => p.id === providerId);
    if (!profile || !profile.enabled) return null;

    if (profile.kind === 'anthropic') return null; // verified: no image API

    if (profile.kind === 'zai') {
      // Prefer the credential explicitly stored in the desktop vault. The
      // bundled Z.AI SDK only discovers environment credentials, which are
      // absent from a normal installed app even when Settings has a key.
      const key = this.settings.revealApiKey(providerId);
      if (key) {
        return createOpenAiCompatibleAdapter({
          providerId: profile.id,
          providerLabel: profile.label,
          model: profile.model,
          baseUrl: profile.baseUrl || 'https://api.z.ai/api/paas/v4',
          apiKey: key,
          supportsN: false,
          fetch: fetchImpl,
        });
      }
      // Keep the SDK fallback for developer environments that intentionally
      // provide its own machine-level Z.AI configuration.
      return createZaiAdapter();
    }

    const key = this.settings.revealApiKey(providerId);
    if (!key) return null; // no usable credential — the manager reports it
    return createOpenAiCompatibleAdapter({
      providerId: profile.id,
      providerLabel: profile.label,
      model: profile.model,
      baseUrl: profile.baseUrl,
      apiKey: key,
      supportsN: profile.kind === 'openai',
      fetch: fetchImpl,
    });
  }

  // ---------------------------------------------------------------- usage

  private loadUsage(): UsageFile {
    if (this.usageCache) return this.usageCache;
    try {
      if (this.fs.existsSync(this.usagePath)) {
        const parsed = JSON.parse(this.fs.readFileSync(this.usagePath, 'utf8')) as UsageFile;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.records)) {
          this.usageCache = { version: 1, records: parsed.records.slice(-USAGE_CAP) };
          return this.usageCache;
        }
      }
    } catch {
      // corrupt usage file → start fresh (usage is bookkeeping, not data)
      this.logger.warn('ai.usage.recovered', { file: this.usagePath });
    }
    this.usageCache = { version: 1, records: [] };
    return this.usageCache;
  }

  private appendUsage(record: UsageRecord): void {
    const file = this.loadUsage();
    file.records.push(record);
    if (file.records.length > USAGE_CAP) {
      file.records = file.records.slice(-USAGE_CAP);
    }
    try {
      const tmp = `${this.usagePath}.tmp`;
      this.fs.writeFileSync(tmp, JSON.stringify(file));
      this.fs.renameSync(tmp, this.usagePath);
    } catch (err) {
      this.logger.warn('ai.usage.write_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export function monthSpendFromRecords(records: UsageRecord[], now = Date.now()): number {
  const monthStart = Math.floor(now / (30 * 24 * 3600_000)) * (30 * 24 * 3600_000);
  let sum = 0;
  for (const r of records) {
    if (r.cacheHit || r.costEstimateUsd === null) continue;
    const t = Date.parse(r.finishedAt);
    if (Number.isFinite(t) && t >= monthStart) sum += r.costEstimateUsd;
  }
  return sum;
}

export { AiJobError };
