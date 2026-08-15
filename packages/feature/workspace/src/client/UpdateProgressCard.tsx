'use client';

/**
 * Top-level floating card for a self-update in flight.
 *
 * Deliberately NOT a toast and NOT the sidebar popover it replaces. An update
 * takes tens of seconds to minutes, during which the server is gone; the two
 * things the user needs are (a) confirmation that something is still happening
 * and (b) a way out if it isn't. Both have to survive the popover closing, the
 * sidebar collapsing, and a page reload — so this renders from Providers,
 * outside the three-panel container, and never auto-dismisses.
 *
 * No progress BAR by design. npm reports no percentage, and the only numbers we
 * could invent (elapsed / last-run duration) stall at 99% exactly when the user
 * is most anxious. Elapsed time next to the previous run's duration gives the
 * same "how much longer" anchor without ever contradicting itself.
 *
 * This is also the single place in the app that offers a reload. It absorbs
 * useServerBuildGuard — an update this tab never started (`cockpit update` from
 * a terminal, another tab, a manual reinstall + restart) leaves no progress
 * state to show, only a stale build id. That case used to be a separate bottom
 * banner, which produced two cards and two Reload buttons side by side the
 * moment a self-update finished.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import {
  dismissUpdateProgress,
  getUpdateProgress,
  restoreUpdateProgress,
  subscribeUpdateProgress,
  type UpdateProgressState,
} from './updateProgressStore';
import { useServerBuildGuard } from './useServerBuildGuard';

const IN_FLIGHT: ReadonlySet<UpdateProgressState['stage']> = new Set([
  'preparing',
  'installing',
  'repairing',
  'rolling-back',
  'restarting',
]);

function Spinner() {
  return (
    <svg className="h-4 w-4 flex-shrink-0 animate-spin text-brand" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function UpdateProgressCard() {
  const { t } = useTranslation();
  const progress = useSyncExternalStore(
    subscribeUpdateProgress,
    getUpdateProgress,
    // Server snapshot: nothing is ever in flight during SSR.
    getUpdateProgress
  );
  const [now, setNow] = useState(() => Date.now());
  const restored = useRef(false);
  const { stale } = useServerBuildGuard();
  const [staleDismissed, setStaleDismissed] = useState(false);

  // Recover a failed (or still-running) update the reload threw away.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    void restoreUpdateProgress();
  }, []);

  const inFlight = progress.visible && IN_FLIGHT.has(progress.stage);

  // One interval, only while something is actually running — a card sitting on
  // a terminal state must not keep waking the tab up.
  useEffect(() => {
    if (!inFlight) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [inFlight]);

  const copyCommand = useCallback(() => {
    navigator.clipboard.writeText(progress.fixCommand);
    toast(t('workspace.updateCardFixCopied'));
  }, [progress.fixCommand, t]);

  // Our own flow wins: while it is running it already reports the restart, and
  // the build guard would otherwise fire mid-update and say the same thing
  // twice.
  const stalePrompt = !progress.visible && stale && !staleDismissed;
  if (!progress.visible && !stalePrompt) return null;

  const elapsedSec = progress.startedAt ? Math.max(0, Math.round((now - progress.startedAt) / 1000)) : 0;
  const baselineSec = progress.baselineMs ? Math.round(progress.baselineMs / 1000) : null;
  const succeeded = stalePrompt || progress.stage === 'done';
  const terminal = stalePrompt || !IN_FLIGHT.has(progress.stage);
  // Nothing was installed, so this tab's chunks are still the ones the server
  // is serving. Offering a reload here would be a button that does nothing.
  const showReload = succeeded && !progress.upToDate;

  const title = stalePrompt ? t('workspace.serverRestarted') : (() => {
    switch (progress.stage) {
      case 'preparing':
        return t('workspace.updateCardPreparing');
      case 'installing':
        return t('workspace.updateCardInstalling');
      case 'repairing':
        return t('workspace.updateCardRepairing');
      case 'rolling-back':
        return t('workspace.updateCardRollingBack');
      case 'restarting':
        return t('workspace.updateCardRestarting');
      case 'done':
        if (!progress.installedVersion) return t('workspace.updateComplete');
        return progress.upToDate
          ? t('workspace.updateCardUpToDate', { version: progress.installedVersion })
          : t('workspace.updateCardDone', { version: progress.installedVersion });
      case 'failed':
        return t('workspace.updateFailed');
    }
  })();

  return (
    <div
      // Top-right, above the panels, below modals and tooltips: this must stay
      // visible across panel swipes without ever blocking a dialog.
      className="fixed top-4 right-4 z-[100] w-80 rounded-lg border border-border
                 bg-background/95 p-3 shadow-lv2 backdrop-blur"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-2.5">
        {inFlight ? (
          <Spinner />
        ) : succeeded ? (
          <svg className="h-4 w-4 flex-shrink-0 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="h-4 w-4 flex-shrink-0 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        )}

        <div className="min-w-0 flex-1">
          <div className="text-sm text-foreground">{title}</div>

          {inFlight && (
            <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
              {t('workspace.updateCardElapsed', { seconds: elapsedSec })}
              {baselineSec !== null && (
                <> · {t('workspace.updateCardBaseline', { seconds: baselineSec })}</>
              )}
            </div>
          )}

          {inFlight && !progress.live && (
            // Says the progress detail is missing, not that the update is.
            <div className="mt-1 text-[11px] leading-snug text-muted-foreground/80">
              {t('workspace.updateCardNoLiveStatus')}
            </div>
          )}

          {inFlight && (
            // A foreground `cockpit` does not stay in the foreground across an
            // update: the terminal that owned it is already released by the
            // time the replacement is spawned.
            <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
              {t('workspace.updateRestartNote')}
            </div>
          )}

          {/* `stalePrompt` guard matters: a dismissed failure leaves
              stage === 'failed' behind with visible === false, and the build
              guard could then re-open the card on top of it. */}
          {!stalePrompt && progress.stage === 'failed' && (
            <>
              <div className="mt-1 break-words text-[11px] leading-snug text-muted-foreground">
                {progress.error}
              </div>
              {progress.rolledBack && (
                <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
                  {t('workspace.updateCardRolledBack')}
                </div>
              )}
              <div className="mt-2 text-[11px] leading-snug text-muted-foreground">
                {t('workspace.updateCardManualHint')}
              </div>
              {/* The command is rendered, not just copied: a dropped native
                  binary needs `npm uninstall -g … && npm install -g …`, not
                  `cockpit update`, and a copy button whose label does not match
                  what lands on the clipboard is worse than no button. */}
              <code className="mt-1 block break-all rounded bg-hover px-2 py-1.5 text-[11px]
                               leading-snug text-foreground">
                {progress.fixCommand}
              </code>
              <button
                type="button"
                onClick={copyCommand}
                className="mt-1.5 w-full rounded-md border border-border px-2.5 py-1.5 text-xs
                           text-foreground transition-colors hover:bg-hover"
              >
                {t('workspace.updateCardCopyFix')}
              </button>
              {progress.logPath && (
                <div className="mt-1.5 break-all text-[11px] leading-snug text-muted-foreground/80">
                  {t('workspace.updateCardLogHint', { path: progress.logPath })}
                </div>
              )}
            </>
          )}

          {showReload && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-2 w-full rounded-md bg-primary px-2.5 py-1.5 text-xs
                         text-primary-foreground transition-opacity hover:opacity-90"
            >
              {t('workspace.reloadNow')}
            </button>
          )}
        </div>

        {/* Dismissable only once it has stopped moving: an in-flight update the
            user cannot see is exactly the state this card exists to prevent. */}
        {terminal && (
          <button
            type="button"
            // Silences the build guard too, always. Both are statements about
            // the same underlying fact ("the server is on a new build"), so
            // without this, dismissing a finished update immediately re-opens
            // the card with the stale-build wording instead.
            onClick={() => {
              setStaleDismissed(true);
              if (!stalePrompt) dismissUpdateProgress();
            }}
            aria-label={t('common.close')}
            className="-mr-1 -mt-1 rounded p-1 text-muted-foreground transition-colors hover:bg-hover"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
