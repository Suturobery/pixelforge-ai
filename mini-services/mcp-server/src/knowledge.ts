/**
 * PixelForge AI — embedded skill knowledge (v3.1 skill-system addendum §2/§3).
 *
 * Server-local (relay:false): serves the shipped pixel-art knowledge base and
 * grows it with studied references. No editor round-trip — works with no
 * editor connected; every paired AI client reads the same knowledge.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from '../../../packages/core/src/persist/png';
import { medianCutPalette } from '../../../packages/core/src/ai/normalize-v2';
import type { ToolEnvelope } from './types';

// Compiled exe (bun --compile) has a virtual import.meta.dir — the packaged
// launcher points PF_KNOWLEDGE_DIR at resources/mcp/knowledge instead.
const SHIPPED_DIR = process.env.PF_KNOWLEDGE_DIR ?? path.resolve(import.meta.dir, '../knowledge');
const DATA_DIR = process.env.PF_MCP_DATA_DIR ?? path.resolve(import.meta.dir, '../../../db');
const USER_LEARNED_DIR = path.join(DATA_DIR, 'knowledge-learned');

const TOPICS = [
  'methodology', 'patterns', 'palettes', 'animation', 'techniques',
  'cleanup', 'sharp_edges', 'validations', 'export', 'lpc',
  'shade', 'rig', 'tileset', 'concept', 'fix', 'palette_library', 'learned',
  'agent',
] as const;

function fail(code: string, message: string, hint?: string): ToolEnvelope {
  return { ok: false, error: { code, message, hint } };
}

function toHex(rgb: [number, number, number]): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

/** get_knowledge — read-only serve; user-grown learned styles override shipped. */
export function getKnowledge(topic: string, style?: string): ToolEnvelope {
  if (topic === 'learned') return learnedIndex(style);
  if (topic === 'palette_library') return paletteLibrary(style);
  if (!(TOPICS as readonly string[]).includes(topic)) {
    return fail('bad_request', `Unknown topic "${topic}".`, `Valid topics: ${TOPICS.join(', ')}.`);
  }
  try {
    const markdown = readFileSync(path.join(SHIPPED_DIR, `${topic}.md`), 'utf8');
    return { ok: true, data: { topic, markdown }, summary: `knowledge: ${topic}` };
  } catch {
    return fail('internal_error', `Shipped knowledge file for "${topic}" is missing on disk.`);
  }
}

function learnedIndex(style?: string): ToolEnvelope {
  if (style) {
    for (const dir of [USER_LEARNED_DIR, path.join(SHIPPED_DIR, 'learned')]) {
      const file = path.join(dir, `${style}.md`);
      if (existsSync(file)) {
        const markdown = readFileSync(file, 'utf8');
        return {
          ok: true,
          data: { topic: 'learned', style, source: dir === USER_LEARNED_DIR ? 'user' : 'shipped', markdown },
          summary: `learned style: ${style}`,
        };
      }
    }
    return fail('bad_request', `No learned style "${style}".`, 'List styles with get_knowledge {topic:"learned"}.');
  }
  const parts: string[] = [];
  try {
    parts.push(readFileSync(path.join(SHIPPED_DIR, 'learned', 'INDEX.md'), 'utf8'));
  } catch {
    /* shipped index optional */
  }
  const userIndex = path.join(USER_LEARNED_DIR, 'INDEX.md');
  parts.push(
    existsSync(userIndex)
      ? `## User-grown styles\n\n${readFileSync(userIndex, 'utf8')}`
      : '## User-grown styles\n\n(none yet — study a reference with study_reference)'
  );
  return { ok: true, data: { topic: 'learned', markdown: parts.join('\n\n') }, summary: 'knowledge: learned index' };
}

// ---------------------------------------------------------- palette library

interface PalettePreset {
  name: string;
  author?: string;
  size: number;
  notes?: string;
  colors: string[];
}

let paletteLib: { presets: Record<string, PalettePreset> } | null = null;

function loadPalettes(): { presets: Record<string, PalettePreset> } {
  if (paletteLib) return paletteLib;
  const parsed = JSON.parse(readFileSync(path.join(SHIPPED_DIR, 'palette-library.json'), 'utf8')) as {
    presets: Record<string, PalettePreset>;
  };
  paletteLib = parsed;
  return parsed;
}

function trimNotes(notes: string | undefined): string {
  if (!notes) return '';
  return notes.length > 110 ? `${notes.slice(0, 107)}…` : notes;
}

/** palette_library — 2000+ named palettes; style = exact id or keyword search. */
function paletteLibrary(query?: string): ToolEnvelope {
  let lib: { presets: Record<string, PalettePreset> };
  try {
    lib = loadPalettes();
  } catch {
    return fail('internal_error', 'palette-library.json is missing or unreadable.');
  }
  const presets = lib.presets ?? {};
  const ids = Object.keys(presets);

  if (query && presets[query]) {
    const p = presets[query];
    const markdown = [
      `# ${p.name}`,
      '',
      `- id: **${query}** · ${p.size} colors${p.author ? ` · by ${p.author}` : ''}`,
      ...(p.notes ? ['', p.notes] : []),
      '',
      `colors: ${p.colors.join(' ')}`,
    ].join('\n');
    return {
      ok: true,
      data: { topic: 'palette_library', id: query, name: p.name, author: p.author, size: p.size, notes: p.notes, colors: p.colors, markdown },
      summary: `palette: ${p.name} (${p.size} colors)`,
    };
  }

  if (query) {
    const q = query.toLowerCase();
    const hits = ids
      .filter((id) => {
        const p = presets[id];
        return id.includes(q) || p.name.toLowerCase().includes(q) || (p.notes ?? '').toLowerCase().includes(q);
      })
      .slice(0, 20);
    if (hits.length === 0) {
      return fail('bad_request', `No palette matches "${query}".`, 'Try a shorter keyword, or call without style to list the classics.');
    }
    const rows = hits.map((id) => {
      const p = presets[id];
      return `- **${id}** — ${p.name} (${p.size})${trimNotes(p.notes) ? ` · ${trimNotes(p.notes)}` : ''}\n  colors: ${p.colors.join(' ')}`;
    });
    return {
      ok: true,
      data: { topic: 'palette_library', matches: hits.length, markdown: [`# Palette search: ${query}`, '', ...rows].join('\n') },
      summary: `palette search "${query}": ${hits.length} matches`,
    };
  }

  const rows = ids.slice(0, 30).map((id) => {
    const p = presets[id];
    return `- **${id}** — ${p.name} (${p.size})${trimNotes(p.notes) ? ` · ${trimNotes(p.notes)}` : ''}`;
  });
  return {
    ok: true,
    data: {
      topic: 'palette_library',
      count: ids.length,
      markdown: [
        '# Palette library',
        '',
        `${ids.length} named palettes (classic consoles + Lospec most-downloaded). Top entries:`,
        '',
        ...rows,
        '',
        'Search: pass style as a keyword (matches id, name, notes) or an exact id for the full color list.',
      ].join('\n'),
    },
    summary: `palette library: ${ids.length} presets`,
  };
}

export interface StudyInput {
  pngBase64: string;
  styleName?: string;
  notes?: string;
}

/**
 * study_reference — decode a PNG, measure it (palette, symmetry, opaque
 * ratio), append a learned style doc to the user knowledge dir. Analysis
 * only; nothing enters the canvas.
 */
export async function studyReference(input: StudyInput): Promise<ToolEnvelope> {
  const comma = input.pngBase64.indexOf('base64,');
  const b64 = comma >= 0 ? input.pngBase64.slice(comma + 7) : input.pngBase64;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  } catch {
    return fail('bad_request', 'pngBase64 is not valid base64.');
  }
  let width = 0;
  let height = 0;
  let rgba: Uint8ClampedArray;
  try {
    const png = await decodePng(bytes);
    ({ width, height, rgba } = png);
  } catch (err) {
    return fail('bad_request', 'Could not decode the PNG.', err instanceof Error ? err.message : undefined);
  }
  if (width < 1 || height < 1 || width > 512 || height > 512) {
    return fail('bad_request', `Sprite is ${width}x${height}; study_reference accepts 1–512 px per side.`);
  }

  let opaque = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] > 0) opaque++;
  const opaqueRatio = Math.round((opaque / (width * height)) * 1000) / 10;
  const palette = medianCutPalette(rgba, 16).map(toHex);

  // horizontal mirror symmetry over pixels whose mirror twin is also opaque
  let pairs = 0;
  let matched = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < Math.floor(width / 2); x++) {
      const a = (y * width + x) * 4;
      const b = (y * width + (width - 1 - x)) * 4;
      if (rgba[a + 3] > 0 && rgba[b + 3] > 0) {
        pairs++;
        if (rgba[a] === rgba[b] && rgba[a + 1] === rgba[b + 1] && rgba[a + 2] === rgba[b + 2]) matched++;
      }
    }
  }
  const symmetry = pairs === 0 ? null : Math.round((matched / pairs) * 1000) / 10;

  const slugBase =
    (input.styleName ?? 'studied-style').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) ||
    'studied-style';
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const id = `u${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  const file = `${id}-${slugBase}`;

  const doc = [
    `# Study: ${input.styleName ?? slugBase}`,
    '',
    `- **source**: MCP study_reference · studied: ${new Date().toISOString().slice(0, 10)}`,
    `- **true size**: ${width}x${height} · **colors**: ${palette.length} · **opaque**: ${opaqueRatio}%`,
    `- **palette**: ${palette.join(' ')}`,
    `- **horizontal symmetry**: ${symmetry === null ? 'n/a (no mirrored opaque pairs)' : `${symmetry}%`}`,
    ...(input.notes ? [`- **notes**: ${input.notes}`] : []),
    '',
    '## Measurements',
    '- palette extracted via median-cut (≤16); apply it with the palette tools when creating in this style',
    `- ${symmetry !== null && symmetry >= 95 ? 'near-perfect mirror symmetry — draw one half, mirror the other' : 'asymmetric composition — plan both halves'}`,
    '',
    '## Rules to apply',
    `- start from the extracted ${palette.length}-color palette; keep ramps within it`,
    '- re-run study_reference on more references of this style to strengthen this entry',
    '',
  ].join('\n');

  try {
    mkdirSync(USER_LEARNED_DIR, { recursive: true });
    const docPath = path.join(USER_LEARNED_DIR, `${file}.md`);
    const tmp = `${docPath}.tmp`;
    writeFileSync(tmp, doc, 'utf8');
    renameSync(tmp, docPath);
    const indexPath = path.join(USER_LEARNED_DIR, 'INDEX.md');
    const line = `- **${input.styleName ?? slugBase}** — \`${file}\` · ${width}x${height} · ${palette.length} colors · symmetry ${symmetry ?? 'n/a'}\n`;
    writeFileSync(indexPath, (existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '') + line, 'utf8');
  } catch {
    return fail('internal_error', 'Could not persist the learned style doc.', `Check that the data dir is writable: ${USER_LEARNED_DIR}`);
  }

  return {
    ok: true,
    data: { learnedId: file, palette, width, height, opaqueRatio, symmetry, userDir: USER_LEARNED_DIR },
    undoable: false,
    summary: `studied ${width}x${height} sprite — ${palette.length} colors, symmetry ${symmetry ?? 'n/a'}`,
  };
}
