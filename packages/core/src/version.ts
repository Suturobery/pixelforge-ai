/** Version of the @pixelforge/core package. */
export const CORE_VERSION = '0.3.0' as const;

/**
 * Serialized project schema version targeted by this build (v3.1 §6):
 * v2 = per-clip layer stack + per-frame cel objects + parts + trash.
 * v1 documents are read via the compat boundary (Task 3 importer).
 */
export const SCHEMA_VERSION = 2 as const;
