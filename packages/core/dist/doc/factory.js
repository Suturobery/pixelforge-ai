"use strict";
/**
 * Document factories v2 (v3.1 §2.4/§6): new clips default to a single layer
 * "Layer 1"; frames carry cels per layer; linked layers share one cel.
 * Ported from the prototype's factory.ts and re-targeted to the v2 model.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PALETTE = void 0;
exports.clampCanvasSize = clampCanvasSize;
exports.createCel = createCel;
exports.createLayer = createLayer;
exports.createFrame = createFrame;
exports.duplicateFrame = duplicateFrame;
exports.createClip = createClip;
exports.createProject = createProject;
exports.cloneProject = cloneProject;
const id_1 = require("../id");
const document_1 = require("../types/document");
/** Default palette — the prototype's Forge-16 set (store.ts initialProject). */
exports.DEFAULT_PALETTE = [
    '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070',
    '#38b764', '#257179', '#29366f', '#3b5dc9', '#41a6f6', '#73eff7',
    '#f4f4f4', '#94b0c2', '#566c86', '#333c57',
];
function clampCanvasSize(n) {
    return Math.min(document_1.CANVAS_MAX, Math.max(document_1.CANVAS_MIN, Math.round(n)));
}
function createCel(width, height, linked = false, buffer) {
    return {
        buffer: buffer ?? new Uint8ClampedArray(width * height * 4),
        linked,
    };
}
function createLayer(name, linked = false) {
    return {
        id: (0, id_1.uid)('ly'),
        name,
        visible: true,
        opacity: 1,
        linked,
    };
}
/** A frame with a transparent cel per given layer (linked layers share later). */
function createFrame(width, height, layers) {
    const cels = {};
    for (const layer of layers) {
        cels[layer.id] = createCel(width, height, layer.linked);
    }
    return { id: (0, id_1.uid)('fr'), durationMs: 0, cels };
}
/**
 * Duplicate a frame "preserving cels exactly" (v3.1 §2.7):
 *  - normal layers → independent deep-copied buffers;
 *  - linked layers → the SAME shared cel object (that is what linked means).
 * Copy-on-write discipline is preserved either way: buffers are never
 * mutated in place, only replaced wholesale.
 */
function duplicateFrame(frame, clipLayers) {
    const cels = {};
    for (const layer of clipLayers) {
        const src = frame.cels[layer.id];
        if (!src)
            continue; // missing cel stays missing (transparent)
        cels[layer.id] = layer.linked ? src : { buffer: new Uint8ClampedArray(src.buffer), linked: false };
    }
    return { id: (0, id_1.uid)('fr'), durationMs: frame.durationMs, cels };
}
function createClip(opts) {
    const fps = Math.min(60, Math.max(1, Math.round(opts.fps ?? 8)));
    const layers = (opts.layerNames && opts.layerNames.length > 0
        ? opts.layerNames
        : ['Layer 1']).map((n) => createLayer(n));
    const frameCount = Math.max(1, Math.round(opts.frameCount ?? 1));
    const frames = [];
    for (let i = 0; i < frameCount; i++)
        frames.push(createFrame(opts.width, opts.height, layers));
    return {
        id: (0, id_1.uid)('cl'),
        name: opts.name,
        fps,
        loop: opts.loop ?? true,
        loopMode: opts.loopMode ?? 'forward',
        layers,
        parts: [],
        frames,
        tags: [],
    };
}
function createProject(opts = {}) {
    const width = clampCanvasSize(opts.width ?? 32);
    const height = clampCanvasSize(opts.height ?? 32);
    return {
        id: opts.id ?? null,
        schemaVersion: 2,
        name: opts.name ?? 'untitled',
        width,
        height,
        palette: [...(opts.palette ?? exports.DEFAULT_PALETTE)],
        settings: {
            paletteEnforce: true,
            onion: { prev: 1, next: 0 },
        },
        clips: [
            createClip({
                name: 'idle',
                width,
                height,
                fps: opts.fps ?? 8,
                loop: opts.loop ?? true,
                loopMode: opts.loopMode ?? 'forward',
            }),
        ],
        trash: [],
    };
}
/** Deep clone including every cel buffer. Used sparingly (load/reset/tests). */
function cloneProject(p) {
    const celClones = new Map();
    const cloneCel = (c) => {
        const seen = celClones.get(c);
        if (seen)
            return seen; // linked cels stay shared in the clone
        const copy = { buffer: new Uint8ClampedArray(c.buffer), linked: c.linked };
        celClones.set(c, copy);
        return copy;
    };
    return {
        ...p,
        palette: [...p.palette],
        settings: { paletteEnforce: p.settings.paletteEnforce, onion: { ...p.settings.onion } },
        trash: p.trash.map((t) => ({ ...t })),
        clips: p.clips.map((c) => ({
            ...c,
            layers: c.layers.map((l) => ({ ...l })),
            parts: c.parts.map((pt) => ({ ...pt })),
            tags: c.tags.map((t) => ({ ...t })),
            frames: c.frames.map((f) => ({
                ...f,
                cels: Object.fromEntries(Object.entries(f.cels).map(([k, cel]) => [k, cloneCel(cel)])),
            })),
        })),
    };
}
