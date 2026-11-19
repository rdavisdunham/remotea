/**
 * Every name remotea used before the wmux rename (PR10), in one place.
 *
 * Only three things may read this module: the move command
 * (`src/main/rename-move.ts`, `remote-server/src/move.ts`), the old-state
 * notice (`src/main/old-state-notice.ts`), and the install cleanup that
 * removes remotea's own old hook entries and blocks. Nothing else reads an old
 * name: after the move, old-named state is ignored.
 *
 * A real wmux install writes byte-identical names, so a name alone never
 * proves an artifact is remotea's. `artifact-ownership.ts` holds the rules
 * that do.
 */

/** Prefix of every environment variable remotea set in its terminals. */
export const LEGACY_ENV_PREFIX = 'WMUX_';

/** The per-user config folder, `~/.wmux` (config.toml, locales/). */
export const LEGACY_CONFIG_DIR = '.wmux';

/** File names under `resources/cli` that hook commands and env vars embedded. */
export const LEGACY_CLI_FILES = {
  cli: 'wmux.js',
  hook: 'wmux-hook.js',
  codex: 'wmux-codex.js',
} as const;

/** The helper files a host copied into `~/.local/share/remotea/cli`. */
export const LEGACY_HOST_HELPER_FILES = ['wmux-hook.js', 'wmux.js'] as const;

/** Substring every old hook command contained. Never proof of ownership. */
export const LEGACY_HOOK_MARKER = 'wmux-hook';

/** Delimiters of the old managed block in agent context files. */
export const LEGACY_BLOCK_START = '<!-- wmux:start';
export const LEGACY_BLOCK_END = '<!-- wmux:end -->';

/** The instructions placeholder the old block was rendered from. */
export const LEGACY_CLI_BIN_PLACEHOLDER = '{{WMUX_CLI_BIN}}';

/** Header line the old plugin files carried. */
export const LEGACY_PLUGIN_VERSION_TAG = 'wmux-plugin-version';

/**
 * Export name of the OpenCode plugin before the code-symbol rename. A plugin
 * file installed before then (version marker 10 or lower) still carries it.
 */
export const LEGACY_OPENCODE_PLUGIN_EXPORT = 'WmuxPlugin';

/** The packaged exe before the rename. A portable install still running it is updated in kind. */
export const LEGACY_APP_EXE = 'wmux.exe';

/** Right-click verb under `HKCU\Software\Classes\{Directory,…}\shell\`. */
export const LEGACY_REGISTRY_VERB = 'wmux';

/** Prefix of the desktop's localStorage-backed keys in settings.json. */
export const LEGACY_STORAGE_PREFIX = 'wmux-';

/** Project files in the user's own repositories. The move never touches them. */
export const LEGACY_PROJECT_FILES = ['.wmux.json', 'wmux.workspace.json', '.wmux/workspace.json'] as const;

/**
 * Old file names of the plugins and rule files remotea wrote into agent
 * folders, by agent. Each sits in the folder the agent's own module already
 * resolves (`getOmpAgentDir()`, the OpenCode plugin folder, …), beside its new
 * `remotea` name. Those with no path inside cannot be proven remotea's, so the
 * move lists them and asks; it never removes one on its own.
 */
export const LEGACY_PLUGIN_FILES = {
  opencode: ['wmux.js'],
  opencodeTui: ['wmux-tui.js', 'wmux-tui-core.js'],
  /** The folder `wmux opencode-tui` installed under OpenCode's `plugins/`. */
  opencodeTuiDir: ['wmux-cli'],
  pi: ['wmux.js'],
  omp: ['wmux.js'],
  agy: ['wmux'],
  agyHook: ['wmux-agy-hook.cjs'],
  qwenStub: ['wmux-qwen-hook.cjs'],
  grokRules: ['wmux.md'],
  grokHooks: ['wmux.json'],
  kiro: ['wmux.md'],
} as const;

/** Old name for a new name: `WMUX_X` for `REMOTEA_X`, the rule KTD13 fixed. */
export function legacyEnvName(remoteaName: string): string {
  if (!remoteaName.startsWith('REMOTEA_')) throw new Error(`not a remotea variable: ${remoteaName}`);
  return LEGACY_ENV_PREFIX + remoteaName.slice('REMOTEA_'.length);
}

/**
 * The old plugin files and folders under `home` that carry no path, so
 * nothing proves whose they are: a real wmux writes the same ones. The move
 * lists those that exist and removes them only when the user says yes.
 */
export function legacyPluginPaths(home: string, env: Record<string, string | undefined> = {}): string[] {
  const join = (...parts: string[]) => parts.join('/').replace(/\\/g, '/');
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  return [
    join(configHome, 'opencode', 'plugin', LEGACY_PLUGIN_FILES.opencode[0]),
    join(configHome, 'opencode', 'plugins', LEGACY_PLUGIN_FILES.opencodeTuiDir[0]),
    join(home, '.pi', 'agent', 'extensions', LEGACY_PLUGIN_FILES.pi[0]),
    join(home, '.omp', 'agent', 'extensions', LEGACY_PLUGIN_FILES.omp[0]),
    join(home, '.gemini', 'config', 'plugins', LEGACY_PLUGIN_FILES.agy[0]),
  ];
}
