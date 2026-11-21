// P1 tests: web project payload validation (project-validate.ts).
// Fixture matches the real v1 contract the renderer exports
// (exportLegacyProjectJson): per-frame layer stacks with PNG data URLs.
import { describe, expect, test } from 'bun:test';
import { validateProjectPayload } from '../src/lib/pixelforge/project-validate';

function validProject() {
  return {
    version: 1,
    name: 'Test Project',
    width: 32,
    height: 32,
    palette: ['#000000', '#ffffff'],
    clips: [
      {
        name: 'Idle',
        fps: 12,
        frames: [
          {
            id: 'fr_1',
            layers: [{ id: 'ly_1', name: 'Layer 1', visible: true, opacity: 1, png: 'data:image/png;base64,AAA' }],
          },
        ],
      },
    ],
  };
}

describe('web project payload validation (P1)', () => {
  test('accepts a well-formed v1 payload', () => {
    expect(validateProjectPayload(validProject())).toEqual([]);
  });

  test('accepts the exact shape exportLegacyProjectJson emits', () => {
    // exporter output for a fresh 32×32 project: every frame has all layers
    // with a transparent PNG — must never be rejected by the save guard
    const exported = {
      version: 1,
      name: 'untitled',
      width: 32,
      height: 32,
      palette: ['#000000'],
      clips: [
        {
          id: 'clip_1',
          name: 'idle',
          fps: 8,
          loop: true,
          frames: [
            { id: 'fr_1', layers: [{ id: 'ly_1', name: 'Layer 1', visible: true, opacity: 1, png: 'data:image/png;base64,iVBOR' }] },
          ],
        },
      ],
    };
    expect(validateProjectPayload(exported)).toEqual([]);
  });

  test('rejects wrong version / missing name / bad dims', () => {
    const bad = validProject() as Record<string, unknown>;
    bad.version = 2;
    expect(validateProjectPayload(bad).some((i) => i.path === 'project.version')).toBe(true);
    expect(validateProjectPayload({ ...validProject(), name: '' }).length).toBeGreaterThan(0);
    expect(validateProjectPayload({ ...validProject(), width: 0 }).some((i) => i.path === 'project.width')).toBe(true);
    expect(validateProjectPayload({ ...validProject(), height: 9999 }).some((i) => i.path === 'project.height')).toBe(true);
  });

  test('rejects non-hex palette entries', () => {
    const bad = validProject() as Record<string, unknown>;
    bad.palette = ['#000000', 'purple'];
    const issues = validateProjectPayload(bad);
    expect(issues.some((i) => i.path.startsWith('project.palette['))).toBe(true);
  });

  test('rejects frames without layers and layers without png', () => {
    const bad = validProject() as Record<string, unknown>;
    (bad.clips as unknown[]).push({ name: 'Empty', fps: 12 });
    expect(validateProjectPayload(bad).some((i) => i.path.startsWith('project.clips[1]'))).toBe(true);
    const noPng = validProject() as Record<string, unknown>;
    delete ((noPng.clips as Record<string, unknown>[])[0].frames as Record<string, unknown>[])[0].layers![0]!.png;
    expect(validateProjectPayload(noPng).some((i) => i.path.endsWith('.png'))).toBe(true);
  });

  test('rejects non-object payloads outright', () => {
    expect(validateProjectPayload(null).length).toBeGreaterThan(0);
    expect(validateProjectPayload('delete everything').length).toBeGreaterThan(0);
  });
});
