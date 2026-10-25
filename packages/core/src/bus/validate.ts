/**
 * Hand-rolled payload validators (zero dependencies — zod stays in the MCP
 * package where the prototype already uses it, v3.1 §5.3).
 */

import { fail } from './errors';
import type { LoopMode, RGBA } from '../types/document';

export function assertObject(payload: unknown, what: string): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail(`${what} must be an object`);
  }
  return payload as Record<string, unknown>;
}

export function getString(o: Record<string, unknown>, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) fail(`${what}: "${key}" must be a non-empty string`);
  return v;
}

export function getOptionalString(
  o: Record<string, unknown>, key: string, what: string
): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') fail(`${what}: "${key}" must be a string`);
  return v;
}

export function getInt(
  o: Record<string, unknown>, key: string, what: string, min?: number, max?: number
): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    fail(`${what}: "${key}" must be an integer`);
  }
  if (min !== undefined && v < min) fail(`${what}: "${key}" must be ≥ ${min}`);
  if (max !== undefined && v > max) fail(`${what}: "${key}" must be ≤ ${max}`);
  return v;
}

export function getOptionalInt(
  o: Record<string, unknown>, key: string, what: string, min?: number, max?: number
): number | undefined {
  if (o[key] === undefined) return undefined;
  return getInt(o, key, what, min, max);
}

export function getNumber(o: Record<string, unknown>, key: string, what: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${what}: "${key}" must be a number`);
  return v;
}

export function getBool(o: Record<string, unknown>, key: string, what: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') fail(`${what}: "${key}" must be a boolean`);
  return v;
}

export function getOptionalBool(
  o: Record<string, unknown>, key: string, what: string
): boolean | undefined {
  if (o[key] === undefined) return undefined;
  return getBool(o, key, what);
}

const LOOP_MODES: readonly LoopMode[] = ['forward', 'reverse', 'pingpong'];

export function getLoopMode(o: Record<string, unknown>, key: string, what: string): LoopMode {
  const v = o[key];
  if (typeof v !== 'string' || !LOOP_MODES.includes(v as LoopMode)) {
    fail(`${what}: "${key}" must be one of ${LOOP_MODES.join(' | ')}`);
  }
  return v as LoopMode;
}

export function getOptionalLoopMode(
  o: Record<string, unknown>, key: string, what: string
): LoopMode | undefined {
  if (o[key] === undefined) return undefined;
  return getLoopMode(o, key, what);
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function getHexColor(o: Record<string, unknown>, key: string, what: string): string {
  const v = getString(o, key, what);
  if (!HEX_RE.test(v)) fail(`${what}: "${key}" must be a hex color like #rrggbb`);
  return v.toLowerCase();
}

export function getRgba(o: Record<string, unknown>, key: string, what: string): RGBA {
  const v = o[key];
  if (!Array.isArray(v) || v.length !== 4) fail(`${what}: "${key}" must be [r,g,b,a]`);
  const out: RGBA = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const n = v[i];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 255) {
      fail(`${what}: "${key}" channels must be numbers 0–255`);
    }
    out[i] = Math.round(n);
  }
  return out;
}
