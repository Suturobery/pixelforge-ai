/**
 * @pixelforge/core — pure, framework-free editor core (v3.1 Plan §8.3).
 *
 * Owns: document model v2 (per-clip layer stacks + per-frame cels, linked
 * cels, parts, trash), the CommandBus (single mutation path for UI/AI/MCP),
 * 16×16 tile-diff history with a memory budget, ported pixel ops, and the
 * v1 compatibility boundary.
 *
 * Everything in this package MUST stay DOM-free so it runs identically in
 * Electron main, workers, and unit tests (§12 Task 2). React/Electron/DOM
 * integration lives in apps/desktop and the renderer (Task 4).
 */
export { CORE_VERSION, SCHEMA_VERSION } from './version';
export { uid } from './id';
export type { CellBuffer, Cel, Clip, ClipTag, DocumentSettings, Frame, Layer, LoopMode, Palette, Part, PartRect, Project, RGBA, TrashEntry, TrashItem, } from './types/document';
export { CANVAS_MAX, CANVAS_MIN, ONION_MAX, TRASH_CAP, } from './types/document';
export type { SerializedCelV2, SerializedClipV2, SerializedFrameV2, SerializedLayerV2, SerializedPartV2, SerializedProjectV2, SerializedTagV2, SerializedTrashEntryV2, SerializedTrashItemV2, } from './types/serialized';
export { isSerializedProjectV2 } from './types/serialized';
export type { AnyCommandDefinition, ApplyOutcome, ChangeEvent, ChangeListener, CommandContext, CommandDefinition, CommandOrigin, HistoryStepResult, PixelHistoryData, StrokeCommitResult, StrokeHandle, StrokeParams, } from './types/commands';
export type { HistoryEntry, HistoryStats, TileDiff } from './types/history';
export { CommandError } from './bus/errors';
export type { CommandErrorCode } from './bus/errors';
export { DEFAULT_PALETTE, clampCanvasSize, cloneProject, createCel, createClip, createFrame, createLayer, createProject, duplicateFrame, } from './doc/factory';
export { findClip, findFrame, findLayer, locateCel, mapClip, mapFrames, pushTrash, replaceCelBuffer, setCel, setCelEverywhere, takeTrash, } from './doc/access';
export { clearBufferInPlace, drawLinePixels, drawRectPixels, floodFill, getPixel, inBounds, moveBuffer, stampBrush, } from './pixels/ops';
export { drawEllipsePixels, ellipseOutlinePoints, normalizeEllipseBox, type EllipsePoint, } from './pixels/ellipse';
export { clampRect, clearRegionInPlace, extractRegion, flipRegionHInPlace, flipRegionVInPlace, pasteRegionInPlace, rotateRegionCCWInPlace, rotateRegionCWInPlace, type PixelRect, } from './pixels/region';
export { TILE_BYTES, TILE_PIXELS, TILE_SIZE, applyTileDiff, extractTileDiff, tileIndexAt, tilesPerColumn, tilesPerRow, } from './pixels/tile';
export { DEFAULT_HISTORY_BUDGET_BYTES, MAX_HISTORY_BUDGET_BYTES, MIN_HISTORY_BUDGET_BYTES, HistoryEngine, applyEntry, clampHistoryBudget, estimatePixelEntryBytes, estimateProjectStructureBytes, estimateStructureEntryBytes, makeCompositeEntry, makePixelEntry, makeStructureEntry, } from './history/engine';
export { CommandBus } from './bus/bus';
export type { CommandBusOptions } from './bus/bus';
export { clipAdd, clipDelete, clipSetProps, frameAdd, frameDelete, frameMove, frameSetDuration, layerAdd, layerDelete, layerDuplicate, layerMergeDown, layerMove, layerSetLinked, layerSetProps, paletteAddColor, paletteRemoveColor, projectRename, settingsSetOnion, trashPurge, trashRestore, } from './bus/builtins';
export { applyPixelOpsCommand } from './bus/pixel-commands';
export type { ApplyPixelOpsPayload, PixelOp, PixelPoint } from './bus/pixel-commands';
export { PlaybackClock, buildPlaybackCycle, effectiveFrameMs, frameAtPosition, type ClockTick, type PlaybackCycle, type PlaybackEntry, } from './anim/clock';
export { ExportError, EXPORT_METADATA_VERSION, buildAllArtifacts, buildClipMetadata, composeFrameRgba, composeSheetRgba, encodeExportPng, planExport, resolveSheetLayout, sheetFrameOrigin, slugify, writeExportPlan, type ClipExportMetadata, type ExportErrorCode, type ExportFormat, type ExportPlan, type ExportRequest, type ExportScope, type PlannedArtifact, type SheetLayout, type SheetOptions, type WriteExportOptions, type WriteExportResult, } from './export/export';
export { convertV1Loop, isSerializedProjectV1, mapV1Loop, v1ClipSkeleton, v2ProjectShell, } from './compat/v1';
export type { CelSourceResolver, V1ImportResult, V1SerializedClip, V1SerializedFrame, V1SerializedLayer, V1SerializedProject, V1ToV2Importer, } from './types/v1';
export { bufferEquals, cloneBuffer, isZeroBuffer } from './util/buffers';
export { PersistError, type PersistErrorCode, type PersistIssue, } from './persist/errors';
export { crc32 } from './persist/crc32';
export { base64Encode, base64Decode } from './persist/base64';
export { sha256Hex } from './persist/digest';
export { decodePng, encodePng, peekPngSize, type DecodedPng, } from './persist/png';
export { assertSafeEntryName, zipRead, zipWrite, type ZipArchive, type ZipEntry, } from './persist/zip';
export { celSrc, sharedCelSrc, trashCelSrc, trashClipCelSrc, isSafeId, assertSafeCelSrc, MANIFEST_ENTRY, PROJECT_ENTRY, JOURNAL_ENTRY, } from './persist/paths';
export { validateSerializedProjectV2, validateSerializedProjectV2OrThrow, } from './persist/schema';
export { projectFromSerialized, serializeProjectV2, type CelBytesProvider, type SerializedWithCels, } from './persist/serialize';
export { FORMAT_VERSION, buildPixelforgeproj, readPixelforgeproj, type BuiltContainer, type BuildContainerOptions, type ManifestJson, type ReadContainerResult, } from './persist/container';
export { JOURNAL_CAP, JournalRecorder, decodeJsonSafe, encodeJsonSafe, linesToRecords, recordsToLines, replayJournal, type JournalRecord, type JournalRecorderOptions, type ReplayResult, } from './persist/journal';
export type { FileFs } from './persist/store';
export { MemoryFs } from './persist/memory-fs';
export { autosavePathFor, backupsDirFor, buildArchive, createBackup, inspectRecovery, journalPathFor, listBackups, loadPixelforgeproj, readEmbeddedJournal, rotateBackups, saveAutosave, savePixelforgeproj, tmpPathFor, type LoadOptions, type LoadResult, type RecoveryInfo, type SaveOptions, type SaveResult, } from './persist/store';
export { pngDataUrlResolver, v1Importer, V1ProjectImporter, } from './compat/import-v1';
