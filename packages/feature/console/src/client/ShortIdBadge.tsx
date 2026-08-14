'use client';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast, useWebSocket } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { TitleEditDialog } from './TitleEditDialog';
import { loadBubbleTitles, saveBubbleTitle } from './effect/consoleClient';

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
  // Anchor for the title popover. Only one trigger renders at a time
  // (✎ when a title is set, "set title" chip otherwise), so a single ref
  // attached to whichever is mounted is enough.
  const editAnchorRef = useRef<HTMLButtonElement>(null);

  // Fetch existing title once per (fullId, projectCwd, tabId) tuple. `titles` is
  // keyed by fullId (commandId for terminal, fullId for browser).
  useEffect(() => {
    if (!fullId || !projectCwd || !tabId) return;
    let cancelled = false;
    BrowserRuntime.runPromiseExit(loadBubbleTitles(projectCwd, tabId)).then(
      (exit) => {
        if (cancelled || exit._tag !== 'Success') return;
        const v = exit.value[fullId];
        if (typeof v === 'string') setTitle(v);
      }
    );
    return () => { cancelled = true; };
  }, [fullId, projectCwd, tabId]);

  // Keep the title in sync when another browser tab renames this bubble.
  // Apply is idempotent (sets the same string), so our own echo is harmless.
  useWebSocket({
    url: '/ws/global-state',
    enabled: !!fullId && !!projectCwd && !!tabId,
    onMessage: (raw) => {
      const p = raw as {
        type?: string; cwd?: string; tabId?: string; op?: string;
        titles?: Record<string, string>;
      };
      if (p.type !== 'console-delta' || p.op !== 'rename') return;
      if (p.cwd !== projectCwd || p.tabId !== tabId) return;
      if (!p.titles || !fullId) return;
      if (Object.prototype.hasOwnProperty.call(p.titles, fullId)) {
        setTitle(p.titles[fullId] ?? '');
      }
    },
  });

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
    // Empty string deletes the entry server-side (see mergeTitles).
    const exit = await BrowserRuntime.runPromiseExit(
      saveBubbleTitle(projectCwd, tabId, fullId, newTitle)
    );
    // Failure is swallowed — a title save failing shouldn't break the bubble
    // UX. Could surface a toast in a future iteration.
    if (exit._tag === 'Success') setTitle(newTitle);
    setEditing(false);
  }, [fullId, projectCwd, tabId]);

  return (
    <>
      <button
        onClick={handleClick}
        // Swallow double-clicks so they don't bubble to the bubble header's
        // onDoubleClick (which would maximize the window). The badge only
        // responds to single-click (register/copy toggle).
        onDoubleClick={(e) => e.stopPropagation()}
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
            ref={editAnchorRef}
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
          ref={editAnchorRef}
          onClick={openEdit}
          className="inline-flex items-center gap-0.5 text-[10px] leading-none flex-shrink-0 text-muted-foreground/50 hover:text-muted-foreground italic transition-colors"
          title={t('shortIdBadge.setTitle')}
        >
          ({t('shortIdBadge.setTitlePlaceholder')}) ✎
        </button>
      ))}
      <TitleEditDialog
        open={editing}
        anchorRef={editAnchorRef}
        initialValue={title}
        onCancel={() => setEditing(false)}
        onSave={saveTitle}
      />
    </>
  );
});
