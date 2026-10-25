// PixelForge AI — single project API (load + delete)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isSerializedProject } from '@/lib/pixelforge/project-io'
import { guardStateChange, guardRead } from '@/lib/pixelforge/api-guard'

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = guardRead(req)
  if (denied) return denied
  try {
    const { id } = await ctx.params
    const row = await db.project.findUnique({ where: { id } })
    if (!row) {
      return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 })
    }
    const project = JSON.parse(row.data)
    if (!isSerializedProject(project)) {
      return NextResponse.json({ ok: false, error: 'Corrupt project data' }, { status: 500 })
    }
    return NextResponse.json({ ok: true, project, meta: { id: row.id, updatedAt: row.updatedAt } })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Failed to load project' },
      { status: 500 }
    )
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // Interim state-change guard (Task 8 replaces with pairing + tiers).
  const denied = guardStateChange(req)
  if (denied) return denied

  try {
    const { id } = await ctx.params
    await db.project.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Failed to delete project' },
      { status: 500 }
    )
  }
}
