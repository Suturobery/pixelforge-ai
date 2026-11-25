import { describe, expect, test } from 'bun:test'
import {
  generateGodot4SpriteFramesTres,
  buildExportArtifacts,
  buildAtlasExportArtifacts,
} from '@/lib/pixelforge/export'
import {
  buildAsepriteJson,
  buildAtlasAsepriteJson,
  composeAtlasRgba,
  createProject,
  createClip,
  createFrame,
  decodePng,
} from '@pixelforge/core'

describe('Godot 4 SpriteFrames (.tres) Exporter', () => {
  test('generates valid Godot 4 text resource format with frames and animations', () => {
    const tres = generateGodot4SpriteFramesTres({
      sheetFilename: 'hero_idle_sheet.png',
      clipName: 'idle',
      fps: 8,
      loop: true,
      frames: [
        { index: 0, x: 0, y: 0, w: 32, h: 32, durationMs: 125 },
        { index: 1, x: 32, y: 0, w: 32, h: 32, durationMs: 250 },
      ],
      tags: [{ name: 'blink', from: 1, to: 1 }],
    })

    expect(tres).toContain('[gd_resource type="SpriteFrames"')
    expect(tres).toContain('format=3')
    expect(tres).toContain('[ext_resource type="Texture2D" path="res://hero_idle_sheet.png" id="1_tex"]')
    expect(tres).toContain('[sub_resource type="AtlasTexture" id="AtlasTexture_0"]')
    expect(tres).toContain('region = Rect2(0, 0, 32, 32)')
    expect(tres).toContain('[sub_resource type="AtlasTexture" id="AtlasTexture_1"]')
    expect(tres).toContain('region = Rect2(32, 0, 32, 32)')
    expect(tres).toContain('name": &"idle"')
    expect(tres).toContain('speed": 8')
    expect(tres).toContain('name": &"blink"')
  })

  test('buildExportArtifacts includes .tres artifact when includeTres is true', async () => {
    const project = createProject({ name: 'GodotTest', width: 16, height: 16 })
    const clip = project.clips[0]
    clip.tags = [{ name: 'walk', from: 0, to: 0 }]

    const artifacts = await buildExportArtifacts(
      project,
      {
        scope: 'clip',
        clipId: clip.id,
        format: 'sheet',
        includeJson: true,
      },
      1,
      true,
    )

    const filenames = artifacts.map((a) => a.filename)
    expect(filenames.some((f) => f.endsWith('.png'))).toBeTrue()
    expect(filenames.some((f) => f.endsWith('.json'))).toBeTrue()
    expect(filenames.some((f) => f.endsWith('.tres'))).toBeTrue()

    const tresArtifact = artifacts.find((a) => a.filename.endsWith('.tres'))
    expect(tresArtifact).toBeDefined()
    const content = new TextDecoder().decode(tresArtifact!.bytes)
    expect(content).toContain('SpriteFrames')
    expect(content).toContain('&"walk"')
  })

  test('buildAsepriteJson emits Unity/Phaser/Godot-compatible frames hash & scaled coords', () => {
    const project = createProject({ name: 'Knight', width: 16, height: 16 })
    const clip = project.clips[0]!
    clip.name = 'idle'
    clip.fps = 10
    clip.loopMode = 'pingpong'
    const f2 = createFrame(16, 16, clip.layers)
    f2.durationMs = 150
    clip.frames.push(f2)
    clip.tags = [{ name: 'breathe', from: 0, to: 1 }]

    const ase = buildAsepriteJson(project, clip, { columns: 0, padding: 1, spacing: 2 }, 'knight_idle_sheet.png', 2)
    expect(ase.meta.image).toBe('knight_idle_sheet.png')
    expect(ase.meta.format).toBe('RGBA8888')
    expect(ase.meta.scale).toBe('2')
    // Native sheet: 2*1 + 2*16 + 2 = 36 wide, 2*1 + 16 = 18 tall -> 2x = 72x36
    expect(ase.meta.size).toEqual({ w: 72, h: 36 })
    expect(ase.frames.idle_00.frame).toEqual({ x: 2, y: 2, w: 32, h: 32 })
    expect(ase.frames.idle_01.frame).toEqual({ x: 38, y: 2, w: 32, h: 32 })
    expect(ase.frames.idle_01.duration).toBe(150)
    expect(ase.meta.frameTags).toEqual([
      { name: 'idle', from: 0, to: 1, direction: 'pingpong' },
      { name: 'breathe', from: 0, to: 1, direction: 'pingpong' },
    ])
  })

  test('Master Atlas packs all clips into one PNG + Aseprite JSON + combined Godot 4 .tres', async () => {
    const project = createProject({ name: 'HeroPack', width: 16, height: 16 })
    const idle = project.clips[0]!
    idle.name = 'idle'
    idle.frames.push(createFrame(16, 16, idle.layers))
    const walk = createClip({ name: 'walk', width: 16, height: 16, fps: 12, loop: true, frameCount: 3 })
    project.clips.push(walk)

    const { layout } = composeAtlasRgba(project, { padding: 1, spacing: 1 })
    expect(layout.clips.length).toBe(2)
    expect(layout.frames.length).toBe(5)
    expect(layout.columns).toBe(3)
    expect(layout.rows).toBe(2)

    const ase = buildAtlasAsepriteJson(project, { padding: 1, spacing: 1 }, 'heropack_atlas.png', 1)
    expect(ase.meta.frameTags).toEqual([
      { name: 'idle', from: 0, to: 1, direction: 'forward' },
      { name: 'walk', from: 2, to: 4, direction: 'forward' },
    ])

    const artifacts = await buildAtlasExportArtifacts(project, {
      scale: 2,
      padding: 1,
      spacing: 1,
      includeJson: true,
      jsonFormat: 'aseprite',
      includeTres: true,
    })
    expect(artifacts.map((a) => a.filename)).toEqual([
      'heropack_atlas.png',
      'heropack_atlas.json',
      'heropack_atlas.tres',
    ])

    const png = await decodePng(artifacts[0]!.bytes)
    expect(png.width).toBe(layout.width * 2)
    expect(png.height).toBe(layout.height * 2)

    const tresText = new TextDecoder().decode(artifacts[2]!.bytes)
    expect(tresText).toContain('path="res://heropack_atlas.png"')
    expect(tresText).toContain('&"idle"')
    expect(tresText).toContain('&"walk"')
    expect(tresText).toContain('AtlasTexture_4')
  })
})
