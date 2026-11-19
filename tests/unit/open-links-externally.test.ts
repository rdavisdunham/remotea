import { describe, expect, it } from 'vitest';
import { linkOpensExternally } from '../../src/renderer/utils/open-in-browser';

/**
 * Where a clicked link goes (issue #201).
 *
 * `browserPrefs.openLinksExternally` picks the destination and Ctrl/Cmd
 * INVERTS it — it does not force the system browser. That distinction is the
 * whole feature: forcing would mean someone who turns the setting on can never
 * reach the panel again, which is worse than the Ctrl+click-only behaviour the
 * request was about.
 *
 * The truth table is pinned rather than the routing because the routing needs a
 * live store, a split tree and a webview; the decision is the part that can be
 * wrong, and it is four cases.
 */
describe('linkOpensExternally', () => {
  it('sends a plain click to the panel by default', () => {
    // The shipped default. Unchanged behaviour for everyone who never opens
    // Settings, which is why openLinksExternally defaults to false.
    expect(linkOpensExternally(false, false)).toBe(false);
  });

  it('sends a Ctrl/Cmd+click to the system browser by default', () => {
    expect(linkOpensExternally(false, true)).toBe(true);
  });

  it('sends a plain click to the system browser once the setting is on', () => {
    expect(linkOpensExternally(true, false)).toBe(true);
  });

  it('sends a Ctrl/Cmd+click BACK to the panel once the setting is on', () => {
    // The case that makes the modifier an inversion rather than a shortcut to
    // "external". Someone who browses mostly in their own browser still has to
    // be able to put a link in the panel for an agent to look at.
    expect(linkOpensExternally(true, true)).toBe(false);
  });

  it('treats a missing modifier flag as no inversion', () => {
    // openInRemoteaBrowser is called with no opts from callers that have no mouse
    // event at all; `undefined` must not read as "invert".
    expect(linkOpensExternally(false, undefined)).toBe(false);
    expect(linkOpensExternally(true, undefined)).toBe(true);
  });
});

/**
 * The in-app browser switch (2026-11-18). Off by default, and while it is off
 * every link goes to the system browser: there is no panel for Ctrl+click to
 * invert to.
 */
describe('openInRemoteaBrowser with the in-app browser off', () => {
  it('defaults the in-app browser to off', async () => {
    const { DEFAULT_BROWSER_PREFS } = await import('../../src/renderer/store/settings-slice');
    expect(DEFAULT_BROWSER_PREFS.inAppBrowser).toBe(false);
  });

  it('sends plain and Ctrl+clicked links to the system browser', async () => {
    const opened: string[] = [];
    (globalThis as { window?: unknown }).window = { remotea: { system: { openExternal: (u: string) => opened.push(u) } } };
    try {
      const { useStore } = await import('../../src/renderer/store');
      const { openInRemoteaBrowser } = await import('../../src/renderer/utils/open-in-browser');
      const prefs = useStore.getState().browserPrefs;
      useStore.setState({ browserPrefs: { ...prefs, inAppBrowser: false, openLinksExternally: false } });
      openInRemoteaBrowser('https://example.com/a');
      openInRemoteaBrowser('https://example.com/b', { invert: true });
      expect(opened).toEqual(['https://example.com/a', 'https://example.com/b']);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
