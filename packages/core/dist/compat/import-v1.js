"use strict";
/**
 * v1 → v2 project importer (v3.1 §2.4 "Migration", §13 "v1→v2 migration
 * golden files incl. loop mapping C3; forward-read refusal").
 *
 * v1 shape (prototype serialize.ts): per-frame layer stacks, each layer a
 * PNG data URL, `loop: boolean` per clip. v1 layer ids are PER-FRAME (the
 * flaw v2 fixes), so layers are matched across frames **by name** (first
 * occurrence wins; the prototype's own deleteFrame had the same constraint).
 *
 * Guarantees:
 *  - unknown-shaped input is rejected up front (never half-converted);
 *  - loop mapping per C3 (loop:false = play once, mode forward);
 *  - a layer missing from a frame becomes an ABSENT cel (= transparent, C2)
 *    with a warning;
 *  - layer property mismatches across frames adopt the first occurrence and
 *    warn;
 *  - cel PNG dimension mismatches are pad/cropped (top-left anchored) with a
 *    warning — v1 canvases were always drawn at project size, but a resized
 *    v1 file could carry stale cels;
 *  - the result passes validateSerializedProjectV2 when re-serialized.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.v1Importer = exports.pngDataUrlResolver = exports.V1ProjectImporter = void 0;
const document_1 = require("../types/document");
const v1_1 = require("../types/v1");
const v1_2 = require("./v1");
const png_1 = require("../persist/png");
const base64_1 = require("../persist/base64");
const errors_1 = require("../persist/errors");
class V1ProjectImporter {
    async import(raw, resolver, opts = {}) {
        if (!(0, v1_1.isSerializedProjectV1)(raw)) {
            throw new errors_1.PersistError('INVALID_SCHEMA', 'input is not a v1 serialized project (version:1 with name/width/height/palette/clips)');
        }
        const v1 = raw;
        const warnings = [];
        const project = (0, v1_2.v2ProjectShell)(v1, { id: opts.id ?? null });
        if (opts.name)
            project.name = opts.name;
        // OPTIONAL Task 6 extension: document onion-skin range. Only values in
        // 0..ONION_MAX are adopted; anything else keeps the shell default.
        const v1Onion = v1.settings?.onion;
        if (v1Onion && typeof v1Onion === 'object') {
            const ok = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= document_1.ONION_MAX;
            if (ok(v1Onion.prev) || ok(v1Onion.next)) {
                project.settings.onion = {
                    prev: ok(v1Onion.prev) ? v1Onion.prev : project.settings.onion.prev,
                    next: ok(v1Onion.next) ? v1Onion.next : project.settings.onion.next,
                };
            }
            else if (v1Onion.prev !== undefined || v1Onion.next !== undefined) {
                warnings.push('project.settings.onion: invalid values ignored — using defaults');
            }
        }
        for (const v1Clip of v1.clips) {
            project.clips.push(await importClip(v1Clip, v1, resolver, warnings));
        }
        return { project, warnings };
    }
}
exports.V1ProjectImporter = V1ProjectImporter;
async function importClip(v1Clip, v1, resolver, warnings) {
    const clip = (0, v1_2.v1ClipSkeleton)(v1Clip);
    // OPTIONAL Task 6 extension: preserve the playback direction when the
    // exporter stored it. Anything else (absent/unknown) stays the C3 default.
    if (v1Clip.loopMode !== undefined) {
        if (v1Clip.loopMode === 'forward' || v1Clip.loopMode === 'reverse' || v1Clip.loopMode === 'pingpong') {
            clip.loopMode = v1Clip.loopMode;
        }
        else {
            warnings.push(`clip "${v1Clip.name}": unknown loopMode "${String(v1Clip.loopMode)}" — using forward`);
        }
    }
    // Union of layers across frames, matched by name, first occurrence wins.
    const layerNames = [];
    const layerProps = new Map();
    for (const frame of v1Clip.frames) {
        for (const layer of frame.layers) {
            if (!layerProps.has(layer.name)) {
                layerNames.push(layer.name);
                layerProps.set(layer.name, { id: layer.id, visible: layer.visible, opacity: layer.opacity });
            }
            else {
                const first = layerProps.get(layer.name);
                if (first.visible !== layer.visible || Math.abs(first.opacity - layer.opacity) > 1e-9) {
                    warnings.push(`clip "${v1Clip.name}": layer "${layer.name}" has differing visibility/opacity across frames — keeping the first occurrence`);
                }
                if (first.id !== layer.id) {
                    warnings.push(`clip "${v1Clip.name}": layer "${layer.name}" has per-frame ids (v1 model) — matched by name`);
                }
            }
        }
    }
    const layers = layerNames.map((name) => {
        const props = layerProps.get(name);
        return {
            id: props.id,
            name,
            visible: props.visible,
            opacity: props.opacity,
            linked: false, // v1 has no linked concept
        };
    });
    clip.layers = layers;
    const byName = new Map(layers.map((l) => [l.name, l]));
    const frames = [];
    for (const v1Frame of v1Clip.frames) {
        const cels = {};
        for (const v1Layer of v1Frame.layers) {
            const layer = byName.get(v1Layer.name);
            if (!layer) {
                warnings.push(`clip "${v1Clip.name}" frame "${v1Frame.id}": layer "${v1Layer.name}" not in stack — skipped`);
                continue;
            }
            let buffer;
            try {
                // Dimension mismatch detection (top-left crop/pad in the resolver).
                const marker = 'base64,';
                const mIdx = v1Layer.png.indexOf(marker);
                const raw = (0, base64_1.base64Decode)(mIdx >= 0 ? v1Layer.png.slice(mIdx + marker.length) : v1Layer.png);
                const size = (0, png_1.peekPngSize)(raw);
                if (size && (size.width !== v1.width || size.height !== v1.height)) {
                    warnings.push(`clip "${v1Clip.name}" frame "${v1Frame.id}" layer "${v1Layer.name}": PNG is ${size.width}×${size.height}, project is ${v1.width}×${v1.height} — top-left crop/pad applied`);
                }
                buffer = await resolver.resolve(v1Layer.png, v1.width, v1.height);
            }
            catch (err) {
                warnings.push(`clip "${v1Clip.name}" frame "${v1Frame.id}" layer "${v1Layer.name}": PNG decode failed (${err instanceof Error ? err.message : String(err)}) — cel dropped (transparent)`);
                continue;
            }
            if (buffer.length !== v1.width * v1.height * 4) {
                // Defensive: a conforming resolver always returns the exact size.
                warnings.push(`clip "${v1Clip.name}" frame "${v1Frame.id}": buffer size mismatch — cel dropped`);
                continue;
            }
            cels[layer.id] = { buffer, linked: false };
        }
        // Warn once per frame about layers absent from this frame (transparent).
        for (const layer of layers) {
            if (!v1Frame.layers.some((l) => l.name === layer.name)) {
                warnings.push(`clip "${v1Clip.name}" frame "${v1Frame.id}": layer "${layer.name}" absent — cel left transparent`);
            }
        }
        // OPTIONAL Task 6 extension: per-frame duration override (0 = inherit).
        // Invalid values fall back to 0 (fps-inherited) with a warning instead of
        // producing a zero-length playback interval.
        let durationMs = 0;
        const raw = v1Frame.durationMs;
        if (raw !== undefined) {
            if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 60_000) {
                durationMs = raw;
            }
            else {
                warnings.push(`clip "${v1Clip.name}" frame "${v1Frame.id}": invalid durationMs ${String(raw)} — using the clip fps`);
            }
        }
        frames.push({ id: v1Frame.id, durationMs, cels });
    }
    clip.frames = frames;
    return clip;
}
/**
 * CelSourceResolver for v1 PNG data URLs (data:image/png;base64,…).
 * Dimension mismatches are top-left anchored: crop overflow, pad (transparent)
 * shortfall — deterministic and lossless for conforming v1 files.
 */
exports.pngDataUrlResolver = {
    async resolve(src, width, height) {
        const marker = 'base64,';
        const idx = src.indexOf(marker);
        const b64 = idx >= 0 ? src.slice(idx + marker.length) : src;
        let bytes;
        try {
            bytes = (0, base64_1.base64Decode)(b64);
        }
        catch (err) {
            throw new errors_1.PersistError('DECODE_FAILED', 'data URL base64 is invalid', { cause: err });
        }
        const png = await (0, png_1.decodePng)(bytes);
        const out = new Uint8ClampedArray(width * height * 4);
        const copyW = Math.min(width, png.width);
        const copyH = Math.min(height, png.height);
        for (let y = 0; y < copyH; y++) {
            out.set(png.rgba.subarray(y * png.width * 4, y * png.width * 4 + copyW * 4), y * width * 4);
        }
        return out;
    },
};
/** Convenience singleton (matches the V1ToV2Importer contract). */
exports.v1Importer = new V1ProjectImporter();
