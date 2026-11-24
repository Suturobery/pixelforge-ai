import { describe, expect, test } from 'bun:test'
import {
  PIXEL_ART_RECIPES,
  applyPixelArtRecipe,
  buildAssetBrief,
  defaultBriefFields,
  detectRecipeSuitability,
  type BriefProject,
} from '@/lib/pixelforge/asset-brief'

const project: BriefProject = {
  name: 'Recipe Test',
  width: 32,
  height: 32,
  palette: ['#101018', '#39405c', '#f4d35e', '#f7f7ff'],
  clips: [],
  settings: { styleProfile: { enabled: true, artDirection: 'chunky retro', lighting: 'top-left', outline: 'dark 1px', transparentBackground: true } },
}

const memory = { avoid: ['pillow shading'], prefer: ['strong silhouette'] }

describe('Pixel Art Recipes', () => {
  test('every recipe applies meaningful defaults without dropping shared fields', () => {
    const base = { ...defaultBriefFields(project, memory), notes: 'keep this note', references: ['Idle'] }
    for (const recipe of PIXEL_ART_RECIPES) {
      const result = applyPixelArtRecipe(base, recipe.id)
      expect(result.assetType.length).toBeGreaterThan(0)
      expect(result.poseGoal.length).toBeGreaterThan(0)
      expect(result.requiredDetails.length).toBeGreaterThan(0)
      expect(result.notes).toBe('keep this note')
      expect(result.references).toEqual(['Idle'])
    }
  })

  test('generated contract requires staged drawing, native review, palette discipline, and refinement', () => {
    const fields = applyPixelArtRecipe(defaultBriefFields(project, memory), 'character')
    const { detail } = buildAssetBrief(fields, project, memory)
    expect(detail).toContain('EXECUTION CONTRACT')
    expect(detail).toContain('actually draw in the active PixelForge project')
    expect(detail).toContain('SILHOUETTE')
    expect(detail).toContain('get_frame_png at native 1x size')
    expect(detail).toContain('project-palette colors only')
    expect(detail).toContain('validate_style')
    expect(detail).toContain('repeat preview and fixes')
    expect(detail).toContain('No image generation')
  })

  test('animated recipes require timing, tags, and animation preview', () => {
    const fields = applyPixelArtRecipe(defaultBriefFields(project, memory), 'vfx')
    const { detail } = buildAssetBrief(fields, project, memory)
    expect(detail).toContain('set_frame_duration')
    expect(detail).toContain('set_clip_tags')
    expect(detail).toContain('preview_animation')
    expect(detail).toContain('loop continuity')
  })

  test('single-frame recipes require composition and 1x readability', () => {
    const fields = applyPixelArtRecipe(defaultBriefFields(project, memory), 'ui-icon')
    const { detail } = buildAssetBrief(fields, project, memory)
    expect(detail).toContain('COMPOSE')
    expect(detail).toContain('recognizable at native 1x')
    expect(detail).not.toContain('set_frame_duration')
  })

  test('brief stays within the task-board limit and truncates safely', () => {
    const fields = {
      ...applyPixelArtRecipe(defaultBriefFields(project, memory), 'character'),
      notes: 'important artist direction '.repeat(300),
      requiredDetails: 'ornament '.repeat(300),
      references: Array.from({ length: 100 }, (_, index) => `Reference ${index}`),
    }
    const result = buildAssetBrief(fields, project, memory)
    expect(result.detail.length).toBeLessThanOrEqual(2000)
    expect(result.detail).toContain('EXECUTION CONTRACT')
    expect(result.detail).toContain('brain_complete_task')
  })

  test('every recipe defines suitable asset types and contextual placeholder', () => {
    for (const recipe of PIXEL_ART_RECIPES) {
      expect(recipe.suitableAssetTypes.length).toBeGreaterThanOrEqual(3)
      expect(recipe.placeholder.length).toBeGreaterThan(0)
    }
  })

  test('detectRecipeSuitability categorizes asset types accurately', () => {
    expect(detectRecipeSuitability('dungeon brick wall autotile')).toBe('tileset')
    expect(detectRecipeSuitability('platformer ground & ledges')).toBe('tileset')
    expect(detectRecipeSuitability('knight hero sprite')).toBe('character')
    expect(detectRecipeSuitability('slime boss monster')).toBe('enemy')
    expect(detectRecipeSuitability('health potion consumable')).toBe('item')
    expect(detectRecipeSuitability('fireball burst explosion')).toBe('vfx')
    expect(detectRecipeSuitability('heart life icon')).toBe('ui-icon')
    expect(detectRecipeSuitability('')).toBe(null)
  })

  test('applyPixelArtRecipe switches assetType when switching to tileset or unsuitable category', () => {
    const characterBase = { ...defaultBriefFields(project, memory), assetType: 'knight hero sprite' }
    // When picking tileset, "knight hero sprite" is unsuitable so it changes to tileset defaults
    const tilesetResult = applyPixelArtRecipe(characterBase, 'tileset')
    expect(detectRecipeSuitability(tilesetResult.assetType)).toBe('tileset')
    expect(tilesetResult.poseGoal).toContain('tile sheet')

    // If already a tileset assetType, keep user's specific tileset type
    const customTileset = { ...defaultBriefFields(project, memory), assetType: 'dungeon brick wall autotile' }
    const preservedResult = applyPixelArtRecipe(customTileset, 'tileset')
    expect(preservedResult.assetType).toBe('dungeon brick wall autotile')
  })
})
