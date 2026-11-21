"use strict";
// PixelForge AI — Character Kit v1 (local, deterministic character creator).
//
// One original 32×32 side-view kit: a shared body (legs + far arm), swappable
// heads, outfits, and held items. Parts are hand-drawn grids of palette-role
// chars; every char maps through `KIT_ROLE_HEX` and is snapped to the ACTIVE
// project palette at compose time — so kit art always obeys the project's
// approved palette, whatever palette the project uses.
//
// Determinism contract: same kit version + same part selection + same palette
// ⇒ byte-identical buffers. No randomness, no clock, no locale-dependent code.
//
// Layout contract (matches the motion presets' role names — see
// src/motion/presets.ts):
//   layer "Body"   → parts legL / legR (rects) + armL (rect)   — walk legs + counter-swing arm
//   layer "Outfit" → part `body` (whole layer)                 — torso clothes follow the body curve
//   layer "Head"   → part `head` (whole layer)                 — face + cap/helmet follow the head
//   layer "Item"   → part `armR` (whole layer)                 — held item rides the front hand
// `part.set` forbids duplicate part names (names ARE roles), so each role
// exists exactly once — clothes and headwear are drawn onto the layers that
// own their motion role. Foot baseline: row 30 (row 31 stays empty so the
// style margin check passes).
//
// Pure TypeScript: no React, no zustand, no DOM — unit-testable headlessly.
Object.defineProperty(exports, "__esModule", { value: true });
exports.KIT_ATTACHMENTS = exports.KIT_LAYERS = exports.KIT_DEFAULT_SELECTION = exports.KIT_PRESETS = exports.KIT_ITEMS = exports.KIT_OUTFITS = exports.KIT_HEADS = exports.KIT_ROLE_HEX = exports.KIT_FOOT_BASELINE_Y = exports.KIT_CANVAS = exports.CHARACTER_KIT_VERSION = void 0;
exports.snapToPalette = snapToPalette;
exports.validateKitSelection = validateKitSelection;
exports.composeKitBuffers = composeKitBuffers;
exports.composeKitPreviewRgba = composeKitPreviewRgba;
exports.kitSelectionFromPreset = kitSelectionFromPreset;
exports.kitSelectionLabel = kitSelectionLabel;
exports.matchKitCharacter = matchKitCharacter;
exports.describeKit = describeKit;
exports.CHARACTER_KIT_VERSION = 'kit-1';
exports.KIT_CANVAS = 32;
/** Rows the standing poses' feet touch; row 31 must stay transparent (margin). */
exports.KIT_FOOT_BASELINE_Y = 30;
// ---------------------------------------------------------------------------
// palette roles → source hex (snapped to the project palette at compose time)
// ---------------------------------------------------------------------------
exports.KIT_ROLE_HEX = Object.freeze({
    O: '#1a1c2c', // outline (dark 1px, per the default style contract)
    S: '#ffcd75', // skin
    s: '#ef7d57', // skin shade
    E: '#1a1c2c', // eye
    M: '#94b0c2', // metal
    m: '#f4f4f4', // metal light (top-left highlight)
    d: '#566c86', // metal dark (right shade)
    R: '#b13e53', // red
    r: '#ef7d57', // orange highlight
    P: '#5d275d', // deep plum — leather / dark red shade / mushroom underside
    Y: '#ffcd75', // straw / gold trim
    B: '#3b5dc9', // blue cloth
    b: '#29366f', // navy shade
    G: '#566c86', // gray (sleeves, can body)
    g: '#38b764', // green
    L: '#a7f070', // lime highlight
    C: '#73eff7', // cyan steel
    A: '#41a6f6', // water
    W: '#f4f4f4', // white (spots / bright metal)
});
/** Snap a hex to the nearest project-palette entry (weighted RGB, stable tie-break). */
function snapToPalette(hex, palette) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    let best = palette[0] ?? hex;
    let bestDist = Infinity;
    for (const entry of palette) {
        const raw = entry.replace('#', '');
        const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw.slice(0, 6);
        const r2 = parseInt(full.slice(0, 2), 16);
        const g2 = parseInt(full.slice(2, 4), 16);
        const b2 = parseInt(full.slice(4, 6), 16);
        const dist = 2 * (r - r2) * (r - r2) + 4 * (g - g2) * (g - g2) + 3 * (b - b2) * (b - b2);
        if (dist < bestDist) {
            bestDist = dist;
            best = entry;
        }
    }
    return best;
}
function roleBuffer(grid, palette) {
    const out = new Uint8ClampedArray(exports.KIT_CANVAS * exports.KIT_CANVAS * 4);
    const cache = new Map();
    for (let y = 0; y < exports.KIT_CANVAS; y++) {
        const row = grid[y] ?? '';
        for (let x = 0; x < exports.KIT_CANVAS; x++) {
            const ch = row[x];
            if (!ch || ch === '.')
                continue;
            const hex = exports.KIT_ROLE_HEX[ch];
            if (!hex)
                continue;
            let rgb = cache.get(ch);
            if (!rgb) {
                const snapped = snapToPalette(hex, palette);
                rgb = [
                    parseInt(snapped.replace('#', '').slice(0, 2), 16),
                    parseInt(snapped.replace('#', '').slice(2, 4), 16),
                    parseInt(snapped.replace('#', '').slice(4, 6), 16),
                ];
                cache.set(ch, rgb);
            }
            const o = (y * exports.KIT_CANVAS + x) * 4;
            out[o] = rgb[0];
            out[o + 1] = rgb[1];
            out[o + 2] = rgb[2];
            out[o + 3] = 255; // binary alpha — matches the style checks + normalize v2
        }
    }
    return out;
}
/** Straight-alpha source-over blit of `src` onto `dst` (both 32×32×4). */
function blitOver(dst, src) {
    for (let i = 0; i < dst.length; i += 4) {
        const sa = src[i + 3] / 255;
        if (sa <= 0)
            continue;
        if (sa >= 1 || dst[i + 3] === 0) {
            dst[i] = src[i];
            dst[i + 1] = src[i + 1];
            dst[i + 2] = src[i + 2];
            dst[i + 3] = src[i + 3];
            continue;
        }
        const da = dst[i + 3] / 255;
        const oa = sa + da * (1 - sa);
        dst[i] = Math.round((src[i] * sa + dst[i] * da * (1 - sa)) / oa);
        dst[i + 1] = Math.round((src[i + 1] * sa + dst[i + 1] * da * (1 - sa)) / oa);
        dst[i + 2] = Math.round((src[i + 2] * sa + dst[i + 2] * da * (1 - sa)) / oa);
        dst[i + 3] = Math.round(oa * 255);
    }
}
// ---------------------------------------------------------------------------
// part art — 32 rows × 32 chars. '.' = transparent; legend in KIT_ROLE_HEX.
// Rows may omit trailing dots (normalized to 32 at load — keeps the hand-written
// art readable while guaranteeing the 32×32 grid).
// ---------------------------------------------------------------------------
function normalizeGrid(rows) {
    if (rows.length !== exports.KIT_CANVAS)
        throw new Error(`kit grid must have ${exports.KIT_CANVAS} rows, got ${rows.length}`);
    return rows.map((r) => (r.length === exports.KIT_CANVAS ? r : r.padEnd(exports.KIT_CANVAS, '.')));
}
/** Shared body: far arm (armL rect) + both legs (legL/legR rects). */
const BODY_GRID = normalizeGrid([
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '............OGG................',
    '...........OGGd................',
    '...........OGGd................',
    '...........OGGd................',
    '...........OSSs................',
    '...........OOOO................',
    '................................',
    '.............OBBbbOOBBbbO.......',
    '.............OBBbbOOBBbbO.......',
    '.............OBBbbOOBBbbO.......',
    '.............OBBbbOOBBbbO.......',
    '.............OBBbbOOBBbbO.......',
    '.............OBBbbOOBBbbO.......',
    '.............OPPPPOPPPPPO.......',
    '.............OPPPPOPPPPPO.......',
    '.............OOOOOOOOOOOO.......',
    '................................',
]);
const HEAD_MUSHROOM_GRID = normalizeGrid([
    '................................',
    '...................OOOOO........',
    '.................OrrrrrrRO......',
    '...............OrrrrrrrRRO......',
    '..............OrWrrrrrrRPO......',
    '.............OrrrrrrRRPPPO......',
    '............ORRRRRRRRRRRRPO.....',
    '............OPPPPPPPPPPPPPO.....',
    '.................OSSSSSSsO......',
    '.................OSSSSSEsO......',
    '.................OSSSSSEsO......',
    '.................OSSSSSSsO......',
    '.................OsSSSSssO......',
    '..................OSSSO.........',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
]);
const HEAD_STRAW_GRID = normalizeGrid([
    '................................',
    '................................',
    '...................OOOO.........',
    '.................OYYYYYYO.......',
    '.................OYYYYYrO.......',
    '................OPPPPPPPPO......',
    '.............OYYYYYYYYYYYYYO....',
    '.............OrrrrrrrrrrrrO.....',
    '.................OSSSSSSsO......',
    '.................OSSSSSEsO......',
    '.................OSSSSSEsO......',
    '.................OSSSSSSsO......',
    '.................OsSSSSssO......',
    '..................OSSSO.........',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
]);
const HEAD_GUARD_GRID = normalizeGrid([
    '................................',
    '...................OOOO.........',
    '..................ORRRRO........',
    '...............OOmMMMMMdO.......',
    '..............OmMMMMMMddO.......',
    '..............OmMMMMMMddO.......',
    '..............OMMMMMMMddO.......',
    '.............OddddddddddO.......',
    '.................OSSSSSSsO......',
    '.................OSSSSSEsO......',
    '.................OSSSSSEsO......',
    '.................OSSSSSSsO......',
    '.................OsSSSSssO......',
    '..................OSSSO.........',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
]);
const OUTFIT_KNIGHT_GRID = normalizeGrid([
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '.............OMMMMMMMMMMMO......',
    '.............OmMMMMMMMMddO......',
    '.............OMmMMMMMMMddO......',
    '.............OMMMMMMMMMddO......',
    '.............OMMMMMMMMMddO......',
    '.............OMMMMMMMMMddO......',
    '.............OYYYYYYYYYYO.......',
    '.............OMMMdddMMMdO.......',
    '.............OMMddddddMO........',
    '.............OdddddddddO........',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
]);
const OUTFIT_FARM_GRID = normalizeGrid([
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '.............OLBLLLLLLLgO.......',
    '.............OLBLLLLLLLgO.......',
    '.............OLLBBBBBBLgO.......',
    '.............OLLBBBBBBLgO.......',
    '.............OLLBBWBBBLgO.......',
    '.............OLLBBBBBBLgO.......',
    '.............OLLBBBBBBLgO.......',
    '.............OBBBBBBBBBO........',
    '.............ObbbbbbbbO.........',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
]);
const OUTFIT_GUARD_GRID = normalizeGrid([
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '.............OrrRRRRRRRPO.......',
    '.............OrRRRRRRRRPO.......',
    '.............ORRRRRRRRRPO.......',
    '.............ORRRRRRRRRPO.......',
    '.............ORRRRRRRRRPO.......',
    '.............ORRRRRRRRRPO.......',
    '.............OYYYYYYYYYYO.......',
    '.............ORRRPPPRRPO........',
    '.............ORRPPPPRPO.........',
    '.............OPPPPPPPPO.........',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
]);
const ITEM_SWORD_GRID = normalizeGrid([
    '................................',
    '................................',
    '................................',
    '...........................mM..',
    '..........................OmMO.',
    '..........................OmMO.',
    '..........................OmMO.',
    '..........................OmMO.',
    '..........................OmMO.',
    '..........................OmMO.',
    '..........................OmMO.',
    '..........................OmMO.',
    '..........................OmMO.',
    '..........................OmMO.',
    '..........................OmMO.',
    '......................OMMOYYYYO.',
    '......................OMMMPPO...',
    '......................OMMMPO....',
    '......................OOOOOO....',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
]);
const ITEM_CAN_GRID = normalizeGrid([
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '......................OSS.......',
    '......................OSS.......',
    '......................OsS.......',
    '....................OOOOOOO.....',
    '....................OGGGGdOO....',
    '....................OGGGGdOA....',
    '....................OGGGGdO.....',
    '....................OGGGGdO.....',
    '....................OOOOOOO.....',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
]);
const ITEM_SHIELD_GRID = normalizeGrid([
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '.....................ORR........',
    '.....................ORROOOO....',
    '.....................OROMMMMO...',
    '......................OMgggMO...',
    '......................OMgYYYgMO.',
    '......................OMgYYYgMO.',
    '......................OMggYggMO.',
    '.......................OMgggMO..',
    '........................OMMMO...',
    '.........................OOO....',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
]);
exports.KIT_HEADS = [
    { id: 'mushroom-cap', label: 'Mushroom cap', grid: HEAD_MUSHROOM_GRID },
    { id: 'straw-hat', label: 'Straw hat', grid: HEAD_STRAW_GRID },
    { id: 'guard-helmet', label: 'Guard helmet', grid: HEAD_GUARD_GRID },
];
exports.KIT_OUTFITS = [
    { id: 'knight-armor', label: 'Knight armor', grid: OUTFIT_KNIGHT_GRID },
    { id: 'farm-clothes', label: 'Farm clothes', grid: OUTFIT_FARM_GRID },
    { id: 'guard-uniform', label: 'Guard uniform', grid: OUTFIT_GUARD_GRID },
];
exports.KIT_ITEMS = [
    { id: 'sword', label: 'Sword', grid: ITEM_SWORD_GRID },
    { id: 'watering-can', label: 'Watering can', grid: ITEM_CAN_GRID },
    { id: 'shield', label: 'Shield', grid: ITEM_SHIELD_GRID },
];
exports.KIT_PRESETS = [
    { id: 'mushroom-knight', label: 'Mushroom Knight', headId: 'mushroom-cap', outfitId: 'knight-armor', itemId: 'sword' },
    { id: 'farmer', label: 'Farmer', headId: 'straw-hat', outfitId: 'farm-clothes', itemId: 'watering-can' },
    { id: 'guard', label: 'Guard', headId: 'guard-helmet', outfitId: 'guard-uniform', itemId: 'shield' },
];
exports.KIT_DEFAULT_SELECTION = {
    headId: 'mushroom-cap',
    outfitId: 'knight-armor',
    itemId: 'sword',
};
/**
 * Layer + motion-part layout the character is inserted with. Part names are
 * the motion preset roles (unique per `part.set`); rects cover every opaque
 * pixel of their region so nothing on the Body layer is left static.
 */
exports.KIT_LAYERS = [
    {
        name: 'Body',
        grid: 'body',
        parts: [
            { name: 'legL', rect: { x: 13, y: 22, w: 6, h: 9 } },
            { name: 'legR', rect: { x: 19, y: 22, w: 6, h: 9 } },
            { name: 'armL', rect: { x: 11, y: 15, w: 4, h: 6 } },
        ],
    },
    { name: 'Outfit', grid: 'outfit', parts: [{ name: 'body' }] },
    { name: 'Head', grid: 'head', parts: [{ name: 'head' }] },
    { name: 'Item', grid: 'item', parts: [{ name: 'armR' }] },
];
/** Fixed attachment points (pixels) shared by every part variant. */
exports.KIT_ATTACHMENTS = Object.freeze({
    headNeck: { x: 21, y: 13 },
    hand: { x: 25, y: 17 },
    footBaselineY: exports.KIT_FOOT_BASELINE_Y,
});
// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------
function partById(list, id) {
    return list.find((p) => p.id === id);
}
/** Throws a plain-language error for an unknown part id. */
function validateKitSelection(selection) {
    for (const [list, id, kind] of [
        [exports.KIT_HEADS, selection.headId, 'head'],
        [exports.KIT_OUTFITS, selection.outfitId, 'outfit'],
        [exports.KIT_ITEMS, selection.itemId, 'item'],
    ]) {
        if (!partById(list, id)) {
            throw new Error(`Unknown kit ${kind} "${id}" — the bundled kit supports: ${list.map((p) => p.id).join(', ')}`);
        }
    }
}
/** Compose the four layer buffers for a selection against a project palette. */
function composeKitBuffers(selection, palette) {
    validateKitSelection(selection);
    const head = partById(exports.KIT_HEADS, selection.headId);
    const outfit = partById(exports.KIT_OUTFITS, selection.outfitId);
    const item = partById(exports.KIT_ITEMS, selection.itemId);
    return {
        body: roleBuffer(BODY_GRID, palette),
        outfit: roleBuffer(outfit.grid, palette),
        head: roleBuffer(head.grid, palette),
        item: roleBuffer(item.grid, palette),
    };
}
/** Full composited 32×32 RGBA preview (body → outfit → head → item). */
function composeKitPreviewRgba(selection, palette) {
    const buffers = composeKitBuffers(selection, palette);
    const out = new Uint8ClampedArray(buffers.body);
    blitOver(out, buffers.outfit);
    blitOver(out, buffers.head);
    blitOver(out, buffers.item);
    return out;
}
function kitSelectionFromPreset(presetId) {
    const preset = exports.KIT_PRESETS.find((p) => p.id === presetId);
    if (!preset)
        return null;
    return { headId: preset.headId, outfitId: preset.outfitId, itemId: preset.itemId };
}
/** The clip name an inserted character uses (preset label or generic). */
function kitSelectionLabel(selection) {
    const preset = exports.KIT_PRESETS.find((p) => p.headId === selection.headId && p.outfitId === selection.outfitId && p.itemId === selection.itemId);
    return preset ? preset.label : 'Character';
}
// ---------------------------------------------------------------------------
// Second Brain brief matching (deterministic; no model call)
// ---------------------------------------------------------------------------
const KIT_MATCHERS = [
    { presetId: 'mushroom-knight', re: /mushroom|kngiht|knigth|knight|knigt|toadstool/i },
    { presetId: 'farmer', re: /farm|peasant|villager/i },
    { presetId: 'guard', re: /guard|gaurd|sentry|watchman|soldier/i },
];
/** Match a free-text brief/prompt against the bundled characters. */
function matchKitCharacter(prompt) {
    const text = prompt.toLowerCase();
    for (const m of KIT_MATCHERS) {
        if (m.re.test(text)) {
            const preset = exports.KIT_PRESETS.find((p) => p.id === m.presetId);
            return { kind: 'match', presetId: preset.id, label: preset.label };
        }
    }
    return { kind: 'none' };
}
/** What the kit supports — shown when a brief names an unsupported character. */
function describeKit() {
    return `The bundled character kit supports: ${exports.KIT_PRESETS.map((p) => `${p.label} (${p.headId}, ${p.outfitId}, ${p.itemId})`).join(' · ')}`;
}
