import React, { useState } from 'react';
import { useT } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import { useStore } from '../../store';
import { DEFAULT_SHORTCUTS, type ShortcutAction, type ShortcutBinding } from '../../store/settings-slice';
import { formatAccelerator, liveShortcutText } from '../../shortcuts';
import '../../styles/tutorial.css';

interface TutorialProps {
  onClose: () => void;
}

interface Step {
  title: string;
  body: string;
  /** The actions whose LIVE bindings the step shows (and whose defaults its text names). */
  shortcuts: ShortcutAction[];
}

function buildSteps(t: (key: TranslationKey) => string): Step[] {
  return [
    { title: t('tutorial.step.welcome.title'), body: t('tutorial.step.welcome.body'), shortcuts: [] },
    { title: t('tutorial.location.title'), body: t('tutorial.location.body'), shortcuts: [] },
    { title: t('tutorial.step.workspaces.title'), body: t('tutorial.step.workspaces.body'), shortcuts: ["newWorkspace", "toggleSidebar"] },
    { title: t('tutorial.step.splitPanes.title'), body: t('tutorial.step.splitPanes.body'), shortcuts: ["splitRight", "splitDown"] },
    { title: t('tutorial.step.surfaceTabs.title'), body: t('tutorial.step.surfaceTabs.body'), shortcuts: ["newSurface", "closeSurfaceOrPane"] },
    { title: t('tutorial.step.browserPanel.title'), body: t('tutorial.step.browserPanel.body'), shortcuts: ["openBrowser"] },
    { title: t('tutorial.step.notifications.title'), body: t('tutorial.step.notifications.body'), shortcuts: ["jumpToUnread"] },
    { title: t('tutorial.return.title'), body: t('tutorial.return.body'), shortcuts: [] },
    { title: t('tutorial.step.allSet.title'), body: t('tutorial.step.allSet.body'), shortcuts: ["toggleShortcutCheatSheet", "openSettings", "commandPalette"] },
  ];
}

export default function Tutorial({ onClose }: TutorialProps) {
  const t = useT();
  const [currentStep, setCurrentStep] = useState(0);

  const live = useStore((s) => s.shortcuts) as Record<ShortcutAction, ShortcutBinding>;
  // Text that names a default key (and the chips under it) shows the live binding.
  const prose: ShortcutAction[] = ['newWorkspace', 'toggleZoom', 'newSurface', 'openBrowser', 'jumpToUnread', 'openSettings', 'commandPalette'];
  const STEPS = buildSteps(t).map((st) => ({ ...st, body: liveShortcutText(st.body, prose, live, DEFAULT_SHORTCUTS) }));
  const step = STEPS[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === STEPS.length - 1;

  const handleNext = () => {
    if (!isLast) setCurrentStep((s) => s + 1);
  };

  const handlePrevious = () => {
    if (!isFirst) setCurrentStep((s) => s - 1);
  };

  return (
    <div className="tutorial-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="tutorial-card">
        {!isLast && (
          <button className="tutorial-skip" onClick={onClose}>
            {t('tutorial.skip', 'Skip')}
          </button>
        )}

        <div className="tutorial-dots">
          {STEPS.map((_, idx) => (
            <div
              key={idx}
              className={`tutorial-dot${idx === currentStep ? ' tutorial-dot--active' : ''}`}
            />
          ))}
        </div>

        <h2 className="tutorial-title">{step.title}</h2>
        <p className="tutorial-body">{step.body}</p>

        {step.shortcuts.length > 0 && (
          <div className="tutorial-shortcuts">
            {step.shortcuts.map((action) => formatAccelerator(live[action])).filter(Boolean).map((shortcut) => (
              <span key={shortcut} className="tutorial-shortcut">
                {shortcut}
              </span>
            ))}
          </div>
        )}

        <div className="tutorial-nav">
          <button
            className="tutorial-btn tutorial-btn--secondary"
            onClick={handlePrevious}
            disabled={isFirst}
          >
            {t('tutorial.previous', 'Previous')}
          </button>

          <span className="tutorial-step-counter">
            {currentStep + 1} / {STEPS.length}
          </span>

          {isLast ? (
            <button className="tutorial-btn tutorial-btn--primary" onClick={onClose}>
              {t('tutorial.getStarted', 'Get Started')}
            </button>
          ) : (
            <button className="tutorial-btn tutorial-btn--primary" onClick={handleNext}>
              {t('tutorial.next', 'Next')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
