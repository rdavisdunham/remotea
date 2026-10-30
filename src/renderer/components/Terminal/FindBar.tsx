import { useState, useRef, useEffect } from 'react';
import { useT } from '../../i18n';
import { FIXED_SHORTCUTS, shortcutTooltip } from '../../shortcuts';

interface FindBarProps {
  onSearch: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  matchCount?: number;
  currentMatch?: number;
}

export default function FindBar({ onSearch, onNext, onPrevious, onClose, matchCount, currentMatch }: FindBarProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    onSearch(query);
  }, [query, onSearch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); e.stopPropagation(); }
    if (e.key === 'Enter') { e.shiftKey ? onPrevious() : onNext(); }
  };

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        className="find-bar__input"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('terminal.findPlaceholder', 'Find...')}
      />
      {matchCount !== undefined && (
        <span className="find-bar__count">{currentMatch ?? 0}/{matchCount}</span>
      )}
      <button className="find-bar__btn" onClick={onPrevious} title={shortcutTooltip(t('terminal.findPrevious', 'Previous (Shift+Enter)'), FIXED_SHORTCUTS.previousMatch)}>&#x2191;</button>
      <button className="find-bar__btn" onClick={onNext} title={shortcutTooltip(t('terminal.findNext', 'Next (Enter)'), FIXED_SHORTCUTS.nextMatch)}>&#x2193;</button>
      <button className="find-bar__btn" onClick={onClose} title={shortcutTooltip(t('terminal.findClose', 'Close (Esc)'), FIXED_SHORTCUTS.dismiss)}>&#x00D7;</button>
    </div>
  );
}
