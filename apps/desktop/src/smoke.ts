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
  ping?: string;
  info?: unknown;
  hasCanvas?: boolean;
  title?: string;
  fileRoundTrip?: unknown;
  corruptFileRejected?: unknown;
  autosaveNewerThanMain?: boolean;
  exportRoundTrip?: unknown;
  mcp?: { status: string; endpoint: string | null; editorConnected: boolean };
  mcpE2E?: { paired: boolean; summary: string; revoked: boolean };
  ai?: {
    bridgeV5: boolean;
    candidateReady: boolean;
    colors: number;
    provenanceOk: boolean;
    jobListed: boolean;
    importUndone: boolean;
  };
  settings?: {
    bridgeV4: boolean;
    namespace: boolean;
    roundTrip: boolean;
    keyStored: boolean;
    sessionOnly: boolean;
    plaintextOnDisk: boolean;
    plaintextInLogs: boolean;
    secretInIpcView: boolean;
    removed: boolean;
  };
  settingsPersisted?: { hasKeyAfterRestart: boolean; cleaned: boolean };
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
          ping: await b.ping(),
          info: await b.app.getInfo(),
          hasCanvas: !!document.querySelector('canvas'),
          title: document.title,
        };
      })()`,
    )) as SmokeProbe;

    if (!probe || probe.bridge !== true || probe.ping !== 'pong') {
      throw new Error(`preload bridge probe failed: ${JSON.stringify(probe ?? null)}`);
    }
    if (mode === 'dev-server' && probe.hasCanvas !== true) {
      // The prototype's canvas-stage must be present — proves the React editor
      // mounted. Poll: dev compilation + hydration can exceed the settle delay.
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

    // --- Task 4: native file round-trip (PF_SMOKE_FILE=1, dev server) ------
    // Drives the REAL product path: store shim → project-files → bridge fs
    // (allowlisted) → core persistence (atomic save + load), plus programmatic
    // path registration. Native DIALOGS cannot be automated headlessly — those
    // remain a manual verification item (documented in the Task 4 report).
    if (process.env.PF_SMOKE_FILE === '1' && mode === 'dev-server') {
      const tmpDir = path.join(process.cwd(), 'artifacts');
      fs.mkdirSync(tmpDir, { recursive: true });
      const projectPath = path.join(tmpDir, 'smoke-roundtrip.pixelforgeproj');
      const corruptPath = path.join(tmpDir, 'smoke-corrupt.pixelforgeproj');
      fs.writeFileSync(corruptPath, Buffer.from('definitely-not-a-zip-file'));
      await win.webContents.executeJavaScript(
        `window.__smokeFilePath = ${JSON.stringify(projectPath)}; window.__smokeCorruptPath = ${JSON.stringify(corruptPath)}; 'set'`,
      );
      const fileResult = (await win.webContents.executeJavaScript(
        `(async () => {
          const pf = window.__pf;
          if (!pf || !pf.files) return { ok: false, error: 'dev test hook missing' };
          const st = pf.useEditor.getState();
          if (!window.pixelforge || window.pixelforge.bridgeVersion < 2) {
            return { ok: false, error: 'bridge v2 missing' };
          }
          st.setAutosave(false); // deterministic: no autosave recovery prompt mid-test
          const path = window.__smokeFilePath;
          // 1. save the live document to a temp path (core atomic save)
          const saved = await pf.files.saveProjectToPath(path);
          if (!saved) return { ok: false, error: 'saveProjectToPath returned false' };
          // 2. dirty the document, verify dirty flag
          st.setName('smoke-file-roundtrip');
          const dirtyAfter = pf.useEditor.getState().dirty;
          // 3. reload from disk → document matches the saved state
          const opened = await pf.files.openProjectFromPath(path);
          if (!opened) return { ok: false, error: 'openProjectFromPath returned false' };
          const s2 = pf.useEditor.getState();
          // 4. recovery inspection on the freshly saved file
          const rec = await pf.files.inspectCurrentFileRecovery();
          return {
            ok: true,
            saved: true,
            dirtyAfter,
            name: s2.project.name,
            clips: s2.project.clips.length,
            frames: s2.project.clips[0]?.frames.length ?? 0,
            layers: s2.project.clips[0]?.layers.length ?? 0,
            schema: s2.project.schemaVersion,
            filePath: s2.filePath,
            dirtyAfterOpen: s2.dirty,
            recovery: rec,
          };
        })()`,
      )) as { ok: boolean; error?: string; [k: string]: unknown };
      if (!fileResult.ok) {
        throw new Error(`file round-trip failed: ${JSON.stringify(fileResult)}`);
      }
      probe.fileRoundTrip = fileResult;

      // Corrupted file → typed failure, no crash, editor document untouched.
      const corruptResult = (await win.webContents.executeJavaScript(
        `(async () => {
          const pf = window.__pf;
          const before = pf.useEditor.getState().project.name;
          const opened = await pf.files.openProjectFromPath(window.__smokeCorruptPath);
          const after = pf.useEditor.getState().project.name;
          return { opened, before, after, documentUntouched: before === after };
        })()`,
      )) as { opened: boolean; before: string; after: string; documentUntouched: boolean };
      if (corruptResult.opened !== false || !corruptResult.documentUntouched) {
        throw new Error(`corrupt file not rejected cleanly: ${JSON.stringify(corruptResult)}`);
      }
      probe.corruptFileRejected = corruptResult;

      // Desktop autosave: dirty the doc, wait past the debounce, the recovery
      // inspector must see a NEWER autosave (crash-recovery source, C6).
      const autosaveResult = (await win.webContents.executeJavaScript(
        `(async () => {
          const pf = window.__pf;
          const st = pf.useEditor.getState();
          st.setAutosave(true);
          st.setName('autosave-probe');
          await new Promise((r) => setTimeout(r, 4000)); // autosaveDelay 2.5s + headroom
          const rec = await pf.files.inspectCurrentFileRecovery();
          st.setAutosave(false);
          return rec;
        })()`,
      )) as { autosaveExists?: boolean; newerAutosave?: boolean } | null;
      if (!autosaveResult?.autosaveExists || !autosaveResult.newerAutosave) {
        throw new Error(`desktop autosave did not produce a newer autosave: ${JSON.stringify(autosaveResult)}`);
      }
      probe.autosaveNewerThanMain = true;
    }

    // --- Task 7: native export round-trip (PF_SMOKE_EXPORT=1, dev server) --
    // Drives the REAL export transport: __pf.exportProbe (same core service
    // the dialog uses) → core writeExportPlan → bridge fs (session-allowlisted)
    // → main-process disk. Conflict preflight + overwrite are exercised too.
    // Native DIALOGS cannot be automated headlessly — manual item (report §11).
    if (process.env.PF_SMOKE_EXPORT === '1' && mode === 'dev-server') {
      const exportDir = path.join(process.cwd(), 'artifacts', 'smoke-export');
      fs.mkdirSync(exportDir, { recursive: true });
      const marker = path.join(exportDir, 'marker.png');
      fs.writeFileSync(marker, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // registration anchor
      await win.webContents.executeJavaScript(
        `window.__smokeExportDir = ${JSON.stringify(exportDir)}; window.__smokeExportMarker = ${JSON.stringify(marker)}; 'set'`,
      );
      const exportResult = (await win.webContents.executeJavaScript(
        `(async () => {
          const pf = window.__pf;
          const b = window.pixelforge;
          if (!pf || !pf.exportProbe) return { ok: false, error: 'exportProbe missing' };
          if (!b || b.bridgeVersion < 3) return { ok: false, error: 'bridge v3 missing' };
          // register the marker → its parent dir joins the session allowlist
          await b.project.registerPath(window.__smokeExportMarker);
          const files = await pf.exportProbe.build({
            scope: 'clip', format: 'sheet',
            sheet: { columns: 2, padding: 2, spacing: 2 }, includeJson: true,
          });
          if (files.length !== 2) return { ok: false, error: 'expected sheet + json artifacts' };
          const dir = window.__smokeExportDir;
          const written = [];
          for (const f of files) written.push({ filename: f.filename, bytes: f.bytes });
          const res = await pf.exportProbe.write(dir, written, true);
          if (res.status !== 'ok') return { ok: false, error: 'write status ' + res.status, res };
          // read back through the REAL bridge fs and byte-compare
          const roundtrip = [];
          for (const f of files) {
            const back = await b.project.fs.readFile(dir + '/' + f.filename);
            let same = back.length === f.bytes.length;
            for (let i = 0; same && i < f.bytes.length; i++) if (back[i] !== f.bytes[i]) same = false;
            roundtrip.push({ file: f.filename, bytes: back.length, same });
          }
          // conflict preflight: overwrite=false must refuse (files now exist)
          const conflict = await pf.exportProbe.write(dir, written, false);
          return {
            ok: roundtrip.every((r) => r.same),
            roundtrip,
            conflictStatus: conflict.status,
            conflictCount: conflict.status === 'conflicts' ? conflict.conflicts.length : 0,
            exportsApi: typeof b.exports?.pickDir === 'function',
          };
        })()`,
      )) as {
        ok: boolean;
        error?: string;
        roundtrip?: { file: string; bytes: number; same: boolean }[];
        conflictStatus?: string;
        conflictCount?: number;
        exportsApi?: boolean;
      };
      if (!exportResult.ok) {
        throw new Error(`export round-trip failed: ${JSON.stringify(exportResult)}`);
      }
      if (exportResult.conflictStatus !== 'conflicts' || exportResult.conflictCount !== 2) {
        throw new Error(`conflict preflight failed: ${JSON.stringify(exportResult)}`);
      }
      if (!exportResult.exportsApi) {
        throw new Error('bridge exports.pickDir namespace missing (bridge v3)');
      }
      // main-process proof: the files really hit the disk (not just the bridge)
      for (const r of exportResult.roundtrip ?? []) {
        const onDisk = fs.statSync(path.join(exportDir, r.file));
        if (onDisk.size !== r.bytes) {
          throw new Error(`on-disk size mismatch for ${r.file}: ${onDisk.size} != ${r.bytes}`);
        }
      }
      probe.exportRoundTrip = exportResult;
    }

    // --- Task 8: MCP editor bridge (PF_SMOKE_MCP=1, dev server) ------------
    // The MCP server (mini-services/mcp-server) must be running on
    // 127.0.0.1:3030. The renderer bridge auto-connects (gateway path fails
    // inside Electron → direct-loopback failover). This block proves the
    // live link inside the REAL desktop renderer; full pairing + SDK-client
    // tool flows are covered by mini-services/mcp-server (contract tests +
    // e2e-client.mjs against the same page code).
    if (process.env.PF_SMOKE_MCP === '1' && mode === 'dev-server') {
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
        throw new Error(`MCP E2E client failed: ${e.message ?? String(err)}${e.stderr ? ` :: ${e.stderr.slice(-400)}` : ''}`);
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

    // --- Task 13a: settings + credential vault (PF_SMOKE_SETTINGS=1) -------
    // Exercises the REAL bridge settings namespace from the real renderer:
    // store a key → scan the userData tree from MAIN while the key is stored
    // (plaintext must appear NOWHERE — ciphertext only) → prove the IPC view
    // is secret-free → remove. C13 plaintext-key grep gate, end-to-end.
    if (process.env.PF_SMOKE_SETTINGS === '1' && mode === 'dev-server') {
      const probeKey = `sk-smoke-13a-${Date.now().toString(36)}-SECRET`;
      const providerId = 'openai';

      const setResult = (await win.webContents.executeJavaScript(
        `(async () => {
          const b = window.pixelforge;
          if (!b || b.bridgeVersion < 4 || !b.settings) {
            return { bridgeV4: false, namespace: !!b?.settings };
          }
          const set = await b.settings.setApiKey(${JSON.stringify(providerId)}, ${JSON.stringify(probeKey)});
          const stored = (await b.settings.hasKey(${JSON.stringify(providerId)})) === true;
          const view = await b.settings.getAll();
          const leakInIpcView = JSON.stringify(view).includes(${JSON.stringify(probeKey)});
          const status = await b.settings.credentialStatus();
          return {
            bridgeV4: true, namespace: true,
            sessionOnly: set.sessionOnly === true,
            stored,
            leakInIpcView,
            statusProvider: status.providers.some((p) => p.id === ${JSON.stringify(providerId)} && p.hasKey === true),
            encryptionAvailable: status.encryptionAvailable,
            backend: status.backend,
          };
        })()`,
      )) as {
        bridgeV4: boolean; namespace: boolean; sessionOnly: boolean; stored: boolean;
        leakInIpcView: boolean; statusProvider: boolean; encryptionAvailable: boolean; backend: string;
      };

      if (!setResult.bridgeV4 || !setResult.namespace) {
        throw new Error(`bridge v4 settings namespace missing: ${JSON.stringify(setResult)}`);
      }
      if (!setResult.stored) throw new Error('setApiKey → hasKey returned false');
      if (setResult.leakInIpcView) throw new Error('SECRET LEAK: API key visible in the settings IPC view');
      if (!setResult.statusProvider) throw new Error('credentialStatus does not report the stored key');

      // MAIN-side disk + log scan WHILE the key is stored (grep gate, C13).
      let plaintextOnDisk = false;
      let plaintextInLogs = false;
      const scanTree = (dir: string, depth: number): void => {
        if (depth > 3) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          try {
            if (entry.isDirectory()) {
              if (entry.name === 'CachedData' || entry.name.startsWith('GPUCache')) continue;
              scanTree(full, depth + 1);
            } else if (entry.isFile()) {
              if (fs.readFileSync(full).includes(Buffer.from(probeKey))) {
                if (entry.name.endsWith('.log')) plaintextInLogs = true;
                else plaintextOnDisk = true;
              }
            }
          } catch { /* unreadable entries are not ours */ }
        }
      };
      scanTree(app.getPath('userData'), 0);
      if (plaintextOnDisk || plaintextInLogs) {
        throw new Error(`SECRET LEAK: plaintext key found on disk (file=${plaintextOnDisk}, log=${plaintextInLogs})`);
      }

      // cleanup + confirm
      const cleaned = (await win.webContents.executeJavaScript(
        `(async () => {
          const b = window.pixelforge.settings;
          const ok = await b.removeKey('openai');
          return ok && (await b.hasKey('openai')) === false;
        })()`,
      )) as boolean;
      if (!cleaned) throw new Error('removeKey failed to clear the stored credential');

      probe.settings = {
        bridgeV4: true,
        namespace: true,
        roundTrip: true,
        keyStored: true,
        sessionOnly: setResult.sessionOnly,
        plaintextOnDisk: false,
        plaintextInLogs: false,
        secretInIpcView: false,
        removed: true,
      };
    }

    // --- Task 13a restart persistence (runner-driven two-launch sequence) ---
    // Launch 1: PF_SMOKE_KEY_SEED=1 PF_SMOKE_KEY=<secret> → stores the key,
    //           verifies hasKey, exits (key STAYS on disk, encrypted).
    // Launch 2: PF_SMOKE_KEY_VERIFY=1 → hasKey must still be true (the key
    //           survived a full app restart), then removeKey + confirm.
    if (process.env.PF_SMOKE_KEY_SEED === '1' && mode === 'dev-server') {
      const seedKey = process.env.PF_SMOKE_KEY ?? `sk-seed-13a-${Date.now().toString(36)}`;
      const seeded = (await win.webContents.executeJavaScript(
        `(async () => {
          const b = window.pixelforge.settings;
          await b.setApiKey('openai', ${JSON.stringify(seedKey)});
          return (await b.hasKey('openai')) === true;
        })()`,
      )) as boolean;
      if (!seeded) throw new Error('seed phase: setApiKey → hasKey returned false');
    }
    if (process.env.PF_SMOKE_KEY_VERIFY === '1' && mode === 'dev-server') {
      const hasKey = (await win.webContents.executeJavaScript(
        `window.pixelforge.settings.hasKey('openai')`,
      )) as boolean;
      if (hasKey !== true) {
        throw new Error('credential did not survive the app restart (hasKey=false)');
      }
      const cleaned = (await win.webContents.executeJavaScript(
        `(async () => {
          const b = window.pixelforge.settings;
          const ok = await b.removeKey('openai');
          return ok && (await b.hasKey('openai')) === false;
        })()`,
      )) as boolean;
      if (!cleaned) throw new Error('verify-phase cleanup (removeKey) failed');
      probe.settingsPersisted = { hasKeyAfterRestart: true, cleaned: true };
    }

    // --- Task 9: AI generation pipeline (PF_SMOKE_AI=1, dev server) ---------
    // Runs with PF_AI_MOCK=1 (offline deterministic mock adapter — NO network,
    // NO cost): renderer → bridge v5 ai.submit → MAIN job manager → mock
    // adapter → job events → candidate store (normalize v2) → CommandBus
    // import as layer → undo. Also proves NO key material ever reaches the
    // renderer job view.
    if (process.env.PF_SMOKE_AI === '1' && mode === 'dev-server') {
      const aiProbe = (await win.webContents.executeJavaScript(
        `(async () => {
          const b = window.pixelforge;
          if (!b || b.bridgeVersion < 5 || !b.ai) return { bridgeV5: false };
          const ai = window.__pfAi;
          if (!ai) return { bridgeV5: true, probe: false };
          const fullPrompt = 'smoke sprite, pixel art sprite, retro 16-bit game asset style';
          await ai.submit({
            prompt: fullPrompt, recipeId: 'item', width: 32, height: 32, count: 1,
            providerId: 'mock', providerLabel: 'Mock (offline)', model: 'mock-pattern',
            normalize: { targetW: 32, targetH: 32, removeBg: true, bgTolerance: 48, paletteMode: 'auto', palette: [], maxColors: 16, outlineCleanup: true },
          });
          // wait for the candidate pipeline to settle (worker normalize)
          const deadline = Date.now() + 30000;
          let candidate = null;
          while (Date.now() < deadline) {
            const c = ai.store.getState().candidates.find((x) => x.prompt === fullPrompt && x.status === 'review' && x.normalized);
            if (c) { candidate = c; break; }
            await new Promise((r) => setTimeout(r, 100));
          }
          if (!candidate) {
            const anyC = ai.store.getState().candidates.find((x) => x.prompt === fullPrompt);
            return { bridgeV5: true, probe: true, candidateReady: false, status: anyC?.status ?? 'none', error: anyC?.error ?? null };
          }
          const jobView = await b.ai.list();
          const viewJson = JSON.stringify(jobView);
          const leak = /sk-[A-Za-z0-9_-]{8,}/.test(viewJson);
          const layersBefore = ai.snapshot().layers;
          ai.importAsLayer(new Uint8ClampedArray(candidate.normalized.buffer), 'AI: smoke');
          const afterImport = ai.snapshot();
          ai.undo();
          const afterUndo = ai.snapshot();
          return {
            bridgeV5: true, probe: true,
            candidateReady: true,
            colors: candidate.normalized.colors,
            provenance: {
              provider: candidate.providerLabel,
              model: candidate.model,
              duration: typeof candidate.jobDurationMs === 'number',
              estimateField: 'costEstimateUsd' in candidate,
            },
            jobListed: jobView.length > 0,
            keyLeakInView: leak,
            importWorked: afterImport.layers === layersBefore + 1 && afterImport.topLayerName === 'AI: smoke',
            undoRestored: afterUndo.layers === layersBefore,
          };
        })()`,
      )) as {
        bridgeV5: boolean; probe: boolean; candidateReady?: boolean; colors?: number;
        provenance?: { provider: string; model: string; duration: boolean; estimateField: boolean };
        jobListed?: boolean; keyLeakInView?: boolean; importWorked?: boolean; undoRestored?: boolean;
        status?: string; error?: string | null;
      };

      if (!aiProbe.bridgeV5 || !aiProbe.probe) {
        throw new Error(`AI bridge/probe missing: ${JSON.stringify(aiProbe)}`);
      }
      if (!aiProbe.candidateReady) {
        throw new Error(`AI candidate never reached review (status=${aiProbe.status}, error=${aiProbe.error})`);
      }
      if (aiProbe.keyLeakInView) throw new Error('SECURITY: API-key-shaped material found in the renderer job view');
      if (!aiProbe.importWorked) throw new Error('AI import-as-layer failed (CommandBus transaction)');
      if (!aiProbe.undoRestored) throw new Error('AI import was not undone exactly');
      probe.ai = {
        bridgeV5: true,
        candidateReady: true,
        colors: aiProbe.colors ?? 0,
        provenanceOk: aiProbe.provenance?.duration === true && aiProbe.provenance?.estimateField === true,
        jobListed: aiProbe.jobListed === true,
        importUndone: aiProbe.importWorked && aiProbe.undoRestored,
      };
    }

    const dir = path.join(process.cwd(), 'artifacts');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `smoke-${mode}.png`);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(file, image.toPNG());

    logger.info('smoke.probe', probe);
    logger.info('smoke.screenshot', { file });
    console.log('[SMOKE:OK]', JSON.stringify({ mode, ...probe, screenshot: file }));
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
