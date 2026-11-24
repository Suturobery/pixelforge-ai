import { expect, test } from 'bun:test'
import { composeFrameRgba, createProject, encodePng } from '@pixelforge/core'
import { currentProjectIdentity, executeMcpTool, type ToolReview } from '@/lib/pixelforge/mcp-tools'
import { getBus, useEditor } from '@/lib/pixelforge/store'

const context = { clientId: 'test-agent', clientName: 'Test agent', tier: 'L1' as const }

test('one set_pixels call preserves fallback and per-pixel colors in order and undoes atomically', async () => {
  useEditor.getState().newProject(createProject({ width: 16, height: 16 }))
  const pixels = [
    { x: 1, y: 0, color: '#445566' },
    { x: 0, y: 0 },
    { x: 1, y: 0, color: '#aabbcc' },
  ]
  const read = () => {
    const project = getBus().getProject()
    const clip = project.clips[0]!
    return Array.from(composeFrameRgba(project, clip, clip.frames[0]!).slice(0, 8))
  }
  const before = read()
  const result = await executeMcpTool('set_pixels', { color: '#112233', pixels }, context)
  expect(result.ok).toBeTrue()
  expect(read()).toEqual([17, 34, 51, 255, 170, 187, 204, 255])
  expect((await executeMcpTool('undo', {}, context)).ok).toBeTrue()
  expect(read()).toEqual(before)
})

test('review captures the edited cel even if a different clip is selected', async () => {
  useEditor.getState().newProject(createProject({ width: 16, height: 16 }))
  const bus = getBus()
  const idle = bus.getProject().clips[0]!
  bus.execute('clip.add', { name: 'Walk' }, 'ui')
  const clip = bus.getProject().clips.find((item) => item.name === 'Walk')!
  bus.execute('frame.add', { clipId: clip.id }, 'ui')
  bus.execute('layer.add', { clipId: clip.id, name: 'Sword' }, 'ui')
  useEditor.getState().selectClip(idle.id)
  const walk = bus.getProject().clips.find((item) => item.id === clip.id)!
  const reviews: ToolReview[] = []

  const result = await executeMcpTool('set_pixels', {
    clipName: 'Walk',
    frameIndex: 1,
    layerName: 'Sword',
    pixels: [{ x: 0, y: 0 }],
    color: '#ff0000',
  }, { ...context, onReview: (snapshot) => reviews.push(snapshot) })

  expect(result.ok).toBeTrue()
  expect(reviews).toHaveLength(1)
  const review = reviews[0]!
  expect(review.clipId).toBe(walk.id)
  expect(review.frameId).toBe(walk.frames[1]!.id)
  expect(review.frameNumber).toBe(2)
  expect(review.layerName).toBe('Sword')
  expect(Array.from(review.before.buffer.slice(0, 4))).toEqual([0, 0, 0, 0])
  expect(Array.from(review.after.buffer.slice(0, 4))).toEqual([255, 0, 0, 255])
  expect(composeFrameRgba(bus.getProject(), idle, idle.frames[0]!)[3]).toBe(0)
})

test('renderer refuses a task edit whose project changed since relay', async () => {
  useEditor.getState().newProject(createProject({ name: 'A', width: 16, height: 16 }))
  const expectedProjectKey = currentProjectIdentity().key
  useEditor.getState().newProject(createProject({ name: 'B', width: 16, height: 16 }))
  const replacement = getBus().getProject()
  const result = await executeMcpTool('set_pixels', {
    pixels: [{ x: 0, y: 0 }],
    color: '#ff0000',
  }, { ...context, expectedProjectKey })

  expect(result.error?.code).toBe('task_project_mismatch')
  expect(getBus().getProject()).toBe(replacement)
})

test('resize review preserves both snapshot sizes on a rectangular canvas', async () => {
  useEditor.getState().newProject(createProject({ width: 16, height: 24 }))
  const reviews: ToolReview[] = []
  const result = await executeMcpTool('resize_canvas', { width: 24, height: 16 }, {
    ...context, tier: 'L2', onReview: (snapshot) => reviews.push(snapshot),
  })

  expect(result.ok).toBeTrue()
  expect(reviews).toHaveLength(1)
  expect(reviews[0]!.before).toMatchObject({ width: 16, height: 24 })
  expect(reviews[0]!.after).toMatchObject({ width: 24, height: 16 })
  expect(reviews[0]!.layerId).toBeUndefined()
})

test('a pending PNG decode cannot add an image to a different project', async () => {
  useEditor.getState().newProject(createProject({ name: 'A', width: 16, height: 16 }))
  const expectedProjectKey = currentProjectIdentity().key
  const png = await encodePng(16, 16, new Uint8ClampedArray(16 * 16 * 4))
  const pending = executeMcpTool('import_image_as_layer', {
    name: 'Key', pngBase64: Buffer.from(png).toString('base64'),
  }, { ...context, expectedProjectKey })
  useEditor.getState().newProject(createProject({ name: 'B', width: 16, height: 16 }))
  const replacement = getBus().getProject()

  expect((await pending).error?.code).toBe('task_project_mismatch')
  expect(getBus().getProject()).toBe(replacement)
})
