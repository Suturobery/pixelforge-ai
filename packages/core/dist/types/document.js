"use strict";
/**
 * PixelForge AI — editor document model v2 (v3.1 Plan §2.4 / §6).
 *
 * Architecture (approved v3.1):
 *   Project
 *   ├─ settings, palette, trash[]                ← trash: deleted frames/layers/clips (C5)
 *   └─ Clip (id, name, fps, loop, loopMode, tags[])
 *      ├─ layers: Layer[] (bottom→top)           ← stack defined ONCE PER CLIP (C1)
 *      ├─ parts: Part[] (optional motion regions, C4)
 *      └─ frames[] — each holds a Cel per layer
 *          Cel { buffer, linked }                ← missing cel = fully transparent (C2)
 *
 * Runtime model: layers/cels are Uint8ClampedArray RGBA buffers (prototype
 * type kept); the JSON in §6 is the serialized form and maps cel src paths
 * ⇄ in-memory cels 1:1 (see types/serialized.ts). Linked cels share the SAME
 * buffer object across every frame of the clip — "edit once applies
 * everywhere" (C2; engine support P0, UI toggle P2 per C19).
 *
 * This module is pure TypeScript: no React, no Electron, no DOM (§8.3).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ONION_MAX = exports.TRASH_CAP = exports.CANVAS_MAX = exports.CANVAS_MIN = void 0;
/** Canvas bounds (v3.1 §2: pixel canvas 16–256). */
exports.CANVAS_MIN = 16;
exports.CANVAS_MAX = 256;
/** Trash capacity (v3.1 C5/C9). */
exports.TRASH_CAP = 20;
/** Onion-skin depth bounds (§2.6: previous/next N, 1–3 configured; 0 disables). */
exports.ONION_MAX = 3;
