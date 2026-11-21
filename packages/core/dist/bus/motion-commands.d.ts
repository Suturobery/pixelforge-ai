/**
 * Motion & part commands (v3.1 §4.1/§4.1.1, Task 10) — thin CommandBus
 * wrappers over the deterministic composer, following builtins.ts discipline:
 * pure (document in) → (document out), hand-rolled validation, structural
 * snapshot history (exact undo), trash never involved (nothing is deleted).
 *
 *  part.set     — replace a clip's whole parts array in ONE undoable step
 *                 (the plan's `set_parts` MCP tool maps here; regions only,
 *                 never cuts — C4).
 *  motion.apply — run a preset through planMotion() and commit the frames
 *                 atomically (new clip sized exactly / overwrite with
 *                 holds, R6), unlinking tagged linked layers in the same
 *                 undo entry (R8). Generated frames get durationMs 0 (R7).
 *
 * New clip/frame/part ids use the shared uid() generators like every other
 * structural command; PIXEL content is fully deterministic (the composer is
 * pure) — "same source + parameters = byte-identical output" holds for the
 * composed buffers, which is what golden tests assert.
 */
import type { LoopMode } from '../types/document';
import type { CommandDefinition } from '../types/commands';
import { type GapFillMode, type MotionPresetId } from '../motion/types';
export interface PartSetPayload {
    clipId: string;
    parts: Array<{
        name: string;
        layerId: string;
        rect?: {
            x: number;
            y: number;
            w: number;
            h: number;
        };
        anchorFrameId?: string;
        z?: number;
    }>;
}
export declare const partSet: CommandDefinition<PartSetPayload>;
export interface MotionApplyPayload {
    sourceClipId: string;
    preset: MotionPresetId;
    params?: {
        amplitude?: number;
        frameCount?: number;
        gapFill?: GapFillMode;
        smear?: boolean;
    };
    /** Anchor frame INDEX (0-based; default 0 = frame 1, R5). */
    anchorFrameIndex?: number;
    target: {
        kind: 'new';
        name: string;
        fps?: number;
        loop?: boolean;
        loopMode?: LoopMode;
    } | {
        kind: 'existing';
        clipId: string;
        overwrite: true;
    };
}
export declare const motionApply: CommandDefinition<MotionApplyPayload>;
