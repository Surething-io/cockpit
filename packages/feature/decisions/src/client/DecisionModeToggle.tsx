'use client';

import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Scale } from 'lucide-react';
import { confirm, toast } from '@cockpit/shared-ui';
import { useDecisionMode } from './useDecisionMode';

/**
 * Decision-mode feature switch for the chat input toolbar (docs/DECISION_MODE.md §2).
 *
 * Per project, default off. Off means the feature produces nothing at all;
 * on enters the review / decision working mode. Desktop only — the mobile
 * chat does not mount it.
 */
export const DecisionModeToggle = memo(function DecisionModeToggle({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const { resolution, enabled, busy, setEnabled, bind } = useDecisionMode(cwd);

  const failed = useCallback(() => toast(t('decisions.toggleFailed', { defaultValue: 'Could not change decision mode' }), 'error'), [t]);

  const onChange = useCallback(
    async (next: boolean) => {
      if (!resolution || busy) return;
      if (!next) {
        if (!(await setEnabled(false))) failed();
        return;
      }

      // A clone that shares its root commit with another live checkout: ask
      // whether it is the same project before anything is written.
      if (resolution.status === 'ambiguous') {
        const candidate = resolution.candidates[0];
        const same = await confirm(
          t('decisions.ambiguousSame', {
            defaultValue: 'This repository shares its first commit with {{path}}. Is it the same project? Same project shares its decisions.',
            path: candidate.toplevels.join(', '),
          }),
          {
            title: t('decisions.ambiguousTitle', { defaultValue: 'Which project is this?' }),
            confirmText: t('decisions.sameProject', { defaultValue: 'Same project' }),
            cancelText: t('decisions.notSameProject', { defaultValue: 'No' }),
          },
        );
        let choice: string | null = same ? candidate.projectId : null;
        if (!same) {
          const separate = await confirm(
            t('decisions.ambiguousSeparate', { defaultValue: 'Start a separate decision record for this repository?' }),
            {
              title: t('decisions.ambiguousTitle', { defaultValue: 'Which project is this?' }),
              confirmText: t('decisions.separateProject', { defaultValue: 'Separate project' }),
            },
          );
          if (separate) choice = 'new';
        }
        if (!choice) return;
        const bound = await bind(choice);
        if (!bound) return failed();
        if (!(await setEnabled(true))) failed();
        return;
      }

      if (resolution.kind === 'path' && resolution.enabledAt === undefined) {
        const ok = await confirm(
          t('decisions.pathProjectWarning', {
            defaultValue: 'This folder is not a git repository with commits, so decisions are tied to its path. Moving or renaming the folder loses them. Turn on decision mode?',
          }),
          { title: t('decisions.mode', { defaultValue: 'Decision mode' }) },
        );
        if (!ok) return;
      }
      if (!(await setEnabled(true))) failed();
    },
    [resolution, busy, setEnabled, bind, failed, t],
  );

  return (
    <label
      className="flex items-center gap-2 text-xs cursor-pointer select-none"
      data-tooltip={t('decisions.modeDesc', { defaultValue: 'review changes · keep decisions · per project' })}
    >
      <input
        type="checkbox"
        data-testid="decisionmode-toggle"
        checked={enabled}
        disabled={!resolution || busy}
        onChange={(e) => void onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-brand peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-50"
      >
        <span className={`h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </span>
      <span className="flex items-center gap-1.5 text-foreground">
        <Scale className="w-3.5 h-3.5" />
        {t('decisions.mode', { defaultValue: 'Decision mode' })}
      </span>
    </label>
  );
});
