// Side-effect module: imported FIRST by index.ts so it runs before any module
// that reads the instance name at load time (settings-store, session-persistence,
// the pipe path, Electron's userData). A `--smoke` run (smoke.ts) must never
// touch a real install: its own instance (pipe, %APPDATA%\remotea-smoke, own
// Electron profile), no agent integration (nothing written to ~/.claude), no
// updater, no detached DevTools in a dev build. Explicit settings win.
import { parseSmokeArgs } from './smoke';

if (parseSmokeArgs(process.argv, process.env)) {
  process.env.REMOTEA_SMOKE = '1';
  if (!process.env.REMOTEA_INSTANCE?.trim()) process.env.REMOTEA_INSTANCE = 'smoke';
  process.env.REMOTEA_SKIP_AGENT_INTEGRATION = '1';
  process.env.REMOTEA_DISABLE_UPDATER = '1';
  process.env.REMOTEA_NO_DEVTOOLS = '1';
}
