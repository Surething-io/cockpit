'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { useWebSocket } from '@cockpit/shared-ui';
import { loadRunningTerminals, type RunningTerminal } from './effect/consoleClient';

/** Spawn + exit of a rerun, or several bubbles cleared at once, arrive as a burst. */
const REFETCH_DEBOUNCE_MS = 150;

/**
 * Every live terminal bubble across all projects, kept current by the
 * payload-less `running-terminals-changed` ping on /ws/global-state. A bubble
 * rename (`console-delta` rename) refetches too, since titles ride along.
 */
export function useRunningTerminals(): { terminals: RunningTerminal[]; refresh: () => void } {
  const [terminals, setTerminals] = useState<RunningTerminal[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    BrowserRuntime.runPromiseExit(loadRunningTerminals()).then((exit) => {
      if (exit._tag === 'Success') setTerminals(exit.value);
    });
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      refresh();
    }, REFETCH_DEBOUNCE_MS);
  }, [refresh]);

  useEffect(() => {
    refresh();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [refresh]);

  useWebSocket({
    url: '/ws/global-state',
    onMessage: (raw) => {
      const p = raw as { type?: string; op?: string };
      if (p.type === 'running-terminals-changed' || (p.type === 'console-delta' && p.op === 'rename')) {
        scheduleRefresh();
      }
    },
  });

  return { terminals, refresh };
}
