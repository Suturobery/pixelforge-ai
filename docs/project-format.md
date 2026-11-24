# PixelForge AI — Project and File Formats

PixelForge has one in-memory document model and two ways to store it. Which one is used depends
on where the app runs.

| | Browser (web studio) | Desktop app |
| --- | --- | --- |
| Format | "v1 JSON" in a SQLite row | `.pixelforgeproj` file ("v2" container) |
| Pixels stored as | PNG data URLs inside the JSON | PNG files inside a ZIP |
| Opened through | The core's v1 importer | The core's persistence layer, natively |
| Needs a database | Yes | No |

Both directions go through `@pixelforge/core`, so the same validation applies. The renderer
never converts formats itself.

## The document model (runtime, schema version 2)

Defined in `packages/core/src/types/document.ts`.

```text
Project
├─ id, schemaVersion (2), name, width, height
├─ palette: string[]                 ordered hex colours (#rrggbb or #rrggbbaa)
├─ settings
│   ├─ paletteEnforce: boolean
│   ├─ styleProfile?: StyleProfile    "Style Lock"
│   └─ onion: { prev, next }          0–3 frames each side
├─ trash: TrashEntry[]                at most 20 entries
└─ clips: Clip[]
    ├─ id, name, fps, loop, loopMode
    ├─ layers: Layer[]                bottom → top, one stack per clip
    ├─ parts: Part[]                  motion regions
    ├─ frames: Frame[]
    │   ├─ id, durationMs             0 = inherit the clip's fps
    │   └─ cels: Record<layerId, Cel> an absent cel is fully transparent
    └─ tags: ClipTag[]                frame-range tags
```

| Type | Fields |
| --- | --- |
| `Project` | `id` (null while unsaved), `schemaVersion`, `name`, `width`, `height`, `palette`, `settings`, `clips`, `trash` |
| `Clip` | `id`, `name`, `fps` (1–60), `loop`, `loopMode` (`forward`, `reverse`, `pingpong`), `layers`, `parts`, `frames`, `tags` |
| `Layer` | `id`, `name`, `visible`, `opacity` (0–1), `linked`, optional `locked`, optional `blend` |
| `Frame` | `id`, `durationMs`, `cels` |
| `Cel` | `buffer` (RGBA, `width × height × 4` bytes), `linked` |
| `Part` | `id`, `name`, `layerId`, optional `rect`, `anchorFrameId`, `z` |
| `ClipTag` | `name`, `from`, `to` |
| `TrashEntry` | `id`, `label`, `deletedAt`, `item` (a frame, a layer with its cels, or a clip) |
| `BlendMode` | `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten` |

**Limits**

| What | Value | Constant |
| --- | --- | --- |
| Canvas size | 16 to 256 px per side | `CANVAS_MIN`, `CANVAS_MAX` |
| Clip frame rate | 1 to 60 fps | — |
| Onion skin depth | 0 to 3 frames each side | `ONION_MAX` |
| Trash | 20 entries, oldest evicted | `TRASH_CAP` |

A linked layer's cels all point at the same buffer object, so one edit changes every frame.

**Style Lock** (`StyleProfile`): `enabled`, `name` (≤48), `artDirection` (≤180), `cameraAngle`
(optional), `lighting`, `outline`, `paletteMode`, `transparentBackground`, `notes` (≤480),
`references` (≤6 of `{ clipId, frameId, label }`), `feedback` (`prefer` and `avoid`, ≤4 cues of
≤72 characters each).

## `.pixelforgeproj` (desktop)

A ZIP archive. Format version 2.

```text
manifest.json                         format version, app version, timestamps, checksums
project.json                          the document (serialized v2)
cels/<clipId>/<frameId>/<layerId>.png one RGBA PNG per cel
cels/<clipId>/shared/<layerId>.png    a linked layer's shared cel, stored once
trash/<n>/cels/…                      pixels of trashed items
history/journal.jsonl                 recent command records (optional)
```

**`manifest.json`**

| Field | Meaning |
| --- | --- |
| `formatVersion` | `2`. A file declaring another version is refused with `UNSUPPORTED_VERSION` |
| `appVersion`, `createdAt`, `updatedAt` | Provenance |
| `journalSeq` | Sequence number of the last embedded journal record |
| `checksums` | SHA-256 of `project.json`, every cel and the journal, keyed by entry name |

**`project.json`** mirrors the runtime model. Differences from the runtime types:

- A cel is `{ src, linked? }` where `src` is its path inside the archive.
- A serialized layer has only `id`, `name`, `visible`, `opacity` and `linked`. See
  [Known gaps](#known-gaps).
- Entry names are validated on read: forward slashes, relative, safe id segments. Traversal
  and duplicates are rejected.

**Sidecar files** next to the project file:

| File | Purpose |
| --- | --- |
| `<file>.tmp` | Temporary file during an atomic write |
| `<file>.autosave.pixelforgeproj` | Autosave |
| `<file>.journal` | History journal sidecar; up to 200 records |
| `backups/` in the same directory | Rolling backups (5 by default) |

**Opening a file** reads the archive, verifies checksums, decodes every cel and validates the
schema. Corruption is reported with a typed code instead of a partial load. Before loading, the
app checks for a newer autosave and for journal records newer than the ones embedded in the
file, and offers recovery.

**Persistence errors:** `NOT_FOUND`, `BAD_ZIP`, `BAD_CHECKSUM`, `UNSUPPORTED_VERSION`,
`MISSING_ENTRY`, `INVALID_SCHEMA`, `UNSAFE_PATH`, `DUPLICATE_ENTRY`, `DECODE_FAILED`,
`ENCODE_FAILED`, `FS_ERROR`, `REPLAY_FAILED`.

## v1 JSON (browser and SQLite)

The original format: per-frame layer stacks with PNG data URLs. It is what `/api/projects`
stores and what the browser studio saves.

```text
{
  version: 1, name, width, height,
  palette: string[],
  clips: [{
    id, name, fps, loop,
    loopMode?,                 optional extension
    parts?,                    optional extension
    frames: [{
      id, durationMs?,         optional extension
      layers: [{ id, name, visible, opacity, locked?, blend?, png }]
    }]
  }],
  settings?: { onion, styleProfile? }
}
```

Saving converts the v2 runtime document to this shape. Loading imports it through the core's
`V1ProjectImporter`. The optional fields are ignored by readers that predate them.
`src/lib/pixelforge/project-validate.ts` rejects malformed payloads before they reach the
database.

## Where data lives

| Data | Development (web or desktop) | Packaged desktop |
| --- | --- | --- |
| SQLite database | `db/custom.db` (`DATABASE_URL`) | `%APPDATA%/PixelForge AI/mcp-data/webapp.db`, created from a blank template on first run |
| MCP client allowlist | `db/mcp-clients.json` | `%APPDATA%/PixelForge AI/mcp-data/mcp-clients.json` |
| MCP audit log | `db/mcp-ops.jsonl` | `…/mcp-data/mcp-ops.jsonl` |
| Editor-link secret | `db/editor-auth.json` | `…/mcp-data/editor-auth.json` |
| Task board | `db/brain-tasks.json` | `…/mcp-data/brain-tasks.json` |
| Learned styles | `db/knowledge-learned/` | `…/mcp-data/knowledge-learned/` |
| Settings file | `%APPDATA%/PixelForge AI/settings.json` | Same |
| Trusted recent projects | `%APPDATA%/PixelForge AI/trusted-project-paths.json` | Same |
| Main-process logs | `%APPDATA%/PixelForge AI/logs/main-<date>.log` | Same |

The MCP data directory is `PF_MCP_DATA_DIR`. The audit log is trimmed to its last 1 MB once it
passes 2 MB.

**What the MCP server stores about clients.** Only SHA-256 hashes of tokens, never the tokens
themselves. Audit entries hold a hash of the arguments, not the arguments.

## Database schema

`prisma/schema.prisma`, SQLite through Prisma.

```prisma
model Project {
  id        String   @id @default(cuid())
  name      String
  width     Int
  height    Int
  palette   String     // JSON array
  data      String     // the v1 project JSON
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

The schema also contains scaffold `User` and `Post` models that no application code uses.

## Browser storage keys

| Key | Holds |
| --- | --- |
| `pixelforge-settings-v1` | App preferences (persisted format version 6) |
| `pixelforge:second-brain:memory:v1` | Second Brain memory |
| `pixelforge:macros` | Saved macros |
| `pixelforge:lastProjectId` | Last project, for restore after a refresh |
| `pixelforge:recentProjectFiles:v1` | Recent file list |
| `pixelforge:onboarded-v1` | First-run tour flag |
| `pixelforge-viewbar-v1`, `pixelforge-preview-v1`, `pixelforge-palette-v1`, `pixelforge:panel…` | Floating panel positions and visibility |

The editor document itself is not kept in browser storage: it is rebuilt from SQLite or from the
project file.

## Exports

| File | Contents |
| --- | --- |
| `{base}_{clip}_sheet.png` | All frames of one clip, grid or strip, RGBA8 PNG |
| `{base}_{clip}_frame{NN}.png` | One composited frame per file |
| `{base}_{clip}.json` | Metadata describing that sheet (version 2) |

One JSON per sheet; a multi-clip export writes one set per clip. The schema, geometry rules and
playback interpretation are specified in [Export metadata schema](export-metadata.md). That
document's "out of scope" note is outdated: GIF export exists in the export dialog, and the
agent tools `export_sheet` and `export_gif` return data URLs rather than writing files.

## Identities

**Project key.** Used to bind task-board work to a project: `db:<id>` for a database project,
`file:<path>` for a file, `unsaved:<editor session>:<load epoch>` for an untitled document.

**State hash.** A SHA-256 digest, truncated to 32 characters, over the project's name, size,
palette, settings, every clip's properties and layer list, per-frame durations, tags, the number
of motion parts (not their rectangles), a CRC-32 of every cel buffer, and the trash entry ids.
It changes whenever the document changes and is what `expectedStateHash` is checked against.

## Known gaps

- **Paint lock and blend mode are not saved in `.pixelforgeproj` files.** The serialized layer
  has only `id`, `name`, `visible`, `opacity` and `linked`
  (`packages/core/src/persist/serialize.ts`), so on desktop a layer's lock and blend mode return
  to their defaults when the file is reopened. The v1 JSON used in the browser does keep both.
- **Linked layers and frame-range tags have no editor control and no agent tool.** They are part
  of the model and survive a round trip, but nothing in the UI or the MCP catalog creates them.
