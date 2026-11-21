/**
 * Pixel-editing command: `pixels.applyOp` (v3.1 §2.5 — every tool is a
 * pointer stream → command-bus call; no tool mutates the canvas directly).
 *
 * The interactive path is the stroke flow (begin/end/cancel on the bus,
 * prototype contract kept); this command covers single-shot deterministic
 * edits (MCP tools, AI ops, programmatic edits) and produces the same
 * 16×16 tile-diff history entries.
 */
import type { RGBA } from '../types/document';
import type { CommandDefinition } from '../types/commands';
import { type PixelRect } from '../pixels/region';
export interface PixelPoint {
    x: number;
    y: number;
}
export type PixelOp = ({
    op: 'stamp';
} & PixelPoint & {
    size?: number;
    mirrorX?: boolean;
}) | {
    op: 'line';
    from: PixelPoint;
    to: PixelPoint;
    size?: number;
    mirrorX?: boolean;
} | {
    op: 'rect';
    from: PixelPoint;
    to: PixelPoint;
    size?: number;
    filled?: boolean;
    mirrorX?: boolean;
} | {
    op: 'ellipse';
    from: PixelPoint;
    to: PixelPoint;
    size?: number;
    filled?: boolean;
    mirrorX?: boolean;
} | ({
    op: 'fill';
} & PixelPoint & {
    mirrorX?: boolean;
}) | {
    op: 'shift';
    dx: number;
    dy: number;
} | {
    op: 'clear';
}
/** Region transforms — rect omitted = whole cel. Integer, interpolation-free. */
 | {
    op: 'flipH';
    rect?: PixelRect;
} | {
    op: 'flipV';
    rect?: PixelRect;
} | {
    op: 'rotateCW';
    rect?: PixelRect;
} | {
    op: 'rotateCCW';
    rect?: PixelRect;
}
/** Nearest-neighbor scale about the region's top-left corner. factor 0.5
 * downsamples (every-other-pixel), integers 2–8 duplicate pixels. Content
 * pushed outside the canvas is dropped; rect omitted = whole cel. */
 | {
    op: 'scale';
    factor: number;
    rect?: PixelRect;
}
/** Free NN resample: scale the `rect` region into the explicit `to`
 * footprint (per-axis, uniform or not). Overwrites the destination area,
 * clears the source, clips to the canvas. Powers the interactive
 * selection-scale handles. */
 | {
    op: 'scaleTo';
    rect: PixelRect;
    to: PixelRect;
}
/** Full cel replace (AI import path) — buffer must match w*h*4. */
 | {
    op: 'setBuffer';
    buffer: Uint8ClampedArray;
};
export interface ApplyPixelOpsPayload {
    clipId: string;
    frameId: string;
    layerId: string;
    /** Required for stamp/line/rect/fill; ignored otherwise. */
    color?: RGBA;
    ops: PixelOp[];
}
export declare const applyPixelOpsCommand: CommandDefinition<ApplyPixelOpsPayload>;
