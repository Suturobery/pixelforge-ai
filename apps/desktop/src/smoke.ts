import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import { resolveRendererTarget } from './config';
import type { Logger } from './logger';

const LOAD_TIMEOUT_MS = 20_000;
const HYDRATION_SETTLE_MS = 1_500;
/** Dev-mode canvas poll: Next.js compiles/hydrates lazily — poll instead of a single probe. */
const CANVAS_POLL_TIMEOUT_MS = 20_000;
const CANVAS_POLL_INTERVAL_MS = 500;

interface SmokeProbe {
  bridge: boolean;
  bridgeVersion?: number;
  ping?: string;
  info?: { version?: string };
  hasCanvas?: boolean;
  title?: string;
  fileRoundTrip?: unknown;
  corruptFileRejected?: unknown;
  autosaveNewerThanMain?: boolean;
  exportRoundTrip?: unknown;
  mcp?: { status: string; endpoint: string | null; editorConnected: boolean };
  mcpE2E?: { paired: boolean; summary: string; revoked: boolean };
}

/**
 * Headless-verifiable startup probe (v3.1 §9.1 protocol, Task-1 subset):
 * waits for the renderer to load, pings the bridge FROM THE PAGE CONTEXT
 * (proves contextIsolation + preload wiring end-to-end), captures a screenshot
 * as evidence, then exits 0/1. Used by `npm run smoke:*` under xvfb/CI and by
 * humans on Windows (`npm run smoke:dev`).
 */
export async function runSmokeTest(win: BrowserWindow, logger: Logger): Promise<void> {
  const target = resolveRendererTarget();
  const mode = target.kind;

  // Attach BEFORE the first navigation (main calls this prior to loadRenderer).
  const loaded = new Promise<void>((resolve, reject) => {
    win.webContents.once('did-finish-load', () => resolve());
    win.webContents.once('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (isMainFrame) reject(new Error(`did-fail-load ${code} ${description} (${url})`));
    });
  });

  try {
    logger.info('smoke.start', { mode });
    await withTimeout(loaded, LOAD_TIMEOUT_MS, `renderer load timed out after ${LOAD_TIMEOUT_MS} ms`);
    await sleep(HYDRATION_SETTLE_MS); // let React hydrate / autosave settle

    const probe = (await win.webContents.executeJavaScript(
      `(async () => {
        const b = window.pixelforge;
        if (!b) return { bridge: false };
        return {
          bridge: true,
          bridgeVersion: b.bridgeVersion,
          ping: await b.ping(),
          info: await b.app.getInfo(),
          hasCanvas: !!document.querySelector('canvas'),
          title: document.title,
        };
      })()`,
    )) as SmokeProbe;

    if (!probe || probe.bridge !== true || probe.ping !== 'pong' || probe.bridgeVersion !== 5) {
      throw new Error(`preload bridge probe failed: ${JSON.stringify(probe ?? null)}`);
    }
    if (probe.info?.version !== app.getVersion()) {
      throw new Error(`renderer/main version mismatch: renderer=${probe.info?.version ?? 'unknown'} main=${app.getVersion()}`);
    }
    if ((mode === 'dev-server' || app.isPackaged) && probe.hasCanvas !== true) {
      // The editor canvas must be present — proves the React editor mounted.
      // Poll because startup/hydration can exceed the initial settle delay.
      const deadline = Date.now() + CANVAS_POLL_TIMEOUT_MS;
      let hasCanvas = false;
      while (Date.now() < deadline) {
        await sleep(CANVAS_POLL_INTERVAL_MS);
        hasCanvas = await win.webContents.executeJavaScript("!!document.querySelector('canvas')");
        if (hasCanvas) break;
      }
      if (!hasCanvas) {
        throw new Error('editor canvas not found in dev-server renderer (polled)');
      }
      probe.hasCanvas = true;
    }

    // --- Task 4: native file permission smoke (PF_SMOKE_FILE=1) ------------
    // Picker-granted directories are intentionally the only way to obtain
    // filesystem access. A headless smoke cannot drive the OS picker, so it
    // verifies the bridge shape and leaves real picker round-trips to the
    // focused desktop acceptance test.
    if (process.env.PF_SMOKE_FILE === '1' && (mode === 'dev-server' || app.isPackaged)) {
      if (app.isPackaged) {
        // Production intentionally has no raw path-registration bridge.
        const packagedResult = (await win.webContents.executeJavaScript(
          `(async () => {
            const b = window.pixelforge;
            if (!b?.project?.fs || !b.project?.pickOpen || !b.project?.pickSave) return { ok: false, error: 'permissioned file bridge missing' };
            return { ok: !('registerPath' in b.project), permissioned: true };
          })()`,
        )) as { ok: boolean; error?: string; permissioned?: boolean };
        if (!packagedResult.ok) {
          throw new Error(`packaged native file bridge failed: ${JSON.stringify(packagedResult)}`);
        }
        probe.fileRoundTrip = packagedResult;
      } else {
      const bridgeResult = (await win.webContents.executeJavaScript(
        `(() => ({ ok: Boolean(window.pixelforge?.project?.pickOpen && window.pixelforge?.project?.pickSave), rawPathRegistrationExposed: 'registerPath' in (window.pixelforge?.project || {}) }))()`,
      )) as { ok: boolean; rawPathRegistrationExposed: boolean };
      if (!bridgeResult.ok || bridgeResult.rawPathRegistrationExposed) {
        throw new Error(`unsafe desktop file bridge: ${JSON.stringify(bridgeResult)}`);
      }
      probe.fileRoundTrip = { ...bridgeResult, manualPickerRoundTripRequired: true };
      }
    }

    // --- Task 7: export permission smoke (PF_SMOKE_EXPORT=1, dev server) ---
    // Exports need a picker-granted folder just like project files. Do not add
    // a testing-only arbitrary-path escape hatch merely to automate this.
    if (process.env.PF_SMOKE_EXPORT === '1' && mode === 'dev-server') {
      const exportResult = (await win.webContents.executeJavaScript(
        `(() => ({ ok: typeof window.pixelforge?.exports?.pickDir === 'function', rawPathRegistrationExposed: 'registerPath' in (window.pixelforge?.project || {}) }))()`,
      )) as {
        ok: boolean;
        rawPathRegistrationExposed: boolean;
      };
      if (!exportResult.ok || exportResult.rawPathRegistrationExposed) {
        throw new Error(`unsafe desktop export bridge: ${JSON.stringify(exportResult)}`);
      }
      probe.exportRoundTrip = { ...exportResult, manualPickerRoundTripRequired: true };
    }

    // --- Task 8: MCP editor bridge (PF_SMOKE_MCP=1, dev server) ------------
    // The MCP server (mini-services/mcp-server) must be running on
    // 127.0.0.1:3030. The renderer bridge auto-connects (gateway path fails
    // inside Electron → direct-loopback failover). This block proves the
    // live link inside the REAL desktop renderer; full pairing + SDK-client
    // tool flows are covered by mini-services/mcp-server (contract tests +
    // e2e-client.mjs against the same page code).
    if (process.env.PF_SMOKE_MCP === '1' && (mode === 'dev-server' || app.isPackaged)) {
      if (app.isPackaged) {
        const mcpDeadline = Date.now() + 20_000;
        let packagedMcp: { ready: boolean; endpoint: string | null } | null = null;
        while (Date.now() < mcpDeadline) {
          packagedMcp = (await win.webContents.executeJavaScript(
            'window.pixelforge?.mcp?.status() ?? null',
          )) as { ready: boolean; endpoint: string | null } | null;
          if (packagedMcp?.ready === true) break;
          await sleep(500);
        }
        if (packagedMcp?.ready !== true) {
          throw new Error(`packaged MCP service was not ready: ${JSON.stringify(packagedMcp)}`);
        }
        probe.mcp = {
          status: 'ready',
          endpoint: packagedMcp.endpoint,
          editorConnected: false,
        };
      } else {
      const mcpDeadline = Date.now() + 20_000;
      let mcpStatus: string | null = null;
      while (Date.now() < mcpDeadline) {
        mcpStatus = await win.webContents.executeJavaScript(
          "window.__pfMcp ? window.__pfMcp.getBridgeState().status : 'no-hook'",
        );
        if (mcpStatus === 'connected') break;
        await sleep(500);
      }
      if (mcpStatus !== 'connected') {
        throw new Error(`MCP editor bridge did not connect (status: ${mcpStatus})`);
      }
      const mcpServer = await win.webContents.executeJavaScript(
        "window.__pfMcp.getBridgeState().server",
      );
      probe.mcp = {
        status: 'connected',
        endpoint: mcpServer?.endpoint ?? null,
        editorConnected: mcpServer?.editorConnected ?? false,
      };
      }
    }
    // When the E2E flag rides along with PF_SMOKE_MCP, reuse the connected
    // probe instead of polling twice (the E2E block re-checks status itself).

    // --- Task 15a: full MCP E2E (PF_SMOKE_MCP_E2E=1, dev server) -----------
    // Automates the Task-8 live E2E for CI: the editor bridge generates a
    // pairing code through the SAME ctrl plane the Settings UI uses, then the
    // main process spawns the real SDK client (e2e-client.mjs) against the
    // live MCP server + this very renderer. A non-zero client exit fails the
    // smoke. The e2e client is revoked afterwards (best-effort) so the client
    // store stays clean. The code travels via env (never argv) so a failure
    // log can never echo the single-use pairing token.
    if (process.env.PF_SMOKE_MCP_E2E === '1' && mode === 'dev-server') {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);

      const bridgeDeadline = Date.now() + 20_000;
      let bridgeStatus: string | null = null;
      while (Date.now() < bridgeDeadline) {
        bridgeStatus = await win.webContents.executeJavaScript(
          "window.__pfMcp ? window.__pfMcp.getBridgeState().status : 'no-hook'",
        );
        if (bridgeStatus === 'connected') break;
        await sleep(500);
      }
      if (bridgeStatus !== 'connected') {
        throw new Error(`MCP E2E prerequisite: editor bridge not connected (${bridgeStatus})`);
      }

      const pairing = (await win.webContents.executeJavaScript(
        `(async () => {
          const res = await window.__pfMcp.mcpCtrl({ kind: 'pair-generate', tier: 'L1' });
          return { ok: res.ok, token: res.data?.token ?? null, error: res.error ?? null };
        })()`,
      )) as { ok: boolean; token: string | null; error: { code: string; message: string } | null };
      if (!pairing.ok || !pairing.token) {
        throw new Error(`MCP E2E pairing failed: ${JSON.stringify(pairing)}`);
      }

      const repoRoot = path.resolve(process.cwd(), '..', '..');
      const e2eScript = path.join(repoRoot, 'mini-services', 'mcp-server', 'e2e-client.mjs');
      const bunBin = process.env.PF_BUN_BIN ?? 'bun';
      let e2eStdout: string;
      try {
        const res = await run(bunBin, [e2eScript], {
          cwd: path.dirname(e2eScript),
          timeout: 180_000,
          encoding: 'utf8',
          env: { ...process.env, PF_E2E_PAIRING_CODE: pairing.token },
        });
        e2eStdout = res.stdout;
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        // Bun reports a non-zero exit for failed assertions on stdout. Keep
        // that tail in the smoke failure so a desktop QA run identifies the
        // real failed check instead of only showing an empty process error.
        const output = [e.stdout?.slice(-6000), e.stderr?.slice(-1200)].filter(Boolean).join(' :: ');
        throw new Error(`MCP E2E client failed: ${e.message ?? String(err)}${output ? ` :: ${output}` : ''}`);
      }
      const summary = e2eStdout.trim().split('\n').pop() ?? '';
      const passed = /\d+\/\d+ checks passed/.test(summary) && !summary.startsWith('0/');
      if (!passed) {
        throw new Error(`MCP E2E did not pass: ${e2eStdout.trim().split('\n').filter((l) => l.startsWith('FAIL')).join(' | ') || summary}`);
      }

      // best-effort cleanup: revoke the e2e-assistant client
      const revoked = (await win.webContents.executeJavaScript(
        `(async () => {
          const list = await window.__pfMcp.mcpCtrl({ kind: 'clients-list' });
          if (!list.ok) return false;
          const target = (list.data?.clients ?? []).find((c) => c.name === 'e2e-assistant' && !c.revoked);
          if (!target) return true;
          const res = await window.__pfMcp.mcpCtrl({ kind: 'client-revoke', clientId: target.clientId });
          return res.ok === true;
        })()`,
      )) as boolean;
      probe.mcpE2E = { paired: true, summary, revoked };
    }

    // --- Task 13a: settings file preferences (PF_SMOKE_SETTINGS=1) -------
    // Exercises the REAL bridge settings namespace from the real renderer:
    // preference round-trip through main's versioned settings file. The
    // credential-vault variant of this smoke was removed together with the
    // in-app AI provider stack.
    if (process.env.PF_SMOKE_SETTINGS === '1' && mode === 'dev-server') {
      const roundTrip = (await win.webContents.executeJavaScript(
        `(async () => {
          const b = window.pixelforge;
          if (!b || b.bridgeVersion < 4 || !b.settings) {
            return { bridgeV4: false, namespace: !!b?.settings };
          }
          const before = await b.settings.getAll();
          const patch = { app: { autosaveDelay: before.app.autosaveDelay } };
          const after = await b.settings.update(patch);
          return {
            bridgeV4: true,
            namespace: true,
            roundTrip: after.app.autosaveDelay === before.app.autosaveDelay,
          };
        })()`,
      )) as { bridgeV4: boolean; namespace: boolean; roundTrip: boolean };

      if (!roundTrip.bridgeV4 || !roundTrip.namespace) {
        throw new Error(`bridge v4 settings namespace missing: ${JSON.stringify(roundTrip)}`);
      }
      if (!roundTrip.roundTrip) {
        throw new Error('settings preference round-trip failed');
      }
    }

    // --- Task 9: AI generation pipeline smoke was removed with the feature --
    // (PF_SMOKE_AI=1 / PF_AI_MOCK=1 no longer exist: in-app generation was
    // removed; agents draw through MCP tools instead.)

    let screenshot: string | null = null;
    try {
      const dir = path.join(process.cwd(), 'artifacts');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `smoke-${mode}.png`);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(file, image.toPNG());
      screenshot = file;
      logger.info('smoke.screenshot', { file });
    } catch (err) {
      // A packaged app can run on a Windows session without a capturable
      // display surface. That does not invalidate the bridge/renderer probes
      // above, so retain the successful smoke result and log the limitation.
      logger.warn('smoke.screenshot.unavailable', { error: String(err) });
    }

    logger.info('smoke.probe', probe);
    console.log('[SMOKE:OK]', JSON.stringify({ mode, ...probe, screenshot }));
    app.exit(0);
  } catch (err) {
    logger.error('smoke.fail', { mode, error: String(err) });
    console.error('[SMOKE:FAIL]', String(err));
    app.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
