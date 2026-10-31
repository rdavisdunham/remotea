import { useT } from '../../i18n';
import type { RunHealth } from '../../remote-sessions/host-health';
import '../../styles/remote-hosts.css';

/**
 * remotea: the run state chip on a task workspace's sidebar row (task
 * 0ec167e4): the same labels and tones as Settings → Remote hosts, where the
 * run, the process and the host connection are told apart.
 */
export default function TaskRunChip({ run }: { run: RunHealth | null }) {
  const t = useT();
  if (!run) return null;
  const activity = t(`health.run.${run.state}`);
  const label = run.stale ? t('health.lastKnown').replace('{state}', activity) : activity;
  return (
    <span
      className={`remote-host-chip remote-host-chip--${run.tone} sidebar__run-chip`}
      data-kind="run"
      data-state={run.state}
      title={`${t('activity.runActivity')} ${run.runId.slice(0, 8)} · ${run.generation}${run.verify ? ` · ${run.verify}` : ''}. ${t('activity.stateHint')}`}
    >
      <span className="remote-host-chip__dot" />
      {label}
    </span>
  );
}
