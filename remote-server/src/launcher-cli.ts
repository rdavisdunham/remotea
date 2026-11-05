/**
 * `remotea launcher probe|status`: run the managed-run conformance probe
 * (launcher-conformance-probe.ts) now, or show what is recorded.
 *
 *   remotea launcher probe [claude|codex] [--bin <path>] [--no-turns] [--json]
 *       probe every launcher of the harness (the bare name and each target's
 *       `bin`), even when an unchanged binary already has a record. The result
 *       goes to <config dir>/launcher-conformance.json; the running server
 *       reads it within 30 s and sends Eridani a new hello when the admission
 *       changed.
 *   remotea launcher status [--json]
 *       the recorded probes, newest first.
 *
 * The CLI applies its own environment's REMOTEA_MANAGED_<HARNESS>_FORCE /
 * _BLOCK only to decide what to probe; the server applies the service's.
 */
import path from 'path';
import { loadTargets } from './eridani-targets';
import { launchersToProbe, probeLauncher } from './launch-caps';
import { CONFORMANCE_FILE, MANAGED_HARNESSES, identityOf, precheck, readRecords, summarize, writeRecord, type ConformanceRecord, type ManagedHarness } from './launcher-conformance';
import { runConformance, turnsEnabled } from './launcher-conformance-probe';

const USAGE = 'usage: remotea launcher probe [claude|codex] [--bin <path>] [--no-turns] [--json] | status [--json]';

export interface LauncherCliIo {
  out: (s: string) => void;
  /** Tests: the probe runner and the version probe. */
  run?: typeof runConformance;
  probe?: typeof probeLauncher;
  env?: NodeJS.ProcessEnv;
}

function fmtRecord(r: ConformanceRecord): string {
  const head = `${r.harness} \`${r.bin}\` ${r.version ?? '?'}: ${r.outcome === 'pass' ? 'VERIFIED' : `FAILED at ${r.failed_step}`} (${r.at}, ${Math.round(r.duration_ms / 100) / 10} s, by ${r.by})`;
  const lines = r.steps.map((s) => `  ${s.status.padEnd(7)} ${s.id.padEnd(16)} ${String(s.ms).padStart(6)} ms${s.message ? `  ${s.message}` : ''}`);
  return [head, ...(r.path ? [`  binary ${r.path}`] : []), ...lines].join('\n');
}

export async function launcherCommand(dir: string, argv: string[], io: LauncherCliIo = { out: (s) => process.stdout.write(s) }): Promise<number> {
  const [sub, ...rest] = argv;
  const json = rest.includes('--json');
  const file = path.join(dir, CONFORMANCE_FILE);
  if (sub === 'status') {
    const records = Object.values(readRecords(file)).sort((a, b) => b.at.localeCompare(a.at));
    io.out(json ? JSON.stringify(records, null, 2) + '\n' : records.length ? records.map(fmtRecord).join('\n') + '\n' : 'no launcher has been probed yet\n');
    return 0;
  }
  if (sub !== 'probe') {
    io.out(USAGE + '\n');
    return sub === undefined || sub === 'help' || sub === '--help' ? 0 : 2;
  }
  const only = rest.find((a) => (MANAGED_HARNESSES as readonly string[]).includes(a)) as ManagedHarness | undefined;
  const binAt = rest.indexOf('--bin');
  const bin = binAt >= 0 ? rest[binAt + 1] : undefined;
  if (binAt >= 0 && !bin) throw new Error(USAGE);
  if (bin && !only) throw new Error('--bin needs a harness: remotea launcher probe claude --bin <path>');
  const env = io.env ?? process.env;
  const turns = !rest.includes('--no-turns') && turnsEnabled(env);
  const launchers = bin
    ? [{ harness: only!, bin }]
    : launchersToProbe(loadTargets(dir)).filter((l): l is { harness: ManagedHarness; bin: string } => (MANAGED_HARNESSES as readonly string[]).includes(l.harness) && (!only || l.harness === only));
  const results: Array<ConformanceRecord | { harness: ManagedHarness; bin: string; skipped: string }> = [];
  let failed = false;
  for (const l of launchers) {
    const probe = await (io.probe ?? probeLauncher)(l.bin);
    if (!probe.ok) { results.push({ ...l, skipped: probe.error ?? 'not installed' }); if (!json) io.out(`${l.harness} \`${l.bin}\`: not probed: ${probe.error ?? 'not installed'}\n`); continue; }
    const pre = precheck(l.harness, probe.version, env);
    if (pre && pre.conformance !== 'forced') { results.push({ ...l, skipped: pre.conformance_message ?? pre.conformance }); if (!json) io.out(`${l.harness} \`${l.bin}\` ${probe.version}: not probed: ${pre.conformance_message ?? pre.conformance}\n`); continue; }
    if (!json) io.out(`${l.harness} \`${l.bin}\` ${probe.version}: probing…\n`);
    const started = Date.now();
    const steps = await (io.run ?? runConformance)(l.harness, l.bin, { turns });
    const record = summarize(l.harness, l.bin, identityOf(probe), steps, started, Date.now(), 'cli');
    writeRecord(file, record);
    failed ||= record.outcome === 'fail';
    results.push(record);
    if (!json) io.out(fmtRecord(record) + '\n');
  }
  if (json) io.out(JSON.stringify(results, null, 2) + '\n');
  else if (!launchers.length) io.out('no launcher to probe\n');
  else io.out(`recorded in ${file}; a running server picks it up within 30 s\n`);
  return failed ? 1 : 0;
}
