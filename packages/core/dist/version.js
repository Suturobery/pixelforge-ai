"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCHEMA_VERSION = exports.CORE_VERSION = void 0;
/** Version of the @pixelforge/core package. */
exports.CORE_VERSION = '0.2.0';
/**
 * Serialized project schema version targeted by this build (v3.1 §6):
 * v2 = per-clip layer stack + per-frame cel objects + parts + trash.
 * v1 documents are read via the compat boundary (Task 3 importer).
 */
exports.SCHEMA_VERSION = 2;
