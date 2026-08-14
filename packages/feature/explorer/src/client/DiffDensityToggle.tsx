'use client';

import { useTranslation } from 'react-i18next';

/**
 * 精简/全文 (compact/full) density toggle for DiffView.
 *
 * DiffView owns the actual capability (`compact` prop: GitHub-style
 * changed-lines-only with expandable gap bars vs. every line rendered);
 * this is just the standard pair of buttons that pane toolbars mount to
 * drive it. State stays pane-local by design (same as StatusDiffPane) —
 * no persistence.
 */
export interface DiffDensityToggleProps {
  value: 'compact' | 'full';
  onChange: (value: 'compact' | 'full') => void;
  className?: string;
}

export function DiffDensityToggle({ value, onChange, className }: DiffDensityToggleProps) {
  const { t } = useTranslation();
  return (
    <div className={`flex items-center gap-0.5 rounded border border-border overflow-hidden ${className ?? ''}`}>
      {(['compact', 'full'] as const).map((density) => (
        <button
          key={density}
          onClick={(e) => {
            e.stopPropagation();
            onChange(density);
          }}
          className={`px-2 py-0.5 text-xs transition-colors ${
            value === density
              ? 'bg-brand text-white'
              : 'text-muted-foreground hover:bg-hover'
          }`}
        >
          {t(density === 'compact' ? 'diffViewer.compact' : 'diffViewer.full')}
        </button>
      ))}
    </div>
  );
}
