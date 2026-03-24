import { useState, useCallback, useEffect } from 'react';
import type { PinnedSession } from '@/app/api/pinned-sessions/route';

export type { PinnedSession };

export function usePinnedSessions() {
  const [pinnedSessions, setPinnedSessions] = useState<PinnedSession[]>([]);

  // Load
  const reload = useCallback(() => {
    fetch('/api/pinned-sessions')
      .then(res => res.json())
      .then(data => setPinnedSessions(data.sessions || []))
      .catch(() => {});
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
    fetch('/api/pinned-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessions }),
    }).catch(() => {});
    // Notify parent window and all iframes
    try {
      window.parent.postMessage({ type: 'PINNED_SESSIONS_CHANGED' }, '*');
    } catch { /* ignore */ }
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
