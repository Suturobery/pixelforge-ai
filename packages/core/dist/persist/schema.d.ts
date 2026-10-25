/**
 * Deep structural validation of SerializedProjectV2 (v3.1 §6 / §13 "project
 * schema validation"). Read-path hardening: every structural invariant the
 * runtime model relies on is checked here so the deserializer can assume a
 * coherent document. Pure, synchronous, returns ALL issues (not just the
 * first) so corrupted-file reports are actionable in one pass.
 */
import type { SerializedProjectV2 } from '../types/serialized';
import { type PersistIssue } from './errors';
/** Validate the full document; throws PersistError('INVALID_SCHEMA') with all issues. */
export declare function validateSerializedProjectV2OrThrow(doc: unknown): asserts doc is SerializedProjectV2;
/** Validate and return every issue found (empty array = valid). */
export declare function validateSerializedProjectV2(doc: unknown): PersistIssue[];
