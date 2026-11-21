import type { StyleProfile } from '../style-profile';
export type StyleCheckStatus = 'pass' | 'warning' | 'info';
export interface StyleCheck {
    id: 'size' | 'palette' | 'alpha' | 'background' | 'margin';
    status: StyleCheckStatus;
    label: string;
    detail: string;
}
/**
 * Honest, deterministic post-normalization checks. This validates technical
 * pipeline constraints only; it intentionally does not claim to score an
 * image's artistic quality or semantic correctness.
 */
export declare function validateStyleCandidate(input: {
    buffer: Uint8ClampedArray;
    width: number;
    height: number;
    targetWidth: number;
    targetHeight: number;
    palette: string[];
    profile?: StyleProfile;
    allowEdgeTouch?: boolean;
}): StyleCheck[];
