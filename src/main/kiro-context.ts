import { reportIntegrationFailure } from './integration-failures';
/**
 * Kiro CLI integration (issue #148).
 *
 * Kiro is the third agent wmux teaches about itself, after Claude Code and
 * OpenCode, and it is the one that needs the least machinery — because Kiro's
 * global *steering* directory is designed for exactly this.
 *
 * ── Why a whole file, and not a block in a shared one ────────────────────────
 *
 * Claude Code and OpenCode each read a single global context file
 * (~/.claude/CLAUDE.md, ~/.config/opencode/AGENTS.md). wmux does not own those
 * files, so it splices its section between markers and leaves everything else
 * alone — that is what `injectWmuxBlock` / `stripWmuxBlock` exist for.
 *
 * Kiro instead reads *every* markdown file in ~/.kiro/steering/ and concatenates
 * them, and its own guidance is "keep files focused — one domain per file". So
 * the idiomatic thing here is also the safe thing: write one file that is
 * entirely ours. There is no user prose to preserve, no splice to get wrong, and
 * uninstalling is a delete rather than a rewrite.
 *
 * We still write the marker-wrapped instructions verbatim rather than stripping
 * the markers, for two reasons: the file is then byte-identical to what the
 * other two agents receive (one source of truth, no per-agent drift), and the
 * start marker is what `removeKiroContext` checks before deleting — a remotea.md
 * the user wrote themselves has no marker and is left where it is.
 *
 * ── What is deliberately NOT installed ───────────────────────────────────────
 *
 * No hooks. Kiro's hooks live in .kiro/hooks/ *per project*, with no global
 * equivalent, so wiring the sidebar the way ensureClaudeHooks does would mean
 * writing into every repository the user opens. That is precisely the complaint
 * in #132, and it is not worth a status indicator. Kiro reports state the same
 * way any agent can without a plugin: the instructions block documents
 * `wmux report-agent`, and the declared-state protocol (#128) takes it from
 * there.
 *
 * Inclusion modes are also skipped: Kiro CLI ignores them and loads every
 * steering file unconditionally, and the default in the IDE is already
 * `always`, so front matter would add a Kiro-version dependency for no gain.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readRenderedInstructions } from './agent-instructions';
import { isLegacyRemoteaBlockFile } from '../shared/legacy-cleanup';
import { LEGACY_PLUGIN_FILES } from '../shared/legacy-names';
import { desktopOwnershipContext } from './ownership-context';

/** Identifies a file as wmux-managed. Shared with the other two agent paths. */
const START_MARKER = '<!-- remotea:start';

/**
 * ~/.kiro/steering/remotea.md — the *global* steering location, which applies to
 * every workspace. The per-project .kiro/steering/ is the user's, not ours.
 */
export function getKiroSteeringPath(): string {
  return path.join(os.homedir(), '.kiro', 'steering', 'remotea.md');
}

/** Pure: is this file ours to manage? Everything else is the user's. */
export function isWmuxManaged(content: string): boolean {
  return content.includes(START_MARKER);
}

/** Writes the wmux steering file into ~/.kiro/steering/. */
export function ensureKiroContext(): void {
  try {
    // Rendered, not read: carries this install's absolute CLI path (#158).
    const rendered = readRenderedInstructions();
    if (rendered === null) return;
    const block = rendered.trimEnd() + '\n';
    const steeringPath = getKiroSteeringPath();

    // The old-named file goes only when the path inside it is this install's
    // (KTD8); a wmux install writes the same name.
    const oldPath = path.join(path.dirname(steeringPath), LEGACY_PLUGIN_FILES.kiro[0]);
    const ctx = desktopOwnershipContext();
    const old = ctx.readFile(oldPath);
    if (old !== null && isLegacyRemoteaBlockFile(old, ctx)) fs.unlinkSync(oldPath);

    // A pre-existing remotea.md that is NOT ours belongs to the user. Overwriting
    // it would be the same class of mistake as clobbering their CLAUDE.md.
    if (fs.existsSync(steeringPath)) {
      const current = fs.readFileSync(steeringPath, 'utf-8');
      if (!isWmuxManaged(current)) {
        console.warn('[remotea] ~/.kiro/steering/remotea.md exists and is not remotea\'s — leaving it alone');
        return;
      }
      if (current === block) return; // already current; don't churn the mtime
    }

    fs.mkdirSync(path.dirname(steeringPath), { recursive: true });
    fs.writeFileSync(steeringPath, block, 'utf-8');
    console.log('[remotea] Updated remotea steering in ~/.kiro/steering/remotea.md');
  } catch (err) {
    reportIntegrationFailure('Kiro', 'write', err);
    console.warn('[remotea] Failed to update Kiro context:', err);
  }
}

/**
 * Delete the wmux steering file (issue #132's inverse requirement: every write
 * wmux makes outside its own directory must be undoable).
 *
 * Guarded on the marker, so a remotea.md the user happens to have written under
 * that name survives switching the integration off.
 */
export function removeKiroContext(): void {
  try {
    const steeringPath = getKiroSteeringPath();
    if (!fs.existsSync(steeringPath)) return;
    if (!isWmuxManaged(fs.readFileSync(steeringPath, 'utf-8'))) return;
    fs.unlinkSync(steeringPath);
    console.log('[remotea] Removed remotea steering from ~/.kiro/steering/remotea.md');
  } catch (err) {
    reportIntegrationFailure('Kiro', 'remove', err);
    console.warn('[remotea] Failed to remove Kiro context:', err);
  }
}
