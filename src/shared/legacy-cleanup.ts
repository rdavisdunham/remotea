/**
 * Removing remotea's own old-named hook entries and managed blocks, and
 * nothing else.
 *
 * Before the rename (PR10) remotea wrote the same names a real wmux writes:
 * hook commands running `wmux-hook.js`, blocks between `<!-- wmux:start` and
 * `<!-- wmux:end -->`. Each install path (app startup, `remotea hooks
 * install`, the move command) runs these before writing the new entries, so
 * an agent never runs both the old and the new helper. An old artifact goes
 * only when the path inside it proves it is remotea's (artifact-ownership.ts);
 * a wmux install's entries are left byte-identical.
 */
import {
  LEGACY_BLOCK_END,
  LEGACY_BLOCK_START,
  LEGACY_CLI_FILES,
  LEGACY_PLUGIN_FILES,
} from './legacy-names';
import {
  hookCommandScript,
  isRemoteaBlock,
  isRemoteaFilePath,
  type OwnershipContext,
} from './artifact-ownership';

const LEGACY_HOOK_FILE = LEGACY_CLI_FILES.hook;
const LEGACY_QWEN_STUB = LEGACY_PLUGIN_FILES.qwenStub[0];

const baseName = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? '';

/** The helper an old Qwen stub requires, or null when it is not one. */
function qwenStubTarget(source: string | null): string | null {
  if (source === null) return null;
  const m = /^require\(("(?:[^"\\]|\\.)*")\);$/m.exec(source);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return null;
  }
}

/**
 * Whether an old hook command runs remotea's helper: `wmux-hook.js` in a
 * remotea folder, or Qwen's `wmux-qwen-hook.cjs` stub requiring one.
 */
export function isLegacyRemoteaCommand(command: unknown, ctx: OwnershipContext): boolean {
  if (typeof command !== 'string') return false;
  const script = hookCommandScript(command);
  if (script === null) return false;
  const name = baseName(script);
  if (name === LEGACY_HOOK_FILE) return isRemoteaFilePath(script, ctx);
  if (name === LEGACY_QWEN_STUB) {
    const target = qwenStubTarget(ctx.readFile(script));
    return target !== null && baseName(target) === LEGACY_HOOK_FILE && isRemoteaFilePath(target, ctx);
  }
  return false;
}

/** Whether an old Qwen stub file is remotea's (it requires a proven helper). */
export function isLegacyRemoteaQwenStub(source: string | null, ctx: OwnershipContext): boolean {
  const target = qwenStubTarget(source);
  return target !== null && baseName(target) === LEGACY_HOOK_FILE && isRemoteaFilePath(target, ctx);
}

const isEntryWithLegacyCommand = (entry: unknown, ctx: OwnershipContext): boolean => {
  const hooks = (entry as { hooks?: unknown })?.hooks;
  return Array.isArray(hooks) && hooks.some((h: any) => isLegacyRemoteaCommand(h?.command, ctx));
};

/**
 * `settings` without remotea's old hook entries, for any file shaped like
 * Claude Code's `hooks: { Event: [{ hooks: [{ command }] }] }` (Claude, Codex,
 * Qwen). An event array emptied by the removal is deleted; every other entry
 * and key is kept as it was. Returns the same object when nothing matched.
 */
export function stripLegacyHookEntries<T>(settings: T, ctx: OwnershipContext): T {
  const s = settings as any;
  if (!s || typeof s !== 'object' || !s.hooks || typeof s.hooks !== 'object' || Array.isArray(s.hooks)) return settings;
  let changed = false;
  const hooks: Record<string, unknown> = { ...s.hooks };
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((e) => !isEntryWithLegacyCommand(e, ctx));
    if (kept.length === entries.length) continue;
    changed = true;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!changed) return settings;
  const next = { ...s };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

/** How many old remotea hook entries `settings` holds. */
export function countLegacyHookEntries(settings: unknown, ctx: OwnershipContext): number {
  const hooks = (settings as any)?.hooks;
  if (!hooks || typeof hooks !== 'object') return 0;
  let n = 0;
  for (const entries of Object.values(hooks)) {
    if (Array.isArray(entries)) n += entries.filter((e) => isEntryWithLegacyCommand(e, ctx)).length;
  }
  return n;
}

/**
 * `text` without each complete old block that is remotea's. A wmux block,
 * a block with no path, and an unterminated start are left alone.
 */
export function stripLegacyBlocks(text: string, ctx: OwnershipContext): string {
  let out = text;
  let from = 0;
  for (;;) {
    const start = out.indexOf(LEGACY_BLOCK_START, from);
    if (start === -1) break;
    const endAt = out.indexOf(LEGACY_BLOCK_END, start);
    if (endAt === -1) break;
    const end = endAt + LEGACY_BLOCK_END.length;
    if (isRemoteaBlock(out.slice(start, end), ctx)) {
      out = out.slice(0, start) + out.slice(end);
      from = start;
    } else {
      from = end;
    }
  }
  return out === text ? text : out.replace(/\n{3,}/g, '\n\n');
}

/**
 * Whether a whole file is one old remotea block and nothing else: Kiro's
 * steering file and Grok's rules file, which held only the block.
 */
export function isLegacyRemoteaBlockFile(content: string, ctx: OwnershipContext): boolean {
  const start = content.indexOf(LEGACY_BLOCK_START);
  if (start === -1) return false;
  const endAt = content.indexOf(LEGACY_BLOCK_END, start);
  if (endAt === -1) return false;
  return isRemoteaBlock(content.slice(start, endAt + LEGACY_BLOCK_END.length), ctx);
}

/**
 * Whether Grok's old hooks file is remotea's: valid JSON whose every handler
 * runs a proven old helper. One foreign handler and the file is not ours.
 */
export function isLegacyRemoteaGrokHooksFile(content: string, ctx: OwnershipContext): boolean {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (Object.keys(parsed).some((k) => k !== 'hooks')) return false;
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  const groups = Object.values(hooks).flat() as any[];
  if (groups.length === 0) return false;
  return groups.every((g) => Array.isArray(g?.hooks) && g.hooks.length > 0
    && g.hooks.every((h: any) => isLegacyRemoteaCommand(h?.command, ctx)));
}
