import { composeFrameRgba, measureStyleAnchor, type Project } from '@pixelforge/core'

export interface AssetSetRow {
  clipId: string
  clipName: string
  actor: boolean
  sampleFrame: number
  width: number | null
  height: number | null
  groundMargin: number | null
  outline: string | null
  issues: string[]
}

/** Advisory preflight of each clip's representative frame. Actor comparisons
 * are opt-in because props, VFX, and tiles should not match a hero's height. */
export function reviewAssetSet(project: Project, actorClipIds: readonly string[]): AssetSetRow[] {
  const anchor = project.settings.styleProfile?.anchor
  const actors = new Set(actorClipIds)
  const palette = new Set(project.palette.map((color) => color.slice(0, 7).toLowerCase()))
  return project.clips.map((clip) => {
    const sampleFrame = clip.id === anchor?.clipId
      ? Math.min(anchor.frameIndex, clip.frames.length - 1)
      : 0
    const frame = clip.frames[sampleFrame]
    const issues: string[] = []
    if (!frame) return { clipId: clip.id, clipName: clip.name, actor: actors.has(clip.id), sampleFrame, width: null, height: null, groundMargin: null, outline: null, issues: ['No frame to inspect'] }
    const rgba = composeFrameRgba(project, clip, frame)
    const measured = measureStyleAnchor(rgba, project.width, project.height, { label: clip.name, clipId: clip.id, frameIndex: sampleFrame })
    if (!measured) issues.push('Representative frame is empty')
    let outsidePalette = 0
    const outside = new Set<string>()
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] === 0) continue
      const color = `#${rgba[i]!.toString(16).padStart(2, '0')}${rgba[i + 1]!.toString(16).padStart(2, '0')}${rgba[i + 2]!.toString(16).padStart(2, '0')}`
      if (!palette.has(color) && !outside.has(color)) { outside.add(color); outsidePalette++ }
    }
    if (outsidePalette > 0) issues.push(`${outsidePalette} color${outsidePalette === 1 ? '' : 's'} outside project palette`)
    if (anchor && measured && actors.has(clip.id) && clip.id !== anchor.clipId) {
      if (Math.abs(measured.spriteHeight - anchor.spriteHeight) > 2) issues.push(`Sprite height ${measured.spriteHeight}px vs anchor ${anchor.spriteHeight}px`)
      if (Math.abs(measured.bottomMargin - anchor.bottomMargin) > 1) issues.push(`Ground line ${measured.bottomMargin}px vs anchor ${anchor.bottomMargin}px`)
      if (measured.outlineStyle !== anchor.outlineStyle) issues.push(`Outline ${measured.outlineStyle} vs anchor ${anchor.outlineStyle}`)
    }
    return {
      clipId: clip.id,
      clipName: clip.name,
      actor: actors.has(clip.id),
      sampleFrame,
      width: measured?.spriteWidth ?? null,
      height: measured?.spriteHeight ?? null,
      groundMargin: measured?.bottomMargin ?? null,
      outline: measured?.outlineStyle ?? null,
      issues,
    }
  })
}
