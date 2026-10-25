"use strict";
/**
 * Pixel-editing command: `pixels.applyOp` (v3.1 §2.5 — every tool is a
 * pointer stream → command-bus call; no tool mutates the canvas directly).
 *
 * The interactive path is the stroke flow (begin/end/cancel on the bus,
 * prototype contract kept); this command covers single-shot deterministic
 * edits (MCP tools, AI ops, programmatic edits) and produces the same
 * 16×16 tile-diff history entries.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyPixelOpsCommand = void 0;
const access_1 = require("../doc/access");
const buffers_1 = require("../util/buffers");
const ops_1 = require("../pixels/ops");
const ellipse_1 = require("../pixels/ellipse");
const region_1 = require("../pixels/region");
const tile_1 = require("../pixels/tile");
const errors_1 = require("./errors");
const validate_1 = require("./validate");
const OPS_NEEDING_COLOR = new Set(['stamp', 'line', 'rect', 'ellipse', 'fill']);
function validateRect(rect, what) {
    if (!rect || typeof rect !== 'object')
        (0, errors_1.fail)(`${what} requires a rect object`);
    const r = rect;
    (0, validate_1.getInt)(r, 'x', what);
    (0, validate_1.getInt)(r, 'y', what);
    const w = (0, validate_1.getInt)(r, 'w', what);
    const h = (0, validate_1.getInt)(r, 'h', what);
    if (w < 1 || h < 1)
        (0, errors_1.fail)(`${what} rect must be at least 1×1`);
}
function validateOp(op, hasColor, ctx, i) {
    const what = `pixels.applyOp ops[${i}] (${op.op})`;
    if (!op || typeof op !== 'object')
        (0, errors_1.fail)(`${what} must be an object`);
    switch (op.op) {
        case 'stamp':
        case 'fill':
            (0, validate_1.getInt)(op, 'x', what);
            (0, validate_1.getInt)(op, 'y', what);
            (0, validate_1.getOptionalInt)(op, 'size', what, 1, 8);
            (0, validate_1.getOptionalBool)(op, 'mirrorX', what);
            break;
        case 'line':
        case 'rect':
        case 'ellipse':
            if (!op.from || !op.to)
                (0, errors_1.fail)(`${what} requires from/to points`);
            (0, validate_1.getInt)(op.from, 'x', what);
            (0, validate_1.getInt)(op.from, 'y', what);
            (0, validate_1.getInt)(op.to, 'x', what);
            (0, validate_1.getInt)(op.to, 'y', what);
            (0, validate_1.getOptionalInt)(op, 'size', what, 1, 8);
            (0, validate_1.getOptionalBool)(op, 'mirrorX', what);
            if (op.op !== 'line' && op.filled !== undefined) {
                (0, validate_1.getOptionalBool)(op, 'filled', what);
            }
            break;
        case 'flipH':
        case 'flipV':
        case 'rotateCW':
        case 'rotateCCW': {
            const rect = op.rect;
            if (rect !== undefined)
                validateRect(rect, what);
            break;
        }
        case 'shift':
            (0, validate_1.getInt)(op, 'dx', what);
            (0, validate_1.getInt)(op, 'dy', what);
            break;
        case 'clear':
            break;
        case 'setBuffer': {
            const buf = op.buffer;
            if (!(buf instanceof Uint8ClampedArray))
                (0, errors_1.fail)(`${what} requires a Uint8ClampedArray buffer`);
            if (buf.length !== ctx.width * ctx.height * 4) {
                (0, errors_1.fail)(`${what} buffer length must be width*height*4 (${ctx.width * ctx.height * 4})`);
            }
            break;
        }
        default:
            (0, errors_1.fail)(`${what}: unknown op kind`);
    }
    if (OPS_NEEDING_COLOR.has(op.op) && !hasColor) {
        (0, errors_1.fail)(`pixels.applyOp: "color" is required for op "${op.op}"`);
    }
}
exports.applyPixelOpsCommand = {
    type: 'pixels.applyOp',
    defaultLabel: 'Pixel edit',
    validate(payload, ctx) {
        const p = (0, validate_1.assertObject)(payload, 'pixels.applyOp payload');
        (0, validate_1.getString)(p, 'clipId', 'pixels.applyOp');
        (0, validate_1.getString)(p, 'frameId', 'pixels.applyOp');
        (0, validate_1.getString)(p, 'layerId', 'pixels.applyOp');
        let hasColor = false;
        let color;
        if (p.color !== undefined) {
            color = (0, validate_1.getRgba)(p, 'color', 'pixels.applyOp');
            hasColor = true;
        }
        if (!Array.isArray(p.ops) || p.ops.length === 0) {
            (0, errors_1.fail)('pixels.applyOp: "ops" must be a non-empty array');
        }
        if (p.ops.length > 4096)
            (0, errors_1.fail)('pixels.applyOp: too many ops in one command (max 4096)');
        for (let i = 0; i < p.ops.length; i++) {
            validateOp(p.ops[i], hasColor, ctx, i);
        }
        void color;
    },
    apply(payload, ctx) {
        const { clipId, frameId, layerId } = payload;
        const loc = (0, access_1.locateCel)(ctx.project, clipId, frameId, layerId);
        if (!loc)
            (0, errors_1.failNotFound)(`pixels.applyOp: cel target ${clipId}/${frameId}/${layerId} not found`);
        const { width, height } = ctx.project;
        // Missing cel = transparent (C2): painting creates the cel.
        const base = loc.cel
            ? (0, buffers_1.cloneBuffer)(loc.cel.buffer)
            : new Uint8ClampedArray(width * height * 4);
        for (const op of payload.ops) {
            const c = payload.color;
            switch (op.op) {
                case 'stamp':
                    (0, ops_1.stampBrush)(base, width, height, op.x, op.y, op.size ?? 1, c, op.mirrorX ?? false);
                    break;
                case 'line':
                    (0, ops_1.drawLinePixels)(base, width, height, op.from.x, op.from.y, op.to.x, op.to.y, op.size ?? 1, c, op.mirrorX ?? false);
                    break;
                case 'rect':
                    (0, ops_1.drawRectPixels)(base, width, height, op.from.x, op.from.y, op.to.x, op.to.y, op.size ?? 1, c, op.filled ?? false, op.mirrorX ?? false);
                    break;
                case 'ellipse':
                    (0, ellipse_1.drawEllipsePixels)(base, width, height, op.from.x, op.from.y, op.to.x, op.to.y, op.size ?? 1, c, op.filled ?? false, op.mirrorX ?? false);
                    break;
                case 'fill':
                    (0, ops_1.floodFill)(base, width, height, op.x, op.y, c, op.mirrorX ?? false);
                    break;
                case 'flipH':
                case 'flipV':
                case 'rotateCW':
                case 'rotateCCW': {
                    const rect = op.rect;
                    const scope = rect ? (0, region_1.clampRect)(rect, width, height) : { x: 0, y: 0, w: width, h: height };
                    if (!scope)
                        break; // rect fully outside the canvas → visual no-op
                    if (op.op === 'flipH')
                        (0, region_1.flipRegionHInPlace)(base, width, height, scope);
                    else if (op.op === 'flipV')
                        (0, region_1.flipRegionVInPlace)(base, width, height, scope);
                    else if (op.op === 'rotateCW')
                        (0, region_1.rotateRegionCWInPlace)(base, width, height, scope);
                    else
                        (0, region_1.rotateRegionCCWInPlace)(base, width, height, scope);
                    break;
                }
                case 'shift': {
                    const moved = (0, ops_1.moveBuffer)(base, width, height, op.dx, op.dy);
                    base.set(moved);
                    break;
                }
                case 'clear':
                    (0, ops_1.clearBufferInPlace)(base);
                    break;
                case 'setBuffer':
                    base.set(op.buffer);
                    break;
            }
        }
        const tiles = (0, tile_1.extractTileDiff)(loc.cel ? loc.cel.buffer : new Uint8ClampedArray(width * height * 4), base, width, height);
        const project = (0, access_1.replaceCelBuffer)(ctx.project, clipId, frameId, layerId, base, loc.layer.linked);
        if (!project)
            (0, errors_1.failNotFound)('pixels.applyOp: cel target vanished during apply');
        // Always mark the pixel path (even with zero tiles) so the bus never
        // records a structural snapshot for a visual no-op.
        const outcome = {
            project,
            pixels: { clipId, frameId, layerId, tiles },
        };
        if (tiles.length > 0) {
            outcome.label = payload.ops.length === 1 ? describeOp(payload.ops[0]) : `Pixel edit (${payload.ops.length} ops)`;
        }
        return outcome;
    },
};
function describeOp(op) {
    const scope = 'rect' in op && op.rect ? ' (selection)' : '';
    switch (op.op) {
        case 'stamp': return 'Brush';
        case 'line': return 'Line';
        case 'rect': return op.filled ? 'Filled rect' : 'Rect';
        case 'ellipse': return (op.filled ? 'Filled ellipse' : 'Ellipse') + scope;
        case 'fill': return 'Fill';
        case 'flipH': return 'Flip horizontal' + scope;
        case 'flipV': return 'Flip vertical' + scope;
        case 'rotateCW': return 'Rotate 90° CW' + scope;
        case 'rotateCCW': return 'Rotate 90° CCW' + scope;
        case 'shift': return 'Move layer';
        case 'clear': return 'Clear cel';
        case 'setBuffer': return 'Replace cel';
        default: return 'Pixel edit';
    }
}
