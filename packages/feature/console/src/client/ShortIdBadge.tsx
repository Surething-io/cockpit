'use client';

import { useState, useCallback, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { TitleEditDialog } from './TitleEditDialog';

/** Use `cockpit-dev` on the dev port; `cockpit` (the recommended long-name
 *  entry) everywhere else. Prod port is auto-detected from ~/.cockpit/server.json. */
function getCockBin(): string {
  const port = typeof window !== 'undefined' ? window.location.port : '3457';
  return port === '3456' ? 'cockpit-dev' : 'cockpit';
}

interface ShortIdBadgeProps {
  shortId: string;
  /** CLI subcommand type: terminal / browser */
  type: 'terminal' | 'browser';
  onRegister: () => void | Promise<void>;
  onUnregister: () => void | Promise<void>;
  /**
   * Stable persistence key for the bubble's title. Terminal: commandId.
   * Browser: fullId. Must match the key the server uses in bubble-order's
   * titles map.
   */
  fullId?: string;
  /** Project root the bubble belongs to. Required for title fetch + save. */
  projectCwd?: string;
  /** Tab the bubble lives in. Required for title fetch + save. */
  tabId?: string;
}

export const ShortIdBadge = memo(function ShortIdBadge({
  shortId,
  type,
  onRegister,
  onUnregister,
  fullId,
  projectCwd,
  tabId,
}: ShortIdBadgeProps) {
  const { t } = useTranslation();
  const [registered, setRegistered] = useState(false);
  const [title, setTitle] = useState('');
  const [editing, setEditing] = useState(false);

  // Fetch existing title once per (fullId, projectCwd, tabId) tuple. The
  // bubble-order GET returns { order, titles } where titles is keyed by fullId
  // (commandId for terminal, fullId for browser).
  useEffect(() => {
    if (!fullId || !projectCwd || !tabId) return;
    let cancelled = false;
    const params = new URLSearchParams({ cwd: projectCwd, tabId });
    fetch(`/api/terminal/bubble-order?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        const titles = (j?.data?.titles ?? {}) as Record<string, string>;
        const v = titles[fullId];
        if (typeof v === 'string') setTitle(v);
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [fullId, projectCwd, tabId]);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (registered) {
      // Unregister
      await onUnregister();
      setRegistered(false);
      toast(t('toast.disconnected', { id: shortId }));
    } else {
      // Register + copy help command
      await onRegister();
      setRegistered(true);
      const cmd = `${getCockBin()} ${type} ${shortId}`;
      navigator.clipboard.writeText(cmd);
      toast(t('toast.copiedCommand', { command: cmd }));
    }
  }, [registered, shortId, type, onRegister, onUnregister, t]);

  const canEditTitle = !!(fullId && projectCwd && tabId);

  const openEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (canEditTitle) setEditing(true);
  }, [canEditTitle]);

  const saveTitle = useCallback(async (newTitle: string) => {
    if (!fullId || !projectCwd || !tabId) return;
    try {
      await fetch('/api/terminal/bubble-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: projectCwd,
          tabId,
          // Empty string deletes the entry server-side (see mergeTitles).
          titles: { [fullId]: newTitle },
        }),
      });
      setTitle(newTitle);
      setEditing(false);
    } catch {
      // Swallow — title save failure shouldn't break the bubble UX. Could
      // surface a toast in a future iteration.
      setEditing(false);
    }
  }, [fullId, projectCwd, tabId]);

  return (
    <>
      <button
        onClick={handleClick}
        className="inline-flex items-center gap-1 text-[10px] font-mono leading-none px-1.5 py-0.5 rounded flex-shrink-0 transition-colors bg-muted/60 hover:bg-muted text-muted-foreground"
        title={registered ? t('shortIdBadge.clickToDisconnect') : t('shortIdBadge.clickToRegister')}
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${registered ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
        {shortId}
      </button>
      {canEditTitle && (title ? (
        // Title set → label chip + ✎ button.
        <span
          className="inline-flex items-center gap-0.5 text-[10px] leading-none flex-shrink-0 text-muted-foreground"
          title={t('shortIdBadge.titleSet', { title }) || title}
        >
          <span className="px-1 py-0.5 rounded bg-muted/40 max-w-[120px] truncate">{title}</span>
          <button
            onClick={openEdit}
            className="opacity-50 hover:opacity-100 transition-opacity"
            aria-label={t('shortIdBadge.editTitle')}
            title={t('shortIdBadge.editTitle')}
          >
            ✎
          </button>
        </span>
      ) : (
        // No title → muted "set title" chip; whole thing is clickable.
        <button
          onClick={openEdit}
          className="inline-flex items-center gap-0.5 text-[10px] leading-none flex-shrink-0 text-muted-foreground/50 hover:text-muted-foreground italic transition-colors"
          title={t('shortIdBadge.setTitle')}
        >
          ({t('shortIdBadge.setTitlePlaceholder')}) ✎
        </button>
      ))}
      <TitleEditDialog
        open={editing}
        initialValue={title}
        onCancel={() => setEditing(false)}
        onSave={saveTitle}
      />
    </>
  );
});
