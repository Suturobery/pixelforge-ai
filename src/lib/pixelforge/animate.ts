import type {
  MotionFramePlan,
  PixelGrid,
  PresetDef,
  PresetId,
  PresetParams,
  Rig,
} from './types'
import { composeFrame } from './composer'
import { DEFAULT_PARAMS } from './presets'

export interface GeneratedAnimation {
  presetId: PresetId
  preset: PresetDef
  params: PresetParams
  plans: MotionFramePlan[]
  frames: PixelGrid[]
  oobPerFrame: number[]
}

/** Generate + compose a full animation from a sprite, rig and preset. */
export function generateAnimation(
  base: PixelGrid,
  rig: Rig,
  preset: PresetDef,
  params: PresetParams = DEFAULT_PARAMS
): GeneratedAnimation {
  const plans = preset.buildFrames(rig, { ...DEFAULT_PARAMS, ...params })
  const frames: PixelGrid[] = []
  const oobPerFrame: number[] = []
  for (const plan of plans) {
    const { grid, oobPixels } = composeFrame(base, rig, plan.offsets)
    frames.push(grid)
    oobPerFrame.push(oobPixels)
  }
  return { presetId: preset.id, preset, params: { ...DEFAULT_PARAMS, ...params }, plans, frames, oobPerFrame }
}
