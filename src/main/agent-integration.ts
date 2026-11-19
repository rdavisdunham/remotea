import { clearIntegrationFailures } from './integration-failures';
/**
 * Consent gate for everything remotea writes outside its own directory (issue #132).
 *
 * remotea integrates with Claude Code, OpenCode, Kiro, omp, pi, Grok, agy and Qwen Code by editing files
 * in the user's home: it appends a block to ~/.claude/CLAUDE.md,
 * ~/.config/opencode/AGENTS.md, ~/.omp/agent/AGENTS.md and pi's user-scope
 * context file, writes ~/.kiro/steering/remotea.md, registers eight hook families
 * in ~/.claude/settings.json, installs a status extension into
 * ~/.pi/agent/extensions/, points chrome-devtools-mcp at its own CDP proxy, and
 * installs an OpenCode status plugin.
 *
 * All of that used to happen unconditionally on every launch, with no prompt and
 * no record of a decision — so deleting any of it was futile, because the next
 * launch simply put it back. As #132 put it, the app modifies global config
 * "without permission and/or warning". Idempotence and consent pull in opposite
 * directions, and the code only implemented the first.
 *
 * The fix is a decision stored in remotea's OWN settings file (%APPDATA%\remotea),
 * never in the files being written:
 *
 *   unset     nothing has been written yet; ask on first launch
 *   granted   apply the features that are switched on
 *   declined  write nothing, and take back anything a previous version wrote
 *
 * `declined` is deliberately sticky and re-asserted on every launch: a user who
 * says no once should not have to say it again after an update, and should not
 * have to hand-delete the leftovers either.
 */
import {
  ensureClaudeContext,
  ensureClaudeHooks,
  ensureChromeDevtoolsConfig,
  removeClaudeContext,
  removeClaudeHooks,
  removeChromeDevtoolsConfig,
} from './claude-context';
import {
  ensureOpencodeContext,
  ensureOpencodePlugin,
  removeOpencodeContext,
  removeOpencodePlugin,
} from './opencode-context';
import { ensureKiroContext, removeKiroContext } from './kiro-context';
import { ensureOmpContext, removeOmpContext, ensureOmpExtension, removeOmpExtension } from './omp-context';
import {
  ensureGrokContext,
  ensureGrokHooks,
  removeGrokContext,
  removeGrokHooks,
} from './grok-context';
import {
  ensurePiContext,
  ensurePiExtension,
  removePiContext,
  removePiExtension,
} from './pi-context';
import { ensureAgyPlugin, removeAgyPlugin } from './agy-context';
import {
  ensureQwenContext,
  ensureQwenHooks,
  ensureQwenMcp,
  removeQwenContext,
  removeQwenHooks,
  removeQwenMcp,
} from './qwen-context';
import { loadSettings, saveSetting } from './settings-store';

export type IntegrationDecision = 'unset' | 'granted' | 'declined';

/**
 * The four things remotea writes, split the way a user would reason about them
 * rather than the way the code is organised — each one is independently useful
 * and independently refusable.
 */
export type IntegrationFeature = 'instructions' | 'hooks' | 'orchestrator' | 'browserMcp';

export const INTEGRATION_FEATURES: IntegrationFeature[] = [
  'instructions',
  'hooks',
  'orchestrator',
  'browserMcp',
];

export interface IntegrationConsent {
  decision: IntegrationDecision;
  features: Record<IntegrationFeature, boolean>;
  decidedAt?: number;
}

const SETTINGS_KEY = 'agentIntegration';

/** Every feature on: what "yes" means, and what every pre-0.40 install already had. */
const ALL_ON: Record<IntegrationFeature, boolean> = {
  instructions: true,
  hooks: true,
  orchestrator: true,
  browserMcp: true,
};

export const DEFAULT_CONSENT: IntegrationConsent = { decision: 'unset', features: { ...ALL_ON } };

/** Every file the local integration edits outside remotea's own data directory. */
export const INTEGRATION_CONSENT_DETAIL =
  'remotea can teach your coding agents to drive its browser panel, markdown views ' +
  'and sidebar status. Doing so edits files in your home directory:\n\n' +
  '  • ~/.claude/CLAUDE.md, ~/.config/opencode/AGENTS.md, ~/.omp/agent/AGENTS.md\n' +
  '    and ~/.pi/agent/AGENTS.md\n' +
  '      a remotea section, between markers, leaving your own text untouched\n' +
  '  • ~/.kiro/steering/remotea.md\n' +
  '      a steering file of remotea\'s own; your other Kiro steering is untouched\n' +
  '  • ~/.grok/rules/remotea.md and ~/.grok/hooks/remotea.json (only if Grok is installed)\n' +
  '      files of remotea\'s own; the rules file only when Grok is not already\n' +
  '      reading the ~/.claude/CLAUDE.md section\n' +
  '  • ~/.qwen/QWEN.md and ~/.qwen/settings.json (only if Qwen Code is installed)\n' +
  '      a remotea section in QWEN.md; in settings.json the same status hooks as\n' +
  '      Claude Code below, plus chrome-devtools-mcp — your own keys untouched\n' +
  '  • ~/.claude/settings.json\n' +
  '      eight hook families: PostToolUse, Notification, Stop, SubagentStop,\n' +
  '      SessionStart, UserPromptSubmit, PreToolUse and SessionEnd\n' +
  '  • ~/.pi/agent/extensions/remotea.js\n' +
  '      a pi extension that reports this pane\'s status to the sidebar\n' +
  '  • ~/.omp/agent/extensions/remotea.js\n' +
  '      an omp extension that reports foreground and background job state\n' +
  '  • ~/.gemini/config/plugins/remotea/ (only if the Antigravity CLI is installed)\n' +
  '      an agy plugin of remotea\'s own that reports each pane\'s conversation\n' +
  '  • ~/.config/opencode/plugin/remotea.js\n' +
  '      the remotea status plugin for OpenCode\n' +
  '  • ~/.claude/settings.json\n' +
  '      a pinned chrome-devtools-mcp pointed at the browser panel instead of its own Chrome\n\n' +
  'Nothing is written until this is turned on. Turning it off removes anything ' +
  'remotea added. You can change this any time, feature by feature, ' +
  'in Settings → Agent integration.';

/**
 * Normalise whatever is on disk into a usable consent record.
 *
 * Anything unrecognised falls back to `unset` — i.e. to *asking* — rather than
 * to granting. A corrupted settings file must not be a silent yes on the user's
 * behalf, which is the whole complaint in #132.
 */
export function parseConsent(raw: unknown): IntegrationConsent {
  if (!raw || typeof raw !== 'object') return { decision: 'unset', features: { ...ALL_ON } };
  const obj = raw as Record<string, unknown>;
  const decision: IntegrationDecision =
    obj.decision === 'granted' || obj.decision === 'declined' ? obj.decision : 'unset';
  const storedFeatures = (obj.features ?? {}) as Record<string, unknown>;
  const features = { ...ALL_ON };
  for (const feature of INTEGRATION_FEATURES) {
    // Only an explicit `false` turns a feature off. A key added by a later
    // version is missing from an older record, and must default to the same
    // thing a fresh grant would give it, not to off.
    if (storedFeatures[feature] === false) features[feature] = false;
  }
  return {
    decision,
    features,
    decidedAt: typeof obj.decidedAt === 'number' ? obj.decidedAt : undefined,
  };
}

export function readConsent(): IntegrationConsent {
  return parseConsent(loadSettings()[SETTINGS_KEY]);
}

export function writeConsent(consent: IntegrationConsent): boolean {
  return saveSetting(SETTINGS_KEY, consent);
}

/** Apply one feature, or take it back. Split out so `applyConsent` reads as a table. */
function applyFeature(feature: IntegrationFeature, enabled: boolean): void {
  switch (feature) {
    case 'instructions':
      if (enabled) {
        // Grok after Claude: it writes its rules file only when Grok would not
        // already read the block ensureClaudeContext just put in CLAUDE.md.
        ensureClaudeContext(); ensureOpencodeContext(); ensureKiroContext();
        ensureOmpContext(); ensurePiContext(); ensureGrokContext(); ensureQwenContext();
      } else {
        removeClaudeContext(); removeOpencodeContext(); removeKiroContext();
        removeOmpContext(); removePiContext(); removeGrokContext(); removeQwenContext();
      }
      break;
    case 'hooks':
      // The pi extension belongs here and not under `orchestrator` because the
      // panel's own label for this toggle is "Status hooks", and that is
      // precisely what it is: a per-event reporter, no orchestration. The
      // OpenCode plugin does the same job from under `orchestrator`, which is a
      // pre-existing mismatch deliberately left alone — moving it would
      // silently re-enable a status bridge for every user who switched that
      // toggle off, which is the #132 complaint in reverse.
      // The agy plugin likewise: it reports which conversation a pane holds,
      // the same job Claude's SessionStart hook does from this toggle.
      if (enabled) { ensureClaudeHooks(); ensurePiExtension(); ensureOmpExtension(); ensureGrokHooks(); ensureAgyPlugin(); ensureQwenHooks(); }
      else { removeClaudeHooks(); removePiExtension(); removeOmpExtension(); removeGrokHooks(); removeAgyPlugin(); removeQwenHooks(); }
      break;
    case 'orchestrator':
      // The OpenCode status plugin. The key keeps its old name because renaming
      // it would switch the plugin back on for anyone who turned it off. The
      // Claude Code orchestrator plugin it once also controlled is gone; see
      // docs/remotea/orchestrator-architecture.md.
      if (enabled) ensureOpencodePlugin();
      else removeOpencodePlugin();
      break;
    case 'browserMcp':
      if (enabled) { ensureChromeDevtoolsConfig(); ensureQwenMcp(); }
      else { removeChromeDevtoolsConfig(); removeQwenMcp(); }
      break;
  }
}

/**
 * Bring the user's agent config in line with their decision.
 *
 * `unset` writes nothing and removes nothing: the prompt has not been answered
 * yet, and touching either way would pre-empt it.
 *
 * Note that a `granted` decision still *removes* the features that are switched
 * off. Turning a feature off in Settings has to clean up after itself, or the
 * toggle only stops future writes and leaves the current ones in place — which
 * is the same "I deleted it and it came back" complaint one level down.
 */
export function applyConsent(consent: IntegrationConsent): void {
  if (consent.decision === 'unset') return;
  clearIntegrationFailures();
  const granted = consent.decision === 'granted';
  for (const feature of INTEGRATION_FEATURES) {
    applyFeature(feature, granted && consent.features[feature]);
  }
}

/**
 * Startup entry point: apply the standing decision, if there is one.
 *
 * remotea does not ask at launch. Agents on a remote host are set up by that
 * host's server, which the app offers once it is connected (RemoteHooksPrompt).
 * This local integration, inherited from remotea, edits files in the home
 * directory of the computer the app runs on, so it stays off until someone
 * turns it on in Settings → Agent integration. `unset` writes nothing and
 * removes nothing.
 */
export async function initAgentIntegration(): Promise<IntegrationConsent> {
  const consent = readConsent();
  // remotea: a test or scripted instance must neither ask nor reconcile. The
  // files this manages (~/.claude/settings.json, CLAUDE.md, …) are shared by
  // every instance on the machine, so even a "declined" here would strip the
  // hooks a real install put there.
  if (process.env.REMOTEA_SKIP_AGENT_INTEGRATION === '1') return consent;
  applyConsent(consent);
  return consent;
}

/**
 * Settings → Agents wrote a new decision: persist it and reconcile the files now.
 *
 * `features` is a *sparse* patch, not a whole record — the panel sends one
 * checkbox at a time. Typing it as `Partial<IntegrationConsent>` would say a
 * caller must supply all four, which is neither true nor what the UI does.
 */
export function updateConsent(partial: {
  decision?: IntegrationDecision;
  features?: Partial<Record<IntegrationFeature, boolean>>;
}): IntegrationConsent {
  const current = readConsent();
  const next: IntegrationConsent = {
    decision: partial.decision ?? current.decision,
    features: { ...current.features, ...(partial.features ?? {}) },
    decidedAt: Date.now(),
  };
  if (!writeConsent(next)) throw new Error('Integration consent could not be saved.');
  applyConsent(next);
  return next;
}
