/**
 * Shared mock helper: snap a #rrggbb hex to the nearest palette entry
 * (weighted RGB distance, stable tie-break by palette order).
 */
export declare function snapToPaletteHex(hex: string, palette: string[]): string;
