import { encodePng, styleProfilePromptTags, zipWrite, type StyleProfile } from '@pixelforge/core'

/** Two native-resolution views separated by a transparent gutter. */
function drawStudy(buffer: Uint8ClampedArray, size: number) {
  const width = size * 2 + 2
  const guide = new Uint8ClampedArray(width * size * 4)
  for (let i = 0; i < size * size; i++) {
    const src = i * 4
    const dst = (Math.floor(i / size) * width + i % size) * 4
    const alpha = buffer[src + 3]
    if (!alpha) continue
    guide.set([32, 32, 32, alpha], dst)
    const luma = 0.2126 * buffer[src] + 0.7152 * buffer[src + 1] + 0.0722 * buffer[src + 2]
    const value = luma < 85 ? 48 : luma < 170 ? 136 : 224
    guide.set([value, value, value, alpha], dst + (size + 2) * 4)
  }
  return encodePng(width, size, guide)
}

export async function buildSketchPack({ buffer, targetSize, brief, profile, palette, referencePng }: {
  buffer: Uint8ClampedArray
  targetSize: 16 | 32
  brief: string
  profile: StyleProfile
  palette: string[]
  referencePng?: Uint8Array
}) {
  if (!buffer.some((channel, i) => i % 4 === 3 && channel > 0)) {
    throw new Error('Draw a rough sketch on a visible layer in the active frame first.')
  }
  const prompt = [
    brief.trim() || 'Finish the attached sketch as a game sprite.',
    `Use sketch.png for pose, proportions, and framing. Return one ${targetSize}×${targetSize} PNG with crisp pixel edges.`,
    referencePng && 'Use style-reference.png for the rendering style.',
    ...styleProfilePromptTags(profile),
    profile.enabled && profile.paletteMode !== 'none' && `Project palette: ${palette.join(', ')}`,
    '',
    'Drawing and review:',
    '1. Identify the feature that makes the subject recognizable. Block in its silhouette and pose before adding details. Keep deliberate gaps where overlapping forms need separation.',
    '2. Use study.png as a diagnostic: the left panel shows all visible pixels as one shape; the right groups their brightness into three values. An opaque background also appears in these views. Use the brief and sketch to identify the subject.',
    '3. Group light and shadow into connected patches. Reserve small high-contrast marks for features that matter at game size. Follow the reference when it uses a different treatment.',
    '4. Inspect the finished sprite at native size. Can you recognize the subject and read the pose? If a feature disappears, revise its shape or contrast and inspect again. Deliver only the finished sprite.',
  ].filter(Boolean).join('\n')
  const entries = [
    { name: 'sketch.png', data: await encodePng(targetSize, targetSize, buffer) },
    { name: 'study.png', data: await drawStudy(buffer, targetSize) },
    { name: 'prompt.txt', data: new TextEncoder().encode(prompt) },
  ]
  if (referencePng) entries.push({ name: 'style-reference.png', data: referencePng })
  return zipWrite(entries)
}
