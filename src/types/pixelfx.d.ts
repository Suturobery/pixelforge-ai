// pixelfx (github:patch-gg/pixelfx, MIT) ships plain JS without type
// declarations — the integration treats it as an untyped external boundary
// and validates its data at runtime (meta objects, ids, buffers).
declare module 'pixelfx' {
  const pixelfx: Record<string, unknown>;
  export default pixelfx;
  export const createFrame: (w: number, h: number) => unknown;
  export const clearFrame: (frame: unknown) => void;
  export const createFx: (mod: unknown, opts: Record<string, unknown>) => {
    update: (dt: number) => void;
    draw: (frame: unknown, layer: 'back' | 'front') => void;
  };
  export const composite: (frame: unknown, out: Uint8ClampedArray, bg: null, lightK?: number) => void;
}

declare module 'pixelfx/fx/index' {
  const effects: Record<string, {
    meta?: { name?: string; desc?: string; tags?: string[]; size?: number[]; origin?: number[]; duration?: number };
  }>;
  export default effects;
}
