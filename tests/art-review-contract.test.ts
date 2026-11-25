import { expect, test } from 'bun:test'
import { buildArtRevision } from '@/lib/pixelforge/art-review-contract'

const input = {
  taskId: 'bt_hero_1',
  taskTitle: 'Pixel art recipe: hero',
  clipId: 'clip-hero',
  clipName: 'Hero Idle',
  frameIndex: 1,
  focus: ['Silhouette', 'Animation'] as const,
  note: 'The sword disappears at native size. Keep the pose and palette.',
  craftFindings: ['Two orphan pixels at (4, 8)'],
  styleFindings: ['Palette contains one unsupported color'],
  animated: true,
}

test('revision task targets the selected frame and requires real pixel review', () => {
  const result = buildArtRevision(input)
  expect(result?.detail).toContain('clipId clip-hero')
  expect(result?.detail).toContain('frame 2')
  expect(result?.detail).toContain('The sword disappears at native size')
  expect(result?.detail).toContain('preview_animation')
  expect(result?.detail).toContain('brain_complete_task')
  expect(result?.detail).toContain('do not only describe a fix or use image generation')
})

test('blank feedback cannot queue a revision, and large feedback preserves the execution steps', () => {
  expect(buildArtRevision({ ...input, focus: [], note: '' })).toBeNull()
  const result = buildArtRevision({
    ...input,
    note: 'redraw the outline '.repeat(100),
    craftFindings: ['pixel artifact '.repeat(100), 'another artifact '.repeat(100)],
    styleFindings: ['palette warning '.repeat(100)],
  })
  expect(result?.detail.length).toBeLessThanOrEqual(2000)
  expect(result?.detail).toContain('brain_complete_task')
  expect(result?.detail).toContain('Artist feedback:')
})
