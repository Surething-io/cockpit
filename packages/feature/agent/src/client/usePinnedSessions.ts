import { useState, useCallback, useEffect } from 'react';
import type { PinnedSession } from '@/app/api/pinned-sessions/route';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { AppError } from '@cockpit/effect-core';

export type { PinnedSession };

export function usePinnedSessions() {
  const [pinnedSessions, setPinnedSessions] = useState<PinnedSession[]>([]);

  // Load
  const reload = useCallback(() => {
    const loadEff = Effect.tryPromise({
      try: async () => {
        const res = await fetch('/api/pinned-sessions');
        return (await res.json()) as { sessions?: PinnedSession[] };
      },
      catch: (cause) => new AppError({ message: 'loadPinnedSessions failed', cause }),
    });
    BrowserRuntime.runPromise(
      loadEff.pipe(
        Effect.match({
          onSuccess: (data) => setPinnedSessions(data.sessions || []),
          onFailure: () => {
            /* silent — v1 .catch(()=>{}) */
          },
        })
      )
    );
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Listen for cross-iframe notifications
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'PINNED_SESSIONS_CHANGED') {
        reload();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [reload]);

  // Save + notify
  const save = useCallback((sessions: PinnedSession[]) => {
    setPinnedSessions(sessions);
    const saveEff = Effect.tryPromise({
      try: async () => {
        await fetch('/api/pinned-sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessions }),
        });
      },
      catch: (cause) => new AppError({ message: 'savePinnedSessions failed', cause }),
    });
    BrowserRuntime.runFork(saveEff.pipe(Effect.orElse(() => Effect.void)));
    // Notify parent window and all iframes via IframeBus
    publishTopic(Topics.PinnedSessionsChanged, {});
  }, []);

  const isPinned = useCallback((sessionId: string) => {
    return pinnedSessions.some(s => s.sessionId === sessionId);
  }, [pinnedSessions]);

  const pinSession = useCallback((sessionId: string, cwd: string, title: string) => {
    if (pinnedSessions.some(s => s.sessionId === sessionId)) return;
    save([...pinnedSessions, { sessionId, cwd, customTitle: title }]);
  }, [pinnedSessions, save]);

  const unpinSession = useCallback((sessionId: string) => {
    save(pinnedSessions.filter(s => s.sessionId !== sessionId));
  }, [pinnedSessions, save]);

  const updateTitle = useCallback((sessionId: string, title: string) => {
    save(pinnedSessions.map(s => s.sessionId === sessionId ? { ...s, customTitle: title } : s));
  }, [pinnedSessions, save]);

  const reorder = useCallback((newSessions: PinnedSession[]) => {
    save(newSessions);
  }, [save]);

  return {
    pinnedSessions,
    isPinned,
    pinSession,
    unpinSession,
    updateTitle,
    reorder,
    reload,
  };
}
