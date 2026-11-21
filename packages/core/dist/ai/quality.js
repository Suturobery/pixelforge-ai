"use strict";
/**
 * @pixelforge/core — AI sprite output quality report (Task 9 quality
 * follow-up, requirement #4 "non-destructive checks").
 *
 * PURE, deterministic, read-only: it inspects a NORMALIZED sprite buffer and
 * the normalize stats, and returns human-readable findings. It NEVER mutates
 * the buffer and NEVER blocks the review workflow — findings are HEURISTIC
 * signals for the user, not guaranteed defect detections (wording reflects
 * that: "possible", "may", "check").
 *
 * Checks:
 *   • empty sprite (normalization likely erased the subject)
 *   • content touching the canvas edges (possible clipped subject)
 *   • subject filling the whole source frame (likely cropped by the
 *     generator — regeneration recommended)
 *   • isolated stray pixels surviving cleanup
 *   • enclosed background residue (pools matching the original bg color)
 *   • unexpected transparent holes inside the sprite
 *   • excessive palette colors / palette limit reached
 *   • aggressive cleanup (possible missing details)
 *   • anisotropic stretch when fit='fill' on a mismatched aspect
 *   • background removal disabled (matte kept)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeSpriteQuality = analyzeSpriteQuality;
// ------------------------------------------------------------------ helpers
function isOpaque(buf, i) {
    return buf[i + 3] >= 128;
}
/**
 * 4-connected components over opaque pixels. Deterministic row-major scan,
 * stack-based flood (no recursion). Returns component list in scan order.
 */
function opaqueComponents(buf, w, h) {
    const visited = new Uint8Array(w * h);
    const stack = [];
    const out = [];
    for (let start = 0; start < w * h; start++) {
        if (visited[start])
            continue;
        visited[start] = 1;
        if (!isOpaque(buf, start * 4))
            continue;
        let size = 0;
        let touchesBorder = false;
        stack.push(start);
        while (stack.length > 0) {
            const p = stack.pop();
            size += 1;
            const x = p % w;
            const y = (p / w) | 0;
            if (x === 0 || y === 0 || x === w - 1 || y === h - 1)
                touchesBorder = true;
            const visit = (p2) => {
                if (visited[p2])
                    return;
                visited[p2] = 1;
                if (isOpaque(buf, p2 * 4))
                    stack.push(p2);
            };
            if (x > 0)
                visit(p - 1);
            if (x < w - 1)
                visit(p + 1);
            if (y > 0)
                visit(p - w);
            if (y < h - 1)
                visit(p + w);
        }
        out.push({ size, touchesBorder });
    }
    return out;
}
/** 4-connected components over TRANSPARENT holes (alpha < 128), same scan. */
function transparentComponents(buf, w, h) {
    const visited = new Uint8Array(w * h);
    const stack = [];
    const out = [];
    for (let start = 0; start < w * h; start++) {
        if (visited[start])
            continue;
        visited[start] = 1;
        if (isOpaque(buf, start * 4))
            continue;
        let size = 0;
        let touchesBorder = false;
        stack.push(start);
        while (stack.length > 0) {
            const p = stack.pop();
            size += 1;
            const x = p % w;
            const y = (p / w) | 0;
            if (x === 0 || y === 0 || x === w - 1 || y === h - 1)
                touchesBorder = true;
            const visit = (p2) => {
                if (visited[p2])
                    return;
                visited[p2] = 1;
                if (!isOpaque(buf, p2 * 4))
                    stack.push(p2);
            };
            if (x > 0)
                visit(p - 1);
            if (x < w - 1)
                visit(p + 1);
            if (y > 0)
                visit(p - w);
            if (y < h - 1)
                visit(p + w);
        }
        out.push({ size, touchesBorder });
    }
    return out;
}
function parseHexToRgb(hex) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!m)
        return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/**
 * Non-destructive quality report. Deterministic: same inputs → same
 * findings. Every message is a heuristic signal, never a guaranteed defect
 * detection.
 */
function analyzeSpriteQuality(input) {
    const { buffer: buf, w, h, stats, opts } = input;
    const findings = [];
    const total = w * h;
    let opaque = 0;
    for (let i = 0; i < total; i++) {
        if (isOpaque(buf, i * 4))
            opaque += 1;
    }
    // 1. empty sprite — normalization likely erased the subject
    if (opaque === 0) {
        findings.push({
            code: 'empty',
            severity: 'error',
            message: 'The normalized sprite is empty — background removal likely erased the subject.',
            hint: 'Lower the background tolerance, turn off "Remove background", or regenerate.',
        });
        return findings; // nothing else is meaningful on an empty sprite
    }
    // 2. content touching the output frame edge
    let edgePixels = 0;
    for (let x = 0; x < w; x++) {
        if (isOpaque(buf, x * 4))
            edgePixels += 1;
        if (isOpaque(buf, ((h - 1) * w + x) * 4))
            edgePixels += 1;
    }
    for (let y = 0; y < h; y++) {
        if (isOpaque(buf, (y * w) * 4))
            edgePixels += 1;
        if (isOpaque(buf, (y * w + w - 1) * 4))
            edgePixels += 1;
    }
    if (edgePixels > 0) {
        findings.push({
            code: 'edge-touch',
            severity: 'warning',
            message: `Content touches the sprite frame edge (${edgePixels} edge px) — the subject may be clipped or cramped.`,
            hint: opts.fit === 'fill'
                ? 'Enable "Keep aspect" and add padding, or pick a size closer to the subject shape.'
                : 'Increase padding, or regenerate with clearer margins around the subject.',
        });
    }
    // 3. subject filled the whole source frame — likely cropped by the generator
    if (input.source && input.source.w > 0 && input.source.h > 0) {
        const t = stats.trim;
        const fillsW = t.w / input.source.w >= 0.98;
        const fillsH = t.h / input.source.h >= 0.98;
        if (fillsW || fillsH) {
            findings.push({
                code: 'clipped-subject',
                severity: 'warning',
                message: 'The subject fills the whole source image — parts of it may be cropped by the generator.',
                hint: 'Normalization cannot restore missing pixels. Regenerate, or prompt for "full body visible, centered with margins".',
            });
        }
    }
    // 4. stray pixels surviving cleanup
    const comps = opaqueComponents(buf, w, h);
    const strays = comps.filter((c) => c.size <= 2).length;
    if (strays > 0) {
        findings.push({
            code: 'strays',
            severity: 'warning',
            message: `${strays} tiny isolated pixel group${strays === 1 ? '' : 's'} remain — possible leftover noise from the source image.`,
            hint: 'Enable stray cleanup (Advanced) and re-run, or clean the pixels by hand after import.',
        });
    }
    // 5. enclosed background residue
    if (opts.removeBg) {
        const bg = parseHexToRgb(stats.bgColor) ?? [255, 255, 255];
        const tol2 = opts.bgTolerance * opts.bgTolerance;
        let residueComponents = 0;
        let residuePx = 0;
        const visited = new Uint8Array(total);
        const stack = [];
        for (let start = 0; start < total; start++) {
            if (visited[start])
                continue;
            visited[start] = 1;
            const i4 = start * 4;
            if (!isOpaque(buf, i4))
                continue;
            const dr = buf[i4] - bg[0];
            const dg = buf[i4 + 1] - bg[1];
            const db = buf[i4 + 2] - bg[2];
            if (dr * dr + dg * dg + db * db > tol2)
                continue;
            let size = 0;
            let touchesBorder = false;
            stack.push(start);
            while (stack.length > 0) {
                const p = stack.pop();
                size += 1;
                const x = p % w;
                const y = (p / w) | 0;
                if (x === 0 || y === 0 || x === w - 1 || y === h - 1)
                    touchesBorder = true;
                const visit = (p2) => {
                    if (visited[p2])
                        return;
                    visited[p2] = 1;
                    const j = p2 * 4;
                    if (!isOpaque(buf, j))
                        return;
                    const r2 = buf[j] - bg[0];
                    const g2 = buf[j + 1] - bg[1];
                    const b2 = buf[j + 2] - bg[2];
                    if (r2 * r2 + g2 * g2 + b2 * b2 > tol2)
                        return;
                    stack.push(p2);
                };
                if (x > 0)
                    visit(p - 1);
                if (x < w - 1)
                    visit(p + 1);
                if (y > 0)
                    visit(p - w);
                if (y < h - 1)
                    visit(p + w);
            }
            if (!touchesBorder) {
                residueComponents += 1;
                residuePx += size;
            }
        }
        if (residueComponents > 0) {
            if (opts.enclosedResidueCleanup && stats.residueRemoved === 0) {
                // cleanup ran and these survived — likely intentional light details
                findings.push({
                    code: 'residue-survivors',
                    severity: 'info',
                    message: `${residueComponents} enclosed region${residueComponents === 1 ? '' : 's'} still match the background color (${residuePx} px) even after cleanup — they may be intentional light details (eyes, highlights).`,
                });
            }
            else {
                findings.push({
                    code: 'bg-residue',
                    severity: 'warning',
                    message: `${residueComponents} enclosed region${residueComponents === 1 ? '' : 's'} match the original background color (#${stats.bgColor.replace(/^#/, '')}) — possible background residue (${residuePx} px) trapped inside the sprite.`,
                    hint: 'Enable "Enclosed residue cleanup" (Advanced) and re-run — but check it does not erase intentional light details.',
                });
            }
        }
    }
    else {
        findings.push({
            code: 'bg-kept',
            severity: 'info',
            message: 'Background removal is OFF — the sprite keeps its original matte.',
            hint: 'Turn it on for a transparent sprite (recommended for in-game use).',
        });
    }
    // 6. transparent holes fully inside the sprite
    const holes = transparentComponents(buf, w, h).filter((c) => !c.touchesBorder);
    if (holes.length > 0) {
        findings.push({
            code: 'holes',
            severity: 'info',
            message: `${holes.length} transparent hole${holes.length === 1 ? '' : 's'} inside the sprite — verify they are intentional (gaps between limbs often should be transparent).`,
        });
    }
    // 7. palette pressure
    if (opts.paletteMode === 'off' && stats.colorsOut > 24) {
        findings.push({
            code: 'many-colors',
            severity: 'warning',
            message: `${stats.colorsOut} distinct colors — above the usual pixel-art range (≤ 24).`,
            hint: 'Quantize with "auto · median cut" for a cleaner, more readable sprite.',
        });
    }
    else if (opts.paletteMode === 'auto' && stats.colorsOut >= opts.maxColors) {
        findings.push({
            code: 'palette-limit',
            severity: 'info',
            message: `Palette limit reached (${stats.colorsOut}/${opts.maxColors} colors) — fine details may be merging.`,
            hint: 'Raise the color limit if details look lost.',
        });
    }
    // 8. aggressive cleanup — possible missing details
    const cleaned = stats.specklesRemoved + stats.fringeRemoved;
    if (cleaned > 0 && cleaned / Math.max(1, opaque + cleaned) > 0.08) {
        findings.push({
            code: 'cleanup-loss',
            severity: 'warning',
            message: `Cleanup removed ${cleaned} px (${Math.round((cleaned / Math.max(1, opaque + cleaned)) * 100)}% of the sprite) — thin details may have been eaten.`,
            hint: 'Lower the background tolerance or disable outline cleanup, then re-run.',
        });
    }
    // 9. anisotropic stretch when fit='fill' on a mismatched aspect
    if ((opts.fit ?? 'contain') === 'fill') {
        const t = stats.trim;
        const srcAspect = t.w / Math.max(1, t.h);
        const outAspect = w / Math.max(1, h);
        const deviation = Math.abs(srcAspect - outAspect) / Math.max(srcAspect, outAspect);
        if (deviation > 0.25) {
            findings.push({
                code: 'stretched',
                severity: 'warning',
                message: `Aspect mismatch (content ${t.w}×${t.h} → ${w}×${h}) — the sprite is stretched (${Math.round(deviation * 100)}%).`,
                hint: 'Enable "Keep aspect" to preserve proportions.',
            });
        }
    }
    // 10. stray cleanup ran — record what it did (info, not a warning)
    if (stats.sourceStraysRemoved > 0) {
        findings.push({
            code: 'strays-removed',
            severity: 'info',
            message: `Stray cleanup removed ${stats.sourceStraysRemoved} source px in small isolated groups — check no small intentional details were lost.`,
        });
    }
    return findings;
}
