/**
 * Persistence barrel — the complete Task 3 file-format API surface.
 * Re-exported by the package root (src/index.ts).
 */

export * from './errors';
export * from './crc32';
export * from './base64';
export * from './digest';
export * from './png';
export * from './zip';
export * from './paths';
export * from './schema';
export * from './serialize';
export * from './container';
export * from './journal';
export type { FileFs } from './store';
export { MemoryFs } from './memory-fs';
export * from './store';
