'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { onWsReconnect, useWebSocket } from '@cockpit/shared-ui';
import { requestSessionTitle } from './effect/sessionTitlesClient';
import { acceptSessionTitle, effectiveTitle, serverTitleSnapshot, subscribeTitles, titleSnapshot, trackTitle, trackedTitles } from './sessionTitleState';
import { normalizeSessionTitle, type SessionTitleChange } from '../shared/sessionTitle';

export const useSessionTitleOverrides = () => useSyncExternalStore(subscribeTitles, titleSnapshot, serverTitleSnapshot);
export { effectiveTitle } from './sessionTitleState';

/** Shared socket is per URL. Mount once per window, including mobile and project iframes. */
export function SessionTitlesBridge() {
  const onMessage = useCallback((raw: unknown) => {
    const message = raw as { type?: string; data?: SessionTitleChange & { sessions?: SessionTitleChange[] } };
    if (message.type === 'session-title-changed' && message.data) acceptSessionTitle(message.data);
    if (message.type === 'global-state' && message.data?.sessions) {
      for (const entry of message.data.sessions) {
        if (typeof entry.titleRevision === 'number' && entry.defaultTitle !== undefined && entry.customTitle !== undefined) acceptSessionTitle(entry);
      }
    }
  }, []);
  useWebSocket({ url: '/ws/global-state', onMessage });
  useEffect(() => onWsReconnect(() => {
    for (const { cwd, sessionId } of trackedTitles()) {
      BrowserRuntime.runFork(requestSessionTitle(cwd, sessionId).pipe(
        Effect.tap((info) => Effect.sync(() => acceptSessionTitle(info))),
        Effect.catchAll((error) => Effect.logWarning('Cannot refresh session title', error)),
      ));
    }
  }), []);
  return null;
}

export function SessionTitle({ cwd, sessionId, title, titleRevision, initialTitleReady = false, editable = true }: {
  cwd: string; sessionId: string; title: string; titleRevision?: number; initialTitleReady?: boolean; editable?: boolean;
}) {
  const { t } = useTranslation();
  const titles = useSessionTitleOverrides();
  const display = effectiveTitle(titles, cwd, sessionId, title, titleRevision);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (!cwd || !sessionId) return;
    const untrack = trackTitle(cwd, sessionId);
    let active = true;
    if (!initialTitleReady) BrowserRuntime.runFork(requestSessionTitle(cwd, sessionId).pipe(
      Effect.tap((info) => Effect.sync(() => { if (active) acceptSessionTitle(info); })),
      Effect.catchAll((cause) => Effect.logWarning('Cannot read session title', cause)),
    ));
    return () => { active = false; untrack(); };
  }, [cwd, sessionId, initialTitleReady]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setReady(false);
    setError('');
    BrowserRuntime.runFork(requestSessionTitle(cwd, sessionId).pipe(Effect.match({
      onSuccess: (info) => {
        if (!active) return;
        acceptSessionTitle(info); setValue(info.title); setCustom(info.customTitle !== null); setReady(true);
        input.current?.focus(); input.current?.select();
      },
      onFailure: () => { if (active) setError(t('sessions.titleLoadFailed')); },
    })));
    return () => { active = false; };
  }, [open, cwd, sessionId, t]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!pending.current) setOpen(false); }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [open]);

  const save = async (next: string | null) => {
    if (pending.current || !ready) return;
    if (next !== null && !normalizeSessionTitle(next)) { setError(t('sessions.titleEmpty')); return; }
    pending.current = true; setBusy(true); setError('');
    const exit = await BrowserRuntime.runPromiseExit(requestSessionTitle(cwd, sessionId, next));
    pending.current = false; setBusy(false);
    if (exit._tag === 'Success') { acceptSessionTitle(exit.value); setOpen(false); }
    else setError(t('sessions.titleSaveFailed'));
  };

  return <>
    <span className="truncate min-w-0" data-tooltip={display}>{display}</span>
    {editable && cwd && sessionId && <button type="button" className="shrink-0 p-0.5 rounded text-muted-foreground opacity-0 pointer-events-none group-hover/session-title:opacity-100 group-hover/session-title:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto hover:text-foreground hover:bg-hover transition-opacity" aria-label={t('sessions.editTitle')} onClick={(e) => { e.stopPropagation(); setValue(display); setOpen(true); }} onDoubleClick={(e) => e.stopPropagation()}><Pencil className="w-3 h-3" /></button>}
    {open && createPortal(<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <form role="dialog" aria-modal="true" aria-label={t('sessions.editTitle')} className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-xl space-y-3" onSubmit={(e) => { e.preventDefault(); void save(value); }}>
        <h2 className="text-sm font-medium">{t('sessions.editTitle')}</h2>
        <input ref={input} autoFocus aria-label={t('sessions.editTitle')} value={value} disabled={busy} onKeyDown={(e) => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault(); }} onChange={(e) => setValue(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 text-xs">
          {custom && <button type="button" disabled={busy || !ready} className="mr-auto text-muted-foreground disabled:opacity-50" onClick={() => void save(null)}>{t('sessions.restoreTitle')}</button>}
          <button type="button" disabled={busy} onClick={() => setOpen(false)}>{t('common.cancel')}</button>
          <button type="submit" disabled={busy || !ready} className="rounded bg-brand px-3 py-1 text-white disabled:opacity-50">{busy ? t('common.loading') : t('common.save')}</button>
        </div>
      </form>
    </div>, document.body)}
  </>;
}
