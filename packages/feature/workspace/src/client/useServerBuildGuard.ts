'use client';

/**
 * Detect that the server has been replaced under a still-open tab.
 *
 * The failure this prevents: `cockpit update` (or any restart onto a new build)
 * swaps .next-prod, so the server now serves a different BUILD_ID. A tab that
 * was already open — a standalone PWA window can sit there for days — still
 * holds the previous build's content-hashed chunk URLs. Those files are gone,
 * so the next route change or lazy import 404s and the app blanks out. The
 * WebSocket meanwhile reconnects perfectly happily, so nothing looks wrong
 * until it breaks.
 *
 * Trigger is the WS reconnect rather than a timer: a server restart always
 * drops the sockets, so that is both the earliest and the cheapest signal —
 * no polling on an app whose whole point is to sit open all day.
 */
import { useEffect, useState } from 'react';
import { onWsReconnect } from '@cockpit/shared-ui';

declare global {
  interface Window {
    __COCKPIT_BUILD_ID__?: string | null;
  }
}

export function useServerBuildGuard(): { stale: boolean } {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    // Off in dev and on any build predating the stamp: with nothing to compare
    // against, staying silent is the only safe behaviour.
    const own = typeof window !== 'undefined' ? window.__COCKPIT_BUILD_ID__ : null;
    if (!own) return;

    let cancelled = false;

    const check = async () => {
      // Once stale, always stale — the only remedy is a reload, and re-checking
      // would just add noise.
      if (cancelled || stale) return;
      try {
        const res = await fetch('/api/health', {
          cache: 'no-store',
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { buildId?: string | null };
        // A server that reports no buildId is older than this field; treat that
        // as "cannot tell" rather than "changed".
        if (!body.buildId) return;
        if (!cancelled && body.buildId !== own) setStale(true);
      } catch {
        // Offline, still restarting, or timed out — the next reconnect retries.
      }
    };

    const unsubscribe = onWsReconnect(check);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [stale]);

  return { stale };
}
