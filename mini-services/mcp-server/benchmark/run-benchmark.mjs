/**
 * PixelForge benchmark runner (audit recommendation #5 — single-agent baseline).
 *
 * Measures how consistently the CURRENT client+pipeline produces assets for a
 * fixed brief list. Two modes:
 *
 *   dry (default)  — FREE, non-mutating. Records project style-contract
 *                    snapshot + per-frame validate_style + animation
 *                    invariants for every clip in the ACTIVE document.
 *   --live         — PAID. Runs every brief through generate_sprite (each
 *                    parks in the Approval Center — a human must click
 *                    Approve), then validate_candidate scores the normalized
 *                    result WITHOUT accepting it onto the canvas. The
 *                    document is never modified.
 *
 * Results land in benchmark/results-<timestamp>.json. Compare across
 * clients by running this same script from each MCP client environment and
 * diffing the summaries. Aesthetic quality stays a human/vision judgement —
 * this harness only records deterministic facts.
 *
 * Usage:
 *   bun run-benchmark.mjs <pairing-code>            # dry baseline
 *   bun run-benchmark.mjs <pairing-code> --live     # paid generation run
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP = process.env.PF_MCP_URL ?? 'http://127.0.0.1:3030/mcp';
const HERE = dirname(fileURLToPath(import.meta.url));
const pairingCode = process.argv[2];
const live = process.argv.includes('--live');
if (!pairingCode) {
  console.error('usage: bun run-benchmark.mjs <pairing-code> [--live]');
  process.exit(2);
}

const env = (r) => JSON.parse(r.content[0].text);
const unwrap = (r) => {
  const j = env(r);
  return j.data ?? j;
};

async function withClient(bearer, fn) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'pf-benchmark', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  // ---- 1) token: reuse PF_BENCH_TOKEN, or exchange the single-use code ----
  let token = process.env.PF_BENCH_TOKEN ?? null;
  if (!token) {
    token = await withClient(pairingCode, async (c) => {
      const paired = unwrap(await c.callTool({ name: 'pair_client', arguments: { name: 'pf-benchmark' } }));
      const t = paired.data?.token ?? paired.token ?? paired.result?.token;
      if (!t) throw new Error('pair_client returned no token: ' + JSON.stringify(paired).slice(0, 200));
      return t;
    });
  }

  // ---- 2) work under the real token --------------------------------------
  return withClient(token, async (c) => {
    const results = { startedAt: new Date().toISOString(), mode: live ? 'live' : 'dry', project: null, clips: [], briefs: [] };

    // ---- style-contract snapshot (the "profile version" under test) ------
    const state = unwrap(await c.callTool({ name: 'get_project_state', arguments: {} }));
    const profile = state.settings?.styleProfile ?? state.project?.settings?.styleProfile ?? null;
    results.project = {
      name: state.name ?? state.project?.name ?? null,
      width: state.width ?? state.project?.width ?? null,
      height: state.height ?? state.project?.height ?? null,
      paletteSize: state.palette?.length ?? null,
      styleLock: profile
        ? {
            enabled: profile.enabled,
            name: profile.name,
            paletteMode: profile.paletteMode,
            lighting: profile.lighting,
            outline: profile.outline,
            feedbackCues: (profile.feedback?.prefer?.length ?? 0) + (profile.feedback?.avoid?.length ?? 0),
          }
        : null,
    };
    console.log(`project: ${results.project.name} ${results.project.width}×${results.project.height} · styleLock ${results.project.styleLock?.enabled ? 'ON' : 'OFF'}`);

    // ---- dry: deterministic baseline over the ACTIVE document ------------
    const clips = state.clips ?? state.project?.clips ?? [];
    for (const clip of clips) {
      const row = { clipId: clip.id, name: clip.name, frames: 0, checks: [], invariants: null };
      try {
        const pv = unwrap(await c.callTool({ name: 'preview_animation', arguments: { clipId: clip.id, maxFrames: 32 } }));
        row.invariants = pv.invariants ?? null;
        row.frames = pv.totalFrames ?? 0;
      } catch (e) {
        row.invariants = { error: String(e).slice(0, 160) };
      }
      try {
        const v = unwrap(await c.callTool({ name: 'validate_style', arguments: { clipId: clip.id, frameIndex: 0 } }));
        row.checks = v.checks ?? [];
      } catch (e) {
        row.checks = [{ id: 'error', status: 'warning', label: 'validate_style failed', detail: String(e).slice(0, 160) }];
      }
      results.clips.push(row);
      const warns = row.checks.filter((ch) => ch.status === 'warning').length;
      console.log(`  clip "${clip.name}": ${row.frames}f · ${warns} warning(s) · emptyFrames=${row.invariants?.emptyFrames?.length ?? '?'}`);
    }

    // ---- live: paid generation per brief (needs human approval click) ----
    if (live) {
      const all = JSON.parse(readFileSync(join(HERE, 'briefs.json'), 'utf8')).briefs;
      const only = process.env.PF_BENCH_ONLY;
      const briefs = only ? all.filter((b) => b.id === only) : all;
      if (briefs.length === 0) throw new Error(`PF_BENCH_ONLY="${only}" matched no brief`);
      for (const brief of briefs) {
        const t0 = Date.now();
        console.log(`\n[live] "${brief.id}" → generate_sprite (approve the card in the editor)`);
        let gen;
        try {
          // generation + normalization can exceed the SDK's default 60s
          gen = unwrap(await c.callTool({
            name: 'generate_sprite',
            arguments: { prompt: brief.prompt, task: brief.task ?? 'create', count: 1 },
          }, undefined, { timeout: 240_000 }));
        } catch (e) {
          results.briefs.push({ id: brief.id, ok: false, error: String(e).slice(0, 200), durationMs: Date.now() - t0 });
          console.log(`  → client error: ${String(e).slice(0, 120)}`);
          continue;
        }
        const ids = gen.candidateIds ?? [];
        const styleLock = gen.styleLock ?? null;
        if (ids.length === 0) {
          results.briefs.push({ id: brief.id, ok: false, error: gen.error ?? 'no candidates', durationMs: Date.now() - t0 });
          console.log(`  → generation failed: ${JSON.stringify(gen.error).slice(0, 140)}`);
          continue;
        }
        // poll until normalized (normalization runs right after generation)
        let cand = null;
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const cands = unwrap(await c.callTool({ name: 'get_candidates', arguments: { limit: 4 } }));
          cand = (cands.candidates ?? []).find((x) => x.id === ids[0]);
          if (cand && cand.status !== 'normalizing' && cand.status !== 'pending') break;
        }
        const row = {
          id: brief.id,
          candidateId: ids[0],
          styleLock,
          status: cand?.status ?? 'unknown',
          normalizedSize: cand?.normalizedSize ?? null,
          durationMs: Date.now() - t0,
          checks: [],
        };
        if (cand?.normalizedSize) {
          const v = unwrap(await c.callTool({ name: 'validate_candidate', arguments: { candidateId: ids[0] } }));
          row.checks = v.checks ?? [];
          row.pass = v.pass;
        }
        results.briefs.push(row);
        const warns = row.checks.filter((ch) => ch.status === 'warning').length;
        console.log(`  → ${row.status} · ${row.normalizedSize ? `${row.normalizedSize.w}×${row.normalizedSize.h}` : 'no image'} · ${warns} warning(s) · ${(row.durationMs / 1000).toFixed(1)}s`);
      }
    }

    // ---- persist ----------------------------------------------------------
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = join(HERE, `results-${stamp}.json`);
    writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`\nresults → ${out}`);
    console.log(`summary: styleLock=${results.project.styleLock?.enabled ? 'ON' : 'OFF'} · clips=${results.clips.length} · briefs=${results.briefs.length}${live ? ' (paid run)' : ' (dry, free)'}`);
  });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(String(err).slice(0, 500));
    process.exit(1);
  },
);
