/** Bounded follow-up for a finished PixelForge agent task. The IDE agent
 * receives the artist's critique and the precise canvas target, then edits
 * through the existing MCP permission and project gates. */

export const REVIEW_FOCUS = [
  'Silhouette',
  'Palette',
  'Shading',
  'Pixel cleanup',
  'Animation',
] as const

export type ReviewFocus = (typeof REVIEW_FOCUS)[number]

export interface ArtRevisionInput {
  taskId: string
  taskTitle: string
  clipId: string
  clipName: string
  frameIndex: number
  focus: readonly ReviewFocus[]
  note: string
  craftFindings: readonly string[]
  styleFindings: readonly string[]
  animated: boolean
}

export function buildArtRevision(input: ArtRevisionInput): { title: string; detail: string } | null {
  const note = input.note.trim().slice(0, 600)
  const focus = input.focus.filter((item) => REVIEW_FOCUS.includes(item))
  if (!note && focus.length === 0) return null
  if (!input.taskId || !input.clipId || !Number.isInteger(input.frameIndex) || input.frameIndex < 0) return null

  const title = `Revise artwork: ${input.clipName.slice(0, 140)}`.slice(0, 200)
  const lines = [
    'ARTIST REVISION REQUEST — edit the active PixelForge project using MCP tools; do not only describe a fix or use image generation.',
    `Original task: ${input.taskId.slice(0, 100)} (${input.taskTitle.slice(0, 140)}).`,
    `Target clip: ${input.clipName.slice(0, 100)} (clipId ${input.clipId.slice(0, 120)}), frame ${input.frameIndex + 1}. Keep unrelated clips and frames intact.`,
    `Artist focus: ${focus.length ? focus.join(', ') : 'see note'}.`,
    '1. Inspect get_project_state, get_frame_png, get_palette, analyze_pixel_craft, and validate_style on the target frame.',
    '2. Preserve the approved direction and existing useful pixels; revise silhouette first, then color clusters and details with project-palette colors.',
    input.animated
      ? '3. Check preview_animation and frame timing; revise relevant frames for consistent motion without flicker.'
      : '3. Review the result at native 1x and enlarged pixel view; fix any new artifacts.',
    '4. Inspect the final PNG, rerun technical checks, and brain_complete_task with a concise summary. Leave the result visible for artist approval.',
  ]
  const extras = [
    note ? `Artist feedback: ${note}` : '',
    input.craftFindings.length ? `Craft hints (heuristics; inspect before fixing): ${input.craftFindings.slice(0, 3).map((item) => item.slice(0, 110)).join('; ')}.` : '',
    input.styleFindings.length ? `Style warnings: ${input.styleFindings.slice(0, 3).map((item) => item.slice(0, 110)).join('; ')}.` : '',
  ].filter(Boolean)
  let detail = lines.join('\n')
  for (const extra of extras) {
    const room = 2000 - detail.length - 1
    if (room > 20) detail += `\n${extra.slice(0, room)}`
  }
  return { title, detail }
}
