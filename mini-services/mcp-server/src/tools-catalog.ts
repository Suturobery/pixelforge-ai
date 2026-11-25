/**
 * PixelForge AI — MCP tool catalog (v3.1 §5.2/§5.3).
 *
 * Every non-server-side tool is a RELAY: the MCP server validates identity +
 * tier + rate budget, then forwards the call to
 * the PixelForge renderer, which executes it on the REAL CommandBus — the
 * same bus, validation and undo history as manual editing. Nothing here
 * mutates a document directly.
 *
 * Tiers registered: L0 read · L1 undoable writes · L2 destructive/disk.
 * All tools execute locally (editor CommandBus or deterministic helpers) —
 * there is no provider-backed image generation and no paid tools. Task 8b/8c
 * added the embedded knowledge skill set (get_knowledge L0, study_reference
 * L1); the shared-Brain surface exposes deterministic interpretation and the
 * agent task board.
 */

import { z } from 'zod';
import type { Tier } from './types';

export const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
export const hexColor = z.string().regex(HEX_RE, 'must be a hex color like #rrggbb (or #rgb/#rrggbbaa)');

const clipRef = {
  clipId: z.string().min(1).optional().describe('Target clip id (from get_project_state). Defaults to the active clip.'),
  clipName: z.string().min(1).max(60).optional().describe('Target clip by exact name (used when clipId is omitted).'),
};
const frameRef = {
  frameId: z.string().min(1).optional().describe('Target frame id. Overrides frameIndex.'),
  frameIndex: z.number().int().min(0).max(4095).optional().describe('Target frame position (0-based). Defaults to the active frame.'),
};
const layerRef = {
  layerId: z.string().min(1).optional().describe('Target layer id. Overrides layerName.'),
  layerName: z.string().min(1).max(120).optional().describe('Target layer by exact name. Defaults to the active layer.'),
};
const staleGuard = {
  expectedStateHash: z.string().min(8).max(128).optional().describe(
    'Optional optimistic-concurrency guard: the tool fails with stale_document when the document hash no longer matches. Take stateHash from any read tool.'
  ),
};

/** Bounded project data, not a free-form agent-instruction channel. */
const styleProfileSchema = z.object({
  enabled: z.boolean(),
  name: z.string().trim().min(1).max(48),
  artDirection: z.string().trim().min(1).max(180),
  lighting: z.enum(['top-left', 'top', 'front', 'flat']),
  outline: z.enum(['dark-1px', 'light-1px', 'none']),
  paletteMode: z.enum(['enforce', 'prefer', 'none']),
  transparentBackground: z.boolean(),
  notes: z.string().trim().max(480),
  references: z.array(z.object({
    clipId: z.string().regex(/^[a-z0-9_-]{1,80}$/i),
    frameId: z.string().regex(/^[a-z0-9_-]{1,80}$/i),
    label: z.string().trim().min(1).max(80),
  }).strict()).max(6).optional().default([]),
  feedback: z.object({
    prefer: z.array(z.string().trim().min(1).max(72).regex(/^[^\u0000-\u001f\u007f]+$/)).max(4).optional().default([]),
    avoid: z.array(z.string().trim().min(1).max(72).regex(/^[^\u0000-\u001f\u007f]+$/)).max(4).optional().default([]),
  }).strict().optional().default({ prefer: [], avoid: [] }),
  anchor: z.object({
    label: z.string().trim().min(1).max(64),
    clipId: z.string().regex(/^[a-z0-9_-]{1,80}$/i),
    frameIndex: z.number().int().min(0).max(4095),
    canvasWidth: z.number().int().min(1).max(4096),
    canvasHeight: z.number().int().min(1).max(4096),
    spriteWidth: z.number().int().min(1).max(4096),
    spriteHeight: z.number().int().min(1).max(4096),
    heightRatio: z.number().min(0).max(1),
    bottomMargin: z.number().int().min(0).max(4096),
    outlineStyle: z.enum(['dark-ink', 'sel-out', 'lineless']),
    paletteUsed: z.array(hexColor).max(24),
    craftScore: z.number().min(0).max(100),
    pinnedAt: z.number().int().min(0),
  }).strict().optional(),
}).strict();

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  tier: Tier;
  /** false = handled inside the MCP server (no editor round-trip). */
  relay: boolean;
  /** Task 11 §5.2: spends provider money — requires a human approval click. */
  paid?: boolean;
  inputSchema: Record<string, z.ZodType>;
}

export const TOOL_CATALOG: ToolDef[] = [
  // ------------------------------------------------------------------ L0 read
  {
    name: 'get_project_state',
    title: 'Get project state',
    description:
      'Read the ACTIVE PixelForge project: name, canvas size, palette, project Style Lock, clips (layers, frames, durations), ' +
      'trash count, dirty flag and the document stateHash. Call this first; ids and the stateHash it returns ' +
      'feed every other tool.',
    tier: 'L0',
    relay: true,
    inputSchema: {},
  },
  {
    name: 'list_projects',
    title: 'List saved projects',
    description:
      'List projects persisted by the app (id, name, size, timestamps). Use open_project to switch to one of them.',
    tier: 'L0',
    relay: true,
    inputSchema: {},
  },
  {
    name: 'get_clip',
    title: 'Get clip details',
    description:
      'Read one animation clip: layer stack (ids, names, visibility, opacity, linked), every frame with its ' +
      'duration override and which layers have pixels on it, plus tags and loop settings.',
    tier: 'L0',
    relay: true,
    inputSchema: { ...clipRef },
  },
  {
    name: 'get_frame_png',
    title: 'Get frame as PNG',
    description:
      'Inspect one composited frame as a native MCP PNG image. The result envelope also includes its PNG data URL. ' +
      'Supports nearest-neighbor scale 0.25/0.5/1/2/4/8 (use scale=8 with showGrid=true to visually inspect pixel craft, proportions, and alignment).',
    tier: 'L0',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      scale: z
        .union([z.literal(0.25), z.literal(0.5), z.literal(1), z.literal(2), z.literal(4), z.literal(8)])
        .optional()
        .describe('Nearest-neighbor output scale. Default 1 (native). Use 4 or 8 for crisp visual critique.'),
      showGrid: z
        .boolean()
        .optional()
        .describe('When scale >= 4, overlay a subtle pixel grid + 8px major ruler + checkerboard behind transparent pixels. Default false.'),
    },
  },
  {
    name: 'get_palette',
    title: 'Get palette',
    description: 'Read the project palette (ordered hex colors) and the palette-enforcement setting.',
    tier: 'L0',
    relay: true,
    inputSchema: {},
  },
  {
    name: 'validate_style',
    title: 'Validate frame against style contract',
    description:
      'Deterministic technical checks on one frame (composited): canvas size, crisp alpha, project-palette ' +
      'membership (when Style Lock enforces), transparent background and clear margins (when the profile asks ' +
      'for them). Honest scope: technical constraints only — subject readability and pose clarity remain human ' +
      'or vision-model critique. Run this BEFORE presenting work for review.',
    tier: 'L0',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      allowEdgeTouch: z.boolean().optional().describe(
        'true = sprite may touch canvas edges (tilesets, full-bleed backgrounds). Default false.',
      ),
    },
  },
  {
    name: 'analyze_pixel_craft',
    title: 'Analyze pixel-art craft defects',
    description:
      'Deterministic pixel-art craft linter (pure, $0): inspects one composited frame and reports exact (x, y) ' +
      'coordinates of outline doubles (thick L-corners), orphan stray speckles, silhouette jaggies, and pillow shading, ' +
      'plus a 0–100 craft score and bounding-box coverage metrics. Run alongside get_frame_png(scale=8, showGrid=true) to refine artwork.',
    tier: 'L0',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
    },
  },
  {
    name: 'list_templates',
    title: 'List starter sprite templates',
    description:
      'List the 8 built-in deterministic Starter Sprite Templates (chibi-humanoid, slime, rpg-sword, potion-flask, ' +
      'treasure-chest, stone-pedestal, topdown-tree, dungeon-tile). Each template scales to any canvas size, locks strictly ' +
      'to the project palette, and character/creature bases include Motion body-part definitions. Free (L0).',
    tier: 'L0',
    relay: true,
    inputSchema: {},
  },
  {
    name: 'generate_template',
    title: 'Insert starter sprite template',
    description:
      'Insert a palette-locked, sel-out polished Starter Sprite Template onto a new layer on the active/specified frame ' +
      '(and auto-tag Motion body parts for character/creature templates) in ONE undoable transaction. Returns bounds, ' +
      'tagged parts count, and automatic craftGate score. Free (L1).',
    tier: 'L1',
    relay: true,
    inputSchema: {
      template: z
        .enum([
          'chibi-humanoid',
          'slime',
          'rpg-sword',
          'potion-flask',
          'treasure-chest',
          'stone-pedestal',
          'topdown-tree',
          'dungeon-tile',
        ])
        .describe('Template id from list_templates.'),
      ...clipRef,
      ...frameRef,
      autoTagParts: z
        .boolean()
        .optional()
        .describe('Auto-tag Motion Composer body-part regions when supported by the template. Default true.'),
      name: z.string().trim().min(1).max(120).optional().describe('Optional custom layer name.'),
      ...staleGuard,
    },
  },
  {
    name: 'pin_style_anchor',
    title: 'Pin or clear Hero Sprite Style Anchor',
    description:
      'Measure a finished Hero sprite frame (exact spriteWidth × spriteHeight, heightRatio, bottomMargin ground line, ' +
      'outlineStyle dark-ink/sel-out/lineless, paletteUsed, craftScore) and pin it onto project Style Lock so every ' +
      'connected AI IDE matches exact proportions and style across the whole asset pack. Pass clear:true to unpin. Undoable (L1).',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      label: z.string().trim().min(1).max(64).optional().describe('Short label for the anchor, e.g. "Hero Knight".'),
      clear: z.boolean().optional().describe('true = unpin the current Hero Style Anchor.'),
      ...staleGuard,
    },
  },
    {
    name: 'list_vfx',
    title: 'List procedural VFX effects',
    description:
      'Catalog of deterministic procedural pixel-art VFX (pixelfx, MIT) renderable into a project clip by ' +
      'generate_vfx. Filter by category (fire, explosions, ice, lightning, arcane, nature, ui, pickups, …). ' +
      'Free — no cost, no document access.',
    tier: 'L0',
    relay: true,
    inputSchema: {
      category: z.string().min(1).max(40).optional().describe('Filter by category prefix, e.g. "fire".'),
    },
  },
  {
    name: 'generate_vfx',
    title: 'Generate or overlay procedural VFX',
    description:
      'Render a procedural VFX effect (from list_vfx, 244 built-in pixelfx effects) into a NEW clip OR ' +
      'directly onto the CURRENT sprite clip as depth-wrapped Back + Front layers (target:"current_clip", ' +
      'depth:"split") — deterministic (seeded), free, crisp pixel-art quantized by default, auto-warmed for ' +
      'looping effects, one undo transaction. Always prefer this over drawing manual sparkles/auras on sprites.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      effect: z.string().min(1).max(80).describe('Effect id from list_vfx, e.g. "arcane/rune-circle" or "fire/campfire".'),
      target: z.enum(['new_clip', 'current_clip']).optional().describe("'new_clip' creates a standalone clip (default); 'current_clip' overlays VFX layers directly onto the active/specified sprite clip."),
      clipId: z.string().min(1).max(80).optional().describe('Optional target clip id when target is "current_clip". Defaults to the active clip.'),
      depth: z.enum(['split', 'front', 'back', 'combined']).optional().describe("Layer placement: 'split' adds separate Back (behind sprite) and Front (over sprite) layers (default for current_clip); 'front', 'back', or 'combined' add a single layer."),
      crispPixelArt: z.boolean().optional().describe('Authentic pixel-art post-processing (nearest sampling + alpha cutoff + palette lock). Default true; set false for soft anti-aliased glow.'),
      alphaThreshold: z.number().int().min(1).max(254).optional().describe('Alpha cutoff (1..254) when crispPixelArt is true. Default 96.'),
      warmup: z.union([z.literal('auto'), z.number().int().min(0).max(64)]).optional().describe("Pre-roll update ticks before frame 0 so looping effects start alive. Default 'auto' (12 ticks for loop:true, 0 for one-shots)."),
      seed: z.number().int().min(0).max(999999).optional().describe('Random seed. Same seed + options = identical frames.'),
      frames: z.number().int().min(1).max(64).optional().describe('Frame count. Default: matches current clip length for current_clip, or covers effect duration at chosen fps.'),
      fps: z.number().int().min(1).max(60).optional().describe('Clip fps. Default matches current clip or 12.'),
      fit: z.enum(['fit', 'crop']).optional().describe("'fit' = full effect scaled to canvas (default). 'crop' = direct canvas render — tighter composition."),
      light: z.number().min(0).max(1).optional().describe('Additive-light intensity 0..1. Default 0.72 in crisp mode, 1 in soft mode.'),
      x: z.number().int().min(-4096).max(4096).optional().describe('Effect center X on canvas. Default: effect origin.'),
      y: z.number().int().min(-4096).max(4096).optional().describe('Effect center Y on canvas. Default: effect origin.'),
      palette: z.union([z.literal('project'), z.array(z.string().regex(/^#[0-9a-fA-F]{3,8}$/)).min(2).max(16)]).optional().describe(
        'Optional dark→bright hex ramp (or "project") replacing the effect colors.',
      ),
      name: z.string().min(1).max(120).optional().describe('New clip name (new_clip) or base layer name (current_clip).'),
    },
  },
  {
    name: 'preview_animation',
    title: 'Preview animation',
    description:
      'Inspect a clip as ordered MCP PNG images with the exact playback schedule the editor uses ' +
      '(loop mode, per-frame durations, cycle length). Frames are capped by maxFrames to bound the response.',
    tier: 'L0',
    relay: true,
    inputSchema: {
      ...clipRef,
      maxFrames: z.number().int().min(1).max(64).optional().describe('Maximum frames to render. Default 32.'),
    },
  },
  {
    name: 'subscribe_events',
    title: 'Subscribe to editor events',
    description:
      'Returns the current stateHash and instructions for receiving real-time "projectChanged" MCP notifications ' +
      '(custom method notifications/pixelforge/projectChanged with {stateHash, name, dirty}). Use it to detect ' +
      'document changes instead of blind re-polling.',
    tier: 'L0',
    relay: true,
    inputSchema: {},
  },
  {
    name: 'get_operation_log',
    title: 'Get MCP operation log',
    description:
      'Read the MCP audit log (server-side): which paired client called which tool, when, with hashed arguments, ' +
      'the result code and duration. Newest first.',
    tier: 'L0',
    relay: false,
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe('Maximum entries. Default 20.'),
    },
  },
  {
    name: 'get_quota',
    title: 'Get rate quota',
    description:
      'Read THIS client\'s remaining rate budget per tool tier (calls used / limit / seconds until reset). ' +
      'Call it before long batch jobs and pace yourself instead of hitting rate_limited.',
    tier: 'L0',
    relay: false,
    inputSchema: {},
  },
    // ---------------------------------------------------------- L1 safe writes
  {
    name: 'create_project',
    title: 'Create a new project',
    description:
      'Replace the active document with a NEW empty project (one clip, one frame). REJECTED with dirty_project ' +
      'while the current project has unsaved changes — ask the user to save (Ctrl+S) first; work is never discarded.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      name: z.string().trim().min(1).max(120).describe('Project name.'),
      width: z.number().int().min(16).max(256).describe('Canvas width in pixels (16–256).'),
      height: z.number().int().min(16).max(256).describe('Canvas height in pixels (16–256).'),
      fps: z.number().int().min(1).max(60).optional().describe('Frames per second for the first clip. Default 8.'),
      palette: z.array(hexColor).min(1).max(256).optional().describe('Initial palette. Default: the app palette.'),
      confirm: z.boolean().describe('Must be true — create_project replaces the ACTIVE document (the old project stays in list_projects).'),
      ...staleGuard,
    },
  },
  {
    name: 'open_project',
    title: 'Open a saved project',
    description:
      'Open a persisted project (from list_projects) and make it the active document. REJECTED with dirty_project ' +
      'while the current project has unsaved changes — the user saves manually; nothing is discarded.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      projectId: z.string().min(1).describe('Project row id from list_projects.'),
      ...staleGuard,
    },
  },
  {
    name: 'add_frame',
    title: 'Add frame',
    description:
      'Append a frame to a clip (or insert after afterIndex). Empty by default; copyContent duplicates the ' +
      'pixels of the frame at afterIndex (the previous frame when omitted).',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      afterIndex: z.number().int().min(-1).max(4095).optional().describe('Insert after this frame index. Default: append at the end.'),
      copyContent: z.boolean().optional().describe('Duplicate the referenced frame instead of adding an empty one.'),
      ...staleGuard,
    },
  },
  {
    name: 'rename_project',
    title: 'Rename project',
    description: 'Change the active project name. This changes document metadata only and is fully undoable.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      name: z.string().trim().min(1).max(120).describe('New project name.'),
      ...staleGuard,
    },
  },
  {
    name: 'duplicate_frame',
    title: 'Duplicate frame',
    description: 'Insert an exact copy of a frame right after it (undoable, trash-free).',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      frameIndex: z.number().int().min(0).max(4095).optional().describe('Frame to duplicate. Default: the active frame.'),
      ...staleGuard,
    },
  },
  {
    name: 'reorder_frames',
    title: 'Reorder frames',
    description: 'Move a frame from index `from` to index `to` within a clip.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      from: z.number().int().min(0).max(4095).describe('Current frame index.'),
      to: z.number().int().min(0).max(4095).describe('New frame index.'),
      ...staleGuard,
    },
  },
  {
    name: 'reverse_clip',
    title: 'Reverse clip frames',
    description: 'Invert the frame order of a clip (preserving layers, linked cels, and per-frame durations) in one undoable transaction.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...staleGuard,
    },
  },
  {
    name: 'bake_pingpong',
    title: 'Bake ping-pong loop',
    description:
      'Convert a 3+ frame clip into explicit forward ping-pong frames (appends mirrored inner frames [n-2..1] and sets loopMode="forward") ' +
      'for forward-only game engines. One undoable transaction.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...staleGuard,
    },
  },
  {
    name: 'delete_frame',
    title: 'Delete frame',
    description:
      'Remove a frame from a clip. TRASH-BACKED: the frame goes to the project trash (recoverable via ' +
      'restore_from_trash; undo also works). A clip always keeps at least one frame.',
    tier: 'L2',
    relay: true,
    inputSchema: {
      ...clipRef,
      frameIndex: z.number().int().min(0).max(4095).optional().describe('Frame to delete. Default: the active frame.'),
      ...staleGuard,
    },
  },
  {
    name: 'set_frame_duration',
    title: 'Set frame duration',
    description: 'Set one frame duration in milliseconds. Use 0 to inherit the clip FPS. Fully undoable.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      durationMs: z.number().int().min(0).max(60_000).describe('0 = inherit clip FPS; otherwise 1–60000 ms.'),
      ...staleGuard,
    },
  },
  {
    name: 'restore_from_trash',
    title: 'Restore from trash',
    description: 'Restore a previously deleted frame/layer/clip from the project trash (see trash entries in get_project_state).',
    tier: 'L1',
    relay: true,
    inputSchema: {
      entryId: z.string().min(1).describe('Trash entry id.'),
      ...staleGuard,
    },
  },
  {
    name: 'purge_trash',
    title: 'Purge trash',
    description:
      'Permanently remove trash entries: omit entryId to empty the whole trash, or pass one entryId to purge a ' +
      'single entry. PURGED ENTRIES ARE GONE — restore_from_trash can no longer recover them. Undoable as one ' +
      'transaction until the user closes history.',
    tier: 'L2',
    relay: true,
    inputSchema: {
      entryId: z.string().min(1).optional().describe('Purge only this entry. Default: empty the whole trash.'),
      ...staleGuard,
    },
  },
  {
    name: 'resize_canvas',
    title: 'Resize canvas',
    description:
      'Change the canvas size (16–256 per side). Content is SHIFTED, never rescaled: anchor "top-left" keeps the ' +
      'top-left corner fixed; "center" centers the old canvas in the new bounds. Pixels moved outside the new ' +
      'bounds are cropped away. One undoable step.',
    tier: 'L2',
    relay: true,
    inputSchema: {
      width: z.number().int().min(16).max(256).describe('New canvas width in pixels.'),
      height: z.number().int().min(16).max(256).describe('New canvas height in pixels.'),
      anchor: z.enum(['top-left', 'center']).optional().describe('Default top-left.'),
      ...staleGuard,
    },
  },
  {
    name: 'export_sheet',
    title: 'Export sprite sheet',
    description:
      'Render every frame of a clip (all visible layers composited) into ONE horizontal sprite-sheet PNG ' +
      '(optional nearest-neighbor scale 1/2/4/8) — game-engine ready. Returns base64 PNG data URL + dimensions, ' +
      'plus optional Aseprite-compatible JSON metadata (for Unity, Phaser, PixiJS, and Godot).',
    tier: 'L2',
    relay: true,
    inputSchema: {
      ...clipRef,
      padding: z.number().int().min(0).max(64).optional().describe('Outer margin around the sheet, px. Default 0.'),
      spacing: z.number().int().min(0).max(64).optional().describe('Gap between frames, px. Defaults to padding.'),
      scale: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional().describe('Nearest-neighbor integer upscale (1/2/4/8). Default 1.'),
      jsonFormat: z.enum(['pixelforge', 'aseprite']).optional().describe('Include sidecar metadata in the response: "aseprite" returns standard Aseprite JSON (Unity/Phaser/PixiJS/Godot).'),
      ...staleGuard,
    },
  },
  {
    name: 'export_atlas',
    title: 'Export master atlas (all clips)',
    description:
      'Pack EVERY animation clip in the project into ONE master sprite-sheet PNG (one row per clip, or wrapped grid), ' +
      'plus Aseprite-compatible JSON (with frameTags per clip) and optional combined Godot 4 SpriteFrames (.tres). ' +
      'Supports nearest-neighbor scale 1/2/4/8.',
    tier: 'L2',
    relay: true,
    inputSchema: {
      columns: z.number().int().min(0).max(64).optional().describe('0 (default) = one horizontal row per clip; >0 wraps long clips at N columns.'),
      padding: z.number().int().min(0).max(64).optional().describe('Outer margin around the atlas, px. Default 0.'),
      spacing: z.number().int().min(0).max(64).optional().describe('Gap between frames, px. Defaults to padding.'),
      scale: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional().describe('Nearest-neighbor integer upscale (1/2/4/8). Default 1.'),
      includeTres: z.boolean().optional().describe('Also generate a combined Godot 4 SpriteFrames (.tres) resource for all clips. Default false.'),
      ...staleGuard,
    },
  },
  {
    name: 'export_gif',
    title: 'Export animated GIF',
    description:
      'Render a clip as an animated GIF (base64 data URL). Transparency is flattened onto bg (GIF has no alpha). ' +
      'Per-frame durations come from the clip; loops infinitely.',
    tier: 'L2',
    relay: true,
    inputSchema: {
      ...clipRef,
      scale: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional().describe('Nearest-neighbor upscale. Default 1 (native).'),
      bg: hexColor.optional().describe('Flatten background hex. Default #101014.'),
      ...staleGuard,
    },
  },
  {
    name: 'set_pixels',
    title: 'Set pixels',
    description:
      'Paint up to 2000 pixels in one undoable step. Each pixel is {x, y} with an optional per-pixel color; ' +
      'the top-level color is the fallback. Coordinates outside the canvas are rejected per-pixel.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      ...layerRef,
      color: hexColor.optional().describe('Fallback color for pixels without their own color.'),
      pixels: z
        .array(z.object({ x: z.number().int(), y: z.number().int(), color: hexColor.optional() }))
        .min(1)
        .max(2000)
        .describe('Pixels to paint (bounds-checked).'),
      ...staleGuard,
    },
  },
  {
    name: 'fill_rect',
    title: 'Fill rectangle',
    description: 'Draw a filled (default) or outlined rectangle between two corner points, in one undoable step.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      ...layerRef,
      from: z.object({ x: z.number().int(), y: z.number().int() }).describe('First corner.'),
      to: z.object({ x: z.number().int(), y: z.number().int() }).describe('Opposite corner.'),
      color: hexColor.describe('Rectangle color.'),
      filled: z.boolean().optional().describe('true (default) = filled; false = outline only.'),
      ...staleGuard,
    },
  },
  {
    name: 'draw_line',
    title: 'Draw pixel line',
    description: 'Draw a crisp Bresenham pixel line between two points, in one undoable step.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      ...layerRef,
      from: z.object({ x: z.number().int(), y: z.number().int() }).describe('Start point.'),
      to: z.object({ x: z.number().int(), y: z.number().int() }).describe('End point.'),
      color: hexColor.describe('Line color.'),
      size: z.number().int().min(1).max(8).optional().describe('Brush size 1–8. Default 1.'),
      mirrorX: z.boolean().optional().describe('Mirror horizontally across the canvas center. Default false.'),
      ...staleGuard,
    },
  },
  {
    name: 'draw_ellipse',
    title: 'Draw pixel ellipse',
    description: 'Draw a filled (default) or outlined pixel-art ellipse/circle inside a bounding box, in one undoable step. Prefer this over fill_rect for heads, shields, potions, curves, and organic silhouettes.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      ...layerRef,
      from: z.object({ x: z.number().int(), y: z.number().int() }).describe('First corner of bounding box.'),
      to: z.object({ x: z.number().int(), y: z.number().int() }).describe('Opposite corner of bounding box.'),
      color: hexColor.describe('Ellipse color.'),
      filled: z.boolean().optional().describe('true (default) = filled; false = outline only.'),
      size: z.number().int().min(1).max(8).optional().describe('Outline brush size 1–8. Default 1.'),
      mirrorX: z.boolean().optional().describe('Mirror horizontally across the canvas center. Default false.'),
      ...staleGuard,
    },
  },
  {
    name: 'draw_polygon',
    title: 'Draw pixel polygon',
    description: 'Draw a filled (default) or outlined polygon from 2–64 vertices, in one undoable step. Ideal for capes, tapered swords, triangular silhouettes, roofs, and dynamic limbs.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      ...layerRef,
      points: z
        .array(z.object({ x: z.number().int(), y: z.number().int() }))
        .min(2)
        .max(64)
        .describe('Ordered polygon vertices.'),
      color: hexColor.describe('Polygon color.'),
      filled: z.boolean().optional().describe('true (default) = filled; false = outline only.'),
      mirrorX: z.boolean().optional().describe('Mirror horizontally across the canvas center. Default false.'),
      ...staleGuard,
    },
  },
  {
    name: 'flood_fill',
    title: 'Flood fill region',
    description: 'Scanline flood-fill a contiguous region starting at (x, y) with color, in one undoable step.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      ...layerRef,
      x: z.number().int().describe('Seed x coordinate.'),
      y: z.number().int().describe('Seed y coordinate.'),
      color: hexColor.describe('Fill color.'),
      mirrorX: z.boolean().optional().describe('Also fill the horizontally mirrored seed point. Default false.'),
      ...staleGuard,
    },
  },
  {
    name: 'replace_color',
    title: 'Replace color',
    description:
      'Replace every pixel of one color on the target cel with another color (exact match on RGBA). Undoable.',
    tier: 'L2',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      ...layerRef,
      from: hexColor.describe('Color to find.'),
      to: hexColor.describe('Replacement color.'),
      ...staleGuard,
    },
  },
  {
    name: 'flip_frame',
    title: 'Flip frame',
    description: 'Mirror the target cel horizontally or vertically (optionally within a rect). Undoable.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      ...layerRef,
      axis: z.enum(['horizontal', 'vertical']).describe('Mirror axis.'),
      rect: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) })
        .optional()
        .describe('Restrict the flip to this region. Default: whole cel.'),
      ...staleGuard,
    },
  },
  {
    name: 'rotate_frame',
    title: 'Rotate frame',
    description: 'Rotate the target cel 90° clockwise or counter-clockwise (optionally within a square rect). Undoable.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      ...layerRef,
      direction: z.enum(['cw', 'ccw']).describe('Rotation direction.'),
      rect: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) })
        .optional()
        .describe('Restrict the rotation to this region. Default: whole cel.'),
      ...staleGuard,
    },
  },
  {
    name: 'shift_frame',
    title: 'Shift frame',
    description: 'Move the target cel content by dx/dy pixels (wraps nothing: vacated pixels become transparent). Undoable.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      ...layerRef,
      dx: z.number().int().min(-4096).max(4096).describe('Horizontal offset.'),
      dy: z.number().int().min(-4096).max(4096).describe('Vertical offset.'),
      ...staleGuard,
    },
  },
  {
    name: 'center_content',
    title: 'Center artwork on canvas',
    description:
      'Compute the opaque bounding box of the target layer (or all visible unlocked layers on the frame when allLayers:true) and shift artwork cleanly to the exact canvas center in one undoable step.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      ...layerRef,
      allLayers: z.boolean().optional().describe('true = center all visible unlocked layers on the frame together by their combined bounding box. Default false (target layer only).'),
      ...staleGuard,
    },
  },
  {
    name: 'remap_palette',
    title: 'Remap artwork to palette (skin swap)',
    description:
      'Remap pixels on a layer, frame, or entire clip onto a target palette in one undoable transaction. ' +
      'Mode "ramp" (default) preserves OKLab dark→mid→bright shading contrast for clean skin/color variants; ' +
      'mode "nearest" quantizes to the closest OKLab palette colors. Omit palette to remap onto the active project palette.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      ...layerRef,
      palette: z.array(hexColor).min(1).max(256).optional().describe('Target hex color palette. Defaults to the current project palette.'),
      mode: z.enum(['ramp', 'nearest']).optional().describe('"ramp" (default) preserves lightness-rank contrast for skin swaps; "nearest" matches closest OKLab color.'),
      scope: z.enum(['layer', 'frame', 'clip']).optional().describe('Which cels to remap. Default "clip".'),
      updateProjectPalette: z.boolean().optional().describe('Also replace the project palette with `palette`. Default true when `palette` is supplied, false otherwise.'),
      ...staleGuard,
    },
  },
  {
    name: 'auto_trim',
    title: 'Auto-trim canvas to artwork',
    description:
      'Crop excess transparent borders around the combined opaque bounding box across all clips and frames, with optional uniform padding (0–16px, clamped to 16–256px). One undoable step.',
    tier: 'L2',
    relay: true,
    inputSchema: {
      padding: z.number().int().min(0).max(16).optional().describe('Transparent border padding in pixels around the tight bounding box. Default 1.'),
      ...staleGuard,
    },
  },
  {
    name: 'add_clip',
    title: 'Add clip',
    description: 'Create a new animation clip with 1..64 empty frames and its own layer stack.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      name: z.string().trim().min(1).max(60).describe('Clip name (must be unique).'),
      fps: z.number().int().min(1).max(60).optional().describe('Clip fps. Default 8.'),
      frameCount: z.number().int().min(1).max(64).optional().describe('Number of empty frames to create. Default 1.'),
      ...staleGuard,
    },
  },
  {
    name: 'set_clip_props',
    title: 'Set clip properties',
    description: 'Rename a clip or change its playback: fps (1–60), loop on/off, loop mode (forward/reverse/pingpong).',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      name: z.string().trim().min(1).max(120).optional(),
      fps: z.number().int().min(1).max(60).optional(),
      loop: z.boolean().optional().describe('false = play once through and stop.'),
      loopMode: z.enum(['forward', 'reverse', 'pingpong']).optional(),
      ...staleGuard,
    },
  },
  {
    name: 'delete_clip',
    title: 'Delete clip',
    description: 'Remove a clip. TRASH-BACKED (restore_from_trash / undo recover it). A project keeps at least one clip.',
    tier: 'L2',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...staleGuard,
    },
  },
  {
    name: 'set_clip_tags',
    title: 'Set animation tags',
    description: 'Replace the named frame ranges for a clip (for example idle, walk, attack). Frame indexes are zero-based and inclusive.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      tags: z.array(z.object({
        name: z.string().trim().min(1).max(64),
        from: z.number().int().min(0).max(4095),
        to: z.number().int().min(0).max(4095),
      }).strict().refine((tag) => tag.to >= tag.from, { message: 'tag.to must be greater than or equal to tag.from' })).max(128),
      ...staleGuard,
    },
  },
  {
    name: 'add_layer',
    title: 'Add layer',
    description: 'Append an empty layer to the top of a clip\'s stack.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      name: z.string().trim().min(1).max(120).optional().describe('Layer name. Default: "layer N".'),
      ...staleGuard,
    },
  },
  {
    name: 'duplicate_layer',
    title: 'Duplicate layer',
    description: 'Copy a layer (including all its cels) and insert the copy directly above it.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...layerRef,
      ...staleGuard,
    },
  },
  {
    name: 'delete_layer',
    title: 'Delete layer',
    description: 'Remove a layer and its cels. TRASH-BACKED (restore_from_trash / undo recover it). A clip keeps at least one layer.',
    tier: 'L2',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...layerRef,
      ...staleGuard,
    },
  },
  {
    name: 'set_layer_props',
    title: 'Set layer properties',
    description: 'Rename a layer, toggle visibility, or set opacity (0–1).',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...layerRef,
      name: z.string().trim().min(1).max(120).optional(),
      visible: z.boolean().optional(),
      opacity: z.number().min(0).max(1).optional(),
      locked: z.boolean().optional().describe('Paint lock: pixel tools cannot change this layer while locked.'),
      blend: z.enum(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten']).optional(),
      ...staleGuard,
    },
  },
  {
    name: 'set_layer_linked',
    title: 'Set linked layer',
    description: 'Link a layer so all frames share one cel, or unlink it into independent cels. Fully undoable.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...layerRef,
      linked: z.boolean(),
      ...staleGuard,
    },
  },
  {
    name: 'reorder_layers',
    title: 'Reorder layers',
    description: 'Move a layer one position up (towards top) or down (towards bottom) in the stack.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...layerRef,
      direction: z.enum(['up', 'down']).describe('up = towards the top of the stack, down = towards the bottom.'),
      ...staleGuard,
    },
  },
  {
    name: 'merge_down',
    title: 'Merge layer down',
    description: 'Composite a layer onto the one below it and remove the top layer. Undoable (snapshot history).',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...layerRef,
      ...staleGuard,
    },
  },
  {
    name: 'add_palette_color',
    title: 'Add palette color',
    description: 'Append a hex color to the project palette (no-op when already present).',
    tier: 'L1',
    relay: true,
    inputSchema: {
      hex: hexColor.describe('Color to add.'),
      ...staleGuard,
    },
  },
  {
    name: 'set_palette',
    title: 'Set palette',
    description: 'Replace the whole project palette in one undoable step (1–256 colors).',
    tier: 'L2',
    relay: true,
    inputSchema: {
      colors: z.array(hexColor).min(1).max(256).describe('The new palette, bottom → top order.'),
      ...staleGuard,
    },
  },
  {
    name: 'remove_palette_color',
    title: 'Remove palette color',
    description: 'Remove one existing color from the project palette. It does not recolor pixels; use replace_color first when needed.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      hex: hexColor.describe('Existing palette color to remove.'),
      ...staleGuard,
    },
  },
  {
    name: 'brain_interpret_prompt',
    title: 'Second Brain: Interpret & enhance prompt',
    description:
      'Second-brain reasoning helper (L0, free): automatically interpret short, incomplete, misspelled, or ambiguous prompts ' +
      'using the active PixelForge project context (canvas dimensions, palette, Style Lock, clips, layers, and learned artist preferences). ' +
      'Returns the typo-corrected prompt, fully enhanced pixel-art/animation prompt, detected intent, target clip/layer ids, and recommended tool sequence.',
    tier: 'L0',
    relay: true,
    inputSchema: {
      prompt: z.string().min(1).max(2000).describe('Raw user or agent prompt to interpret, correct, and enhance.'),
    },
  },
  {
    name: 'brain_get_tasks',
    title: 'Get brain task board',
    description:
      'Second-brain orchestration: read the task board the Groq planner queued. Pending items are work an IDE ' +
      'agent should claim (brain_claim_task), execute with the normal PixelForge workflow, then finish with ' +
      'brain_complete_task / brain_fail_task. Free (L0).',
    tier: 'L0',
    relay: false,
    inputSchema: {},
  },
  {
    name: 'brain_get_task',
    title: 'Get one brain task',
    description: 'Read the full record of a single task board item (status, progress, claim owner, result). Free (L0).',
    tier: 'L0',
    relay: false,
    inputSchema: {
      id: z.string().min(1).max(80).describe('Task id from brain_get_tasks.'),
    },
  },
  {
    name: 'brain_get_status',
    title: 'Brain service status',
    description:
      'Read: availability of the PixelForge Brain service — editor connection, task-board counts, session and client counts. ' +
      'The reasoning provider itself resolves editor-side per call (keys never leave the editor/vault). Free (L0).',
    tier: 'L0',
    relay: false,
    inputSchema: {},
  },
  {
    name: 'brain_get_capabilities',
    title: 'Brain capability catalog',
    description:
      'Read: the deterministic capability catalog — every MCP tool PixelForge exposes, filtered to YOUR permission tier, ' +
      'plus board counts. Plans must only reference capabilities listed here. Free (L0).',
    tier: 'L0',
    relay: false,
    inputSchema: {},
  },
      {
    name: 'brain_claim_task',
    title: 'Claim a brain task',
    description: 'Claim a pending board task for THIS agent. Only pending tasks can be claimed; the claim is exclusive.',
    tier: 'L1',
    relay: false,
    inputSchema: {
      id: z.string().min(1).max(80).describe('Task id from brain_get_tasks.'),
    },
  },
  {
    name: 'brain_complete_task',
    title: 'Complete a brain task',
    description: 'Mark a task you claimed as DONE with a short result summary. Run validate_style first — a failed validation belongs in brain_fail_task.',
    tier: 'L1',
    relay: false,
    inputSchema: {
      id: z.string().min(1).max(80),
      result: z.string().min(1).max(2000).describe('What was done, validated.'),
    },
  },
  {
    name: 'brain_fail_task',
    title: 'Fail a brain task',
    description: 'Mark a claimed task FAILED with the reason (validation failed, blocked, ambiguous). The planner or the artist will re-plan.',
    tier: 'L1',
    relay: false,
    inputSchema: {
      id: z.string().min(1).max(80),
      reason: z.string().min(1).max(2000),
    },
  },
  {
    name: 'brain_update_task_progress',
    title: 'Update brain task progress',
    description:
      'Owner-only progress note on a task you claimed (moves it claimed → running and refreshes your claim lease). ' +
      'Call periodically on long work so the lease does not expire and the task is not requeued.',
    tier: 'L1',
    relay: false,
    inputSchema: {
      id: z.string().min(1).max(80).describe('Task id from brain_get_tasks.'),
      progress: z.string().min(1).max(200).describe('Short bounded progress note, e.g. "outline pass 2/3".'),
    },
  },
  {
    name: 'brain_cancel_task',
    title: 'Cancel a brain task',
    description:
      'Cancel a task ONLY YOU claimed (pending tasks belong to the artist — they cancel from the editor). ' +
      'Cancelled work is removed from your responsibility; the artist can re-queue it.',
    tier: 'L1',
    relay: false,
    inputSchema: {
      id: z.string().min(1).max(80).describe('Task id you claimed.'),
    },
  },
  {
    name: 'apply_library_palette',
    title: 'Apply a library palette',
    description:
      'Pick a palette by id from the built-in library (2000+ console-classic and Lospec palettes — browse with ' +
      "get_knowledge {topic:'palette_library', style:'<keyword>'}) and set it as the project palette in one step. " +
      'Server-side: resolves the id locally, then performs the same undoable set_palette on the editor. ' +
      'One call replaces search → copy → set_palette.',
    tier: 'L2',
    relay: false,
    inputSchema: {
      id: z.string().min(1).max(80).describe('Library palette id from the palette_library knowledge topic.'),
    },
  },
  {
    name: 'set_style_profile',
    title: 'Set project style profile',
    description:
      'Set the shared PixelForge Style Lock: art direction, lighting, outline, palette behavior and bounded notes. ' +
      'Optional references are pointers to existing project frames; call get_frame_png with their ids to view them. ' +
      'This is an undoable project change. It does not expose credentials or bypass the paid-generation approval gate.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      profile: styleProfileSchema.describe('Complete project Style Lock profile.'),
      ...staleGuard,
    },
  },
  {
    name: 'import_image_as_layer',
    title: 'Import image as layer',
    description:
      'Decode a base64 PNG (≤ 2 MB) and import it as a NEW layer on the target frame. The image dimensions ' +
      'must match the canvas exactly — resize externally first. The import is one undoable step and never ' +
      'replaces existing layers.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      name: z.string().trim().min(1).max(120).optional().describe('Name for the new layer.'),
      pngBase64: z.string().min(8).max(2_800_000).describe('Base64-encoded PNG (raw base64 or a data URL).'),
      ...staleGuard,
    },
  },
  {
    name: 'import_frame_strip',
    title: 'Import frame strip',
    description:
      'Import a sprite-sheet PNG (columns × rows grid of canvas-sized cells) as a NEW animated clip: one layer ' +
      'per frame, left→right top→bottom order, ONE undoable step. The sheet must be exactly ' +
      '(canvasWidth × columns) × (canvasHeight × rows). Max 64 frames.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      name: z.string().trim().min(1).max(120).describe('Name for the new clip.'),
      columns: z.number().int().min(1).max(32).describe('Sheet columns (frames per row).'),
      rows: z.number().int().min(1).max(32).describe('Sheet rows.'),
      fps: z.number().int().min(1).max(60).optional().describe('Clip playback fps. Default 12.'),
      pngBase64: z.string().min(8).max(2_800_000).describe('Base64-encoded sprite-sheet PNG (raw base64 or a data URL).'),
      ...staleGuard,
    },
  },
    {
    name: 'beautify_layer',
    title: 'Beautify & polish layer',
    description:
      'One-call pixel-art polish: supports OKLab hue-shifted selective colored outlines (selOut=true) or flat 1px outline, ' +
      'palette-locked directional shadows (bottom/right) and warm rim highlights (top/left), plus automatic removal of ' +
      'clunky outer L-corner outline doubles (cleanDoubles=true). One undoable step.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      ...layerRef,
      outline: z.string().regex(HEX_RE).nullable().optional().describe('Flat outline color when selOut is false. Default dark studio ink. null = no outline.'),
      selOut: z.boolean().optional().describe('true = OKLab hue-shifted selective colored outlines matched to each adjacent cluster in the project palette. Default false.'),
      shade: z.boolean().optional().describe('Add directional bottom/right shadows (palette-locked when paletteLock is true). Default true.'),
      highlight: z.boolean().optional().describe('Add subtle warm top/left rim highlights from the project palette. Default false.'),
      cleanDoubles: z.boolean().optional().describe('Remove outer L-shaped outline double corners for crisp 1px lines. Default true.'),
      paletteLock: z.boolean().optional().describe('Snap all shaded/highlighted/sel-out pixels strictly to the active project palette via OKLab. Default true.'),
      ...staleGuard,
    },
  },
  {
    name: 'harvest_palette',
    title: 'Harvest palette',
    description: 'Extract the best colors from any base64 PNG via median cut (dark → light). Apply with set_palette.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      pngBase64: z.string().min(8).max(2_800_000).describe('Base64-encoded PNG (raw base64 or a data URL).'),
      maxColors: z.number().int().min(2).max(32).optional().describe('How many colors. Default 16.'),
      ...staleGuard,
    },
  },
  {
    name: 'macro_save',
    title: 'Save macro',
    description: 'Save a named sequence of tool calls (1–50 steps) for replay. Stored per browser.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      name: z.string().trim().min(1).max(60).describe('Macro name.'),
      steps: z.array(z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() })).min(1).max(50).describe('Ordered tool calls.'),
      ...staleGuard,
    },
  },
  {
    name: 'macro_list',
    title: 'List macros',
    description: 'List saved macros.',
    tier: 'L0',
    relay: true,
    inputSchema: { ...staleGuard },
  },
  {
    name: 'macro_run',
    title: 'Run macro',
    description: 'Replay a saved macro step-by-step. NOTE: steps run under the caller identity without per-step tier re-checks — only run macros you trust.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      name: z.string().trim().min(1).max(60).describe('Macro name.'),
      stopOnError: z.boolean().optional().describe('Default true — stop at the first failed step.'),
      ...staleGuard,
    },
  },
  {
    name: 'macro_delete',
    title: 'Delete macro',
    description: 'Delete a saved macro.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      name: z.string().trim().min(1).max(60).describe('Macro name.'),
      ...staleGuard,
    },
  },
  {
    name: 'batch',
    title: 'Run batch of tool calls',
    description:
      'Run 1–50 existing tool calls as ONE undoable transaction — all-or-nothing: any failing step rolls the ' +
      'document back to the pre-batch state (rolledBack:true, nothing applied). Ideal for multi-step drawing/' +
      'animation jobs: one round-trip, one undo entry, no partial work. Avoid undo/redo/batch as steps. ' +
      'NOTE: steps execute under the caller identity without per-step tier re-checks — only batch steps you trust.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      steps: z
        .array(z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() }))
        .min(1)
        .max(50)
        .describe('Ordered tool calls (same shape as macro steps).'),
      stopOnError: z.boolean().optional().describe('Default true — stop at the first failed step (still rolls everything back).'),
      ...staleGuard,
    },
  },

          {
    name: 'suggest_motion_preset',
    title: 'Suggest motion preset',
    description:
      'Propose a motion preset (Idle/Walk/Run/Attack/Jump/Spin/Duck/Hurt/Swim/Death) + parameters from a natural-language prompt. ' +
      'Pure deterministic keyword helper — no model call, no cost, no document access (v3.1 §5.3 helper, L0).',
    tier: 'L0',
    relay: true,
    inputSchema: {
      prompt: z.string().min(1).max(500).describe('What the animation should do, e.g. "make the hero attack with a sword".'),
    },
  },
  {
    name: 'set_parts',
    title: 'Set motion parts',
    description:
      'Tag body-part regions on a clip for the motion presets (v3.1 §4.1): each part is a named rectangle on a layer ' +
      '(head, body, armL, armR, legL, legR, hair, custom). Parts are REGIONS, never cuts; a part without a rect spans ' +
      'its whole layer; overlapping pixels are owned by the highest-z part (warned, never blocked). Replaces the clip\'s ' +
      'whole parts array in ONE undoable step.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      parts: z
        .array(
          z.object({
            name: z.string().min(1).max(40).describe('Part name = motion role key, e.g. "body", "head", "armL" (case-insensitive, unique).'),
            layerId: z.string().min(1).optional().describe('Layer id for this part (from get_clip). Defaults to the active layer.'),
            layerName: z.string().min(1).max(120).optional().describe('Layer by exact name (used when layerId is omitted).'),
            rect: z
              .object({
                x: z.number().int().min(0).max(4095),
                y: z.number().int().min(0).max(4095),
                w: z.number().int().min(1).max(4096),
                h: z.number().int().min(1).max(4096),
              })
              .optional()
              .describe('Region rectangle in canvas pixels (must be inside the canvas). Omit for whole-layer parts.'),
            anchorFrameIndex: z.number().int().min(0).max(4095).optional().describe('Reference frame index (0-based; default frame 1).'),
            z: z.number().int().min(-99).max(99).optional().describe('Paint order override; higher z owns overlaps. Default = array index.'),
          })
        )
        .min(0)
        .max(32)
        .describe('The complete parts array for the clip (empty array clears all parts).'),
      ...clipRef,
      ...staleGuard,
    },
  },
  {
    name: 'apply_motion_preset',
    title: 'Apply motion preset',
    description:
      'Apply a deterministic motion preset (v3.1 §4.1.1): idle/walk/run/attack/jump/spin/duck/hurt/swim/death curves mapped per tagged part, ' +
      'integer-pixel offsets, alpha ≥128 binary rule, anchor-frame alignment, ampScale = clipHeight/32. Commits ATOMICALLY ' +
      'as one undoable command — to a NEW clip (sized exactly to the preset) or, with overwrite:true, to the target clip\'s ' +
      'frames 0..n−1 (extra frames untouched, missing frames become holds). Absent parts are skipped per role and listed ' +
      'in the report (C27). Returns the apply report, QA issues and a frame-1 preview PNG. $0 — no AI involved.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      preset: z.enum(['idle', 'walk', 'run', 'attack', 'jump', 'spin', 'duck', 'hurt', 'swim', 'death']).describe('Motion preset id.'),
      sourceClipId: z.string().min(1).optional().describe('Clip providing parts + anchor frame (default: active clip).'),
      sourceClipName: z.string().min(1).max(60).optional().describe('Source clip by exact name (used when sourceClipId is omitted).'),
      amplitude: z.number().min(0.25).max(3).optional().describe('Curve intensity multiplier before R10 canvas scaling (default 1).'),
      frameCount: z.number().int().min(1).max(64).optional().describe('Frame count (preset-bounded: idle 4 · walk 4/6/8 · run 6 · attack 4–6 · jump 4–8 · spin 6 · duck 4 · hurt 4 · swim 6 · death 5).'),
      gapFill: z.enum(['none', 'edge-extend']).optional().describe('Vacated-pixel handling (R4; default "edge-extend" = seam holes refilled; "none" = honest transparent gaps).'),
      smear: z.boolean().optional().describe('attack only: add the 1-px smear trail on the swing frame.'),
      anchorFrameIndex: z.number().int().min(0).max(4095).optional().describe('Anchor frame index (0-based; default 0 = frame 1, R5).'),
      overwrite: z.boolean().optional().describe('true = overwrite the target clip frames (requires targetClipId, defaults to the source clip). Omit = create a NEW clip.'),
      targetClipId: z.string().min(1).optional().describe('Existing target clip id when overwrite:true (default: the source clip).'),
      targetName: z.string().min(1).max(120).optional().describe('Name for the new clip (default "<preset>-<n>").'),
      ...staleGuard,
    },
  },

  {
    name: 'undo',
    title: 'Undo',
    description: 'Undo the most recent document change (manual or agent-made — one shared history).',
    tier: 'L1',
    relay: true,
    inputSchema: {},
  },
  {
    name: 'redo',
    title: 'Redo',
    description: 'Redo the most recently undone change.',
    tier: 'L1',
    relay: true,
    inputSchema: {},
  },

  // --------------------------------------------------------------- pairing
  {
    name: 'pair_client',
    title: 'Pair this client',
    description:
      'Exchange a one-time 6-word pairing code (Bearer) for a persistent client token. ' +
      'Pass a friendly client name; the user chose your permission tier when generating the code. ' +
      'STORE the returned token safely — it is shown once and grants your tier until revoked.',
    tier: 'L0',
    relay: false,
    inputSchema: {
      name: z.string().trim().min(1).max(60).describe('Display name for this client (shown to the user).'),
    },
  },
  // ------------------------------------------- skill knowledge (v3.1 addendum)
  {
    name: 'get_knowledge',
    title: 'Get pixel-art knowledge',
    description:
      'Read the pixel-art skill knowledge shipped inside PixelForge: methodology (the brief→draw→critique→fix loop), ' +
      'patterns, palettes, animation curves, techniques, cleanup, sharp_edges, validations, export, lpc, shade, rig, ' +
      'tileset, concept, fix — palette_library (2000+ named palettes; style = exact id or keyword search; apply the returned colors with set_palette) — the ' +
      'learned-style index (user-grown styles override shipped; style for one doc) — or agent (how to drive this editor: batching, quotas, safety rules; read it first). Pure knowledge, $0, ' +
      'no editor needed. Consult it BEFORE drawing.',
    tier: 'L0',
    relay: false,
    inputSchema: {
      topic: z
        .enum(['methodology', 'patterns', 'palettes', 'animation', 'techniques', 'cleanup', 'sharp_edges', 'validations', 'export', 'lpc', 'shade', 'rig', 'tileset', 'concept', 'fix', 'palette_library', 'learned', 'agent', 'vfx', 'grids', 'characters'])
        .describe('Knowledge topic to read ("agent" = how to drive this editor efficiently).'),
      style: z.string().min(1).max(60).optional().describe('Learned-style file stem, or a palette-library keyword / exact id.'),
    },
  },
  {
    name: 'study_reference',
    title: 'Study a reference sprite',
    description:
      'Grow the app\'s pixel-art knowledge: decode a PNG reference, extract its palette (median-cut ≤16), measure ' +
      'size, opaque ratio and mirror symmetry, then append a learned style doc every client can read via ' +
      'get_knowledge {topic:"learned"}. Pass styleName and notes to describe the art. Analysis only — nothing ' +
      'enters the canvas.',
    tier: 'L1',
    relay: false,
    inputSchema: {
      pngBase64: z.string().min(8).max(2_800_000).describe('Base64 PNG (raw or data URL) of the reference sprite, 1–512 px per side.'),
      styleName: z.string().trim().min(1).max(60).optional().describe('Short style name, e.g. "chibi-jrpg".'),
      notes: z.string().trim().min(1).max(500).optional().describe('What the art depicts; observations worth keeping.'),
    },
  },
  {
    name: 'save_project',
    title: 'Save project',
    description:
      'Persist the ACTIVE project to its current .pixelforgeproj file (atomic save + journal). If the project has ' +
      'no file yet, the app shows the native Save As dialog — the human picks the destination. Returns the saved path.',
    tier: 'L2',
    relay: true,
    inputSchema: {},
  },
];

/** Tools the pairing-token identity may call before it becomes a client. */
export const PAIRING_ALLOWED_TOOLS = new Set(['pair_client']);
