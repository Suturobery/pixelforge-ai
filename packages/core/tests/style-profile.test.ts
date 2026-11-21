import { describe, expect, test } from 'bun:test';
import {
  CommandBus,
  defaultStyleProfile,
  parseStyleProfile,
  styleProfilePromptTags,
  createProject,
} from '../src';

describe('project style profile', () => {
  test('default is an enabled, editable profile', () => {
    const profile = defaultStyleProfile();
    expect(profile.enabled).toBe(true);
    expect(profile.paletteMode).toBe('enforce');
    expect(parseStyleProfile(profile)).toEqual(profile);
  });

  test('rejects malformed or oversized persisted profile data', () => {
    expect(parseStyleProfile({ enabled: true })).toBeNull();
    expect(
      parseStyleProfile({
        ...defaultStyleProfile(),
        artDirection: 'x'.repeat(181),
      })
    ).toBeNull();
    expect(
      parseStyleProfile({
        ...defaultStyleProfile(),
        lighting: 'sideways',
      })
    ).toBeNull();
  });

  test('keeps only bounded, unique project-frame reference pointers', () => {
    const profile = {
      ...defaultStyleProfile(),
      references: [{ clipId: 'cl_idle', frameId: 'fr_1', label: 'idle · frame 1' }],
    };
    expect(parseStyleProfile(profile)?.references).toEqual(profile.references);
    expect(
      parseStyleProfile({
        ...profile,
        references: [...profile.references, ...profile.references],
      })
    ).toBeNull();
    expect(
      parseStyleProfile({
        ...profile,
        references: [{ clipId: '../outside', frameId: 'fr_1', label: 'bad' }],
      })
    ).toBeNull();
  });

  test('keeps feedback cues bounded and safe for prompt construction', () => {
    const profile = {
      ...defaultStyleProfile(),
      feedback: { prefer: ['chunky silhouette'], avoid: ['smooth gradients'] },
    };
    expect(parseStyleProfile(profile)?.feedback).toEqual(profile.feedback);
    expect(parseStyleProfile({ ...profile, feedback: { prefer: ['bad\ncue'], avoid: [] } })).toBeNull();
    expect(parseStyleProfile({ ...profile, feedback: { prefer: Array(5).fill('trait'), avoid: [] } })).toBeNull();
  });

  test('style tags are descriptive only and preserve the user prompt ordering upstream', () => {
    const profile = {
      ...defaultStyleProfile(),
      enabled: true,
      artDirection: 'cozy 16-bit fantasy RPG',
      notes: 'chunky proportions; no gradients',
      feedback: { prefer: ['warm rim light'], avoid: ['smooth gradients'] },
    };
    expect(styleProfilePromptTags(profile)).toEqual([
      'project art direction: cozy 16-bit fantasy RPG',
      'lighting from the top left',
      'consistent dark 1-pixel outline',
      'camera angle: side view',
      'use only the supplied project palette',
      'isolated subject intended for a transparent background',
      'project style notes: chunky proportions; no gradients',
      'repeat this approved visual trait: warm rim light',
      'avoid this visual trait: smooth gradients',
    ]);
  });

  test('updates through the command bus and undoes exactly', () => {
    const project = createProject();
    const bus = new CommandBus(project);
    const profile = { ...defaultStyleProfile(), enabled: true, name: 'Forest sprites' };
    bus.execute('settings.setStyleProfile', { profile }, 'ui');
    expect(bus.getProject().settings.styleProfile).toEqual(profile);
    expect(bus.undo().ok).toBe(true);
    expect(bus.getProject().settings.styleProfile?.enabled).toBe(true);
  });
});
