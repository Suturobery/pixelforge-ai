"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.setCel = exports.replaceCelBuffer = exports.pushTrash = exports.mapFrames = exports.mapClip = exports.locateCel = exports.findLayer = exports.findFrame = exports.findClip = exports.duplicateFrame = exports.createProject = exports.createLayer = exports.createFrame = exports.createClip = exports.createCel = exports.cloneProject = exports.clampCanvasSize = exports.DEFAULT_PALETTE = exports.CommandError = exports.isSerializedProjectV2 = exports.renderMockReferenceCandidate = exports.hashBrief = exports.isReferenceTargetSize = exports.buildReferencePrompt = exports.buildReferenceCandidate = exports.REFERENCE_TARGET_SIZES = exports.brainHexColor = exports.brainPlanStepSchema = exports.brainPlanSchema = exports.validateStyleCandidate = exports.styleProfilePromptTags = exports.parseStyleProfile = exports.defaultStyleProfile = exports.cloneStyleProfile = exports.STYLE_FEEDBACK_MAX_CUES = exports.STYLE_FEEDBACK_CUE_MAX = exports.STYLE_PALETTE_MODES = exports.STYLE_OUTLINES = exports.STYLE_REFERENCE_SIZES = exports.STYLE_REFERENCE_MAX_PNG_BASE64 = exports.STYLE_LIGHTING = exports.STYLE_CAMERA_ANGLES = exports.DEFAULT_STYLE_PROFILE = exports.TRASH_CAP = exports.ONION_MAX = exports.CANVAS_MIN = exports.CANVAS_MAX = exports.uid = exports.SCHEMA_VERSION = exports.CORE_VERSION = void 0;
exports.clipAdd = exports.CommandBus = exports.makeStructureEntry = exports.makePixelEntry = exports.makeCompositeEntry = exports.estimateStructureEntryBytes = exports.estimateProjectStructureBytes = exports.estimatePixelEntryBytes = exports.clampHistoryBudget = exports.applyEntry = exports.HistoryEngine = exports.MIN_HISTORY_BUDGET_BYTES = exports.MAX_HISTORY_BUDGET_BYTES = exports.DEFAULT_HISTORY_BUDGET_BYTES = exports.tilesPerRow = exports.tilesPerColumn = exports.tileIndexAt = exports.extractTileDiff = exports.applyTileDiff = exports.TILE_SIZE = exports.TILE_PIXELS = exports.TILE_BYTES = exports.scaleRegionToInPlace = exports.scaleRegionInPlace = exports.rotateRegionCWInPlace = exports.rotateRegionCCWInPlace = exports.pasteRegionInPlace = exports.flipRegionVInPlace = exports.flipRegionHInPlace = exports.extractRegion = exports.clearRegionInPlace = exports.clampRect = exports.normalizeEllipseBox = exports.ellipseOutlinePoints = exports.drawEllipsePixels = exports.stampCustomBuffer = exports.stampBrush = exports.beautifyLayer = exports.pixelPerfectStroke = exports.moveBuffer = exports.inBounds = exports.inBrushDisc = exports.getPixel = exports.floodFillDither = exports.floodFill = exports.drawRectPixels = exports.drawLinePixels = exports.clearBufferInPlace = exports.takeTrash = exports.setCelEverywhere = void 0;
exports.srgbToLinear = exports.rgbToOklab = exports.rgbDistance2 = exports.parseHexColor = exports.oklabToRgb = exports.oklabDistance2 = exports.linearToSrgb = exports.v2ProjectShell = exports.v1ClipSkeleton = exports.mapV1Loop = exports.isSerializedProjectV1 = exports.convertV1Loop = exports.writeExportPlan = exports.slugify = exports.sheetFrameOrigin = exports.resolveSheetLayout = exports.planExport = exports.encodeExportPng = exports.composeSheetRgba = exports.composeFrameRgba = exports.buildClipMetadata = exports.buildAllArtifacts = exports.EXPORT_METADATA_VERSION = exports.ExportError = exports.frameAtPosition = exports.effectiveFrameMs = exports.buildPlaybackCycle = exports.PlaybackClock = exports.applyPixelOpsCommand = exports.blendChannel = exports.trashRestore = exports.trashPurge = exports.settingsSetOnion = exports.projectRename = exports.paletteRemoveColor = exports.paletteAddColor = exports.layerSetProps = exports.layerSetLinked = exports.layerReorder = exports.layerMove = exports.layerMergeDown = exports.layerDuplicate = exports.layerDelete = exports.layerAdd = exports.frameSetDuration = exports.frameMove = exports.frameDelete = exports.frameAdd = exports.clipSetProps = exports.clipDelete = void 0;
exports.sha256Hex = exports.base64Decode = exports.base64Encode = exports.crc32 = exports.PersistError = exports.isZeroBuffer = exports.cloneBuffer = exports.bufferEquals = exports.suggestMotionPreset = exports.QA_OPTIONS_DEFAULTS = exports.footContactIssues = exports.diffChangedPixels = exports.analyzeMotionPlan = exports.analyzeClipMotion = exports.roleKey = exports.planMotion = exports.resolveParams = exports.getPreset = exports.PRESET_IDS = exports.MOTION_PRESETS = exports.scaledOffset = exports.rectsIntersect = exports.rectContains = exports.MOTION_PARAMS_DEFAULTS = exports.AMPLITUDE_MIN = exports.AMPLITUDE_MAX = exports.analyzeSpriteQuality = exports.DEFAULT_NORMALIZE2_OPTIONS = exports.trimContentBBox = exports.snapToDetectedGrid = exports.scaleSpriteWholeNumber = exports.sampleBorderColorMedian = exports.sampleBorderColor = exports.removeStrayComponents = exports.removeEnclosedBgResidue = exports.quantizeToPalette = exports.normalizeV2 = exports.nearestNeighborContain = exports.harvestPalette = exports.medianCutPalette = exports.floodRemoveBackgroundWithColor = exports.floodRemoveBackground = exports.fitBufferToCanvas = exports.dominantColorDownscale = exports.detectPixelGrid = exports.despeckleIsolated = exports.computeEdgeProfiles = exports.cleanupOutlineFringeWithColor = exports.cleanupOutlineFringe = exports.applyAlphaThreshold = void 0;
exports.V1ProjectImporter = exports.v1Importer = exports.pngDataUrlResolver = exports.tmpPathFor = exports.savePixelforgeproj = exports.saveAutosave = exports.rotateBackups = exports.readEmbeddedJournal = exports.loadPixelforgeproj = exports.listBackups = exports.journalPathFor = exports.inspectRecovery = exports.createBackup = exports.buildArchive = exports.backupsDirFor = exports.autosavePathFor = exports.MemoryFs = exports.replayJournal = exports.recordsToLines = exports.linesToRecords = exports.encodeJsonSafe = exports.decodeJsonSafe = exports.JournalRecorder = exports.JOURNAL_CAP = exports.readPixelforgeproj = exports.buildPixelforgeproj = exports.FORMAT_VERSION = exports.serializeProjectV2 = exports.projectFromSerialized = exports.validateSerializedProjectV2OrThrow = exports.validateSerializedProjectV2 = exports.JOURNAL_ENTRY = exports.PROJECT_ENTRY = exports.MANIFEST_ENTRY = exports.assertSafeCelSrc = exports.isSafeId = exports.trashClipCelSrc = exports.trashCelSrc = exports.sharedCelSrc = exports.celSrc = exports.zipWrite = exports.zipRead = exports.assertSafeEntryName = exports.peekPngSize = exports.encodePng = exports.decodePng = void 0;
// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------
var version_1 = require("./version");
Object.defineProperty(exports, "CORE_VERSION", { enumerable: true, get: function () { return version_1.CORE_VERSION; } });
Object.defineProperty(exports, "SCHEMA_VERSION", { enumerable: true, get: function () { return version_1.SCHEMA_VERSION; } });
// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------
var id_1 = require("./id");
Object.defineProperty(exports, "uid", { enumerable: true, get: function () { return id_1.uid; } });
var document_1 = require("./types/document");
Object.defineProperty(exports, "CANVAS_MAX", { enumerable: true, get: function () { return document_1.CANVAS_MAX; } });
Object.defineProperty(exports, "CANVAS_MIN", { enumerable: true, get: function () { return document_1.CANVAS_MIN; } });
Object.defineProperty(exports, "ONION_MAX", { enumerable: true, get: function () { return document_1.ONION_MAX; } });
Object.defineProperty(exports, "TRASH_CAP", { enumerable: true, get: function () { return document_1.TRASH_CAP; } });
var style_profile_1 = require("./style-profile");
Object.defineProperty(exports, "DEFAULT_STYLE_PROFILE", { enumerable: true, get: function () { return style_profile_1.DEFAULT_STYLE_PROFILE; } });
Object.defineProperty(exports, "STYLE_CAMERA_ANGLES", { enumerable: true, get: function () { return style_profile_1.STYLE_CAMERA_ANGLES; } });
Object.defineProperty(exports, "STYLE_LIGHTING", { enumerable: true, get: function () { return style_profile_1.STYLE_LIGHTING; } });
Object.defineProperty(exports, "STYLE_REFERENCE_MAX_PNG_BASE64", { enumerable: true, get: function () { return style_profile_1.STYLE_REFERENCE_MAX_PNG_BASE64; } });
Object.defineProperty(exports, "STYLE_REFERENCE_SIZES", { enumerable: true, get: function () { return style_profile_1.STYLE_REFERENCE_SIZES; } });
Object.defineProperty(exports, "STYLE_OUTLINES", { enumerable: true, get: function () { return style_profile_1.STYLE_OUTLINES; } });
Object.defineProperty(exports, "STYLE_PALETTE_MODES", { enumerable: true, get: function () { return style_profile_1.STYLE_PALETTE_MODES; } });
Object.defineProperty(exports, "STYLE_FEEDBACK_CUE_MAX", { enumerable: true, get: function () { return style_profile_1.STYLE_FEEDBACK_CUE_MAX; } });
Object.defineProperty(exports, "STYLE_FEEDBACK_MAX_CUES", { enumerable: true, get: function () { return style_profile_1.STYLE_FEEDBACK_MAX_CUES; } });
Object.defineProperty(exports, "cloneStyleProfile", { enumerable: true, get: function () { return style_profile_1.cloneStyleProfile; } });
Object.defineProperty(exports, "defaultStyleProfile", { enumerable: true, get: function () { return style_profile_1.defaultStyleProfile; } });
Object.defineProperty(exports, "parseStyleProfile", { enumerable: true, get: function () { return style_profile_1.parseStyleProfile; } });
Object.defineProperty(exports, "styleProfilePromptTags", { enumerable: true, get: function () { return style_profile_1.styleProfilePromptTags; } });
var style_validation_1 = require("./ai/style-validation");
Object.defineProperty(exports, "validateStyleCandidate", { enumerable: true, get: function () { return style_validation_1.validateStyleCandidate; } });
var plan_schema_1 = require("./ai/plan-schema");
Object.defineProperty(exports, "brainPlanSchema", { enumerable: true, get: function () { return plan_schema_1.brainPlanSchema; } });
Object.defineProperty(exports, "brainPlanStepSchema", { enumerable: true, get: function () { return plan_schema_1.brainPlanStepSchema; } });
Object.defineProperty(exports, "brainHexColor", { enumerable: true, get: function () { return plan_schema_1.brainHexColor; } });
var reference_candidate_1 = require("./ai/reference-candidate");
Object.defineProperty(exports, "REFERENCE_TARGET_SIZES", { enumerable: true, get: function () { return reference_candidate_1.REFERENCE_TARGET_SIZES; } });
Object.defineProperty(exports, "buildReferenceCandidate", { enumerable: true, get: function () { return reference_candidate_1.buildReferenceCandidate; } });
Object.defineProperty(exports, "buildReferencePrompt", { enumerable: true, get: function () { return reference_candidate_1.buildReferencePrompt; } });
Object.defineProperty(exports, "isReferenceTargetSize", { enumerable: true, get: function () { return reference_candidate_1.isReferenceTargetSize; } });
var reference_mock_1 = require("./ai/reference-mock");
Object.defineProperty(exports, "hashBrief", { enumerable: true, get: function () { return reference_mock_1.hashBrief; } });
Object.defineProperty(exports, "renderMockReferenceCandidate", { enumerable: true, get: function () { return reference_mock_1.renderMockReferenceCandidate; } });
var serialized_1 = require("./types/serialized");
Object.defineProperty(exports, "isSerializedProjectV2", { enumerable: true, get: function () { return serialized_1.isSerializedProjectV2; } });
// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------
var errors_1 = require("./bus/errors");
Object.defineProperty(exports, "CommandError", { enumerable: true, get: function () { return errors_1.CommandError; } });
// ---------------------------------------------------------------------------
// factories & document access
// ---------------------------------------------------------------------------
var factory_1 = require("./doc/factory");
Object.defineProperty(exports, "DEFAULT_PALETTE", { enumerable: true, get: function () { return factory_1.DEFAULT_PALETTE; } });
Object.defineProperty(exports, "clampCanvasSize", { enumerable: true, get: function () { return factory_1.clampCanvasSize; } });
Object.defineProperty(exports, "cloneProject", { enumerable: true, get: function () { return factory_1.cloneProject; } });
Object.defineProperty(exports, "createCel", { enumerable: true, get: function () { return factory_1.createCel; } });
Object.defineProperty(exports, "createClip", { enumerable: true, get: function () { return factory_1.createClip; } });
Object.defineProperty(exports, "createFrame", { enumerable: true, get: function () { return factory_1.createFrame; } });
Object.defineProperty(exports, "createLayer", { enumerable: true, get: function () { return factory_1.createLayer; } });
Object.defineProperty(exports, "createProject", { enumerable: true, get: function () { return factory_1.createProject; } });
Object.defineProperty(exports, "duplicateFrame", { enumerable: true, get: function () { return factory_1.duplicateFrame; } });
var access_1 = require("./doc/access");
Object.defineProperty(exports, "findClip", { enumerable: true, get: function () { return access_1.findClip; } });
Object.defineProperty(exports, "findFrame", { enumerable: true, get: function () { return access_1.findFrame; } });
Object.defineProperty(exports, "findLayer", { enumerable: true, get: function () { return access_1.findLayer; } });
Object.defineProperty(exports, "locateCel", { enumerable: true, get: function () { return access_1.locateCel; } });
Object.defineProperty(exports, "mapClip", { enumerable: true, get: function () { return access_1.mapClip; } });
Object.defineProperty(exports, "mapFrames", { enumerable: true, get: function () { return access_1.mapFrames; } });
Object.defineProperty(exports, "pushTrash", { enumerable: true, get: function () { return access_1.pushTrash; } });
Object.defineProperty(exports, "replaceCelBuffer", { enumerable: true, get: function () { return access_1.replaceCelBuffer; } });
Object.defineProperty(exports, "setCel", { enumerable: true, get: function () { return access_1.setCel; } });
Object.defineProperty(exports, "setCelEverywhere", { enumerable: true, get: function () { return access_1.setCelEverywhere; } });
Object.defineProperty(exports, "takeTrash", { enumerable: true, get: function () { return access_1.takeTrash; } });
// ---------------------------------------------------------------------------
// pixel ops (ported from the prototype) & tile diffs
// ---------------------------------------------------------------------------
var ops_1 = require("./pixels/ops");
Object.defineProperty(exports, "clearBufferInPlace", { enumerable: true, get: function () { return ops_1.clearBufferInPlace; } });
Object.defineProperty(exports, "drawLinePixels", { enumerable: true, get: function () { return ops_1.drawLinePixels; } });
Object.defineProperty(exports, "drawRectPixels", { enumerable: true, get: function () { return ops_1.drawRectPixels; } });
Object.defineProperty(exports, "floodFill", { enumerable: true, get: function () { return ops_1.floodFill; } });
Object.defineProperty(exports, "floodFillDither", { enumerable: true, get: function () { return ops_1.floodFillDither; } });
Object.defineProperty(exports, "getPixel", { enumerable: true, get: function () { return ops_1.getPixel; } });
Object.defineProperty(exports, "inBrushDisc", { enumerable: true, get: function () { return ops_1.inBrushDisc; } });
Object.defineProperty(exports, "inBounds", { enumerable: true, get: function () { return ops_1.inBounds; } });
Object.defineProperty(exports, "moveBuffer", { enumerable: true, get: function () { return ops_1.moveBuffer; } });
Object.defineProperty(exports, "pixelPerfectStroke", { enumerable: true, get: function () { return ops_1.pixelPerfectStroke; } });
Object.defineProperty(exports, "beautifyLayer", { enumerable: true, get: function () { return ops_1.beautifyLayer; } });
Object.defineProperty(exports, "stampBrush", { enumerable: true, get: function () { return ops_1.stampBrush; } });
Object.defineProperty(exports, "stampCustomBuffer", { enumerable: true, get: function () { return ops_1.stampCustomBuffer; } });
var ellipse_1 = require("./pixels/ellipse");
Object.defineProperty(exports, "drawEllipsePixels", { enumerable: true, get: function () { return ellipse_1.drawEllipsePixels; } });
Object.defineProperty(exports, "ellipseOutlinePoints", { enumerable: true, get: function () { return ellipse_1.ellipseOutlinePoints; } });
Object.defineProperty(exports, "normalizeEllipseBox", { enumerable: true, get: function () { return ellipse_1.normalizeEllipseBox; } });
var region_1 = require("./pixels/region");
Object.defineProperty(exports, "clampRect", { enumerable: true, get: function () { return region_1.clampRect; } });
Object.defineProperty(exports, "clearRegionInPlace", { enumerable: true, get: function () { return region_1.clearRegionInPlace; } });
Object.defineProperty(exports, "extractRegion", { enumerable: true, get: function () { return region_1.extractRegion; } });
Object.defineProperty(exports, "flipRegionHInPlace", { enumerable: true, get: function () { return region_1.flipRegionHInPlace; } });
Object.defineProperty(exports, "flipRegionVInPlace", { enumerable: true, get: function () { return region_1.flipRegionVInPlace; } });
Object.defineProperty(exports, "pasteRegionInPlace", { enumerable: true, get: function () { return region_1.pasteRegionInPlace; } });
Object.defineProperty(exports, "rotateRegionCCWInPlace", { enumerable: true, get: function () { return region_1.rotateRegionCCWInPlace; } });
Object.defineProperty(exports, "rotateRegionCWInPlace", { enumerable: true, get: function () { return region_1.rotateRegionCWInPlace; } });
Object.defineProperty(exports, "scaleRegionInPlace", { enumerable: true, get: function () { return region_1.scaleRegionInPlace; } });
Object.defineProperty(exports, "scaleRegionToInPlace", { enumerable: true, get: function () { return region_1.scaleRegionToInPlace; } });
var tile_1 = require("./pixels/tile");
Object.defineProperty(exports, "TILE_BYTES", { enumerable: true, get: function () { return tile_1.TILE_BYTES; } });
Object.defineProperty(exports, "TILE_PIXELS", { enumerable: true, get: function () { return tile_1.TILE_PIXELS; } });
Object.defineProperty(exports, "TILE_SIZE", { enumerable: true, get: function () { return tile_1.TILE_SIZE; } });
Object.defineProperty(exports, "applyTileDiff", { enumerable: true, get: function () { return tile_1.applyTileDiff; } });
Object.defineProperty(exports, "extractTileDiff", { enumerable: true, get: function () { return tile_1.extractTileDiff; } });
Object.defineProperty(exports, "tileIndexAt", { enumerable: true, get: function () { return tile_1.tileIndexAt; } });
Object.defineProperty(exports, "tilesPerColumn", { enumerable: true, get: function () { return tile_1.tilesPerColumn; } });
Object.defineProperty(exports, "tilesPerRow", { enumerable: true, get: function () { return tile_1.tilesPerRow; } });
// ---------------------------------------------------------------------------
// history engine
// ---------------------------------------------------------------------------
var engine_1 = require("./history/engine");
Object.defineProperty(exports, "DEFAULT_HISTORY_BUDGET_BYTES", { enumerable: true, get: function () { return engine_1.DEFAULT_HISTORY_BUDGET_BYTES; } });
Object.defineProperty(exports, "MAX_HISTORY_BUDGET_BYTES", { enumerable: true, get: function () { return engine_1.MAX_HISTORY_BUDGET_BYTES; } });
Object.defineProperty(exports, "MIN_HISTORY_BUDGET_BYTES", { enumerable: true, get: function () { return engine_1.MIN_HISTORY_BUDGET_BYTES; } });
Object.defineProperty(exports, "HistoryEngine", { enumerable: true, get: function () { return engine_1.HistoryEngine; } });
Object.defineProperty(exports, "applyEntry", { enumerable: true, get: function () { return engine_1.applyEntry; } });
Object.defineProperty(exports, "clampHistoryBudget", { enumerable: true, get: function () { return engine_1.clampHistoryBudget; } });
Object.defineProperty(exports, "estimatePixelEntryBytes", { enumerable: true, get: function () { return engine_1.estimatePixelEntryBytes; } });
Object.defineProperty(exports, "estimateProjectStructureBytes", { enumerable: true, get: function () { return engine_1.estimateProjectStructureBytes; } });
Object.defineProperty(exports, "estimateStructureEntryBytes", { enumerable: true, get: function () { return engine_1.estimateStructureEntryBytes; } });
Object.defineProperty(exports, "makeCompositeEntry", { enumerable: true, get: function () { return engine_1.makeCompositeEntry; } });
Object.defineProperty(exports, "makePixelEntry", { enumerable: true, get: function () { return engine_1.makePixelEntry; } });
Object.defineProperty(exports, "makeStructureEntry", { enumerable: true, get: function () { return engine_1.makeStructureEntry; } });
// ---------------------------------------------------------------------------
// command bus & built-in commands
// ---------------------------------------------------------------------------
var bus_1 = require("./bus/bus");
Object.defineProperty(exports, "CommandBus", { enumerable: true, get: function () { return bus_1.CommandBus; } });
var builtins_1 = require("./bus/builtins");
Object.defineProperty(exports, "clipAdd", { enumerable: true, get: function () { return builtins_1.clipAdd; } });
Object.defineProperty(exports, "clipDelete", { enumerable: true, get: function () { return builtins_1.clipDelete; } });
Object.defineProperty(exports, "clipSetProps", { enumerable: true, get: function () { return builtins_1.clipSetProps; } });
Object.defineProperty(exports, "frameAdd", { enumerable: true, get: function () { return builtins_1.frameAdd; } });
Object.defineProperty(exports, "frameDelete", { enumerable: true, get: function () { return builtins_1.frameDelete; } });
Object.defineProperty(exports, "frameMove", { enumerable: true, get: function () { return builtins_1.frameMove; } });
Object.defineProperty(exports, "frameSetDuration", { enumerable: true, get: function () { return builtins_1.frameSetDuration; } });
Object.defineProperty(exports, "layerAdd", { enumerable: true, get: function () { return builtins_1.layerAdd; } });
Object.defineProperty(exports, "layerDelete", { enumerable: true, get: function () { return builtins_1.layerDelete; } });
Object.defineProperty(exports, "layerDuplicate", { enumerable: true, get: function () { return builtins_1.layerDuplicate; } });
Object.defineProperty(exports, "layerMergeDown", { enumerable: true, get: function () { return builtins_1.layerMergeDown; } });
Object.defineProperty(exports, "layerMove", { enumerable: true, get: function () { return builtins_1.layerMove; } });
Object.defineProperty(exports, "layerReorder", { enumerable: true, get: function () { return builtins_1.layerReorder; } });
Object.defineProperty(exports, "layerSetLinked", { enumerable: true, get: function () { return builtins_1.layerSetLinked; } });
Object.defineProperty(exports, "layerSetProps", { enumerable: true, get: function () { return builtins_1.layerSetProps; } });
Object.defineProperty(exports, "paletteAddColor", { enumerable: true, get: function () { return builtins_1.paletteAddColor; } });
Object.defineProperty(exports, "paletteRemoveColor", { enumerable: true, get: function () { return builtins_1.paletteRemoveColor; } });
Object.defineProperty(exports, "projectRename", { enumerable: true, get: function () { return builtins_1.projectRename; } });
Object.defineProperty(exports, "settingsSetOnion", { enumerable: true, get: function () { return builtins_1.settingsSetOnion; } });
Object.defineProperty(exports, "trashPurge", { enumerable: true, get: function () { return builtins_1.trashPurge; } });
Object.defineProperty(exports, "trashRestore", { enumerable: true, get: function () { return builtins_1.trashRestore; } });
Object.defineProperty(exports, "blendChannel", { enumerable: true, get: function () { return builtins_1.blendChannel; } });
var pixel_commands_1 = require("./bus/pixel-commands");
Object.defineProperty(exports, "applyPixelOpsCommand", { enumerable: true, get: function () { return pixel_commands_1.applyPixelOpsCommand; } });
// ---------------------------------------------------------------------------
// animation playback engine (Task 6): pure clock shared by the timeline and
// the preview overlay — per-frame durations, loop modes, scrubbing
// ---------------------------------------------------------------------------
var clock_1 = require("./anim/clock");
Object.defineProperty(exports, "PlaybackClock", { enumerable: true, get: function () { return clock_1.PlaybackClock; } });
Object.defineProperty(exports, "buildPlaybackCycle", { enumerable: true, get: function () { return clock_1.buildPlaybackCycle; } });
Object.defineProperty(exports, "effectiveFrameMs", { enumerable: true, get: function () { return clock_1.effectiveFrameMs; } });
Object.defineProperty(exports, "frameAtPosition", { enumerable: true, get: function () { return clock_1.frameAtPosition; } });
// ---------------------------------------------------------------------------
// export service (Task 7): deterministic PNG frames, sprite sheets, JSON
// animation metadata, atomic multi-file writes — zero DOM (v3.1 §7)
// ---------------------------------------------------------------------------
var export_1 = require("./export/export");
Object.defineProperty(exports, "ExportError", { enumerable: true, get: function () { return export_1.ExportError; } });
Object.defineProperty(exports, "EXPORT_METADATA_VERSION", { enumerable: true, get: function () { return export_1.EXPORT_METADATA_VERSION; } });
Object.defineProperty(exports, "buildAllArtifacts", { enumerable: true, get: function () { return export_1.buildAllArtifacts; } });
Object.defineProperty(exports, "buildClipMetadata", { enumerable: true, get: function () { return export_1.buildClipMetadata; } });
Object.defineProperty(exports, "composeFrameRgba", { enumerable: true, get: function () { return export_1.composeFrameRgba; } });
Object.defineProperty(exports, "composeSheetRgba", { enumerable: true, get: function () { return export_1.composeSheetRgba; } });
Object.defineProperty(exports, "encodeExportPng", { enumerable: true, get: function () { return export_1.encodeExportPng; } });
Object.defineProperty(exports, "planExport", { enumerable: true, get: function () { return export_1.planExport; } });
Object.defineProperty(exports, "resolveSheetLayout", { enumerable: true, get: function () { return export_1.resolveSheetLayout; } });
Object.defineProperty(exports, "sheetFrameOrigin", { enumerable: true, get: function () { return export_1.sheetFrameOrigin; } });
Object.defineProperty(exports, "slugify", { enumerable: true, get: function () { return export_1.slugify; } });
Object.defineProperty(exports, "writeExportPlan", { enumerable: true, get: function () { return export_1.writeExportPlan; } });
// ---------------------------------------------------------------------------
// v1 compatibility boundary (Task 3 implements the importer)
// ---------------------------------------------------------------------------
var v1_1 = require("./compat/v1");
Object.defineProperty(exports, "convertV1Loop", { enumerable: true, get: function () { return v1_1.convertV1Loop; } });
Object.defineProperty(exports, "isSerializedProjectV1", { enumerable: true, get: function () { return v1_1.isSerializedProjectV1; } });
Object.defineProperty(exports, "mapV1Loop", { enumerable: true, get: function () { return v1_1.mapV1Loop; } });
Object.defineProperty(exports, "v1ClipSkeleton", { enumerable: true, get: function () { return v1_1.v1ClipSkeleton; } });
Object.defineProperty(exports, "v2ProjectShell", { enumerable: true, get: function () { return v1_1.v2ProjectShell; } });
// ---------------------------------------------------------------------------
// AI generation system (Task 9): deterministic normalize v2 + OKLab palette
// math + the provider/generation contract shared by web route & desktop job
// runner — pure, DOM-free (v3.1 Plan §3, §8.3)
// ---------------------------------------------------------------------------
var oklab_1 = require("./ai/oklab");
// oklab
Object.defineProperty(exports, "linearToSrgb", { enumerable: true, get: function () { return oklab_1.linearToSrgb; } });
Object.defineProperty(exports, "oklabDistance2", { enumerable: true, get: function () { return oklab_1.oklabDistance2; } });
Object.defineProperty(exports, "oklabToRgb", { enumerable: true, get: function () { return oklab_1.oklabToRgb; } });
Object.defineProperty(exports, "parseHexColor", { enumerable: true, get: function () { return oklab_1.parseHexColor; } });
Object.defineProperty(exports, "rgbDistance2", { enumerable: true, get: function () { return oklab_1.rgbDistance2; } });
Object.defineProperty(exports, "rgbToOklab", { enumerable: true, get: function () { return oklab_1.rgbToOklab; } });
Object.defineProperty(exports, "srgbToLinear", { enumerable: true, get: function () { return oklab_1.srgbToLinear; } });
var normalize_v2_1 = require("./ai/normalize-v2");
// pipeline steps (pure + independently testable)
Object.defineProperty(exports, "applyAlphaThreshold", { enumerable: true, get: function () { return normalize_v2_1.applyAlphaThreshold; } });
Object.defineProperty(exports, "cleanupOutlineFringe", { enumerable: true, get: function () { return normalize_v2_1.cleanupOutlineFringe; } });
Object.defineProperty(exports, "cleanupOutlineFringeWithColor", { enumerable: true, get: function () { return normalize_v2_1.cleanupOutlineFringeWithColor; } });
Object.defineProperty(exports, "computeEdgeProfiles", { enumerable: true, get: function () { return normalize_v2_1.computeEdgeProfiles; } });
Object.defineProperty(exports, "despeckleIsolated", { enumerable: true, get: function () { return normalize_v2_1.despeckleIsolated; } });
Object.defineProperty(exports, "detectPixelGrid", { enumerable: true, get: function () { return normalize_v2_1.detectPixelGrid; } });
Object.defineProperty(exports, "dominantColorDownscale", { enumerable: true, get: function () { return normalize_v2_1.dominantColorDownscale; } });
Object.defineProperty(exports, "fitBufferToCanvas", { enumerable: true, get: function () { return normalize_v2_1.fitBufferToCanvas; } });
Object.defineProperty(exports, "floodRemoveBackground", { enumerable: true, get: function () { return normalize_v2_1.floodRemoveBackground; } });
Object.defineProperty(exports, "floodRemoveBackgroundWithColor", { enumerable: true, get: function () { return normalize_v2_1.floodRemoveBackgroundWithColor; } });
Object.defineProperty(exports, "medianCutPalette", { enumerable: true, get: function () { return normalize_v2_1.medianCutPalette; } });
Object.defineProperty(exports, "harvestPalette", { enumerable: true, get: function () { return normalize_v2_1.harvestPalette; } });
Object.defineProperty(exports, "nearestNeighborContain", { enumerable: true, get: function () { return normalize_v2_1.nearestNeighborContain; } });
Object.defineProperty(exports, "normalizeV2", { enumerable: true, get: function () { return normalize_v2_1.normalizeV2; } });
Object.defineProperty(exports, "quantizeToPalette", { enumerable: true, get: function () { return normalize_v2_1.quantizeToPalette; } });
Object.defineProperty(exports, "removeEnclosedBgResidue", { enumerable: true, get: function () { return normalize_v2_1.removeEnclosedBgResidue; } });
Object.defineProperty(exports, "removeStrayComponents", { enumerable: true, get: function () { return normalize_v2_1.removeStrayComponents; } });
Object.defineProperty(exports, "sampleBorderColor", { enumerable: true, get: function () { return normalize_v2_1.sampleBorderColor; } });
Object.defineProperty(exports, "sampleBorderColorMedian", { enumerable: true, get: function () { return normalize_v2_1.sampleBorderColorMedian; } });
Object.defineProperty(exports, "scaleSpriteWholeNumber", { enumerable: true, get: function () { return normalize_v2_1.scaleSpriteWholeNumber; } });
Object.defineProperty(exports, "snapToDetectedGrid", { enumerable: true, get: function () { return normalize_v2_1.snapToDetectedGrid; } });
Object.defineProperty(exports, "trimContentBBox", { enumerable: true, get: function () { return normalize_v2_1.trimContentBBox; } });
Object.defineProperty(exports, "DEFAULT_NORMALIZE2_OPTIONS", { enumerable: true, get: function () { return normalize_v2_1.DEFAULT_NORMALIZE2_OPTIONS; } });
var quality_1 = require("./ai/quality");
// output quality report (Task 9 quality follow-up) — non-destructive checks
Object.defineProperty(exports, "analyzeSpriteQuality", { enumerable: true, get: function () { return quality_1.analyzeSpriteQuality; } });
// ---------------------------------------------------------------------------
// motion presets (Task 10, v3.1 §4.1/§4.1.1): deterministic composer, QA,
// part ownership, suggest helper — zero DOM
// ---------------------------------------------------------------------------
var types_1 = require("./motion/types");
Object.defineProperty(exports, "AMPLITUDE_MAX", { enumerable: true, get: function () { return types_1.AMPLITUDE_MAX; } });
Object.defineProperty(exports, "AMPLITUDE_MIN", { enumerable: true, get: function () { return types_1.AMPLITUDE_MIN; } });
Object.defineProperty(exports, "MOTION_PARAMS_DEFAULTS", { enumerable: true, get: function () { return types_1.MOTION_PARAMS_DEFAULTS; } });
Object.defineProperty(exports, "rectContains", { enumerable: true, get: function () { return types_1.rectContains; } });
Object.defineProperty(exports, "rectsIntersect", { enumerable: true, get: function () { return types_1.rectsIntersect; } });
Object.defineProperty(exports, "scaledOffset", { enumerable: true, get: function () { return types_1.scaledOffset; } });
var presets_1 = require("./motion/presets");
Object.defineProperty(exports, "MOTION_PRESETS", { enumerable: true, get: function () { return presets_1.MOTION_PRESETS; } });
Object.defineProperty(exports, "PRESET_IDS", { enumerable: true, get: function () { return presets_1.PRESET_IDS; } });
Object.defineProperty(exports, "getPreset", { enumerable: true, get: function () { return presets_1.getPreset; } });
Object.defineProperty(exports, "resolveParams", { enumerable: true, get: function () { return presets_1.resolveParams; } });
var composer_1 = require("./motion/composer");
Object.defineProperty(exports, "planMotion", { enumerable: true, get: function () { return composer_1.planMotion; } });
Object.defineProperty(exports, "roleKey", { enumerable: true, get: function () { return composer_1.roleKey; } });
var qa_1 = require("./motion/qa");
Object.defineProperty(exports, "analyzeClipMotion", { enumerable: true, get: function () { return qa_1.analyzeClipMotion; } });
Object.defineProperty(exports, "analyzeMotionPlan", { enumerable: true, get: function () { return qa_1.analyzeMotionPlan; } });
Object.defineProperty(exports, "diffChangedPixels", { enumerable: true, get: function () { return qa_1.diffChangedPixels; } });
Object.defineProperty(exports, "footContactIssues", { enumerable: true, get: function () { return qa_1.footContactIssues; } });
Object.defineProperty(exports, "QA_OPTIONS_DEFAULTS", { enumerable: true, get: function () { return qa_1.QA_OPTIONS_DEFAULTS; } });
var suggest_1 = require("./motion/suggest");
Object.defineProperty(exports, "suggestMotionPreset", { enumerable: true, get: function () { return suggest_1.suggestMotionPreset; } });
// ---------------------------------------------------------------------------
// buffer utils
// ---------------------------------------------------------------------------
var buffers_1 = require("./util/buffers");
Object.defineProperty(exports, "bufferEquals", { enumerable: true, get: function () { return buffers_1.bufferEquals; } });
Object.defineProperty(exports, "cloneBuffer", { enumerable: true, get: function () { return buffers_1.cloneBuffer; } });
Object.defineProperty(exports, "isZeroBuffer", { enumerable: true, get: function () { return buffers_1.isZeroBuffer; } });
// ---------------------------------------------------------------------------
// persistence (Task 3): .pixelforgeproj format, PNG codec, ZIP container,
// journal + crash recovery, atomic save, backups, v1→v2 importer
// ---------------------------------------------------------------------------
var errors_2 = require("./persist/errors");
Object.defineProperty(exports, "PersistError", { enumerable: true, get: function () { return errors_2.PersistError; } });
var crc32_1 = require("./persist/crc32");
Object.defineProperty(exports, "crc32", { enumerable: true, get: function () { return crc32_1.crc32; } });
var base64_1 = require("./persist/base64");
Object.defineProperty(exports, "base64Encode", { enumerable: true, get: function () { return base64_1.base64Encode; } });
Object.defineProperty(exports, "base64Decode", { enumerable: true, get: function () { return base64_1.base64Decode; } });
var digest_1 = require("./persist/digest");
Object.defineProperty(exports, "sha256Hex", { enumerable: true, get: function () { return digest_1.sha256Hex; } });
var png_1 = require("./persist/png");
Object.defineProperty(exports, "decodePng", { enumerable: true, get: function () { return png_1.decodePng; } });
Object.defineProperty(exports, "encodePng", { enumerable: true, get: function () { return png_1.encodePng; } });
Object.defineProperty(exports, "peekPngSize", { enumerable: true, get: function () { return png_1.peekPngSize; } });
var zip_1 = require("./persist/zip");
Object.defineProperty(exports, "assertSafeEntryName", { enumerable: true, get: function () { return zip_1.assertSafeEntryName; } });
Object.defineProperty(exports, "zipRead", { enumerable: true, get: function () { return zip_1.zipRead; } });
Object.defineProperty(exports, "zipWrite", { enumerable: true, get: function () { return zip_1.zipWrite; } });
var paths_1 = require("./persist/paths");
Object.defineProperty(exports, "celSrc", { enumerable: true, get: function () { return paths_1.celSrc; } });
Object.defineProperty(exports, "sharedCelSrc", { enumerable: true, get: function () { return paths_1.sharedCelSrc; } });
Object.defineProperty(exports, "trashCelSrc", { enumerable: true, get: function () { return paths_1.trashCelSrc; } });
Object.defineProperty(exports, "trashClipCelSrc", { enumerable: true, get: function () { return paths_1.trashClipCelSrc; } });
Object.defineProperty(exports, "isSafeId", { enumerable: true, get: function () { return paths_1.isSafeId; } });
Object.defineProperty(exports, "assertSafeCelSrc", { enumerable: true, get: function () { return paths_1.assertSafeCelSrc; } });
Object.defineProperty(exports, "MANIFEST_ENTRY", { enumerable: true, get: function () { return paths_1.MANIFEST_ENTRY; } });
Object.defineProperty(exports, "PROJECT_ENTRY", { enumerable: true, get: function () { return paths_1.PROJECT_ENTRY; } });
Object.defineProperty(exports, "JOURNAL_ENTRY", { enumerable: true, get: function () { return paths_1.JOURNAL_ENTRY; } });
var schema_1 = require("./persist/schema");
Object.defineProperty(exports, "validateSerializedProjectV2", { enumerable: true, get: function () { return schema_1.validateSerializedProjectV2; } });
Object.defineProperty(exports, "validateSerializedProjectV2OrThrow", { enumerable: true, get: function () { return schema_1.validateSerializedProjectV2OrThrow; } });
var serialize_1 = require("./persist/serialize");
Object.defineProperty(exports, "projectFromSerialized", { enumerable: true, get: function () { return serialize_1.projectFromSerialized; } });
Object.defineProperty(exports, "serializeProjectV2", { enumerable: true, get: function () { return serialize_1.serializeProjectV2; } });
var container_1 = require("./persist/container");
Object.defineProperty(exports, "FORMAT_VERSION", { enumerable: true, get: function () { return container_1.FORMAT_VERSION; } });
Object.defineProperty(exports, "buildPixelforgeproj", { enumerable: true, get: function () { return container_1.buildPixelforgeproj; } });
Object.defineProperty(exports, "readPixelforgeproj", { enumerable: true, get: function () { return container_1.readPixelforgeproj; } });
var journal_1 = require("./persist/journal");
Object.defineProperty(exports, "JOURNAL_CAP", { enumerable: true, get: function () { return journal_1.JOURNAL_CAP; } });
Object.defineProperty(exports, "JournalRecorder", { enumerable: true, get: function () { return journal_1.JournalRecorder; } });
Object.defineProperty(exports, "decodeJsonSafe", { enumerable: true, get: function () { return journal_1.decodeJsonSafe; } });
Object.defineProperty(exports, "encodeJsonSafe", { enumerable: true, get: function () { return journal_1.encodeJsonSafe; } });
Object.defineProperty(exports, "linesToRecords", { enumerable: true, get: function () { return journal_1.linesToRecords; } });
Object.defineProperty(exports, "recordsToLines", { enumerable: true, get: function () { return journal_1.recordsToLines; } });
Object.defineProperty(exports, "replayJournal", { enumerable: true, get: function () { return journal_1.replayJournal; } });
var memory_fs_1 = require("./persist/memory-fs");
Object.defineProperty(exports, "MemoryFs", { enumerable: true, get: function () { return memory_fs_1.MemoryFs; } });
var store_1 = require("./persist/store");
Object.defineProperty(exports, "autosavePathFor", { enumerable: true, get: function () { return store_1.autosavePathFor; } });
Object.defineProperty(exports, "backupsDirFor", { enumerable: true, get: function () { return store_1.backupsDirFor; } });
Object.defineProperty(exports, "buildArchive", { enumerable: true, get: function () { return store_1.buildArchive; } });
Object.defineProperty(exports, "createBackup", { enumerable: true, get: function () { return store_1.createBackup; } });
Object.defineProperty(exports, "inspectRecovery", { enumerable: true, get: function () { return store_1.inspectRecovery; } });
Object.defineProperty(exports, "journalPathFor", { enumerable: true, get: function () { return store_1.journalPathFor; } });
Object.defineProperty(exports, "listBackups", { enumerable: true, get: function () { return store_1.listBackups; } });
Object.defineProperty(exports, "loadPixelforgeproj", { enumerable: true, get: function () { return store_1.loadPixelforgeproj; } });
Object.defineProperty(exports, "readEmbeddedJournal", { enumerable: true, get: function () { return store_1.readEmbeddedJournal; } });
Object.defineProperty(exports, "rotateBackups", { enumerable: true, get: function () { return store_1.rotateBackups; } });
Object.defineProperty(exports, "saveAutosave", { enumerable: true, get: function () { return store_1.saveAutosave; } });
Object.defineProperty(exports, "savePixelforgeproj", { enumerable: true, get: function () { return store_1.savePixelforgeproj; } });
Object.defineProperty(exports, "tmpPathFor", { enumerable: true, get: function () { return store_1.tmpPathFor; } });
var import_v1_1 = require("./compat/import-v1");
Object.defineProperty(exports, "pngDataUrlResolver", { enumerable: true, get: function () { return import_v1_1.pngDataUrlResolver; } });
Object.defineProperty(exports, "v1Importer", { enumerable: true, get: function () { return import_v1_1.v1Importer; } });
Object.defineProperty(exports, "V1ProjectImporter", { enumerable: true, get: function () { return import_v1_1.V1ProjectImporter; } });
