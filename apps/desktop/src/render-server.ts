// PixelForge AI desktop — embedded Next standalone renderer server (Task 4).
//
// The packaged app ships the REAL editor: the Next standalone build
// (resources/renderer/server.js + .next + node_modules + public) served by
// the Electron binary itself in Node mode (ELECTRON_RUN_AS_NODE=1) on a
// private loopback port. Dev mode keeps loading the dev server on :3000.
//
// Lifecycle mirrors the MCP supervisor: wait for /health (any 2xx), own the
// child in packaged builds, stop it on quit.

import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import type { Logger } from './logger';

export interface RenderServerOptions {
  packaged: boolean;
  resourcesPath: string;
  execPath: string;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  port?: number;
  mcpPort?: number;
  healthTimeoutMs?: number;
}

export class RenderServer {
  private child: ChildProcess | null = null;
  private readonly port: number;
  private readonly healthTimeoutMs: number;

  constructor(private readonly options: RenderServerOptions) {
    this.port = options.port ?? 3131;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 20_000;
  }

  url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url()}/`, { signal: AbortSignal.timeout(1500) });
      return res.status < 500;
    } catch {
      return false;
    }
  }

  /**
   * Packaged: start the embedded Next server and wait until it answers.
   * Dev: no-op — the window loads the dev server URL directly.
   */
  async startIfPackaged(): Promise<boolean> {
    if (!this.options.packaged) return true;
    if (await this.healthy()) {
      // Never adopt a fixed-port server: Electron would otherwise navigate to
      // arbitrary loopback content and expose its privileged preload bridge.
      this.options.logger.error('render-server.port-in-use', { url: this.url() });
      return false;
    }
    const serverJs = path.join(this.options.resourcesPath, 'renderer', 'server.js');
    if (!existsSync(serverJs)) {
      this.options.logger.error('render-server.missing', { serverJs });
      return false;
    }
    // ELECTRON_RUN_AS_NODE turns the Electron binary into plain Node —
    // no system Node required on the tester machine. The renderer .env's
    // relative DATABASE_URL (file:../db/custom.db) would resolve against the
    // packaged layout and break — point Prisma at a per-user SQLite file.
    const userData = process.env.PF_USER_DATA_OVERRIDE ?? app.getPath('userData');
    const dbDir = path.join(userData, 'mcp-data');
    try {
      mkdirSync(dbDir, { recursive: true });
    } catch (err) {
      this.options.logger.error('render-server.dbdir.failed', { err: String(err) });
    }
    const dbPath = path.join(dbDir, 'webapp.db');
    const dbUrl = `file:${dbPath.replace(/\\/g, '/')}`;
    // First-run schema: ship a blank, schema-ready SQLite template generated
    // during packaging. This avoids trying to execute Electron-as-Node at
    // runtime (which is unavailable in hardened packaged Electron builds).
    if (!existsSync(dbPath) || statSync(dbPath).size === 0) {
      try {
        const template = path.join(this.options.resourcesPath, 'prisma', 'template.db');
        if (existsSync(template) && statSync(template).size > 0) {
          copyFileSync(template, dbPath);
          this.options.logger.info('render-server.db.initialized', { db: dbPath });
        } else {
          this.options.logger.error('render-server.db.template.missing');
        }
      } catch (err) {
        this.options.logger.error('render-server.db.initialize.failed', { err: String(err).slice(0, 200) });
      }
    }
    this.child = spawn(process.execPath, [serverJs], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        PORT: String(this.port),
        PF_MCP_PORT: String(this.options.mcpPort ?? 3030),
        HOSTNAME: '127.0.0.1',
        DATABASE_URL: dbUrl,
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    this.child.on('exit', (code) => this.options.logger.warn('render-server.exit', { code }));

    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.healthy()) {
        this.options.logger.info('render-server.ready', { url: this.url(), pid: this.child.pid });
        return true;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    this.options.logger.error('render-server.health-timeout', { url: this.url() });
    this.stop();
    return false;
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}
