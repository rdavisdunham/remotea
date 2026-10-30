import type { RunHealth } from '../../remote-sessions/host-health';
import '../../styles/remote-hosts.css';

/**
 * remotea: the run state chip on a task workspace's sidebar row (task
 * 0ec167e4): the same labels and tones as Settings → Remote hosts, where the
 * run, the process and the host connection are told apart.
 */
export default function TaskRunChip({ run }: { run: RunHealth | null }) {
  if (!run) return null;
  return (
    <span
      className={`remote-host-chip remote-host-chip--${run.tone} sidebar__run-chip`}
      data-kind="run"
      data-state={run.state}
      title={`Eridani run ${run.runId.slice(0, 8)} · generation ${run.generation}${run.verify ? ` · ${run.verify}` : ''}`}
    >
      <span className="remote-host-chip__dot" />
      {run.label}
    </span>
  );
}
