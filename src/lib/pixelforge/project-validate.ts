// PixelForge AI — strict validation for web-saved project payloads (P1).
// The v1 JSON contract is the web testbed's storage format (per-frame layer
// stacks with PNG data URLs — see project-io.ts exportLegacyProjectJson and
// core's V1ProjectImporter); this guard rejects malformed saves BEFORE they
// reach the database so a buggy agent or panel can never persist an
// unusable project.

export interface ProjectPayloadIssue {
  path: string
  message: string
}

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/

function isInt(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

/**
 * Validate a v1-shaped project payload. Returns a list of issues — an empty
 * list means the payload is safe to persist. Deliberately stricter than
 * core's isSerializedProjectV1 (which only checks five top-level fields).
 */
export function validateProjectPayload(project: unknown): ProjectPayloadIssue[] {
  const issues: ProjectPayloadIssue[] = []
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return [{ path: 'project', message: 'payload must be an object' }]
  }
  const p = project as Record<string, unknown>

  if (p.version !== 1) issues.push({ path: 'project.version', message: 'must be 1' })
  if (typeof p.name !== 'string' || p.name.trim().length === 0 || p.name.length > 200) {
    issues.push({ path: 'project.name', message: 'string 1..200 required' })
  }
  if (!isInt(p.width, 1, 512)) issues.push({ path: 'project.width', message: 'integer 1..512 required' })
  if (!isInt(p.height, 1, 512)) issues.push({ path: 'project.height', message: 'integer 1..512 required' })

  if (!Array.isArray(p.palette) || p.palette.length < 1 || p.palette.length > 256) {
    issues.push({ path: 'project.palette', message: 'array of 1..256 colors required' })
  } else {
    p.palette.forEach((c, i) => {
      if (typeof c !== 'string' || !HEX_RE.test(c)) {
        issues.push({ path: `project.palette[${i}]`, message: 'hex color required' })
      }
    })
  }

  if (!Array.isArray(p.clips) || p.clips.length < 1 || p.clips.length > 64) {
    issues.push({ path: 'project.clips', message: 'array of 1..64 clips required' })
    return issues
  }

  p.clips.forEach((clip: unknown, ci: number) => {
    const path = `project.clips[${ci}]`
    if (!clip || typeof clip !== 'object') {
      issues.push({ path, message: 'clip must be an object' })
      return
    }
    const c = clip as Record<string, unknown>
    if (typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 120) {
      issues.push({ path: `${path}.name`, message: 'string 1..120 required' })
    }
    if (!isInt(c.fps, 1, 60)) issues.push({ path: `${path}.fps`, message: 'integer 1..60 required' })
    if (!Array.isArray(c.frames) || c.frames.length < 1 || c.frames.length > 512) {
      issues.push({ path: `${path}.frames`, message: 'array of 1..512 frames required' })
      return
    }
    c.frames.forEach((frame: unknown, fi: number) => {
      if (!frame || typeof frame !== 'object') {
        issues.push({ path: `${path}.frames[${fi}]`, message: 'frame must be an object' })
        return
      }
      const fr = frame as Record<string, unknown>
      // v1 contract: per-frame layer stack; each layer carries its PNG data URL
      if (!Array.isArray(fr.layers) || fr.layers.length < 1 || fr.layers.length > 32) {
        issues.push({ path: `${path}.frames[${fi}].layers`, message: 'array of 1..32 layers required' })
        return
      }
      fr.layers.forEach((layer: unknown, li: number) => {
        if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
          issues.push({ path: `${path}.frames[${fi}].layers[${li}]`, message: 'layer must be an object' })
          return
        }
        const l = layer as Record<string, unknown>
        if (typeof l.name !== 'string' || l.name.length === 0 || l.name.length > 120) {
          issues.push({ path: `${path}.frames[${fi}].layers[${li}].name`, message: 'string 1..120 required' })
        }
        if (typeof l.png !== 'string' || l.png.length === 0) {
          issues.push({ path: `${path}.frames[${fi}].layers[${li}].png`, message: 'PNG data URL string required' })
        }
      })
      if (fr.durationMs !== undefined && !isInt(fr.durationMs, 0, 60000)) {
        issues.push({ path: `${path}.frames[${fi}].durationMs`, message: 'integer 0..60000 required' })
      }
    })
  })

  return issues
}
