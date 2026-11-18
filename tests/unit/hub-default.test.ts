import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_APPEARANCE_PREFS,
  HUB_DEFAULT_REV,
  UI_MODE_DEFAULT_REV,
} from '../../src/renderer/store/settings-slice';

// The agent office is off by default in remotea (HUB_DEFAULT_REV 2). wmux
// turned it on for everyone in 2.3.0 (rev 1); remotea switches every profile
// off once, including profiles that had it on, through the same promotion that
// TRACE used in 1.5.0. The two promotions must not interfere.

const APPEARANCE_KEY = 'remotea-appearance-prefs';

// The settings file is read ONCE at module load, so a stored blob can only be
// injected by stubbing window before a fresh import of the slice.
async function loadWith(stored?: Record<string, unknown>) {
  const writes: Record<string, unknown> = {};
  vi.resetModules();
  vi.stubGlobal('window', {
    wmux: {
      settings: {
        getAllSync: () => (stored ? { [APPEARANCE_KEY]: stored } : {}),
        set: (key: string, value: unknown) => { writes[key] = value; },
      },
    },
  });
  const mod = await import('../../src/renderer/store/settings-slice');
  return { prefs: mod.loadAppearancePrefs(), writes };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('agent office default', () => {
  it('ships off', () => {
    expect(DEFAULT_APPEARANCE_PREFS.hubEnabled).toBe(false);
    expect(HUB_DEFAULT_REV).toBe(2);
  });

  it('gives a fresh install no office (AE4)', async () => {
    const { prefs } = await loadWith();
    expect(prefs.hubEnabled).toBe(false);
  });

  // The whole point of the rev: a plain default change reaches nobody, because
  // setAppearancePrefs persists the entire block and the stored true wins.
  it('switches off a rev-1 profile that had the office on, once', async () => {
    const { prefs, writes } = await loadWith({
      uiTheme: 'light',
      hubEnabled: true,
      hubDefaultRev: 1,
      uiModeDefaultRev: UI_MODE_DEFAULT_REV,
    });
    expect(prefs.hubEnabled).toBe(false);
    expect(prefs.hubDefaultRev).toBe(HUB_DEFAULT_REV);
    // Promotion must be recorded on disk immediately, or it repeats every launch.
    expect((writes[APPEARANCE_KEY] as { hubDefaultRev: number }).hubDefaultRev)
      .toBe(HUB_DEFAULT_REV);
  });

  it('keeps every other stored preference while promoting', async () => {
    const { prefs } = await loadWith({
      uiTheme: 'light',
      terminalBgOpacity: 40,
      hubEnabled: true,
      hubDefaultRev: 1,
      uiModeDefaultRev: UI_MODE_DEFAULT_REV,
    });
    expect(prefs.uiTheme).toBe('light');
    expect(prefs.terminalBgOpacity).toBe(40);
  });

  // The promotion is one-time, so switching it back on has to stick.
  it('leaves a post-promotion opt-in alone', async () => {
    const { prefs, writes } = await loadWith({
      hubEnabled: true,
      hubDefaultRev: HUB_DEFAULT_REV,
      uiModeDefaultRev: UI_MODE_DEFAULT_REV,
    });
    expect(prefs.hubEnabled).toBe(true);
    expect(writes[APPEARANCE_KEY]).toBeUndefined();
  });
});

describe('promotion independence', () => {
  // The reason hubDefaultRev is its own counter instead of a bump of
  // UI_MODE_DEFAULT_REV. A shared rev would re-promote uiMode here and drag a
  // deliberate classic choice back to TRACE.
  it('does not disturb a settled classic choice while turning the office off', async () => {
    const { prefs } = await loadWith({
      uiMode: 'classic',
      uiModeDefaultRev: UI_MODE_DEFAULT_REV,
      hubEnabled: true,
      hubDefaultRev: 1,
    });
    expect(prefs.uiMode).toBe('classic');
    expect(prefs.hubEnabled).toBe(false);
  });

  // The mirror case: a pre-1.5.0 blob is due BOTH promotions in one load.
  it('applies both promotions to a legacy blob and stamps both revs', async () => {
    const { prefs, writes } = await loadWith({ uiTheme: 'dark', uiMode: 'classic', hubEnabled: true });
    expect(prefs.uiMode).toBe('trace');
    expect(prefs.hubEnabled).toBe(false);
    const written = writes[APPEARANCE_KEY] as Record<string, number>;
    expect(written.uiModeDefaultRev).toBe(UI_MODE_DEFAULT_REV);
    expect(written.hubDefaultRev).toBe(HUB_DEFAULT_REV);
  });

  // A blob already reconciled against both revs must not be rewritten at all —
  // a write on every launch would mean the promotion never actually settled.
  it('is a no-op once every rev is current', async () => {
    const { writes } = await loadWith({
      uiMode: 'classic',
      uiModeDefaultRev: UI_MODE_DEFAULT_REV,
      hubEnabled: true,
      hubDefaultRev: HUB_DEFAULT_REV,
    });
    expect(writes[APPEARANCE_KEY]).toBeUndefined();
  });
});
