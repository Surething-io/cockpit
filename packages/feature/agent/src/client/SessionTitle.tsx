'use client';

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Pencil, Sparkles } from 'lucide-react';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { forgetSessionBots, notifyBotsChanged } from '@cockpit/shared-api';
import { onWsReconnect, sessionNumberClass, useWebSocket } from '@cockpit/shared-ui';
import { requestSessionTitle, suggestSessionTitle } from './effect/sessionTitlesClient';
import { acceptSessionTitle, effectiveTitle, serverTitleSnapshot, subscribeTitles, titleSnapshot, trackTitle, trackedTitles } from './sessionTitleState';
import { titleNameProblem, type SessionTitleChange, type TitleNameProblem } from '../shared/sessionTitle';

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
  const [mentionable, setMentionable] = useState(false);
  // As loaded, so a save that changes it can tell the Bots panel and `@` menus.
  const [wasMentionable, setWasMentionable] = useState(false);
  // The title as loaded: saving it unchanged must not turn an AI title into a custom one —
  // ticking "can be @-mentioned" on a title the user likes is the whole point of the box.
  const [loadedTitle, setLoadedTitle] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  // The in-flight suggestion; closing the dialog aborts it, which cancels the engine call.
  const suggestion = useRef<AbortController | null>(null);
  const close = useCallback(() => {
    suggestion.current?.abort();
    suggestion.current = null;
    setSuggesting(false);
    setOpen(false);
  }, []);
  useEffect(() => () => suggestion.current?.abort(), []);
  // Gradient id for the AI icon; useId's colons are not valid inside url(#…).
  const aiGradient = `ai-title-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
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
        acceptSessionTitle(info); setValue(info.title); setLoadedTitle(info.title); setCustom(info.customTitle !== null);
        setMentionable(info.mentionable === true); setWasMentionable(info.mentionable === true); setReady(true);
        input.current?.focus(); input.current?.select();
      },
      onFailure: () => { if (active) setError(t('sessions.titleLoadFailed')); },
    })));
    return () => { active = false; };
  }, [open, cwd, sessionId, t]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!pending.current) close(); }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [open]);

  // The session's own engine names it; the result only fills the input — Save still decides.
  const suggest = async () => {
    if (suggesting || busy) return;
    setSuggesting(true); setError('');
    const controller = new AbortController();
    suggestion.current = controller;
    const exit = await BrowserRuntime.runPromiseExit(suggestSessionTitle(cwd, sessionId), { signal: controller.signal });
    if (suggestion.current !== controller) return; // closed (or superseded) meanwhile
    suggestion.current = null;
    setSuggesting(false);
    if (exit._tag === 'Success') {
      setValue(exit.value);
      input.current?.focus();
    } else {
      const reason = exit.cause._tag === 'Fail' ? exit.cause.error.message : '';
      setError(t('sessions.titleSuggestFailed', { reason }));
    }
  };
  const problemText = (problem: TitleNameProblem) => t(problem === 'empty' ? 'sessions.titleEmpty'
    : problem === 'multiline' ? 'sessions.titleSingleLine' : 'sessions.titleNoAt');
  const save = async (next: string | null) => {
    if (pending.current || !ready) return;
    const renamed = next === null || custom || next !== loadedTitle;
    if (next !== null) {
      const problem = titleNameProblem(next);
      // A new name must be valid outright; an untouched default title only matters when it
      // is about to become an `@` name.
      if (problem && renamed) { setError(problemText(problem)); return; }
      if (problem && mentionable) { setError(t('sessions.titleNotMentionable', { reason: problemText(problem) })); return; }
    }
    pending.current = true; setBusy(true); setError('');
    const exit = await BrowserRuntime.runPromiseExit(requestSessionTitle(cwd, sessionId, {
      ...(renamed && { customTitle: next }), mentionable,
    }));
    pending.current = false; setBusy(false);
    if (exit._tag === 'Success') {
      acceptSessionTitle(exit.value); close();
      // A rename changes a session Bot's name too, so any save of one is news to the list.
      if (mentionable || wasMentionable) { BrowserRuntime.runSync(forgetSessionBots); notifyBotsChanged(); }
    }
    else setError(t('sessions.titleSaveFailed'));
  };

  return <>
    <span className="truncate min-w-0" data-tooltip={display}>{display}</span>
    {editable && cwd && sessionId && <button type="button" className="shrink-0 p-0.5 rounded text-muted-foreground opacity-0 pointer-events-none group-hover/session-title:opacity-100 group-hover/session-title:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto hover:text-foreground hover:bg-hover transition-opacity" aria-label={t('sessions.editTitle')} onClick={(e) => { e.stopPropagation(); setValue(display); setOpen(true); }} onDoubleClick={(e) => e.stopPropagation()}><Pencil className="w-3 h-3" /></button>}
    {open && createPortal(<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4" onClick={(e) => {
      e.stopPropagation();
      // A click on the backdrop itself (not inside the dialog) dismisses it, like Escape —
      // except while a save is in flight. A running suggestion is cancelled with it.
      if (e.target === e.currentTarget && !pending.current) close();
    }} onDoubleClick={(e) => e.stopPropagation()}>
      <form role="dialog" aria-modal="true" aria-label={t('sessions.editTitle')} className="w-full max-w-sm rounded-xl border border-border bg-card p-4 shadow-xl space-y-3" onSubmit={(e) => { e.preventDefault(); void save(value); }}>
        <h2 className="text-sm font-medium">{t('sessions.editTitle')}</h2>
        <div className="relative">
          <input ref={input} autoFocus aria-label={t('sessions.editTitle')} value={value} disabled={busy || suggesting} onKeyDown={(e) => { if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault(); }} onChange={(e) => setValue(e.target.value)} className="w-full rounded border border-border bg-background py-1 pl-2 pr-8 text-sm focus:outline-none focus:ring-1 focus:ring-ring" />
          <button type="button" aria-label={t('sessions.suggestTitle')} data-tooltip={t('sessions.suggestTitle')} disabled={busy || suggesting || !ready} onClick={() => void suggest()} className={`absolute right-1 top-1/2 -translate-y-1/2 rounded-full p-0.5 ${suggesting ? '' : 'hover:bg-hover disabled:opacity-50'}`}>
            <svg width="0" height="0" className="absolute" aria-hidden="true">
              <defs>
                <linearGradient id={aiGradient} x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="var(--color-blue-9)" />
                  <stop offset="55%" stopColor="var(--color-brand)" />
                  <stop offset="100%" stopColor="var(--color-amber-9)" />
                </linearGradient>
              </defs>
            </svg>
            {/* While generating: the same orange wash and spinning ring a running session's
                number chip wears, so "the AI is working" reads the same everywhere. */}
            <span className={`flex items-center justify-center w-6 h-6 rounded-full ${suggesting ? sessionNumberClass('loading', false) : ''}`}>
              <Sparkles stroke={`url(#${aiGradient})`} className="w-3.5 h-3.5" />
            </span>
          </button>
        </div>
        <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer select-none">
          <input type="checkbox" className="mt-0.5" checked={mentionable} disabled={busy || !ready} onChange={(e) => setMentionable(e.target.checked)} />
          <span><span className="text-foreground">{t('sessions.mentionable')}</span><br />{t('sessions.mentionableHint')}</span>
        </label>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 text-xs">
          {custom && <button type="button" disabled={busy || !ready} className="mr-auto text-muted-foreground disabled:opacity-50" onClick={() => void save(null)}>{t('sessions.restoreTitle')}</button>}
          <button type="button" disabled={busy} onClick={close}>{t('common.cancel')}</button>
          <button type="submit" disabled={busy || suggesting || !ready} className="rounded bg-brand px-3 py-1 text-white disabled:opacity-50">{busy ? t('common.loading') : t('common.save')}</button>
        </div>
      </form>
    </div>, document.body)}
  </>;
}
