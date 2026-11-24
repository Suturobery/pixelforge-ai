# PixelForge AI — Core Engine (`@pixelforge/core`)

`packages/core` is the editor's engine: the document model, the command bus, pixel operations,
history, playback timing, the export compositor, the motion composer, project persistence and a
set of pure image helpers. It has no runtime dependencies and no DOM, React or Electron code, so
it runs identically in the renderer, in tests and in any Node or Bun process.

| Fact | Value |
| --- | --- |
| Package | `@pixelforge/core`, version `0.3.0` (`CORE_VERSION` constant says `0.2.0`) |
| Entry | `dist/index.js` (TypeScript build output) |
| Schema version | `2` (`SCHEMA_VERSION`) |
| Build | `tsc -p tsconfig.json` |
| Tests | `bun test` inside `packages/core` — 28 test files |

The renderer does not use `dist`. `next.config.ts` aliases `@pixelforge/core` to
`packages/core/src/index.ts` and compiles from source. The MCP server imports a few helpers from
source as well. Treat `dist` as a secondary artifact.

## Module map

| Folder or file | Contents |
| --- | --- |
| `index.ts` | The public API. Everything below is exported from here |
| `version.ts` | `CORE_VERSION`, `SCHEMA_VERSION` |
| `id.ts` | `uid()` id generator |
| `types/document.ts` | The runtime document model (v2) |
| `types/commands.ts` | Command definitions, outcomes, change events, stroke handles |
| `types/history.ts` | `HistoryEntry`, `HistoryStats`, `TileDiff` |
| `types/serialized.ts` | The JSON form of the document and its type guard |
| `types/v1.ts` | The v1 (import) format types |
| `style-profile.ts` | Style Lock profile: constants, defaults, `parseStyleProfile`, prompt tags |
| `doc/factory.ts` | `createProject`, `createClip`, `createFrame`, `createLayer`, `createCel`, `duplicateFrame`, `cloneProject` |
| `doc/access.ts` | Look-up helpers (`findClip`, `findFrame`, `findLayer`, `locateCel`), cel writers, trash helpers |
| `bus/` | The CommandBus and every command |
| `pixels/` | Pixel operations: strokes and shapes, ellipses, region transforms, tile diffs |
| `history/engine.ts` | The budgeted history engine |
| `anim/clock.ts` | The playback clock |
| `export/export.ts` | The export service |
| `motion/` | Motion types, presets, composer, QA and the preset suggester |
| `ai/` | Pure image helpers: normalisation, grid detection, quality report, style checks, reference candidates |
| `compat/` | The v1 importer |
| `persist/` | PNG and ZIP codecs, the `.pixelforgeproj` container, journal, the save/load/recovery store |
| `util/buffers.ts` | `bufferEquals`, `cloneBuffer`, `isZeroBuffer` |

## Document model

Described in [Project and file formats](project-format.md#the-document-model-runtime-schema-version-2).

Factory and access helpers:

| Function | Purpose |
| --- | --- |
| `createProject`, `createClip`, `createFrame`, `createLayer`, `createCel` | Build model objects with ids and defaults |
| `duplicateFrame` | Deep copy of a frame, preserving shared buffers for linked layers |
| `cloneProject` | Deep copy of a whole document |
| `findClip`, `findFrame`, `findLayer`, `locateCel` | Look-ups by id |
| `mapClip`, `mapFrames` | Structural copies with a mapping function |
| `setCel`, `replaceCelBuffer`, `setCelEverywhere` | Cel writers; `setCelEverywhere` writes a linked layer's shared cel |
| `pushTrash`, `takeTrash` | Move deleted items into and out of the trash |

## CommandBus

`bus/bus.ts`. The single mutation path for the document.

| Member | Purpose |
| --- | --- |
| `register(def)` | Register a command definition |
| `has(type)` | Whether a command type is registered |
| `execute(type, payload, origin, opts?)` | Validate, apply and record. Throws `CommandError` on any failure; the document is never left half-changed |
| `transaction(label, origin, fn)` | Run `fn` with nested commands grouped into one history entry. A throw — including from an async `fn` — rolls everything back |
| `beginStroke(params)` / `endStroke(label, changed)` / `cancelStroke()` | Pointer strokes on a copy-on-write working buffer, committed as one command |
| `activeStroke` | Whether a stroke is open |
| `undo()`, `redo()`, `canUndo()`, `canRedo()` | History navigation; results report skipped entries whose target cels are gone |
| `historyStats()` | Depth and byte estimates |
| `resetHistory()`, `setHistoryBudget(bytes)` | History controls |
| `onChange(listener)` | Subscribe to `ChangeEvent`s: `executed`, `undone`, `redone`, `stroke-started`, `stroke-committed`, `stroke-cancelled`, `transaction-rolled-back`, `document-replaced` |
| `getProject()`, `setProject()`, `isDirty()`, `markSaved()` | Document access and dirty state |

A command definition is `{ type, defaultLabel, validate(payload, ctx), apply(payload, ctx) }`.
`validate` throws on bad input. `apply` is pure and returns `{ project, label?, pixels? }`. When
`pixels` (a tile-diff payload) is present the bus records a pixel entry; otherwise a structural
snapshot.

**Error codes:** `UNKNOWN_COMMAND`, `VALIDATION_FAILED`, `NOT_FOUND`, `INVALID_STATE`,
`TRANSACTION_CONFLICT`.

### Commands (27)

| Group | Command types |
| --- | --- |
| Project | `project.rename`, `canvas.resize`, `settings.setOnion`, `settings.setStyleProfile` |
| Clips | `clip.add`, `clip.setProps`, `clip.delete` |
| Frames | `frame.add`, `frame.delete`, `frame.move`, `frame.setDuration` |
| Layers | `layer.add`, `layer.delete`, `layer.duplicate`, `layer.setProps`, `layer.reorder`, `layer.move`, `layer.mergeDown`, `layer.setLinked` |
| Palette | `palette.addColor`, `palette.removeColor`, `palette.replaceAll` |
| Trash | `trash.restore`, `trash.purge` |
| Pixels | `pixels.applyOp` |
| Motion | `part.set`, `motion.apply` |

`canvasResize`, `paletteReplaceAll` and `settings.setStyleProfile` are defined in
`bus/builtins.ts` but not re-exported from the package index.

## Pixel operations

**`pixels.applyOp`** takes a target (clip, frame, layer) and a list of ops, applied together in
one history entry:

`stamp`, `line`, `rect`, `ellipse`, `fill`, `shift`, `clear`, `flipH`, `flipV`, `rotateCW`,
`rotateCCW`, `scale`, `scaleTo`, `setBuffer`.

Transform ops accept an optional `rect` to restrict them to a region.

**Standalone helpers**

| Module | Functions |
| --- | --- |
| `pixels/ops.ts` | `pixelPerfectStroke`, `drawLinePixels`, `drawRectPixels`, `floodFill`, `floodFillDither`, `stampBrush`, `stampCustomBuffer`, `inBrushDisc`, `moveBuffer`, `clearBufferInPlace`, `beautifyLayer`, `getPixel`, `inBounds` |
| `pixels/ellipse.ts` | `drawEllipsePixels`, `ellipseOutlinePoints`, `normalizeEllipseBox` |
| `pixels/region.ts` | `extractRegion`, `pasteRegionInPlace`, `clearRegionInPlace`, `flipRegionHInPlace`, `flipRegionVInPlace`, `rotateRegionCWInPlace`, `rotateRegionCCWInPlace`, `scaleRegionInPlace`, `scaleRegionToInPlace`, `clampRect` |
| `pixels/tile.ts` | `extractTileDiff`, `applyTileDiff`, `tileIndexAt`, `tilesPerRow`, `tilesPerColumn` |

## History

`history/engine.ts` keeps entries under a memory budget and evicts the oldest when it is
exceeded.

| Fact | Value |
| --- | --- |
| Tile size | 16×16 pixels (1024 bytes per side) |
| Default budget | 64 MiB (`DEFAULT_HISTORY_BUDGET_BYTES`) |
| Budget range | 16 MiB to 512 MiB |
| Entry kinds | Pixel (tile diffs), structure (snapshot), composite (a transaction) |

The renderer maps its "history limit" preference to a budget. The store keeps a
`JournalRecorder` that mirrors recent commands into the project's journal sidecar.

## Playback clock

`anim/clock.ts` is the one timing implementation for the timeline, the canvas and the floating
preview.

| Export | Purpose |
| --- | --- |
| `effectiveFrameMs(frame, clipFps)` | A frame's duration: its override, or `1000 / fps` floored at 1 ms |
| `buildPlaybackCycle(clip)` | One full cycle for the clip's loop mode: the frame sequence and per-step durations |
| `PlaybackClock` | `tick(deltaMs)`, `scrubTo(posMs)`, `scrubToFrame(i)`, `currentFrame()`, `setCycle()`, `reset()`, `getCycle()` |
| `frameAtPosition(cycle, posMs)` | Which frame a position falls in |

## Export service

`export/export.ts`. Deterministic and DOM-free: the same compositor serves the browser, the
desktop app and the golden tests.

```ts
const plan = planExport(project, { scope, format, clipId?, frameIndex?, sheet?, includeJson?, baseName?, zeroPadFrames? })
const artifacts = await buildAllArtifacts(plan)      // [{ filename, kind, bytes }]
await writeExportPlan(fs, dir, artifacts, { overwrite })  // desktop; atomic
```

| Export | Purpose |
| --- | --- |
| `planExport` | Validate everything up front and produce a list of artifacts |
| `composeFrameRgba` | Composite one frame's visible layers with straight-alpha source-over |
| `composeSheetRgba` | Lay frames out in a grid or strip |
| `buildClipMetadata` | The version 2 JSON sidecar |
| `resolveSheetLayout`, `sheetFrameOrigin` | Geometry |
| `encodeExportPng` | RGBA8, filter 0, non-interlaced PNG |
| `slugify` | File name bases |

- `ExportScope` is `'frame'`, `'clip'` or `'all-clips'`. `ExportFormat` is `'png-frames'` or
  `'sheet'`.
- `SheetOptions` is `{ columns, padding, spacing? }`. `columns: 0` gives a horizontal strip.
- A sheet is limited to 16384 px per side and 2²⁴ pixels in total.
- Error codes: `EMPTY_PROJECT`, `EMPTY_CLIP`, `INVALID_OPTIONS`, `SHEET_TOO_LARGE`,
  `BAD_CEL_BUFFER`, `DUPLICATE_FILENAME`, `INVALID_FILENAME`, `ENCODE_FAILED`, `WRITE_FAILED`.
- `EXPORT_METADATA_VERSION` is `2`.

## Motion

`motion/` implements part-based animation: body parts are tagged as regions, a preset defines
per-part translation curves, and the composer writes the frames.

| Preset | Frame counts | Default | Play once |
| --- | --- | --- | --- |
| `idle` | 4 | 4 | No |
| `walk` | 4, 6, 8 | 4 | No |
| `run` | 6 | 6 | No |
| `attack` | 4, 5, 6 | 4 | Suggested |
| `jump` | 4–8 | 6 | Suggested |
| `spin` | 4 | 4 | No |
| `duck` | 4 | 4 | No |
| `hurt` | 4 | 4 | Suggested |
| `swim` | 6 | 6 | No |
| `death` | 5 | 5 | Suggested |

The `apply_motion_preset` tool description says "spin 6"; the preset definition says 4.

**Parameters** (`MotionParams`): `amplitude` (0.25–3, default 1), `frameCount` (0 = preset
default), `gapFill` (`none` or `edge-extend`, default `edge-extend`), `smear` (attack only).

| Export | Purpose |
| --- | --- |
| `planMotion(project, source, opts)` | Compose every frame. Returns `MotionPlan { width, height, frames[{ cels }], report }` |
| `analyzeMotionPlan`, `analyzeClipMotion` | QA on a plan or on an existing clip |
| `footContactIssues` | Planted-foot checks |
| `diffChangedPixels` | Pixel difference between two buffers |
| `suggestMotionPreset(prompt)` | Deterministic keyword lookup |
| `roleKey`, `MOTION_PRESETS`, `PRESET_IDS`, `getPreset`, `resolveParams` | Preset access |

Offsets are whole pixels. Amplitude is scaled by `clipHeight / 32`. Pixels pushed off the canvas
are dropped and counted in the report.

**QA issue codes:** `invalid_layer`, `invalid_rect`, `invalid_anchor`, `overlap`,
`detached_part`, `out_of_bounds`, `foot_slide`, `both_feet_lift`, `transparency_artifact`,
`flicker`, `loop_jump`, `frame_consistency`, `play_once`. QA reports; it never mutates.

The `motion.apply` command commits a plan atomically, to a new clip or over a target's leading
frames. `part.set` replaces a clip's parts.

## AI helpers

Pure TypeScript. The "AI" here is deterministic image processing and checking, not a model.

### `ai/normalize-v2.ts` — `normalizeV2`

Turns an arbitrary image buffer into a canvas-ready sprite.

| Option | Meaning | Default |
| --- | --- | --- |
| `targetW`, `targetH` | Output size, 1–512 | required |
| `removeBg` | Flood-remove the background from the borders | required |
| `bgTolerance` | Flood tolerance | required |
| `paletteMode` | `project`, `auto` (median cut) or `off` | required |
| `palette`, `maxColors` | Project palette, or the cap for auto mode (2–64) | — |
| `outlineCleanup` | Clear the anti-aliasing fringe left after background removal | — |
| `fit` | `contain` (keep aspect ratio) or `fill` (stretch) | `contain` |
| `paddingPct` | Margin as a fraction of the smaller side, 0–0.25 | 0.04 |
| `alphaThreshold` | Binary alpha threshold, 1–255 | 128 |
| `strayCleanup` | `off`, `normal` or `strong` | `off` |
| `enclosedResidueCleanup` | Also clear enclosed background-coloured regions | `false` |
| `gridSnap` | `auto` or `off` | `auto` |

Every step is exported on its own as well: `trimContentBBox`, `floodRemoveBackground`,
`dominantColorDownscale`, `applyAlphaThreshold`, `despeckleIsolated`, `removeStrayComponents`,
`removeEnclosedBgResidue`, `medianCutPalette`, `harvestPalette`, `quantizeToPalette`,
`cleanupOutlineFringe`, `nearestNeighborContain`, `fitBufferToCanvas`, and the grid functions.

### `ai/grid-detect.ts`

Recovers the true pixel grid of an image generated at high resolution, where each logical pixel
is a noisy block.

1. `computeEdgeProfiles` — edge energy along each axis.
2. `detectPixelGrid` — block size and phase by autocorrelation and template correlation.
3. `snapToDetectedGrid` — one denoised colour per block.
4. `scaleSpriteWholeNumber` — place the result on the target canvas with integer scaling only.

### `ai/style-validation.ts` — `validateStyleCandidate`

Technical checks on one buffer against a Style Lock profile. Check ids: `size`, `palette`,
`alpha`, `background`, `margin`, `grid`. Each is `pass`, `warning` or `info`. It does not judge
readability or pose.

### `ai/quality.ts` — `analyzeSpriteQuality`

A non-destructive report on a normalised sprite: empty sprite, content touching the edge,
subject filling the source frame, stray pixels, enclosed background residue, unexpected
transparent holes, palette bloat, aggressive cleanup, anisotropic stretch, background removal
disabled.

### `ai/reference-candidate.ts`

The Create from Reference pipeline: decode a PNG, normalise it to a 16 or 32 pixel target using
the project palette and Style Lock, and run the style checks. It keeps the original pixels next
to the cleaned result for review. `ai/reference-mock.ts` is a deterministic stand-in for an image
provider, used by tests.

### Others

- `ai/oklab.ts` — OKLab colour conversion and distance.
- `ai/plan-schema.ts` — a zod schema for planner output (`app-vfx`, `app-palette`, `agent`
  steps). Used by tests; no live route consumes it today.

## v1 importer

`compat/import-v1.ts` converts a v1 JSON project into the v2 runtime model, carrying the optional
extensions when present: `durationMs`, `loopMode`, `parts`, onion settings, Style Lock, layer
`locked` and `blend`. `V1ProjectImporter` takes a `pngDataUrlResolver` so decoding stays
pluggable.

## Persistence

| Module | Contents |
| --- | --- |
| `persist/png.ts` | `encodePng`, `decodePng`, `peekPngSize` |
| `persist/zip.ts` | `zipRead`, `zipWrite`, entry-name validation |
| `persist/container.ts` | `buildPixelforgeproj`, `readPixelforgeproj` |
| `persist/schema.ts` | `validateSerializedProjectV2`, `validateSerializedProjectV2OrThrow` |
| `persist/serialize.ts` | `serializeProjectV2`, `projectFromSerialized` |
| `persist/journal.ts` | `JournalRecorder`, `replayJournal`; capped at 200 records |
| `persist/store.ts` | `savePixelforgeproj`, `saveAutosave`, `loadPixelforgeproj`, `inspectRecovery`, `createBackup`, `rotateBackups`, `listBackups`, `buildArchive` |
| `persist/memory-fs.ts` | `MemoryFs`, an in-memory `FileFs` for tests |
| `persist/crc32.ts`, `base64.ts`, `digest.ts` | Checksums and encodings |

File system access is abstracted behind a small `FileFs` interface, so the same code runs on the
Electron bridge transport, in memory, or on any async fs.

## Tests

Run with `bun test` from `packages/core` (or `bun run core:test` from the repository root), and
type-check with `bun run core:test:typecheck`.

| Area | Test files |
| --- | --- |
| Document model and factories | `factory.test.ts`, `cel-model.test.ts`, `style-profile.test.ts` |
| CommandBus | `bus-commands.test.ts`, `bus-pixel-tools.test.ts`, `bus-undo-redo.test.ts`, `motion-commands.test.ts` |
| History | `history.test.ts` |
| Pixel operations | `pixels-ellipse.test.ts`, `pixels-transform.test.ts`, `pixel-perfect.test.ts`, `blend-modes.test.ts`, `brush-shape.test.ts` |
| Playback | `anim-clock.test.ts` |
| Export (25 golden-image tests) | `export-golden.test.ts` |
| Persistence | `persist-format.test.ts`, `persist-store.test.ts`, `persist-journal.test.ts`, `persist-png.test.ts`, `persist-zip.test.ts` |
| Compatibility | `compat.test.ts`, `import-v1.test.ts` |
| Motion | `motion-composer.test.ts`, `motion-qa-suggest.test.ts` |
| AI helpers | `ai-normalize-golden.test.ts` (25 golden tests), `ai-grid-detect.test.ts` (9 tests), `reference-candidate.test.ts`, `style-validation.test.ts` |

Golden tests use small in-code fixtures and compare decoded pixels, never raw PNG bytes.

## Related code outside the package

`src/lib/pixelforge/` contains an earlier motion prototype (`presets.ts`, `rig.ts`, `animate.ts`,
`composer.ts`, `qa.ts`, `fixtures.ts`) with its own five-preset `PresetId` type. It is not the
code path behind the Motion panel, the `motion.apply` command or `apply_motion_preset`; those
all use `planMotion` in this package. `scripts/motion-audit-core.ts` exercises the core
composer; `scripts/motion-audit.ts` exercises the prototype.
