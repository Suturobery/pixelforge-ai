/**
 * PixelForge AI — MCP tool catalog (v3.1 §5.2/§5.3, P0 scope: L0 + L1).
 *
 * Every non-server-side tool is a RELAY: the MCP server validates identity +
 * tier + rate budget, then forwards the call to the PixelForge renderer,
 * which executes it on the REAL CommandBus — the same bus, validation and
 * undo history as manual editing. Nothing here mutates a document directly.
 *
 * DEFERRED tools (v3.1 dependencies — NOT registered, NOT advertised):
 *   L2 (resize_canvas, save_project-as, export_*, purge_trash) → P1
 *     approval center (Task 11); L3 (generate_sprite) → Task 11 (paid ops
 *     require the approval workflow — NEVER an unrestricted tool; v3.1 §5.2).
 * Task 9 registered the candidate-review set (get_candidates L0;
 * accept/reject_candidate + apply_normalize L1) — no paid generation here.
 * Task 10 registers the motion set (suggest_motion_preset L0; set_parts +
 * apply_motion_preset L1) — deterministic, $0, executed on the real bus.
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

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  tier: Tier;
  /** false = handled inside the MCP server (no editor round-trip). */
  relay: boolean;
  inputSchema: Record<string, z.ZodType>;
}

export const TOOL_CATALOG: ToolDef[] = [
  // ------------------------------------------------------------------ L0 read
  {
    name: 'get_project_state',
    title: 'Get project state',
    description:
      'Read the ACTIVE PixelForge project: name, canvas size, palette, clips (layers, frames, durations), ' +
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
      'Render one frame (all visible layers composited) and return it as a base64 PNG data URL. ' +
      'scale 0.5/0.25 downsamples with nearest-neighbor (no smoothing).',
    tier: 'L0',
    relay: true,
    inputSchema: {
      ...clipRef,
      ...frameRef,
      scale: z.union([z.literal(1), z.literal(0.5), z.literal(0.25)]).optional().describe('Output scale. Default 1 (native size).'),
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
    name: 'preview_animation',
    title: 'Preview animation',
    description:
      'Render every frame of a clip (composited PNGs) plus the exact playback schedule the editor uses ' +
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
    name: 'delete_frame',
    title: 'Delete frame',
    description:
      'Remove a frame from a clip. TRASH-BACKED: the frame goes to the project trash (recoverable via ' +
      'restore_from_trash; undo also works). A clip always keeps at least one frame.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
      frameIndex: z.number().int().min(0).max(4095).optional().describe('Frame to delete. Default: the active frame.'),
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
    name: 'replace_color',
    title: 'Replace color',
    description:
      'Replace every pixel of one color on the target cel with another color (exact match on RGBA). Undoable.',
    tier: 'L1',
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
    tier: 'L1',
    relay: true,
    inputSchema: {
      ...clipRef,
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
    tier: 'L1',
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
    tier: 'L1',
    relay: true,
    inputSchema: {
      colors: z.array(hexColor).min(1).max(256).describe('The new palette, bottom → top order.'),
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

  // ------------------------------------------------- AI candidates (Task 9)
  {
    name: 'get_candidates',
    title: 'Get AI candidates',
    description:
      'List the AI sprite candidates in the review cache with full provenance (prompt, provider, model, seed, ' +
      'duration, cost ESTIMATE) and a small normalized preview PNG. Paid generation itself is NOT exposed as a ' +
      'tool — it stays in the editor UI until the Task 11 approval center (v3.1 §5.2 L3).',
    tier: 'L0',
    relay: true,
    inputSchema: {
      limit: z.number().int().min(1).max(8).optional().describe('Max candidates to return (default 8).'),
      includeImages: z.boolean().optional().describe('Also include the ORIGINAL generated image data URL when small enough.'),
    },
  },
  {
    name: 'accept_candidate',
    title: 'Accept AI candidate',
    description:
      'Accept an AI candidate from the review cache: import its NORMALIZED pixels as a NEW layer on the target ' +
      'frame (mode "layer") or as a NEW frame in the target clip (mode "frame"). One undoable transaction — the ' +
      "candidate never overwrites existing artwork. Read the candidates with get_candidates first.",
    tier: 'L1',
    relay: true,
    inputSchema: {
      candidateId: z.string().min(1).max(128).describe('Candidate id from get_candidates.'),
      mode: z.enum(['layer', 'frame']).describe('Import as a new layer on the target frame, or as a new frame in the clip.'),
      ...clipRef,
      ...frameRef,
      ...layerRef,
      ...staleGuard,
    },
  },
  {
    name: 'reject_candidate',
    title: 'Reject AI candidate',
    description: 'Reject an AI candidate and remove it from the review cache. The document is untouched (not undoable — nothing changed).',
    tier: 'L1',
    relay: true,
    inputSchema: {
      candidateId: z.string().min(1).max(128).describe('Candidate id from get_candidates.'),
    },
  },
  {
    name: 'apply_normalize',
    title: 'Apply normalize v2',
    description:
      'Re-run the deterministic normalize-v2 pipeline (trim → dominant-color downscale → despeckle → background ' +
      'removal → OKLab quantize → fringe cleanup) on an AI candidate with adjusted parameters. Returns the new ' +
      'preview PNG + pipeline stats. Deterministic: identical inputs always give identical output.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      candidateId: z.string().min(1).max(128).describe('Candidate id from get_candidates.'),
      width: z.number().int().min(8).max(512).optional().describe('Output width (default: canvas width).'),
      height: z.number().int().min(8).max(512).optional().describe('Output height (default: canvas height).'),
      removeBg: z.boolean().optional().describe('Flood background removal (default true).'),
      bgTolerance: z.number().int().min(0).max(255).optional().describe('Background tolerance (default 48).'),
      paletteMode: z.enum(['project', 'auto', 'off']).optional().describe('Palette strategy (default "auto" = median cut).'),
      maxColors: z.number().int().min(2).max(64).optional().describe('Max colors for the auto palette (default 16).'),
      outlineCleanup: z.boolean().optional().describe('Clear the AA fringe ring adjacent to transparency (default true).'),
      palette: z.array(z.string()).max(256).optional().describe('Override palette (hex colors); default is the project palette.'),
    },
  },

  {
    name: 'suggest_motion_preset',
    title: 'Suggest motion preset',
    description:
      'Propose a motion preset (Idle/Walk/Run/Attack/Jump) + parameters from a natural-language prompt. ' +
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
      'Apply a deterministic motion preset (v3.1 §4.1.1): idle/walk/run/attack/jump curves mapped per tagged part, ' +
      'integer-pixel offsets, alpha ≥128 binary rule, anchor-frame alignment, ampScale = clipHeight/32. Commits ATOMICALLY ' +
      'as one undoable command — to a NEW clip (sized exactly to the preset) or, with overwrite:true, to the target clip\'s ' +
      'frames 0..n−1 (extra frames untouched, missing frames become holds). Absent parts are skipped per role and listed ' +
      'in the report (C27). Returns the apply report, QA issues and a frame-1 preview PNG. $0 — no AI involved.',
    tier: 'L1',
    relay: true,
    inputSchema: {
      preset: z.enum(['idle', 'walk', 'run', 'attack', 'jump']).describe('Motion preset id.'),
      sourceClipId: z.string().min(1).optional().describe('Clip providing parts + anchor frame (default: active clip).'),
      sourceClipName: z.string().min(1).max(60).optional().describe('Source clip by exact name (used when sourceClipId is omitted).'),
      amplitude: z.number().min(0.25).max(3).optional().describe('Curve intensity multiplier before R10 canvas scaling (default 1).'),
      frameCount: z.number().int().min(1).max(64).optional().describe('Frame count (preset-bounded: idle 4 · walk 4/6/8 · run 6 · attack 4–6 · jump 4–8).'),
      gapFill: z.enum(['none', 'edge-extend']).optional().describe('Vacated-pixel handling (R4; default "none" = honest transparent gaps).'),
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
];

/** Tools the pairing-token identity may call before it becomes a client. */
export const PAIRING_ALLOWED_TOOLS = new Set(['pair_client']);
