// Desktop file recents. These are intentionally separate from the web
// database recents: a .pixelforgeproj is a user-owned file and is never
// inserted into the renderer's SQLite/API project store just to show it here.

export interface RecentProjectFile {
  path: string
  name: string
  updatedAt: string
}

const KEY = 'pixelforge:recentProjectFiles:v1'
const MAX_RECENTS = 12

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts.at(-1) || path
}

export function listRecentProjectFiles(): RecentProjectFile[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value
      .filter((item): item is RecentProjectFile => {
        if (!item || typeof item !== 'object') return false
        const row = item as Record<string, unknown>
        return typeof row.path === 'string' && row.path.length > 0 && row.path.length <= 4096 &&
          typeof row.name === 'string' && typeof row.updatedAt === 'string'
      })
      .slice(0, MAX_RECENTS)
  } catch {
    return []
  }
}

export function rememberRecentProjectFile(path: string, name?: string): void {
  if (!path || path.length > 4096) return
  const item: RecentProjectFile = {
    path,
    name: name?.trim() || basename(path),
    updatedAt: new Date().toISOString(),
  }
  try {
    const next = [item, ...listRecentProjectFiles().filter((existing) => existing.path !== path)].slice(0, MAX_RECENTS)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // private/restricted storage only affects the convenience list; never file I/O
  }
}

export function forgetRecentProjectFile(path: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(listRecentProjectFiles().filter((item) => item.path !== path)))
  } catch {
    // same best-effort policy as remember
  }
}
