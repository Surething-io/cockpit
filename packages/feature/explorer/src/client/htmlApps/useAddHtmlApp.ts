'use client';

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { addHtmlApp } from '@cockpit/shared-api';
import { notifyHtmlAppsChanged } from './htmlAppsBus';

/**
 * Shared "add this HTML to the HTML-apps registry (html.json)" action, used by
 * the chat + explorer HTML-preview buttons. Toasts "added" / "already added" /
 * error, and notifies the registry bus so the panel + `/name` refresh.
 * `path` must be absolute (POST /api/html-apps rejects relative paths).
 */
export function useAddHtmlApp(): (path: string) => Promise<void> {
  const { t } = useTranslation();
  return useCallback(async (path: string) => {
    const exit = await BrowserRuntime.runPromiseExit(addHtmlApp(path));
    if (exit._tag === 'Success') {
      if (exit.value.alreadyExists) {
        toast(t('htmlApps.alreadyAdded'), 'info');
      } else {
        toast(t('htmlApps.added'), 'success');
        notifyHtmlAppsChanged();
      }
    } else {
      const failure = exit.cause._tag === 'Fail' ? exit.cause.error : null;
      const inner = failure?.cause;
      const msg = inner instanceof Error ? inner.message : t('htmlApps.addFailed');
      toast(msg, 'error');
    }
  }, [t]);
}
