/**
 * PixelForge AI — Automatic Hue Shifter (pixel-art color ramp generator).
 *
 * Pure, DOM-free math. Given a single base color, generates a rich pixel-art
 * shading ramp (dark → mid → bright) using classic pixel-art hue shifting:
 * shadows shift cooler (toward violet/indigo ~245°) and highlights shift
 * warmer (toward gold/yellow ~55°), or follow explicit manual degree shifts.
 */

export interface HueRampOptions {
  /** Base color in #rrggbb (or #rgb) format. */
  baseHex: string;
  /** Number of swatches in the ramp (3–9, default 5). */
  steps?: number;
  /**
   * When true (default), automatically shifts shadows toward cool blue-violet
   * (245°) and highlights toward warm yellow (55°) along the shortest hue arc.
   * When false, uses exact signed `shadowHueShift` and `highlightHueShift` degrees.
   */
  autoShift?: boolean;
  /** Hue shift magnitude/offset in degrees for shadows (-90..90, default -28). */
  shadowHueShift?: number;
  /** Hue shift magnitude/offset in degrees for highlights (-90..90, default 22). */
  highlightHueShift?: number;
  /** Lightness spread across the ramp (0.2..1.0, default 0.72). */
  contrast?: number;
  /** Saturation curve adjustment (-0.4..0.4, default 0.12 — richer shadows, cleaner highlights). */
  saturationShift?: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function normalizeHex6(hex: string): string | null {
  const clean = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(clean)) {
    return `#${clean[0]}${clean[0]}${clean[1]}${clean[1]}${clean[2]}${clean[2]}`.toLowerCase();
  }
  if (/^[0-9a-f]{6}$/i.test(clean)) {
    return `#${clean}`.toLowerCase();
  }
  return null;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const f = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}

/** Convert sRGB [0..255] to HSL: h in [0..360), s in [0..1], l in [0..1]. */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return [h % 360, s, l];
}

/** Convert HSL (h in degrees, s/l in [0..1]) to sRGB [0..255]. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const lig = clamp(l, 0, 1);
  if (sat === 0) {
    const v = Math.round(lig * 255);
    return [v, v, v];
  }
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const hue2rgb = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const hk = hue / 360;
  return [
    Math.round(hue2rgb(hk + 1 / 3) * 255),
    Math.round(hue2rgb(hk) * 255),
    Math.round(hue2rgb(hk - 1 / 3) * 255),
  ];
}

/** Signed shortest angular distance from `fromDeg` toward `targetDeg` in [-180, 180]. */
function shortestHueDelta(fromDeg: number, targetDeg: number): number {
  let diff = ((targetDeg - fromDeg + 540) % 360) - 180;
  if (diff < -180) diff += 360;
  return diff;
}

/**
 * Shift a single RGB pixel toward a cool dark shadow color (used by Sel-Out
 * live outline modifier so outlines stay harmonious rather than muddy black).
 */
export function computeSelOutColor(r: number, g: number, b: number): [number, number, number] {
  const [h, s, l] = rgbToHsl(r, g, b);
  const delta = shortestHueDelta(h, 248);
  const shiftedH = h + clamp(delta * 0.25, -24, 24);
  const nextS = s < 0.06 ? s : clamp(s + 0.14, 0.12, 0.88);
  const nextL = clamp(l * 0.44 - 0.05, 0.06, 0.34);
  return hslToRgb(shiftedH, nextS, nextL);
}

/**
 * Generate a pixel-art hue-shifted color ramp (ordered dark → bright).
 * When `steps` is odd, the middle swatch is always the exact normalized `baseHex`.
 */
export function generateHueShiftedRamp(opts: HueRampOptions): string[] {
  const base = normalizeHex6(opts.baseHex);
  if (!base) return [];

  const steps = clamp(Math.round(opts.steps ?? 5), 3, 9);
  const autoShift = opts.autoShift !== false;
  const contrast = clamp(opts.contrast ?? 0.72, 0.2, 1.0);
  const satShift = clamp(opts.saturationShift ?? 0.12, -0.4, 0.4);
  const rawShadowShift = clamp(opts.shadowHueShift ?? -28, -90, 90);
  const rawHighlightShift = clamp(opts.highlightHueShift ?? 22, -90, 90);

  const [r, g, b] = hexToRgb(base);
  const [h, s, l] = rgbToHsl(r, g, b);

  // Determine signed shadow / highlight hue shifts
  let shadowDeg = rawShadowShift;
  let highlightDeg = rawHighlightShift;
  if (autoShift) {
    const shadowMag = Math.abs(rawShadowShift);
    const highlightMag = Math.abs(rawHighlightShift);
    const toCool = shortestHueDelta(h, 245); // cool blue-violet shadow pole
    const toWarm = shortestHueDelta(h, 55); // warm gold-yellow highlight pole
    shadowDeg = Math.sign(toCool || -1) * Math.min(shadowMag, Math.abs(toCool) * 0.85 + 8);
    highlightDeg = Math.sign(toWarm || 1) * Math.min(highlightMag, Math.abs(toWarm) * 0.85 + 8);
  }

  // Lightness bounds around the base color
  const darkFloor = clamp(l - (0.34 + 0.22 * contrast) * Math.max(0.45, l + 0.2), 0.06, Math.max(0.06, l - 0.06));
  const brightCeil = clamp(l + (0.30 + 0.24 * contrast) * Math.max(0.45, 1.15 - l), Math.min(0.95, l + 0.06), 0.95);

  const mid = (steps - 1) / 2;
  const out: string[] = [];

  for (let i = 0; i < steps; i++) {
    if (steps % 2 === 1 && i === mid) {
      out.push(base);
      continue;
    }
    // t in [-1, 1]: -1 = darkest shadow, 0 = base, +1 = brightest highlight
    const t = (i - mid) / mid;
    if (t < 0) {
      const k = -t; // 0..1 toward darkest shadow
      const eased = Math.pow(k, 1.08);
      const nextL = l + (darkFloor - l) * eased;
      const nextH = h + shadowDeg * eased;
      // Keep neutral grays mostly neutral while enriching chromatic shadows
      const nextS = s < 0.04 ? s : clamp(s + satShift * eased * 0.9, 0.06, 0.96);
      const [rr, gg, bb] = hslToRgb(nextH, nextS, nextL);
      out.push(rgbToHex(rr, gg, bb));
    } else {
      const k = t; // 0..1 toward brightest highlight
      const eased = Math.pow(k, 1.04);
      const nextL = l + (brightCeil - l) * eased;
      const nextH = h + highlightDeg * eased;
      // Highlights gently desaturate slightly at the extreme bright end so they glow cleanly
      const nextS = s < 0.04 ? s : clamp(s - satShift * eased * 0.45, 0.06, 0.96);
      const [rr, gg, bb] = hslToRgb(nextH, nextS, nextL);
      out.push(rgbToHex(rr, gg, bb));
    }
  }

  return out;
}
