/**
 * Document factories v2 (v3.1 §2.4/§6): new clips default to a single layer
 * "Layer 1"; frames carry cels per layer; linked layers share one cel.
 * Ported from the prototype's factory.ts and re-targeted to the v2 model.
 */
import type { Cel, CellBuffer, Clip, Frame, Layer, LoopMode, Project } from '../types/document';
/** Default palette — the prototype's Forge-16 set (store.ts initialProject). */
export declare const DEFAULT_PALETTE: string[];
export declare function clampCanvasSize(n: number): number;
export declare function createCel(width: number, height: number, linked?: boolean, buffer?: CellBuffer): Cel;
export declare function createLayer(name: string, linked?: boolean): Layer;
/** A frame with a transparent cel per given layer (linked layers share later). */
export declare function createFrame(width: number, height: number, layers: Layer[]): Frame;
/**
 * Duplicate a frame "preserving cels exactly" (v3.1 §2.7):
 *  - normal layers → independent deep-copied buffers;
 *  - linked layers → the SAME shared cel object (that is what linked means).
 * Copy-on-write discipline is preserved either way: buffers are never
 * mutated in place, only replaced wholesale.
 */
export declare function duplicateFrame(frame: Frame, clipLayers: Layer[]): Frame;
export interface CreateClipOptions {
    name: string;
    width: number;
    height: number;
    fps?: number;
    loop?: boolean;
    loopMode?: LoopMode;
    layerNames?: string[];
    /** Initial frame count (default 1). */
    frameCount?: number;
}
export declare function createClip(opts: CreateClipOptions): Clip;
export interface CreateProjectOptions {
    name?: string;
    width?: number;
    height?: number;
    palette?: string[];
    fps?: number;
    loop?: boolean;
    loopMode?: LoopMode;
    /** Server persistence id (web testbed); null while unsaved. */
    id?: string | null;
}
export declare function createProject(opts?: CreateProjectOptions): Project;
/** Deep clone including every cel buffer. Used sparingly (load/reset/tests). */
export declare function cloneProject(p: Project): Project;
