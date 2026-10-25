// PixelForge AI — project persistence API (list + upsert)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isSerializedProject } from '@/lib/pixelforge/project-io'
import { guardStateChange, guardRead } from '@/lib/pixelforge/api-guard'
import type { SerializedProject } from '@/lib/pixelforge/types'

export async function GET(req: NextRequest) {
  const denied = guardRead(req)
  if (denied) return denied
  try {
    const rows = await db.project.findMany({
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true, width: true, height: true, updatedAt: true },
    })
    return NextResponse.json({ ok: true, projects: rows })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Failed to list projects' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  // Interim state-change guard (Task 8 replaces with pairing + tiers).
  const denied = guardStateChange(req)
  if (denied) return denied

  try {
    const body = (await req.json()) as { id?: string | null; project: SerializedProject }
    if (!isSerializedProject(body.project)) {
      return NextResponse.json({ ok: false, error: 'Invalid project payload' }, { status: 400 })
    }
    const data = JSON.stringify(body.project)
    const palette = JSON.stringify(body.project.palette)

    let id: string
    if (body.id) {
      const existing = await db.project.findUnique({ where: { id: body.id }, select: { id: true } })
      if (existing) {
        const updated = await db.project.update({
          where: { id: body.id },
          data: {
            name: body.project.name,
            width: body.project.width,
            height: body.project.height,
            palette,
            data,
          },
          select: { id: true },
        })
        id = updated.id
      } else {
        const created = await db.project.create({
          data: {
            name: body.project.name,
            width: body.project.width,
            height: body.project.height,
            palette,
            data,
          },
          select: { id: true },
        })
        id = created.id
      }
    } else {
      const created = await db.project.create({
        data: {
          name: body.project.name,
          width: body.project.width,
          height: body.project.height,
          palette,
          data,
        },
        select: { id: true },
      })
      id = created.id
    }
    return NextResponse.json({ ok: true, id })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Failed to save project' },
      { status: 500 }
    )
  }
}
