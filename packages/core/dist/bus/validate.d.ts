/**
 * Hand-rolled payload validators (zero dependencies — zod stays in the MCP
 * package where the prototype already uses it, v3.1 §5.3).
 */
import type { LoopMode, RGBA } from '../types/document';
export declare function assertObject(payload: unknown, what: string): Record<string, unknown>;
export declare function getString(o: Record<string, unknown>, key: string, what: string): string;
export declare function getOptionalString(o: Record<string, unknown>, key: string, what: string): string | undefined;
export declare function getInt(o: Record<string, unknown>, key: string, what: string, min?: number, max?: number): number;
export declare function getOptionalInt(o: Record<string, unknown>, key: string, what: string, min?: number, max?: number): number | undefined;
export declare function getNumber(o: Record<string, unknown>, key: string, what: string): number;
export declare function getBool(o: Record<string, unknown>, key: string, what: string): boolean;
export declare function getOptionalBool(o: Record<string, unknown>, key: string, what: string): boolean | undefined;
export declare function getLoopMode(o: Record<string, unknown>, key: string, what: string): LoopMode;
export declare function getOptionalLoopMode(o: Record<string, unknown>, key: string, what: string): LoopMode | undefined;
export declare const HEX_RE: RegExp;
export declare function getHexColor(o: Record<string, unknown>, key: string, what: string): string;
export declare function getRgba(o: Record<string, unknown>, key: string, what: string): RGBA;
