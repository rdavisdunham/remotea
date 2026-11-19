// `--smoke`: a release smoke test the PACKAGED app runs on itself (the Windows
// smoke workflow, .github/workflows/smoke.yml; README "Releases").
//
//   remotea.exe --smoke [--smoke-out=<result.json>] [--smoke-timeout=<ms>]
//
// Opens the normal main window, waits for the renderer and its preload bridge,
// waits for the renderer's own first local terminal (renderer → preload → IPC →
// PtyManager → shell), types `echo smoke-ok` into it from main, and reads the
// result back out of the renderer's xterm buffer (the `surface.read_text`
// probe) — so a pass means the whole chain works in the shipped binary. Writes
// a JSON result and exits 0 (pass) or 1 (fail) within the timeout.
//
// This file is the pure part (argument parsing, the step runner, the output
// check), unit-tested with fakes in tests/unit/smoke.test.ts. The Electron glue
// is runSmokeMode in index.ts; the env isolation (own instance, no agent
// integration, no updater) is smoke-env.ts, imported first by index.ts.

import { planQuit } from './quit-sequence';

export const SMOKE_FLAG = '--smoke';
export const SMOKE_TOKEN = 'smoke-ok';
export const DEFAULT_SMOKE_TIMEOUT_MS = 90_000;

/** Smoke uses app.exit(), which bypasses will-quit and its normal PTY drain. */
export function shutdownSmoke(deps: {
  ptyCount(): number;
  killAll(): void;
  defer(exit: () => void, ms: number): void;
  exit(code: number): void;
}, code: number): void {
  const ptysAtQuit = deps.ptyCount();
  try { deps.killAll(); } catch { /* preserve the smoke result even if cleanup fails */ }
  // The hard timeout remains an immediate emergency exit; normal pass/fail reuses the established drain.
  const drainMs = code === 2 ? 0 : planQuit({ ptysAtQuit, agentBrowserPending: false, alreadyDeferred: false }).drainMs;
  if (drainMs > 0) deps.defer(() => deps.exit(code), drainMs);
  else deps.exit(code);
}

export interface SmokeOptions {
  /** Where the JSON result goes; null = the caller's default (app data dir). */
  outFile: string | null;
  timeoutMs: number;
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

/** Smoke options from argv/env, or null when this is a normal launch. */
export function parseSmokeArgs(argv: readonly string[], env: Record<string, string | undefined>): SmokeOptions | null {
  const enabled = argv.includes(SMOKE_FLAG) || env.REMOTEA_SMOKE === '1';
  if (!enabled) return null;
  const outFile = argValue(argv, '--smoke-out') || env.REMOTEA_SMOKE_OUT || null;
  const rawTimeout = Number(argValue(argv, '--smoke-timeout') ?? env.REMOTEA_SMOKE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(Math.max(Math.floor(rawTimeout), 5_000), 600_000)
    : DEFAULT_SMOKE_TIMEOUT_MS;
  return { outFile, timeoutMs };
}

/**
 * Whether the screen shows the command's OUTPUT, not just the typed command.
 * The command line itself reads `… echo smoke-ok`, so only a line that is the
 * token alone counts — true for pwsh, powershell, cmd, bash and sh alike.
 */
export function screenShowsToken(text: string | null | undefined, token = SMOKE_TOKEN): boolean {
  if (!text) return false;
  return text.split(/\r?\n|\r/).some((line) => line.trim() === token);
}

export interface SmokeStep {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface RendererProbe {
  /** `window.remotea` exists with its pty API — the (sandboxed) preload ran. */
  bridge: boolean;
  /** `window.__remotea_readScreen` exists — the renderer app booted. */
  readScreen: boolean;
  /** The preload reports `process.sandboxed` — the window really is sandboxed. */
  sandboxed: boolean;
  activeSurfaceId: string | null;
}

export interface SmokeDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Resolves when the main window finished loading; rejects on a load/preload failure. */
  waitForWindowLoad(): Promise<void>;
  probeRenderer(): Promise<RendererProbe>;
  hasPty(surfaceId: string): boolean;
  writePty(surfaceId: string, data: string): void;
  /** The terminal's screen text, or null if the renderer cannot read it. */
  readScreen(surfaceId: string): Promise<string | null>;
}

export interface SmokeRunResult {
  ok: boolean;
  durationMs: number;
  steps: SmokeStep[];
  error?: string;
  surfaceId?: string;
  /** The last lines the terminal showed — what to look at when `echo` failed. */
  screenTail?: string;
}

const POLL_MS = 250;
/** How long to wait for a first prompt before typing anyway. */
const SHELL_READY_MS = 20_000;
/** Type the command again once if nothing came back in this long. */
const RETYPE_AFTER_MS = 15_000;

class StepFailed extends Error {}

export async function runSmoke(deps: SmokeDeps, opts: { timeoutMs: number }): Promise<SmokeRunResult> {
  const start = deps.now();
  const deadline = start + opts.timeoutMs;
  const steps: SmokeStep[] = [];
  let surfaceId: string | undefined;
  let lastScreen: string | null = null;

  const step = async <T>(name: string, fn: () => Promise<{ value: T; detail?: string }>): Promise<T> => {
    const t0 = deps.now();
    try {
      const { value, detail } = await fn();
      steps.push({ name, ok: true, ms: deps.now() - t0, ...(detail ? { detail } : {}) });
      return value;
    } catch (err) {
      steps.push({ name, ok: false, ms: deps.now() - t0, detail: err instanceof Error ? err.message : String(err) });
      throw new StepFailed(name);
    }
  };

  /** Poll `fn` until it returns a non-undefined value, or fail at `until`. */
  const poll = async <T>(what: string, fn: () => Promise<T | undefined>, until = deadline, seen?: () => string): Promise<T> => {
    let lastError = '';
    for (;;) {
      try {
        const v = await fn();
        if (v !== undefined) return v;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (deps.now() >= Math.min(until, deadline)) {
        const state = seen?.();
        throw new Error(`timed out waiting for ${what}${state ? ` (last seen: ${state})` : ''}${lastError ? ` (last error: ${lastError})` : ''}`);
      }
      await deps.sleep(POLL_MS);
    }
  };

  try {
    await step('window-load', async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for did-finish-load')), Math.max(0, deadline - deps.now()));
      });
      try {
        await Promise.race([deps.waitForWindowLoad(), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return { value: undefined };
    });

    await step('renderer-bridge', async () => {
      const probe = await poll('the preload bridge and renderer', async () => {
        const p = await deps.probeRenderer();
        return p.bridge && p.readScreen ? p : undefined;
      });
      // The window is built with sandbox: true (security-policy.ts). A preload
      // that is not sandboxed means that setting regressed in the shipped app.
      if (!probe.sandboxed) throw new Error('the preload is not sandboxed (process.sandboxed !== true)');
      return { value: probe, detail: 'sandboxed' };
    });

    surfaceId = await step('local-terminal', async () => {
      let last = 'no probe answered';
      const id = await poll('the renderer\'s first terminal to get a PTY', async () => {
        const p = await deps.probeRenderer();
        const has = !!p.activeSurfaceId && deps.hasPty(p.activeSurfaceId);
        last = `active surface ${p.activeSurfaceId ?? 'none'}, pty ${has ? 'live' : 'none'}`;
        if (p.activeSurfaceId && !has) lastScreen = await deps.readScreen(p.activeSurfaceId).catch(() => lastScreen);
        return has ? p.activeSurfaceId ?? undefined : undefined;
      }, deadline, () => last);
      return { value: id, detail: id };
    });
    const id = surfaceId;

    await step('shell-ready', async () => {
      try {
        await poll('a first prompt', async () => {
          lastScreen = await deps.readScreen(id);
          return lastScreen && lastScreen.trim() !== '' ? true : undefined;
        }, deps.now() + SHELL_READY_MS);
        return { value: undefined };
      } catch {
        // Not fatal: some shells draw nothing until a key arrives. Type anyway.
        return { value: undefined, detail: 'no prompt seen; typing anyway' };
      }
    });

    await step('echo', async () => {
      deps.writePty(id, `echo ${SMOKE_TOKEN}\r`);
      const typedAt = deps.now();
      let retyped = false;
      await poll(`"${SMOKE_TOKEN}" on the terminal screen`, async () => {
        lastScreen = await deps.readScreen(id);
        if (screenShowsToken(lastScreen)) return true;
        if (!retyped && deps.now() - typedAt >= RETYPE_AFTER_MS) {
          retyped = true;
          deps.writePty(id, `echo ${SMOKE_TOKEN}\r`);
        }
        return undefined;
      });
      return { value: undefined, ...(retyped ? { detail: 'needed a second try' } : {}) };
    });

    return { ok: true, durationMs: deps.now() - start, steps, surfaceId, ...(lastScreen ? { screenTail: tail(lastScreen) } : {}) };
  } catch (err) {
    const failed = err instanceof StepFailed ? steps[steps.length - 1] : undefined;
    return {
      ok: false,
      durationMs: deps.now() - start,
      steps,
      error: failed ? `${failed.name}: ${failed.detail ?? 'failed'}` : (err instanceof Error ? err.message : String(err)),
      ...(surfaceId ? { surfaceId } : {}),
      ...(lastScreen ? { screenTail: tail(lastScreen) } : {}),
    };
  }
}

function tail(text: string, lines = 20): string {
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-lines).join('\n');
}
