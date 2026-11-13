import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import { useStore } from '../../store';
import { DEFAULT_SHORTCUTS, type ShortcutAction, type ShortcutBinding } from '../../store/settings-slice';
import { formatAccelerator, liveShortcutText } from '../../shortcuts';
import '../../styles/tutorial.css';

interface TutorialProps {
  onClose: () => void;
  /** Leave the tour for the screen that adds a host. */
  onAddHost?: () => void;
}

/** The part of the window a step is about; the sketch lights it up. */
type Focus = 'window' | 'hosts' | 'sidebar' | 'panes' | 'brief' | 'palette';

interface Step {
  title: string;
  body: string;
  focus: Focus;
  /** The actions whose LIVE bindings the step shows (and whose defaults its text names). */
  shortcuts: ShortcutAction[];
}

function buildSteps(t: (key: TranslationKey) => string): Step[] {
  return [
    { title: t('tutorial.step.welcome.title'), body: t('tutorial.step.welcome.body'), focus: 'window', shortcuts: [] },
    { title: t('tutorial.hosts.title'), body: t('tutorial.hosts.body'), focus: 'hosts', shortcuts: [] },
    { title: t('tutorial.step.workspaces.title'), body: t('tutorial.step.workspaces.body'), focus: 'sidebar', shortcuts: ['newWorkspace', 'toggleSidebar'] },
    { title: t('tutorial.step.splitPanes.title'), body: t('tutorial.step.splitPanes.body'), focus: 'panes', shortcuts: ['splitRight', 'splitDown', 'newSurface'] },
    { title: t('tutorial.brief.title'), body: t('tutorial.brief.body'), focus: 'brief', shortcuts: ['jumpToUnread'] },
    { title: t('tutorial.find.title'), body: t('tutorial.find.body'), focus: 'palette', shortcuts: ['commandPalette'] },
    { title: t('tutorial.step.allSet.title'), body: t('tutorial.step.allSet.body'), focus: 'window', shortcuts: ['toggleShortcutCheatSheet', 'openSettings'] },
  ];
}

/** A sketch of the window, not a screenshot: it only has to show where to look. */
function WindowSketch({ focus }: { focus: Focus }) {
  return (
    <div className="tutorial-map" data-focus={focus} aria-hidden="true">
      <div className="tutorial-map__bar"><i /><i /><i /></div>
      <div className="tutorial-map__side">
        <b /><b /><b />
        <span className="tutorial-map__host" />
      </div>
      <div className="tutorial-map__main">
        {[0, 1].map((pane) => (
          <div className="tutorial-map__pane" key={pane}>
            <div className="tutorial-map__tabs"><i /><i /></div>
            <div className="tutorial-map__brief"><i /><em /></div>
            <div className="tutorial-map__lines"><i /><i /><i /><i /></div>
          </div>
        ))}
      </div>
      <div className="tutorial-map__palette"><i /><b /><b /><b /></div>
    </div>
  );
}

export default function Tutorial({ onClose, onAddHost }: TutorialProps) {
  const t = useT();
  const [currentStep, setCurrentStep] = useState(0);
  const primary = useRef<HTMLButtonElement>(null);

  const live = useStore((s) => s.shortcuts) as Record<ShortcutAction, ShortcutBinding>;
  // Text that names a default key (and the chips under it) shows the live binding.
  const prose: ShortcutAction[] = ['newWorkspace', 'toggleZoom', 'newSurface', 'openBrowser', 'jumpToUnread', 'openSettings', 'commandPalette'];
  const STEPS = buildSteps(t).map((st) => ({ ...st, body: liveShortcutText(st.body, prose, live, DEFAULT_SHORTCUTS) }));
  const step = STEPS[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === STEPS.length - 1;

  // Keys go to the tour while it is open, not to the terminal behind it.
  useEffect(() => { primary.current?.focus(); }, [currentStep]);

  const handleNext = () => {
    if (!isLast) setCurrentStep((s) => s + 1);
  };

  const handlePrevious = () => {
    if (!isFirst) setCurrentStep((s) => s - 1);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
    else if (event.key === 'ArrowRight') handleNext();
    else if (event.key === 'ArrowLeft') handlePrevious();
    else return;
    event.preventDefault();
  };

  const chips = step.shortcuts
    .map((action) => formatAccelerator(live[action]))
    .filter(Boolean);

  return (
    <div className="tutorial-overlay" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
      <div className="tutorial-card" role="dialog" aria-modal="true" aria-labelledby="tutorial-title">
        <WindowSketch focus={step.focus} />

        <div className="tutorial-content">
          <h2 className="tutorial-title" id="tutorial-title">{step.title}</h2>
          <p className="tutorial-body">{step.body}</p>

          {chips.length > 0 && (
            <div className="tutorial-shortcuts">
              {chips.map((shortcut) => (
                <span key={shortcut} className="tutorial-shortcut">
                  {shortcut}
                </span>
              ))}
            </div>
          )}

          {step.focus === 'hosts' && onAddHost && (
            <button type="button" className="tutorial-link" onClick={onAddHost}>
              {t('tutorial.hosts.add')}
            </button>
          )}
        </div>

        <div className="tutorial-nav">
          <div className="tutorial-dots">
            {STEPS.map((item, idx) => (
              <button
                type="button"
                key={idx}
                className={`tutorial-dot${idx === currentStep ? ' tutorial-dot--active' : ''}`}
                aria-label={`${idx + 1} / ${STEPS.length}: ${item.title}`}
                aria-current={idx === currentStep ? 'step' : undefined}
                onClick={() => setCurrentStep(idx)}
              />
            ))}
          </div>

          {!isLast && (
            <button type="button" className="tutorial-btn tutorial-btn--quiet" onClick={onClose}>
              {t('tutorial.skip', 'Skip')}
            </button>
          )}
          {!isFirst && (
            <button type="button" className="tutorial-btn tutorial-btn--secondary" onClick={handlePrevious}>
              {t('tutorial.previous', 'Previous')}
            </button>
          )}
          <button
            type="button"
            ref={primary}
            className="tutorial-btn tutorial-btn--primary"
            onClick={isLast ? onClose : handleNext}
          >
            {isLast ? t('tutorial.getStarted', 'Get Started') : t('tutorial.next', 'Next')}
          </button>
        </div>
      </div>
    </div>
  );
}
