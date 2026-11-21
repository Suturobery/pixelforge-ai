import type { StyleProfile } from '../style-profile';

export type StyleCheckStatus = 'pass' | 'warning' | 'info';

export interface StyleCheck {
  id: 'size' | 'palette' | 'alpha' | 'background' | 'margin';
  status: StyleCheckStatus;
  label: string;
  detail: string;
}

function canonicalHex(hex: string): string | null {
  const raw = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(raw)) return `#${raw.split('').map((ch) => ch + ch).join('').toLowerCase()}`;
  if (/^[0-9a-f]{4}$/i.test(raw)) return `#${raw.slice(0, 3).split('').map((ch) => ch + ch).join('').toLowerCase()}`;
  if (/^[0-9a-f]{6,8}$/i.test(raw)) return `#${raw.slice(0, 6).toLowerCase()}`;
  return null;
}

function pixelHex(buffer: Uint8ClampedArray, offset: number): string {
  return `#${buffer[offset].toString(16).padStart(2, '0')}${buffer[offset + 1].toString(16).padStart(2, '0')}${buffer[offset + 2].toString(16).padStart(2, '0')}`;
}

/**
 * Honest, deterministic post-normalization checks. This validates technical
 * pipeline constraints only; it intentionally does not claim to score an
 * image's artistic quality or semantic correctness.
 */
export function validateStyleCandidate(input: {
  buffer: Uint8ClampedArray;
  width: number;
  height: number;
  targetWidth: number;
  targetHeight: number;
  palette: string[];
  profile?: StyleProfile;
  allowEdgeTouch?: boolean;
}): StyleCheck[] {
  const checks: StyleCheck[] = [];
  const expectedBytes = input.width * input.height * 4;
  const exactSize = input.width === input.targetWidth && input.height === input.targetHeight && input.buffer.length === expectedBytes;
  checks.push({
    id: 'size',
    status: exactSize ? 'pass' : 'warning',
    label: exactSize ? 'Canvas size matches' : 'Canvas size mismatch',
    detail: `${input.width}×${input.height} · target ${input.targetWidth}×${input.targetHeight}`,
  });

  let transparent = 0;
  let semiTransparent = 0;
  let edgeOpaque = 0;
  const usedColors = new Set<string>();
  for (let y = 0; y < input.height; y++) {
    for (let x = 0; x < input.width; x++) {
      const offset = (y * input.width + x) * 4;
      const alpha = input.buffer[offset + 3] ?? 0;
      if (alpha === 0) {
        transparent += 1;
        continue;
      }
      if (alpha !== 255) semiTransparent += 1;
      usedColors.add(pixelHex(input.buffer, offset));
      if (x === 0 || y === 0 || x === input.width - 1 || y === input.height - 1) edgeOpaque += 1;
    }
  }

  checks.push({
    id: 'alpha',
    status: semiTransparent === 0 ? 'pass' : 'warning',
    label: semiTransparent === 0 ? 'Crisp pixel alpha' : 'Semi-transparent pixels found',
    detail: semiTransparent === 0 ? 'Only transparent or fully opaque pixels' : `${semiTransparent} semi-transparent pixels`,
  });

  if (input.profile?.enabled && input.profile.paletteMode === 'enforce') {
    const palette = new Set(input.palette.map(canonicalHex).filter((c): c is string => c !== null));
    const outOfPalette = [...usedColors].filter((hex) => !palette.has(hex));
    checks.push({
      id: 'palette',
      status: outOfPalette.length === 0 ? 'pass' : 'warning',
      label: outOfPalette.length === 0 ? 'Project palette locked' : 'Colors outside project palette',
      detail: outOfPalette.length === 0 ? `${usedColors.size} colors · ${palette.size} allowed` : `${outOfPalette.length} colors need normalization`,
    });
  } else {
    checks.push({
      id: 'palette',
      status: 'info',
      label: 'Palette not locked',
      detail: `${usedColors.size} colors after normalization`,
    });
  }

  if (input.profile?.enabled && input.profile.transparentBackground) {
    checks.push({
      id: 'background',
      status: transparent > 0 ? 'pass' : 'warning',
      label: transparent > 0 ? 'Transparent background present' : 'No transparent background found',
      detail: transparent > 0 ? `${transparent} transparent pixels` : 'Run normalization with background removal',
    });
    if (!input.allowEdgeTouch) {
      checks.push({
        id: 'margin',
        status: edgeOpaque === 0 ? 'pass' : 'warning',
        label: edgeOpaque === 0 ? 'Clear canvas margin' : 'Subject reaches canvas edge',
        detail: edgeOpaque === 0 ? 'Safe margin around the sprite' : `${edgeOpaque} opaque edge pixels`,
      });
    }
  }
  return checks;
}
