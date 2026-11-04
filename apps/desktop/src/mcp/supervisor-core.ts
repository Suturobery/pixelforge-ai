// PixelForge AI desktop — MCP service supervision state machine (embed v1,
// Task 8). Pure logic, no Node imports: the platform launcher is injected
// via startService, so unit tests drive the whole lifecycle without real
// processes.
//
// Safety context: this manages the project's OWN bundled pixel-art
// mini-service (127.0.0.1 only) so the desktop app can offer MCP tools
// without a separate terminal window.
//
// Lifecycle:
//   • already healthy on the port (user runs dev.sh) → ADOPT, no double-bind
//   • not running → start it via the injected launcher, wait for /health
//   • unexpected exit → bounded restart with backoff
//   • app quit → stop the child WE own (an adopted server stays with its owner)

export interface McpSupervisorOptions {
  port: number;
  logger: {
    log: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
  };
  fetchImpl: (url: string, init?: { signal: AbortSignal }) => Promise<{ ok: boolean }>;
  /** starts the local service; returns null when it could not be started */
  startService: () => SpawnedService | null;
  /** Dev may adopt a known local server; packaged apps must own their server. */
  adoptExisting?: boolean;
  healthTimeoutMs?: number;
  maxRestarts?: number;
}

export interface SpawnedService {
  pid?: number;
  /** graceful stop of the child WE launched (never an adopted one) */
  stop(): void;
  onExit(listener: (code: number | null) => void): void;
}

export type McpSupervisorState =
  | { kind: 'stopped' }
  | { kind: 'adopted' }
  | { kind: 'running'; pid: number | null }
  | { kind: 'failed'; reason: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class McpSupervisor {
  private service: SpawnedService | null = null;
  private stopping = false;
  private restarts = 0;

  state: McpSupervisorState = { kind: 'stopped' };

  constructor(private readonly options: McpSupervisorOptions) {}

  private url(): string {
    return `http://127.0.0.1:${this.options.port}`;
  }

  private say(level: 'log' | 'warn' | 'error', msg: string, data?: unknown): void {
    this.options.logger[level](`[mcp-supervisor] ${msg}`, data ?? '');
  }

  private async healthy(): Promise<boolean> {
    try {
      const res = await this.options.fetchImpl(`${this.url()}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Ensure the MCP endpoint answers. Safe to call repeatedly — ADOPTS an
   * already-running service instead of double-binding the port.
   */
  async start(): Promise<McpSupervisorState> {
    if (this.state.kind === 'running' || this.state.kind === 'adopted') return this.state;
    this.stopping = false;
    this.restarts = 0;

    if (await this.healthy()) {
      if (this.options.adoptExisting === false) {
        this.state = { kind: 'failed', reason: 'MCP port is already occupied by an unverified process' };
        this.say('error', this.state.reason);
        return this.state;
      }
      this.state = { kind: 'adopted' };
      this.say('log', 'adopted — a healthy MCP server already answers on the port');
      return this.state;
    }
    return this.runUntilHealthy();
  }

  private runUntilHealthy(): Promise<McpSupervisorState> {
    return new Promise<McpSupervisorState>((resolve) => {
      const started = this.options.startService();
      if (!started) {
        this.state = { kind: 'failed', reason: 'could not start the local MCP service' };
        this.say('error', this.state.reason);
        resolve(this.state);
        return;
      }
      this.service = started;
      started.onExit((code) => {
        if (this.stopping) return;
        this.say('warn', 'service exited unexpectedly', { code });
        this.service = null;
        void this.scheduleRestart();
      });

      const deadline = Date.now() + (this.options.healthTimeoutMs ?? 15_000);
      const poll = async (): Promise<void> => {
        while (Date.now() < deadline && !this.stopping) {
          if (await this.healthy()) {
            this.state = { kind: 'running', pid: this.service?.pid ?? null };
            this.say('log', 'healthy', { pid: this.service?.pid ?? null, port: this.options.port });
            resolve(this.state);
            return;
          }
          await sleep(400);
        }
        if (!this.stopping) {
          this.state = { kind: 'failed', reason: 'health check timeout' };
          this.say('error', 'health check timeout — stopping the service we own');
          this.service?.stop();
          resolve(this.state);
        }
      };
      void poll();
    });
  }

  private async scheduleRestart(): Promise<void> {
    const maxRestarts = this.options.maxRestarts ?? 3;
    if (this.stopping || this.restarts >= maxRestarts) {
      this.state = { kind: 'failed', reason: `service kept exiting (restarts: ${this.restarts})` };
      this.say('error', 'restart budget exhausted — giving up');
      return;
    }
    this.restarts += 1;
    const backoff = Math.min(8000, 500 * 2 ** this.restarts);
    this.say('log', `restart ${this.restarts}/${maxRestarts} in ${backoff}ms`);
    await sleep(backoff);
    if (this.stopping) return;
    if (await this.healthy()) {
      if (this.options.adoptExisting === false) {
        this.state = { kind: 'failed', reason: 'MCP port was claimed by an unverified process' };
        this.say('error', this.state.reason);
        return;
      }
      // another owner took the port while we were down — adopt, stop watching
      this.state = { kind: 'adopted' };
      this.say('log', 'port recovered by another owner — adopted');
      return;
    }
    await this.runUntilHealthy();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.state.kind === 'adopted') {
      // we did NOT start it — its owner (dev.sh, terminal) owns the lifecycle
      this.say('log', 'stopping supervisor — adopted server left running');
      this.state = { kind: 'stopped' };
      return;
    }
    this.service?.stop();
    this.service = null;
    this.state = { kind: 'stopped' };
  }
}
