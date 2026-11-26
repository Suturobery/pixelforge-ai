// PixelForge AI — client-safe MCP tool catalog (Task 8 P0: L0 + L1).
//
// This mirrors the authoritative zod schemas in
// mini-services/mcp-server/src/tools-catalog.ts (which the MCP server
// registers over the real protocol). It exists for IN-APP UIs (the Agent
// Console) that run tools locally through ./mcp-tools — same names, same
// semantics, one shared executor. The E2E suite calls every catalog entry
// through the real MCP client, so drift between the two files surfaces in
// tests.
//
// Subscription-only product: there is NO provider-backed image generation
// and no paid tools — generate_sprite and the AI-candidate review cache were
// removed; procedural VFX (list_vfx / generate_vfx) runs locally in-app.
// DEFERRED tools (documented, NOT listed — dependencies):
//   L2/L3: resize_canvas, save_project-as, export_*, purge_trash.
// Task 10 adds the motion set: suggest_motion_preset (L0), set_parts +
// apply_motion_preset (L1).

export interface McpToolInfo {
  name: string
  tier: 'L0' | 'L1' | 'L2' | 'L3'
  description: string
  example: Record<string, unknown>
}

export const MCP_TOOLS: McpToolInfo[] = [
    {
    name: 'get_project_state',
    tier: 'L0',
    description: 'Active project summary: name, size, palette, project Style Lock + pinned Hero Style Anchor, clips, trash, dirty flag and the document stateHash.',
    example: {},
  },
  {
    name: 'list_projects',
    tier: 'L0',
    description: 'List projects persisted by the app (ids, names, sizes, timestamps).',
    example: {},
  },
  {
    name: 'get_clip',
    tier: 'L0',
    description: 'One clip in detail: layer stack, per-frame cels, durations, tags.',
    example: { clipName: 'idle' },
  },
  {
    name: 'get_frame_png',
    tier: 'L0',
    description: 'Render one frame (composited) as a base64 PNG; supports nearest-neighbor scale 0.25–8 and optional pixel grid overlay (showGrid).',
    example: { scale: 8, showGrid: true },
  },
  {
    name: 'get_palette',
    tier: 'L0',
    description: 'The project palette and palette-enforcement flag.',
    example: {},
  },
  {
    name: 'validate_style',
    tier: 'L0',
    description: 'Run deterministic canvas, palette, alpha, and margin checks on a frame before review.',
    example: { allowEdgeTouch: false },
  },
  {
    name: 'analyze_pixel_craft',
    tier: 'L0',
    description: 'Deterministic pixel-art craft linter: reports exact (x, y) coordinates of outline doubles, orphan speckles, jaggies, and pillow shading with a 0–100 score.',
    example: {},
  },
  {
    name: 'validate_asset_set',
    tier: 'L0',
    description: 'Check each clip representative frame against the project palette; compare actorClipIds with the pinned Hero Style Anchor for height, ground line, and outline.',
    example: { actorClipIds: [] },
  },
  {
    name: 'list_templates',
    tier: 'L0',
    description: 'List the 8 built-in palette-locked Starter Sprite Templates (chibi-humanoid, slime, rpg-sword, potion-flask, treasure-chest, stone-pedestal, topdown-tree, dungeon-tile).',
    example: {},
  },
  {
    name: 'generate_template',
    tier: 'L1',
    description: 'Insert a palette-locked, sel-out polished Starter Sprite Template onto a new layer (auto-tags Motion body parts for character/creature bases) in one undoable transaction.',
    example: { template: 'chibi-humanoid', autoTagParts: true },
  },
  {
    name: 'pin_style_anchor',
    tier: 'L1',
    description: 'Measure a finished Hero sprite frame (exact dimensions, ground margin, outline style, palette used, craft score) and pin it onto Style Lock so every AI IDE matches its proportions.',
    example: { label: 'Hero Knight' },
  },
  {
    name: 'list_vfx',
    tier: 'L0',
    description: 'Catalog of deterministic procedural pixel-art VFX renderable locally by generate_vfx. Filter by category (fire, explosions, ice, lightning, arcane, nature, ui, pickups, …).',
    example: { category: 'fire' },
  },
  {
    name: 'generate_vfx',
    tier: 'L1',
    description: 'Render any of the 244 built-in pixelfx procedural VFX effects into a NEW clip OR directly onto the CURRENT sprite clip as split Back + Front depth layers — crisp pixel-art quantization, palette lock, looping warmup, deterministic seed, one undo transaction.',
    example: { effect: 'arcane/rune-circle', target: 'current_clip', depth: 'split', crispPixelArt: true, light: 0.72, palette: 'project' },
  },
  {
    name: 'preview_animation',
    tier: 'L0',
    description: 'All frames of a clip as composited PNGs plus the exact playback schedule.',
    example: { maxFrames: 8 },
  },
  {
    name: 'subscribe_events',
    tier: 'L0',
    description: 'Current stateHash + how to receive projectChanged MCP notifications.',
    example: {},
  },
  {
    name: 'get_operation_log',
    tier: 'L0',
    description: 'The MCP audit log (server-side): who called what, when, result, duration.',
    example: { limit: 20 },
  },
  {
    name: 'create_project',
    tier: 'L1',
    description: 'Replace the active document with a new empty project. Requires confirm:true; rejected with dirty_project when unsaved work exists.',
    example: { name: 'hero-idle', width: 32, height: 32, fps: 8, confirm: true },
  },
  {
    name: 'open_project',
    tier: 'L1',
    description: 'Open a persisted project (dirty_project guard applies).',
    example: { projectId: '<projectId from list_projects>' },
  },
  {
    name: 'add_frame',
    tier: 'L1',
    description: 'Append (or insert after afterIndex) an empty frame, optionally copying content.',
    example: { copyContent: true },
  },
  {
    name: 'rename_project',
    tier: 'L1',
    description: 'Rename the active project without changing its artwork.',
    example: { name: 'hero-sprites' },
  },
  {
    name: 'save_project',
    tier: 'L2',
    description: 'Save the active project; a new desktop project opens a native Save As dialog.',
    example: {},
  },
  {
    name: 'duplicate_frame',
    tier: 'L1',
    description: 'Insert an exact copy of a frame right after it.',
    example: { frameIndex: 0 },
  },
  {
    name: 'reorder_frames',
    tier: 'L1',
    description: 'Move a frame from index `from` to index `to`.',
    example: { from: 1, to: 0 },
  },
  {
    name: 'reverse_clip',
    tier: 'L1',
    description: 'Reverse the frame order of a clip in one undoable transaction.',
    example: {},
  },
  {
    name: 'bake_pingpong',
    tier: 'L1',
    description: 'Bake a 3+ frame clip into explicit forward ping-pong frames (appends mirrored inner frames) for forward-only game engines.',
    example: {},
  },
  {
    name: 'delete_frame',
    tier: 'L2',
    description: 'Delete a frame (trash-backed: restore_from_trash / undo recover it).',
    example: { frameIndex: 2 },
  },
  {
    name: 'set_frame_duration',
    tier: 'L1',
    description: 'Set a frame duration in milliseconds; 0 inherits the clip FPS.',
    example: { frameIndex: 0, durationMs: 120 },
  },
  {
    name: 'restore_from_trash',
    tier: 'L1',
    description: 'Restore a deleted frame/layer/clip from the project trash.',
    example: { entryId: '<trash entry id>' },
  },
  {
    name: 'purge_trash',
    tier: 'L2',
    description: 'Permanently remove trash entries (omit entryId to empty the whole trash). Purged entries cannot be restored.',
    example: {},
  },
  {
    name: 'resize_canvas',
    tier: 'L2',
    description: 'Change canvas size (16–256). Content shifts (anchor top-left/center), never rescales; out-of-bounds pixels cropped. One undoable step.',
    example: { width: 96, height: 64, anchor: 'center' },
  },
  {
    name: 'auto_trim',
    tier: 'L2',
    description: 'Crop excess transparent borders around artwork across all clips/frames with optional padding (0–16px). One undoable step.',
    example: { padding: 1 },
  },
  {
    name: 'export_sheet',
    tier: 'L2',
    description: 'Export a clip as ONE horizontal sprite-sheet PNG (supports 1×–8× scale and optional Aseprite JSON for Unity/Phaser/Godot).',
    example: { clipName: 'walk', padding: 1, scale: 1, jsonFormat: 'aseprite' },
  },
  {
    name: 'export_atlas',
    tier: 'L2',
    description: 'Pack ALL clips into ONE master atlas PNG + Aseprite JSON (with frameTags per clip) + optional combined Godot 4 .tres.',
    example: { scale: 1, padding: 1, includeTres: true },
  },
  {
    name: 'export_gif',
    tier: 'L2',
    description: 'Export a clip as an animated GIF (base64 data URL, bg-flattened, clip durations).',
    example: { clipName: 'walk', scale: 2 },
  },
  {
    name: 'set_pixels',
    tier: 'L1',
    description: 'Paint up to 2000 pixels in one undoable step ({x, y, color?} each).',
    example: { pixels: [{ x: 4, y: 4 }, { x: 5, y: 4 }], color: '#ff5555' },
  },
  {
    name: 'fill_rect',
    tier: 'L1',
    description: 'Filled (default) or outlined rectangle between two corners.',
    example: { from: { x: 2, y: 2 }, to: { x: 10, y: 8 }, color: '#22d3ee' },
  },
  {
    name: 'draw_line',
    tier: 'L1',
    description: 'Crisp Bresenham pixel line between two points.',
    example: { from: { x: 4, y: 4 }, to: { x: 20, y: 12 }, color: '#1a1c2c', size: 1 },
  },
  {
    name: 'draw_ellipse',
    tier: 'L1',
    description: 'Filled (default) or outlined pixel-art ellipse inside a bounding box — ideal for organic silhouettes.',
    example: { from: { x: 8, y: 4 }, to: { x: 22, y: 16 }, color: '#38b764', filled: true },
  },
  {
    name: 'draw_polygon',
    tier: 'L1',
    description: 'Filled (default) or outlined polygon from 2–64 vertices — ideal for capes, blades, and tapered shapes.',
    example: { points: [{ x: 6, y: 14 }, { x: 12, y: 12 }, { x: 10, y: 24 }, { x: 4, y: 22 }], color: '#b13e53', filled: true },
  },
  {
    name: 'set_vectors',
    tier: 'L1',
    description: 'Set or replace non-destructive pixel-perfect editable vector shapes (line, curve, rect, ellipse, polygon) on a cel without flattening pixels.',
    example: { vectors: [{ id: 'arc1', kind: 'curve', points: [{ x: 4, y: 24 }, { x: 16, y: 4 }, { x: 28, y: 24 }], stroke: '#2ce8f5', strokeWidth: 1 }] },
  },
  {
    name: 'bake_vectors',
    tier: 'L1',
    description: 'Rasterize all editable vector shapes on the target cel into crisp pixels in one undoable step.',
    example: {},
  },
  {
    name: 'flood_fill',
    tier: 'L1',
    description: 'Scanline flood-fill a contiguous region starting at (x, y).',
    example: { x: 14, y: 14, color: '#38b764' },
  },
  {
    name: 'replace_color',
    tier: 'L2',
    description: 'Replace every pixel of one color on the target cel with another.',
    example: { from: '#ff0000', to: '#00ff00' },
  },
  {
    name: 'flip_frame',
    tier: 'L1',
    description: 'Mirror the target cel horizontally or vertically.',
    example: { axis: 'horizontal' },
  },
  {
    name: 'rotate_frame',
    tier: 'L1',
    description: 'Rotate the target cel 90° cw/ccw.',
    example: { direction: 'cw' },
  },
  {
    name: 'shift_frame',
    tier: 'L1',
    description: 'Move the cel content by dx/dy (vacated pixels become transparent).',
    example: { dx: 2, dy: 0 },
  },
  {
    name: 'center_content',
    tier: 'L1',
    description: 'Center opaque artwork on the canvas (active layer or all visible unlocked layers with allLayers:true) in one undoable step.',
    example: { allLayers: true },
  },
  {
    name: 'remap_palette',
    tier: 'L1',
    description: 'Remap a layer, frame, or clip onto a target palette via OKLab lightness-ramp (skin swap) or nearest color in one undoable step.',
    example: { palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'], mode: 'ramp', scope: 'clip' },
  },
  {
    name: 'create_skin_variants',
    tier: 'L1',
    description: 'Clone a clip into 1–8 palette-swapped skin variant clips (fire, ice, poison, shadow, gold, cyber, gameboy, stone, or custom palettes) without mutating the original.',
    example: { presets: ['fire', 'ice', 'gold'], mode: 'ramp' },
  },
  {
    name: 'add_clip',
    tier: 'L1',
    description: 'Create a new clip with 1–64 empty frames.',
    example: { name: 'walk', fps: 10, frameCount: 4 },
  },
  {
    name: 'set_clip_props',
    tier: 'L1',
    description: 'Rename a clip or change fps / loop / loopMode (forward, reverse, pingpong).',
    example: { fps: 12, loopMode: 'pingpong' },
  },
  {
    name: 'delete_clip',
    tier: 'L2',
    description: 'Remove a clip (trash-backed).',
    example: {},
  },
  {
    name: 'set_clip_tags',
    tier: 'L1',
    description: 'Set named, inclusive frame ranges for animation states such as idle, walk, and attack.',
    example: { tags: [{ name: 'walk', from: 0, to: 3 }] },
  },
  {
    name: 'add_layer',
    tier: 'L1',
    description: 'Append an empty layer to the top of the stack.',
    example: { name: 'outline' },
  },
  {
    name: 'duplicate_layer',
    tier: 'L1',
    description: 'Copy a layer (with all cels) directly above it.',
    example: {},
  },
  {
    name: 'delete_layer',
    tier: 'L2',
    description: 'Remove a layer and its cels (trash-backed).',
    example: {},
  },
  {
    name: 'set_layer_props',
    tier: 'L1',
    description: 'Rename, hide, lock, change blend/opacity, or set non-destructive Live FX modifiers (outline/sel-out, drop shadow, color remap) on a layer.',
    example: { modifiers: { outline: { enabled: true, mode: 'sel-out', color: '#1a1c2c', connectivity: 4 } } },
  },
  {
    name: 'reorder_layers',
    tier: 'L1',
    description: 'Move a layer up or down in the stack.',
    example: { direction: 'up' },
  },
  {
    name: 'set_layer_linked',
    tier: 'L1',
    description: 'Link a layer across all frames or unlink it into independent cels.',
    example: { linked: true },
  },
  {
    name: 'merge_down',
    tier: 'L1',
    description: 'Composite a layer onto the one below and remove it (undoable snapshot).',
    example: {},
  },
  {
    name: 'add_palette_color',
    tier: 'L1',
    description: 'Append a hex color to the palette.',
    example: { hex: '#7fffd4' },
  },
  {
    name: 'set_palette',
    tier: 'L2',
    description: 'Replace the whole palette (1–256 colors) in one undoable step.',
    example: { colors: ['#0d0d0d', '#f4f4f4', '#14b8a6'] },
  },
  {
    name: 'remove_palette_color',
    tier: 'L1',
    description: 'Remove one existing color from the palette without recoloring pixels.',
    example: { hex: '#14b8a6' },
  },
  {
    name: 'generate_hue_ramp',
    tier: 'L1',
    description: 'Automatic Hue Shifter: generate a 3–9 color pixel-art shading ramp (cool shadows, warm highlights) from a single base color and optionally merge it into the palette in one undoable step.',
    example: { baseColor: '#38b764', steps: 5, autoShift: true, addToPalette: true },
  },
  {
    name: 'get_contact_sheet',
    tier: 'L0',
    description: 'Render all project clips side-by-side onto a crisp nearest-neighbor Clips Contact Sheet PNG with shared ground-line guide, trimmed sprite heights, and palette compliance metrics.',
    example: { scale: 3, showGroundLine: true, showBounds: false },
  },
  {
    name: 'stamp_tiles',
    tier: 'L1',
    description: 'Slice a source tileset clip into tileSize×tileSize tiles and stamp one or more tiles (with optional 0/90/180/270 rotation & H/V flip) onto the target layer in one undoable transaction.',
    example: { tileSize: 16, stamps: [{ tileIndex: 0, destCol: 0, destRow: 0, rotation: 90, flipH: false }] },
  },
  {
    name: 'set_style_profile',
    tier: 'L1',
    description: 'Update the shared project Style Lock used by PixelForge, connected IDEs, and AI generation. References are existing project frame ids; inspect them with get_frame_png. Undoable; palette enforcement stays inside PixelForge.',
    example: { profile: { enabled: true, name: 'Forest sprites', artDirection: 'cozy 16-bit fantasy RPG', lighting: 'top-left', outline: 'dark-1px', paletteMode: 'enforce', transparentBackground: true, notes: 'chunky proportions; no gradients', references: [{ clipId: 'cl_idle', frameId: 'fr_1', label: 'idle · frame 1' }], feedback: { prefer: ['chunky silhouette'], avoid: ['smooth gradients'] } } },
  },
  {
    name: 'import_image_as_layer',
    tier: 'L1',
    description: 'Import a base64 PNG (≤2 MB, exact canvas size) as a NEW layer on the target frame.',
    example: { name: 'imported', pngBase64: '<base64 PNG>' },
  },
  {
    name: 'import_frame_strip',
    tier: 'L1',
    description: 'Import a sprite-sheet PNG (columns × rows of canvas-sized cells) as a NEW animated clip — one layer per frame, one undo step.',
    example: { name: 'run-cycle', columns: 4, rows: 3, fps: 12, pngBase64: '<base64 PNG>' },
  },
    {
    name: 'beautify_layer',
    tier: 'L1',
    description: 'Palette-locked pixel polish: OKLab hue-shifted sel-out outlines (selOut=true), directional bottom/right shade + warm top/left rim highlight, and automatic L-corner double cleanup. Undoable.',
    example: { selOut: true, shade: true, highlight: true, cleanDoubles: true, paletteLock: true },
  },
  {
    name: 'harvest_palette',
    tier: 'L1',
    description: 'Steal the best colors from any image (median cut, dark→light). Apply with set_palette or add them one by one.',
    example: { pngBase64: '<base64 PNG>', maxColors: 16 },
  },
  {
    name: 'macro_save',
    tier: 'L1',
    description: 'Save a named sequence of tool calls (1–50 steps) for replay. Stored in this browser.',
    example: { name: 'outline-blue', steps: [{ tool: 'add_layer', args: { name: 'lineart' } }, { tool: 'set_pixels', args: { pixels: [{ x: 1, y: 1 }], color: '#000000' } }] },
  },
  {
    name: 'macro_list',
    tier: 'L0',
    description: 'List saved macros (name, step count, saved time).',
    example: {},
  },
  {
    name: 'macro_run',
    tier: 'L1',
    description: 'Replay a saved macro step-by-step. Stops on the first failed step unless stopOnError=false.',
    example: { name: 'outline-blue' },
  },
  {
    name: 'macro_delete',
    tier: 'L1',
    description: 'Delete a saved macro.',
    example: { name: 'outline-blue' },
  },
  {
    name: 'batch',
    tier: 'L1',
    description: 'Run 1–50 tool calls as ONE undoable transaction (all-or-nothing: any failure rolls everything back). One round-trip, one undo entry.',
    example: { steps: [{ tool: 'set_pixels', args: { pixels: [{ x: 1, y: 1 }], color: '#000000' } }, { tool: 'beautify_layer', args: { outline: '#151111' } }] },
  },
        {
    name: 'suggest_motion_preset',
    tier: 'L0',
    description: 'Propose a motion preset (Idle/Walk/Run/Attack/Jump/Spin/Duck/Hurt/Swim/Death) + parameters from a natural-language prompt. Pure helper, $0, deterministic.',
    example: { prompt: 'make the hero attack with a sword' },
  },
  {
    name: 'set_parts',
    tier: 'L1',
    description: 'Tag body-part regions (head, body, armL, armR, legL, legR, …) on a clip for motion presets. Regions only — never cuts; overlap pixels are owned by the highest-z part.',
    example: { parts: [{ name: 'body', rect: { x: 8, y: 6, w: 16, h: 20 } }, { name: 'head', rect: { x: 10, y: 0, w: 12, h: 8 }, z: 1 }] },
  },
  {
    name: 'apply_motion_preset',
    tier: 'L1',
    description: 'Apply a deterministic motion preset (10: idle/walk/run/attack/jump/spin/duck/hurt/swim/death) through the composer: integer-pixel offsets, R10 amplitude scaling, anchor-frame alignment. Commits atomically to a new clip or overwrite:true frames; returns the apply report + QA issues + frame-1 preview PNG.',
    example: { preset: 'walk', frameCount: 4, targetName: 'hero-walk' },
  },
  {
    name: 'brain_interpret_prompt',
    tier: 'L0',
    description: 'Second Brain reasoning layer: interpret a short, incomplete, or misspelled prompt against the active project context, fix errors, infer missing details, and return an enhanced prompt + recommended tool workflow.',
    example: { prompt: 'make hero wlak 4 frames' },
  },
  {
    name: 'undo',
    tier: 'L1',
    description: 'Undo the most recent document change (shared history with manual edits).',
    example: {},
  },
  {
    name: 'redo',
    tier: 'L1',
    description: 'Redo the most recently undone change.',
    example: {},
  },
]
