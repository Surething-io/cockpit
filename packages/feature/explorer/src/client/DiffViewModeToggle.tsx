'use client';

import { useTranslation } from 'react-i18next';

/**
 * split/unified view-mode toggle for a diff pane.
 *
 * Mirrors DiffDensityToggle: the pane owns the actual capability (render
 * DiffView for 'split' vs. DiffUnifiedView for 'unified'); this is just the
 * standard pair of buttons that toolbars mount to drive it. State stays
 * pane-local by design — no persistence, defaults to 'split'.
 */
export interface DiffViewModeToggleProps {
  value: 'split' | 'unified';
  onChange: (value: 'split' | 'unified') => void;
  className?: string;
}

export function DiffViewModeToggle({ value, onChange, className }: DiffViewModeToggleProps) {
  const { t } = useTranslation();
  return (
    <div className={`flex items-center gap-0.5 rounded border border-border overflow-hidden ${className ?? ''}`}>
      {(['split', 'unified'] as const).map((mode) => (
        <button
          key={mode}
          onClick={(e) => {
            e.stopPropagation();
            onChange(mode);
          }}
          className={`px-2 py-0.5 text-xs transition-colors ${
            value === mode
              ? 'bg-brand text-white'
              : 'text-muted-foreground hover:bg-accent'
          }`}
        >
          {t(mode === 'split' ? 'diffViewer.viewSplit' : 'diffViewer.viewUnified')}
        </button>
      ))}
    </div>
  );
}
