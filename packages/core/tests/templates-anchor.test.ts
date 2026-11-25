import { describe, expect, test } from 'bun:test';
import {
  SPRITE_TEMPLATES,
  cloneStyleProfile,
  collectUniqueOpaqueColors,
  defaultStyleProfile,
  isSpriteTemplateId,
  listSpriteTemplates,
  measureStyleAnchor,
  parseStyleProfile,
  renderSpriteTemplate,
  styleProfilePromptTags,
  type SpriteTemplateId,
} from '../src/index';

const FANTASY_PALETTE = [
  '#141013',
  '#2c2137',
  '#4b3d44',
  '#76428a',
  '#ac3232',
  '#d95763',
  '#df7126',
  '#eec39a',
  '#fbf236',
  '#6abe30',
  '#37946e',
  '#306082',
  '#5b6ee1',
  '#639bff',
  '#cbdbfc',
  '#ffffff',
];

describe('v0.4.0 Starter Sprite Templates', () => {
  test('catalog exposes all 8 templates with valid ids', () => {
    const list = listSpriteTemplates();
    expect(list.length).toBe(8);
    expect(list.length).toBe(SPRITE_TEMPLATES.length);
    for (const item of list) {
      expect(isSpriteTemplateId(item.id)).toBe(true);
    }
    expect(isSpriteTemplateId('not-a-template')).toBe(false);
  });

  test('every template renders cleanly at 16x16, 32x32, and 64x64 strictly within project palette', () => {
    const allowed = new Set(FANTASY_PALETTE.map((c) => c.toLowerCase()));
    const sizes = [16, 32, 64] as const;

    for (const info of SPRITE_TEMPLATES) {
      for (const size of sizes) {
        const res = renderSpriteTemplate(info.id as SpriteTemplateId, size, size, FANTASY_PALETTE);
        expect(res.width).toBe(size);
        expect(res.height).toBe(size);
        expect(res.buffer.length).toBe(size * size * 4);
        expect(res.bounds).not.toBeNull();
        expect(res.bounds!.w).toBeGreaterThan(2);
        expect(res.bounds!.h).toBeGreaterThan(2);
        expect(res.craftScore).toBeGreaterThanOrEqual(50);

        const colors = collectUniqueOpaqueColors([res.buffer]);
        expect(colors.length).toBeGreaterThanOrEqual(2);
        for (const [r, g, b] of colors) {
          const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
          expect(allowed.has(hex)).toBe(true);
        }

        for (const part of res.parts) {
          expect(part.rect.x).toBeGreaterThanOrEqual(0);
          expect(part.rect.y).toBeGreaterThanOrEqual(0);
          expect(part.rect.w).toBeGreaterThanOrEqual(1);
          expect(part.rect.h).toBeGreaterThanOrEqual(1);
          expect(part.rect.x + part.rect.w).toBeLessThanOrEqual(size);
          expect(part.rect.y + part.rect.h).toBeLessThanOrEqual(size);
        }
      }
    }
  });

  test('chibi-humanoid emits all 6 Motion body parts ready for rigging', () => {
    const res = renderSpriteTemplate('chibi-humanoid', 32, 32, FANTASY_PALETTE);
    const names = res.parts.map((p) => p.name);
    expect(names).toEqual(['head', 'body', 'armL', 'armR', 'legL', 'legR']);
  });
});

describe('v0.4.0 Hero Sprite Style Anchor', () => {
  test('measureStyleAnchor returns null for an empty buffer', () => {
    const empty = new Uint8ClampedArray(32 * 32 * 4);
    expect(measureStyleAnchor(empty, 32, 32, { label: 'Empty', clipId: 'c1', frameIndex: 0 })).toBeNull();
  });

  test('measureStyleAnchor accurately measures bounds, ground margin, outline style, and palette', () => {
    const hero = renderSpriteTemplate('chibi-humanoid', 32, 32, FANTASY_PALETTE);
    const anchor = measureStyleAnchor(hero.buffer, 32, 32, {
      label: 'Hero Knight',
      clipId: 'clip_idle',
      frameIndex: 0,
    });
    expect(anchor).not.toBeNull();
    expect(anchor!.label).toBe('Hero Knight');
    expect(anchor!.canvasWidth).toBe(32);
    expect(anchor!.canvasHeight).toBe(32);
    expect(anchor!.spriteWidth).toBe(hero.bounds!.w);
    expect(anchor!.spriteHeight).toBe(hero.bounds!.h);
    expect(anchor!.bottomMargin).toBe(32 - (hero.bounds!.y + hero.bounds!.h));
    expect(anchor!.heightRatio).toBeGreaterThan(0.4);
    expect(anchor!.heightRatio).toBeLessThanOrEqual(1);
    expect(['dark-ink', 'sel-out', 'lineless']).toContain(anchor!.outlineStyle);
    expect(anchor!.paletteUsed.length).toBeGreaterThanOrEqual(2);
    expect(anchor!.craftScore).toBeGreaterThanOrEqual(50);
  });

  test('StyleProfile parse, clone, and prompt tags preserve anchor and reject malformed anchors', () => {
    const hero = renderSpriteTemplate('slime', 32, 32, FANTASY_PALETTE);
    const anchor = measureStyleAnchor(hero.buffer, 32, 32, {
      label: 'Forest Slime',
      clipId: 'clip_idle',
      frameIndex: 0,
    })!;

    const profile = { ...defaultStyleProfile(), enabled: true, anchor };
    const parsed = parseStyleProfile(profile);
    expect(parsed).not.toBeNull();
    expect(parsed!.anchor?.label).toBe('Forest Slime');
    expect(parsed!.anchor?.spriteHeight).toBe(anchor.spriteHeight);

    const cloned = cloneStyleProfile(parsed!);
    expect(cloned.anchor).toEqual(parsed!.anchor);
    cloned.anchor!.paletteUsed.push('#000000');
    expect(parsed!.anchor!.paletteUsed.length).toBe(anchor.paletteUsed.length);

    const tags = styleProfilePromptTags(parsed!);
    expect(tags.some((t) => t.includes('Forest Slime') && t.includes(`${anchor.bottomMargin}px ground margin`))).toBe(true);

    // Malformed anchor (invalid outlineStyle) should be rejected by parseStyleProfile
    const bad = parseStyleProfile({
      ...profile,
      anchor: { ...anchor, outlineStyle: 'neon-glow' },
    });
    expect(bad).toBeNull();
  });
});
