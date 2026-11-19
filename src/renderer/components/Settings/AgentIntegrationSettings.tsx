import { isIntegrationStatus, type IntegrationStatus } from '../../../shared/integration-status';
import { useState, useEffect, useRef } from 'react';
import { useT } from '../../i18n';
import type { TranslationKey } from '../../i18n';

/**
 * Settings → Agents → Agent integration (issue #132).
 *
 * wmux writes into ~/.claude, ~/.config/opencode and ~/.kiro so coding agents drive
 * its browser panel, markdown views and sidebar. It used to do that silently on
 * every launch, which made deleting any of it pointless — the next launch put it
 * straight back. This panel is the "you can change your mind" half of the fix:
 * the first-launch dialog asks, and this is where the answer lives afterwards.
 *
 * Consent is read from main's settings store. A separate read-only file check
 * observes managed content; neither fact proves a running agent has loaded it.
 */

type Feature = 'instructions' | 'hooks' | 'orchestrator' | 'browserMcp';

interface Consent {
  decision: 'unset' | 'granted' | 'declined';
  features: Record<Feature, boolean>;
}

/** What this panel sends back: a decision, or a single flipped checkbox. */
interface ConsentPatch {
  decision?: Consent['decision'];
  features?: Partial<Record<Feature, boolean>>;
}

const FEATURES: Array<{ key: Feature; labelKey: TranslationKey; labelFallback: string; pathHint: string }> = [
  {
    key: 'instructions',
    labelKey: 'settings.integration.instructions',
    labelFallback: 'Agent instructions',
    pathHint: '~/.claude/CLAUDE.md · ~/.config/opencode/AGENTS.md · ~/.kiro/steering/remotea.md · ~/.omp/agent/AGENTS.md · ~/.pi/agent/AGENTS.md · ~/.grok/rules/remotea.md · ~/.qwen/QWEN.md',
  },
  {
    key: 'hooks',
    labelKey: 'settings.integration.hooks',
    labelFallback: 'Status hooks',
    pathHint: '~/.claude/settings.json · ~/.omp/agent/extensions/remotea.js · ~/.pi/agent/extensions/remotea.js · ~/.grok/hooks/remotea.json · ~/.gemini/config/plugins/remotea/ · ~/.qwen/settings.json',
  },
  {
    key: 'orchestrator',
    labelKey: 'settings.integration.orchestrator',
    labelFallback: 'OpenCode status and task plugin',
    // OpenCode only since 2.12.0. The Claude Code plugin this also used to
    // install is deprecated (issue #239) and is uninstalled whichever way this
    // toggle is set, so naming ~/.claude/plugins/ here would promise a write
    // that no longer happens — and the hint is the only place a user can see
    // what a checkbox actually touches.
    pathHint: '~/.config/opencode/plugin/',
  },
  {
    key: 'browserMcp',
    labelKey: 'settings.integration.browserMcp',
    labelFallback: 'Connect agent MCP tools to the desktop browser',
    pathHint: '~/.claude.json · ~/.qwen/settings.json',
  },
];

export default function AgentIntegrationSettings() {
  const t = useT();
  const [consent, setConsent] = useState<Consent | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [error, setError] = useState<'read' | 'write' | null>(null);
  const request = useRef(0);

  const refresh = async () => {
    const current = ++request.current;
    setReading(true);
    setError(null);
    try {
      const api = window.remotea?.integration;
      if (!api?.get || !api?.status) throw new Error('Unavailable');
      const [configured, observed] = await Promise.all([api.get(), api.status()]);
      if (!configured || !isIntegrationStatus(observed)) {
        throw new Error('Invalid integration response');
      }
      if (request.current !== current) return;
      setConsent(configured as Consent);
      setStatus(observed);
    } catch {
      if (request.current === current) setError('read');
    } finally {
      if (request.current === current) setReading(false);
    }
  };

  useEffect(() => {
    void refresh();
    return () => { request.current++; };
  }, []);

  // Consent and observed files are separate facts: a saved choice does not prove
  // every provider write succeeded, nor that a running agent consumed a file.
  const push = async (partial: ConsentPatch) => {
    const current = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const api = window.remotea?.integration;
      if (!api?.set) throw new Error('Unavailable');
      const next = await api.set(partial);
      if (!next) throw new Error('Missing consent response');
      if (request.current !== current) return;
      setConsent(next as Consent);
      try {
        if (!api.status) throw new Error('Unavailable');
        const observed = await api.status();
        if (!isIntegrationStatus(observed)) {
          throw new Error('Invalid integration response');
        }
        if (request.current === current) setStatus(observed);
      } catch {
        if (request.current === current) setError('read');
      }
    } catch {
      if (request.current === current) setError('write');
    } finally {
      if (request.current === current) setBusy(false);
    }
  };

  const enabled = consent?.decision === 'granted';

  return (
    <>
      <div className="settings-divider" />
      <h3 className="settings-section-title">
        {t('settings.integration.section', 'Agent integration')}
      </h3>

      <div className="settings-row">
        <label className="settings-label">
          {t('settings.integration.enable', 'Configure coding-agent integrations on this computer')}
        </label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={enabled}
          disabled={busy || reading || consent === null}
          onChange={(e) => push({ decision: e.target.checked ? 'granted' : 'declined' })}
        />
      </div>

      <p className="settings-hint">
        {t(
          'settings.integration.hint',
          'remotea edits files in your home directory so coding agents can drive its browser panel, markdown views and sidebar status. Turning something off here also removes what it wrote.',
        )}
      </p>

      <p className="settings-hint">{t('settings.integration.configuredHint')}</p>
      {consent && (
        <p className="settings-hint">
          {t('settings.integration.savedChoice')}: {t(`settings.integration.choice.${consent.decision}`)}
        </p>
      )}
      {error && (
        <p className="settings-hint" role="alert">
          {t(error === 'read' ? 'settings.integration.readFailed' : 'settings.integration.writeFailed')}
        </p>
      )}
      <div className="settings-row">
        <button className="settings-btn" disabled={busy || reading} onClick={() => void refresh()}>
          {t(reading ? 'settings.integration.checking' : 'settings.integration.refresh')}
        </button>
        <button
          className="settings-btn"
          disabled={busy || reading || !consent || consent.decision === 'unset'}
          onClick={() => void push({})}
        >
          {t('settings.integration.retryApply')}
        </button>
      </div>
      {status && (
        <div className="settings-integration-status">
          <h4>{t('settings.integration.observedTitle')}</h4>
          <p className="settings-hint">{t('settings.integration.runtimeNotProbed')}</p>
          <p className="settings-hint">
            {t('settings.integration.checkedAt').replace('{time}', new Date(status.checkedAt).toLocaleString())}
          </p>
          <p className="settings-hint">{t('settings.integration.stateMeaning')}</p>
          {status.failures.map((failure, index) => (
            <p key={index} role="alert" className="settings-hint">
              {failure.provider} · {t(failure.operation === 'write'
                ? 'settings.integration.writeOperation' : 'settings.integration.removeOperation')} · {failure.code}
            </p>
          ))}
          {status.files.some(file => file.state === 'error') && (
            <p className="settings-hint" role="alert">{t('settings.integration.fileReadErrors')}</p>
          )}
          {[...new Set(status.files.map(file => file.provider))].map(provider => {
            const files = status.files.filter(file => file.provider === provider);
            const counts = t('settings.integration.fileCounts')
              .replace('{present}', String(files.filter(file => file.state === 'present').length))
              .replace('{missing}', String(files.filter(file => file.state === 'missing').length))
              .replace('{modified}', String(files.filter(file => file.state === 'modified').length))
              .replace('{errors}', String(files.filter(file => file.state === 'error').length));
            return (
              <details key={provider}>
                <summary>{provider} · {t('settings.integration.desktopEnvironment')} · {counts}</summary>
                <ul>
                  {files.map(file => (
                    <li key={`${file.feature}:${file.path}`}>
                      <strong>{t(FEATURES.find(feature => feature.key === file.feature)!.labelKey)}</strong>
                      {' · '}{t(`settings.integration.file.${file.state}`)}
                      {file.code && ` · ${file.code}`}
                      <div className="settings-hint" style={{ overflowWrap: 'anywhere' }}>{file.path}</div>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      )}

      {FEATURES.map((f) => (
        <div className="settings-row" key={f.key}>
          <label className="settings-label">
            {t(f.labelKey, f.labelFallback)}
            <span className="settings-hint" style={{ display: 'block', opacity: 0.65 }}>{f.pathHint}</span>
          </label>
          <input
            type="checkbox"
            className="settings-toggle"
            checked={!!consent?.features?.[f.key] && enabled}
            // Sub-features of an integration that is off are not merely
            // unchecked, they are meaningless — disable them rather than let
            // one be ticked while nothing it controls can run.
            disabled={busy || reading || !enabled}
            onChange={(e) => push({ features: { [f.key]: e.target.checked } })}
          />
        </div>
      ))}
    </>
  );
}
