'use client';

/**
 * Shown when the server has restarted onto a different build than the one this
 * tab was loaded from. See useServerBuildGuard for why that is dangerous.
 *
 * A banner rather than a toast: toasts auto-dismiss, and this state does not go
 * away on its own — every later navigation in this tab is at risk until it is
 * reloaded. Rendered from Providers, outside the three-panel container, so its
 * `position: fixed` is viewport-relative and not dragged around by the panels'
 * translateX (same reason TooltipProvider lives there).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useServerBuildGuard } from './useServerBuildGuard';

export function ServerRestartedBanner() {
  const { stale } = useServerBuildGuard();
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);

  if (!stale || dismissed) return null;

  return (
    <div
      // z-index sits above the panels but below modals/tooltips: this is
      // informational and must never block a dialog the user is mid-way through.
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3
                 rounded-lg border border-border bg-background/95 px-4 py-2.5
                 shadow-lv2 backdrop-blur"
      role="status"
    >
      <span className="text-sm text-foreground">{t('workspace.serverRestarted')}</span>
      <button
        onClick={() => window.location.reload()}
        className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground
                   transition-colors hover:opacity-90"
      >
        {t('workspace.reloadNow')}
      </button>
      <button
        onClick={() => setDismissed(true)}
        aria-label={t('common.close')}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-hover"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
