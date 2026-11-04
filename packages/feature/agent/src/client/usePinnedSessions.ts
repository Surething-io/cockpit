import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { PinnedSession } from '../shared/pinnedSession';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadPinnedSessions, savePinnedSessions } from './effect/pinnedSessionsClient';

export type { PinnedSession };

export function usePinnedSessions() {
  const [pinnedSessions, setPinnedSessions] = useState<PinnedSession[]>([]);
  const revision = useRef(0);
  const pendingSaves = useRef(0);
  const readRequest = useRef(0);
  const saves = useMemo(() => Effect.unsafeMakeSemaphore(1), []);

  // Load
  const reload = useCallback(() => {
    // A successful save will broadcast once the final queued write finishes.
    if (pendingSaves.current > 0) return;
    const startedAtRevision = revision.current;
    const request = ++readRequest.current;
    BrowserRuntime.runPromise(
      loadPinnedSessions.pipe(
        Effect.match({
          onSuccess: (data) => {
            if (request === readRequest.current && startedAtRevision === revision.current && pendingSaves.current === 0) {
              setPinnedSessions(data.sessions || []);
            }
          },
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
    revision.current++;
    pendingSaves.current++;
    setPinnedSessions(sessions);
    BrowserRuntime.runFork(saves.withPermits(1)(savePinnedSessions(sessions)).pipe(
      Effect.ensuring(Effect.sync(() => { pendingSaves.current--; })),
      Effect.catchAll((error) => Effect.logWarning('Cannot save favorites', error).pipe(Effect.tap(() => Effect.sync(reload)))),
    ));
  }, [reload, saves]);

  const isPinned = useCallback((sessionId: string) => {
    return pinnedSessions.some(s => s.sessionId === sessionId);
  }, [pinnedSessions]);

  const pinSession = useCallback((sessionId: string, cwd: string, title: string) => {
    if (pinnedSessions.some(s => s.sessionId === sessionId)) return;
    save([...pinnedSessions, { sessionId, cwd, title }]);
  }, [pinnedSessions, save]);

  const unpinSession = useCallback((sessionId: string) => {
    save(pinnedSessions.filter(s => s.sessionId !== sessionId));
  }, [pinnedSessions, save]);

  const reorder = useCallback((newSessions: PinnedSession[]) => {
    save(newSessions);
  }, [save]);

  return {
    pinnedSessions,
    isPinned,
    pinSession,
    unpinSession,
    reorder,
    reload,
  };
}
