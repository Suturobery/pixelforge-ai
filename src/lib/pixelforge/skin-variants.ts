// PixelForge AI — materialize Sprite Skin / Palette Variant plans onto the CommandBus.
// Shared by the Palette Panel UI (`Skins`) and the `create_skin_variants` MCP tool.

import {
  buildSkinVariantPlan,
  type Clip,
  type CommandBus,
  type CommandOrigin,
  type PaletteRemapMode,
} from '@pixelforge/core'

export interface SkinVariantRequest {
  name: string
  palette: readonly string[]
}

export interface CreatedSkinVariant {
  clipId: string
  name: string
  frames: number
  layers: number
  remappedPixels: number
}

/**
 * Clone `sourceClip` into 1..N palette-swapped skin variant clips inside a
 * single undoable CommandBus transaction. The source clip is never mutated.
 */
export function materializeSkinVariants(
  bus: CommandBus,
  sourceClip: Clip,
  requests: readonly SkinVariantRequest[],
  origin: CommandOrigin,
  opts?: { mode?: PaletteRemapMode; label?: string },
): CreatedSkinVariant[] {
  const mode: PaletteRemapMode = opts?.mode === 'nearest' ? 'nearest' : 'ramp'
  const plans = requests
    .filter((r) => r.palette.length > 0 && r.name.trim().length > 0)
    .map((r) => buildSkinVariantPlan(sourceClip, { name: r.name, palette: r.palette, mode }))

  if (plans.length === 0) return []

  const created: CreatedSkinVariant[] = []
  const label =
    opts?.label ??
    (plans.length === 1
      ? `Create skin variant "${plans[0]!.name}"`
      : `Create ${plans.length} skin variants`)

  bus.transaction(label, origin, () => {
    for (const plan of plans) {
      bus.execute('clip.add', { name: plan.name, fps: plan.fps }, origin)
      const newClip = bus.getProject().clips.at(-1)
      if (!newClip) continue

      if (!plan.loop || plan.loopMode !== 'forward') {
        bus.execute(
          'clip.setProps',
          { clipId: newClip.id, loop: plan.loop, loopMode: plan.loopMode },
          origin,
        )
      }

      // clip.add creates 1 default layer and 1 default frame; match source layers
      const firstLayer = newClip.layers[0]
      const planFirstLayer = plan.layers[0]
      if (firstLayer && planFirstLayer) {
        bus.execute(
          'layer.setProps',
          {
            clipId: newClip.id,
            layerId: firstLayer.id,
            name: planFirstLayer.name,
            visible: planFirstLayer.visible,
            opacity: planFirstLayer.opacity,
            ...(planFirstLayer.blend ? { blend: planFirstLayer.blend } : {}),
          },
          origin,
        )
      }

      for (let li = 1; li < plan.layers.length; li++) {
        const srcL = plan.layers[li]!
        bus.execute('layer.add', { clipId: newClip.id, name: srcL.name }, origin)
        const addedLayer = bus.getProject().clips.find((c) => c.id === newClip.id)?.layers.at(-1)
        if (addedLayer) {
          bus.execute(
            'layer.setProps',
            {
              clipId: newClip.id,
              layerId: addedLayer.id,
              visible: srcL.visible,
              opacity: srcL.opacity,
              ...(srcL.blend ? { blend: srcL.blend } : {}),
            },
            origin,
          )
        }
      }

      // Match frame count and per-frame durations
      for (let fi = 1; fi < plan.frameDurations.length; fi++) {
        bus.execute('frame.add', { clipId: newClip.id }, origin)
      }

      const freshClip = bus.getProject().clips.find((c) => c.id === newClip.id)
      if (!freshClip) continue

      plan.frameDurations.forEach((durationMs, fi) => {
        const fr = freshClip.frames[fi]
        if (fr && durationMs > 0) {
          bus.execute('frame.setDuration', { clipId: freshClip.id, frameId: fr.id, durationMs }, origin)
        }
      })

      // Write remapped cel buffers
      for (const cel of plan.cels) {
        const fr = freshClip.frames[cel.frameIndex]
        const ly = freshClip.layers[cel.layerIndex]
        if (!fr || !ly) continue
        bus.execute(
          'pixels.applyOp',
          {
            clipId: freshClip.id,
            frameId: fr.id,
            layerId: ly.id,
            ops: [{ op: 'setBuffer' as const, buffer: cel.buffer }],
          },
          origin,
        )
      }

      // Restore layer lock flags AFTER pixel writes so locked layers still copy cleanly
      plan.layers.forEach((srcL, li) => {
        const ly = freshClip.layers[li]
        if (ly && srcL.locked) {
          bus.execute('layer.setProps', { clipId: freshClip.id, layerId: ly.id, locked: true }, origin)
        }
      })

      created.push({
        clipId: freshClip.id,
        name: freshClip.name,
        frames: freshClip.frames.length,
        layers: freshClip.layers.length,
        remappedPixels: plan.totalRemappedPixels,
      })
    }
  })

  return created
}
