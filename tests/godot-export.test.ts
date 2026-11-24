import { describe, expect, test } from 'bun:test'
import { generateGodot4SpriteFramesTres, buildExportArtifacts } from '@/lib/pixelforge/export'
import { createProject, createClip, createFrame } from '@pixelforge/core'

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
})
