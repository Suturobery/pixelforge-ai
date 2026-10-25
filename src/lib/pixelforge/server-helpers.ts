// PixelForge AI — server-side MCP helpers (Prisma access + document factories)
// Shared by the /api/mcp/* routes: project row loading/saving, clip & frame
// resolution, empty layer/frame factories and OperationLog bookkeeping.
// Server-only: never import this from client components.

import type { Project as ProjectRow } from '@prisma/client'
import { db } from '@/lib/db'
import { encodePngDataUrl, emptyBuffer } from './server-png'
import { slugify, uid } from './factory'
import type { SerializedClip, SerializedFrame, SerializedLayer, SerializedProject } from './types'

export { slugify }

/** Error thrown by tool handlers; carries the resolved projectId (if any) for OperationLog. */
export class ToolError extends Error {
  projectId?: string
  constructor(message: string, projectId?: string) {
    super(message)
    this.name = 'ToolError'
    this.projectId = projectId
  }
}

/** Loose structural check for a SerializedProject (version 1). */
export function isLooseSerializedProject(v: unknown): v is SerializedProject {
  const p = v as SerializedProject | null
  return (
    !!p &&
    typeof p === 'object' &&
    p.version === 1 &&
    typeof p.name === 'string' &&
    typeof p.width === 'number' &&
    Number.isFinite(p.width) &&
    typeof p.height === 'number' &&
    Number.isFinite(p.height) &&
    Array.isArray(p.palette) &&
    Array.isArray(p.clips)
  )
}

/**
 * Load a Project row + parse its data JSON into a SerializedProject.
 * Throws ToolError (without projectId) if the row does not exist or the stored
 * JSON is corrupt — i.e. no project could be resolved, so callers skip logging.
 */
export async function loadProjectRow(projectId: string): Promise<{ row: ProjectRow; project: SerializedProject }> {
  const row = await db.project.findUnique({ where: { id: projectId } })
  if (!row) throw new ToolError(`Project "${projectId}" not found`)
  let project: SerializedProject
  try {
    project = JSON.parse(row.data) as SerializedProject
  } catch {
    throw new ToolError(`Stored data of project "${projectId}" is not valid JSON`, projectId)
  }
  if (!isLooseSerializedProject(project)) {
    throw new ToolError(`Stored data of project "${projectId}" has an invalid project shape`, projectId)
  }
  return { row, project }
}

/** Persist a SerializedProject back into its row (data JSON + denormalized columns). */
export async function saveProjectRow(projectId: string, project: SerializedProject): Promise<void> {
  await db.project.update({
    where: { id: projectId },
    data: {
      data: JSON.stringify(project),
      name: project.name,
      width: Math.round(project.width),
      height: Math.round(project.height),
      palette: JSON.stringify(project.palette),
    },
  })
}

/** Create a DB row from a SerializedProject; returns the new id. */
export async function createProjectRow(project: SerializedProject): Promise<string> {
  const created = await db.project.create({
    data: {
      name: project.name,
      width: Math.round(project.width),
      height: Math.round(project.height),
      palette: JSON.stringify(project.palette),
      data: JSON.stringify(project),
    },
    select: { id: true },
  })
  return created.id
}

// ---------------------------------------------------------------------------
// Serialized document factories (PNG data URL layers at project size)
// ---------------------------------------------------------------------------

export function makeEmptyLayer(w: number, h: number, name: string): SerializedLayer {
  return { id: uid('ly'), name, visible: true, opacity: 1, png: encodePngDataUrl(w, h, emptyBuffer(w, h)) }
}

export function makeEmptyFrame(w: number, h: number, layerNames: string[]): SerializedFrame {
  return { id: uid('fr'), layers: layerNames.map((n) => makeEmptyLayer(w, h, n)) }
}

export function makeClip(name: string, fps: number, frames: SerializedFrame[]): SerializedClip {
  return { id: uid('cl'), name, fps, loop: true, frames }
}

// ---------------------------------------------------------------------------
// Clip / frame resolution
// ---------------------------------------------------------------------------

/** Resolve a clip by name (exact match) or default to the first clip. */
export function resolveClip(project: SerializedProject, clipName: string | undefined, projectId?: string): SerializedClip {
  if (clipName != null && clipName !== '') {
    const clip = project.clips.find((c) => c.name === clipName)
    if (!clip) throw new ToolError(`Clip "${clipName}" not found in project "${project.name}"`, projectId)
    return clip
  }
  const first = project.clips[0]
  if (!first) throw new ToolError(`Project "${project.name}" has no clips`, projectId)
  return first
}

/** Fetch a frame by index with a friendly out-of-range error. */
export function requireFrame(clip: SerializedClip, frameIndex: number, projectId?: string): SerializedFrame {
  const frame = clip.frames[frameIndex]
  if (!frame) {
    throw new ToolError(
      `Frame index ${frameIndex} out of range (clip "${clip.name}" has ${clip.frames.length} frame(s))`,
      projectId
    )
  }
  return frame
}

// ---------------------------------------------------------------------------
// Operation log
// ---------------------------------------------------------------------------

/**
 * Append an OperationLog row. projectId is a required FK, so logging is
 * silently skipped when no project row could be resolved (projectId missing or
 * not found in the DB). `verified` skips the existence check for callers that
 * have just loaded/created the row themselves.
 *
 * The OperationLog table is optional (absent from prisma/schema.prisma in this
 * workspace) — the access is structurally typed and any failure (missing
 * table included) is swallowed below: logging must never break a tool call.
 */
export async function logOp(
  projectId: string | null | undefined,
  tool: string,
  ok: boolean,
  summary: string,
  detail: Record<string, unknown>,
  verified = false
): Promise<void> {
  if (!projectId) return
  try {
    if (!verified) {
      const exists = await db.project.findUnique({ where: { id: projectId }, select: { id: true } })
      if (!exists) return
    }
    const log = (
      db as unknown as {
        operationLog?: {
          create: (args: {
            data: { projectId: string; tool: string; summary: string; detail: string }
          }) => Promise<unknown>
        }
      }
    ).operationLog
    await log?.create({
      data: { projectId, tool, summary, detail: JSON.stringify({ ok, ...detail }) },
    })
  } catch {
    // Logging must never break the tool response.
  }
}
