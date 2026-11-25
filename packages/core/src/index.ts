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

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------
export { CORE_VERSION, SCHEMA_VERSION } from './version';

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------
export { uid } from './id';

// ---------------------------------------------------------------------------
// document model (types v2)
// ---------------------------------------------------------------------------
export type {
  BlendMode,
  CellBuffer,
  Cel,
  Clip,
  ClipTag,
  DocumentSettings,
  Frame,
  Layer,
  LoopMode,
  Palette,
  Part,
  PartRect,
  Project,
  RGBA,
  TrashEntry,
  TrashItem,
} from './types/document';
export {
  CANVAS_MAX,
  CANVAS_MIN,
  ONION_MAX,
  TRASH_CAP,
} from './types/document';

export type { StyleCameraAngle, StyleFeedback, StyleLighting, StyleOutline, StylePaletteMode, StyleProfile, StyleReference } from './style-profile';
export {
  DEFAULT_STYLE_PROFILE,
  STYLE_CAMERA_ANGLES,
  STYLE_LIGHTING,
  STYLE_REFERENCE_MAX_PNG_BASE64,
  STYLE_REFERENCE_SIZES,
  STYLE_OUTLINES,
  STYLE_PALETTE_MODES,
  STYLE_FEEDBACK_CUE_MAX,
  STYLE_FEEDBACK_MAX_CUES,
  cloneStyleProfile,
  defaultStyleProfile,
  parseStyleProfile,
  styleProfilePromptTags,
} from './style-profile';
export type { StyleCheck, StyleCheckStatus } from './ai/style-validation';
export { validateStyleCandidate } from './ai/style-validation';
export { brainPlanSchema, brainPlanStepSchema, brainHexColor, type BrainPlanStep } from './ai/plan-schema';
export {
  REFERENCE_TARGET_SIZES,
  buildReferenceCandidate,
  buildReferencePrompt,
  isReferenceTargetSize,
} from './ai/reference-candidate';
export type { ReferenceCandidate, ReferenceCandidateInput } from './ai/reference-candidate';
export { hashBrief, renderMockReferenceCandidate } from './ai/reference-mock';

export type {
  SerializedCelV2,
  SerializedClipV2,
  SerializedFrameV2,
  SerializedLayerV2,
  SerializedPartV2,
  SerializedProjectV2,
  SerializedTagV2,
  SerializedTrashEntryV2,
  SerializedTrashItemV2,
} from './types/serialized';
export { isSerializedProjectV2 } from './types/serialized';

// ---------------------------------------------------------------------------
// commands & events
// ---------------------------------------------------------------------------
export type {
  AnyCommandDefinition,
  ApplyOutcome,
  ChangeEvent,
  ChangeListener,
  CommandContext,
  CommandDefinition,
  CommandOrigin,
  HistoryStepResult,
  PixelHistoryData,
  StrokeCommitResult,
  StrokeHandle,
  StrokeParams,
} from './types/commands';

export type { HistoryEntry, HistoryStats, TileDiff } from './types/history';

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------
export { CommandError } from './bus/errors';
export type { CommandErrorCode } from './bus/errors';

// ---------------------------------------------------------------------------
// factories & document access
// ---------------------------------------------------------------------------
export {
  DEFAULT_PALETTE,
  clampCanvasSize,
  cloneProject,
  createCel,
  createClip,
  createFrame,
  createLayer,
  createProject,
  duplicateFrame,
} from './doc/factory';
export {
  findClip,
  findFrame,
  findLayer,
  locateCel,
  mapClip,
  mapFrames,
  pushTrash,
  replaceCelBuffer,
  setCel,
  setCelEverywhere,
  takeTrash,
} from './doc/access';

// ---------------------------------------------------------------------------
// pixel ops (ported from the prototype) & tile diffs
// ---------------------------------------------------------------------------
export {
  clearBufferInPlace,
  drawLinePixels,
  drawRectPixels,
  floodFill,
  floodFillDither,
  getPixel,
  inBrushDisc,
  inBounds,
  moveBuffer,
  pixelPerfectStroke,
  beautifyLayer,
  stampBrush,
  stampCustomBuffer,
} from './pixels/ops';
export type { BrushShape, CustomBrush, PixelPerfectState } from './pixels/ops';
export {
  drawEllipsePixels,
  ellipseOutlinePoints,
  normalizeEllipseBox,
  type EllipsePoint,
} from './pixels/ellipse';
export {
  analyzePixelCraft,
  applyShadeBrush,
  applyShadeLine,
  collectUniqueOpaqueColors,
  computeCenterShift,
  computeTrimBounds,
  drawDitherGradientPixels,
  drawLineWrapped,
  drawPolygonPixels,
  magicWandBounds,
  polishLayerPixelArt,
  remapBufferToPalette,
  renderInspectionRgba,
  replaceColorInBuffer,
  shadePixelStep,
  sortPaletteColors,
  stampBrushWrapped,
  wrapCoord,
  type CenterShiftResult,
  type CraftDefect,
  type CraftPoint,
  type DitherGradientOptions,
  type InspectionScale,
  type MagicWandResult,
  type PaletteRemapMode,
  type PaletteSortBy,
  type PixelCraftInput,
  type PixelCraftReport,
  type PolishPixelArtOptions,
  type ShadeBrushOptions,
  type ShadeMode,
  type TrimBoundsResult,
} from './pixels/craft';
export {
  clampRect,
  clearRegionInPlace,
  extractRegion,
  flipRegionHInPlace,
  flipRegionVInPlace,
  pasteRegionInPlace,
  rotateRegionCCWInPlace,
  rotateRegionCWInPlace,
  scaleRegionInPlace,
  scaleRegionToInPlace,
  type PixelRect,
} from './pixels/region';
export {
  TILE_BYTES,
  TILE_PIXELS,
  TILE_SIZE,
  applyTileDiff,
  extractTileDiff,
  tileIndexAt,
  tilesPerColumn,
  tilesPerRow,
} from './pixels/tile';

// ---------------------------------------------------------------------------
// history engine
// ---------------------------------------------------------------------------
export {
  DEFAULT_HISTORY_BUDGET_BYTES,
  MAX_HISTORY_BUDGET_BYTES,
  MIN_HISTORY_BUDGET_BYTES,
  HistoryEngine,
  applyEntry,
  clampHistoryBudget,
  estimatePixelEntryBytes,
  estimateProjectStructureBytes,
  estimateStructureEntryBytes,
  makeCompositeEntry,
  makePixelEntry,
  makeStructureEntry,
} from './history/engine';

// ---------------------------------------------------------------------------
// command bus & built-in commands
// ---------------------------------------------------------------------------
export { CommandBus } from './bus/bus';
export type { CommandBusOptions } from './bus/bus';
export {
  clipAdd,
  clipDelete,
  clipSetProps,
  frameAdd,
  frameDelete,
  frameMove,
  frameSetDuration,
  layerAdd,
  layerDelete,
  layerDuplicate,
  layerMergeDown,
  layerMove,
  layerReorder,
  layerSetLinked,
  layerSetProps,
  paletteAddColor,
  paletteRemoveColor,
  projectRename,
  settingsSetOnion,
  trashPurge,
  trashRestore,
  blendChannel,
} from './bus/builtins';
export { applyPixelOpsCommand } from './bus/pixel-commands';
export type { ApplyPixelOpsPayload, PixelOp, PixelPoint } from './bus/pixel-commands';

// ---------------------------------------------------------------------------
// animation playback engine (Task 6): pure clock shared by the timeline and
// the preview overlay — per-frame durations, loop modes, scrubbing
// ---------------------------------------------------------------------------
export {
  PlaybackClock,
  buildPlaybackCycle,
  effectiveFrameMs,
  frameAtPosition,
  type ClockTick,
  type PlaybackCycle,
  type PlaybackEntry,
} from './anim/clock';

// ---------------------------------------------------------------------------
// export service (Task 7): deterministic PNG frames, sprite sheets, JSON
// animation metadata, atomic multi-file writes — zero DOM (v3.1 §7)
// ---------------------------------------------------------------------------
export {
  ExportError,
  EXPORT_METADATA_VERSION,
  buildAllArtifacts,
  buildAsepriteJson,
  buildAtlasAsepriteJson,
  buildClipMetadata,
  composeAtlasRgba,
  composeFrameRgba,
  composeSheetRgba,
  encodeExportPng,
  planExport,
  resolveAtlasLayout,
  resolveSheetLayout,
  sheetFrameOrigin,
  slugify,
  upscaleRgbaNearest,
  writeExportPlan,
  type AsepriteFrameRect,
  type AsepriteFrameTag,
  type AsepriteJson,
  type AtlasClipSpan,
  type AtlasFrameEntry,
  type AtlasLayout,
  type AtlasOptions,
  type ClipExportMetadata,
  type ExportErrorCode,
  type ExportFormat,
  type ExportPlan,
  type ExportRequest,
  type ExportScope,
  type PlannedArtifact,
  type SheetLayout,
  type SheetOptions,
  type WriteExportOptions,
  type WriteExportResult,
} from './export/export';

// ---------------------------------------------------------------------------
// v1 compatibility boundary (Task 3 implements the importer)
// ---------------------------------------------------------------------------
export {
  convertV1Loop,
  isSerializedProjectV1,
  mapV1Loop,
  v1ClipSkeleton,
  v2ProjectShell,
} from './compat/v1';
export type {
  CelSourceResolver,
  V1ImportResult,
  V1SerializedClip,
  V1SerializedFrame,
  V1SerializedLayer,
  V1SerializedProject,
  V1ToV2Importer,
} from './types/v1';

// ---------------------------------------------------------------------------
// AI generation system (Task 9): deterministic normalize v2 + OKLab palette
// math + the provider/generation contract shared by web route & desktop job
// runner — pure, DOM-free (v3.1 Plan §3, §8.3)
// ---------------------------------------------------------------------------
export {
  // oklab
  linearToSrgb,
  oklabDistance2,
  oklabToRgb,
  parseHexColor,
  rgbDistance2,
  rgbToOklab,
  srgbToLinear,
} from './ai/oklab';
export type { Oklab } from './ai/oklab';
export {
  // pipeline steps (pure + independently testable)
  applyAlphaThreshold,
  cleanupOutlineFringe,
  cleanupOutlineFringeWithColor,
  computeEdgeProfiles,
  despeckleIsolated,
  detectPixelGrid,
  dominantColorDownscale,
  fitBufferToCanvas,
  floodRemoveBackground,
  floodRemoveBackgroundWithColor,
  medianCutPalette,
  harvestPalette,
  nearestNeighborContain,
  normalizeV2,
  quantizeToPalette,
  removeEnclosedBgResidue,
  removeStrayComponents,
  sampleBorderColor,
  sampleBorderColorMedian,
  scaleSpriteWholeNumber,
  snapToDetectedGrid,
  trimContentBBox,
  DEFAULT_NORMALIZE2_OPTIONS,
} from './ai/normalize-v2';
export type {
  DetectedGrid,
  GridScaleMode,
  GridSnapStats,
  Normalize2Options,
  Normalize2Result,
  Normalize2Stats,
  PaletteMode,
  SnappedSprite,
  WholeNumberScaleResult,
} from './ai/normalize-v2';
export {
  // output quality report (Task 9 quality follow-up) — non-destructive checks
  analyzeSpriteQuality,
} from './ai/quality';
export type { QualityFinding } from './ai/quality';

// ---------------------------------------------------------------------------
// motion presets (Task 10, v3.1 §4.1/§4.1.1): deterministic composer, QA,
// part ownership, suggest helper — zero DOM
// ---------------------------------------------------------------------------
export {
  AMPLITUDE_MAX,
  AMPLITUDE_MIN,
  MOTION_PARAMS_DEFAULTS,
  rectContains,
  rectsIntersect,
  scaledOffset,
} from './motion/types';
export type {
  ComposedFrame,
  GapFillMode,
  MotionParams,
  MotionPlan,
  MotionPlanReport,
  MotionPresetId,
  MotionSkippedReason,
  MotionWarning,
  PartOffset,
  PresetCurves,
  PresetDef,
  SkippedPart,
} from './motion/types';
export {
  MOTION_PRESETS,
  PRESET_IDS,
  getPreset,
  resolveParams,
} from './motion/presets';
export { planMotion, roleKey, type PlanMotionOptions } from './motion/composer';
export {
  analyzeClipMotion,
  analyzeMotionPlan,
  diffChangedPixels,
  footContactIssues,
  QA_OPTIONS_DEFAULTS,
  type QAIssue,
  type QaOptions,
  type QALevel,
} from './motion/qa';
export { suggestMotionPreset, type MotionSuggestion } from './motion/suggest';
export type { MotionApplyPayload, PartSetPayload } from './bus/motion-commands';

// ---------------------------------------------------------------------------
// buffer utils
// ---------------------------------------------------------------------------
export { bufferEquals, cloneBuffer, isZeroBuffer } from './util/buffers';

// ---------------------------------------------------------------------------
// persistence (Task 3): .pixelforgeproj format, PNG codec, ZIP container,
// journal + crash recovery, atomic save, backups, v1→v2 importer
// ---------------------------------------------------------------------------
export {
  PersistError,
  type PersistErrorCode,
  type PersistIssue,
} from './persist/errors';
export { crc32 } from './persist/crc32';
export { base64Encode, base64Decode } from './persist/base64';
export { sha256Hex } from './persist/digest';
export {
  decodePng,
  encodePng,
  peekPngSize,
  type DecodedPng,
} from './persist/png';
export {
  assertSafeEntryName,
  zipRead,
  zipWrite,
  type ZipArchive,
  type ZipEntry,
} from './persist/zip';
export {
  celSrc,
  sharedCelSrc,
  trashCelSrc,
  trashClipCelSrc,
  isSafeId,
  assertSafeCelSrc,
  MANIFEST_ENTRY,
  PROJECT_ENTRY,
  JOURNAL_ENTRY,
} from './persist/paths';
export {
  validateSerializedProjectV2,
  validateSerializedProjectV2OrThrow,
} from './persist/schema';
export {
  projectFromSerialized,
  serializeProjectV2,
  type CelBytesProvider,
  type SerializedWithCels,
} from './persist/serialize';
export {
  FORMAT_VERSION,
  buildPixelforgeproj,
  readPixelforgeproj,
  type BuiltContainer,
  type BuildContainerOptions,
  type ManifestJson,
  type ReadContainerResult,
} from './persist/container';
export {
  JOURNAL_CAP,
  JournalRecorder,
  decodeJsonSafe,
  encodeJsonSafe,
  linesToRecords,
  recordsToLines,
  replayJournal,
  type JournalRecord,
  type JournalRecorderOptions,
  type ReplayResult,
} from './persist/journal';
export type { FileFs } from './persist/store';
export { MemoryFs } from './persist/memory-fs';
export {
  autosavePathFor,
  backupsDirFor,
  buildArchive,
  createBackup,
  inspectRecovery,
  journalPathFor,
  listBackups,
  loadPixelforgeproj,
  readEmbeddedJournal,
  rotateBackups,
  saveAutosave,
  savePixelforgeproj,
  tmpPathFor,
  type LoadOptions,
  type LoadResult,
  type RecoveryInfo,
  type SaveOptions,
  type SaveResult,
} from './persist/store';
export {
  pngDataUrlResolver,
  v1Importer,
  V1ProjectImporter,
} from './compat/import-v1';
