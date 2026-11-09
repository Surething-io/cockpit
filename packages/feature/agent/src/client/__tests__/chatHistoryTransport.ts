const listeners = new Map<string, Set<(data: unknown) => void>>();

// Replace only the WebSocket transport; the viewer's replay logic stays real.
export function useWebSocket(options: { url: string; onMessage: (data: unknown) => void; enabled?: boolean }) {
  useLayoutEffect(() => {
    if (options.enabled === false) return;
    const url = new URL(options.url, 'http://test');
    url.searchParams.delete('subscriber');
    const key = url.pathname + url.search;
    const group = listeners.get(key) ?? new Set();
    group.add(options.onMessage); listeners.set(key, group);
    return () => { group.delete(options.onMessage); if (!group.size) listeners.delete(key); };
  }, [options.url, options.enabled, options.onMessage]);
}

export function deliverSessionMessage(data: unknown, url?: string) {
  const listener = url ? listeners.get(url) : listeners.values().next().value;
  if (!listener) throw new Error('Session stream is not connected');
  for (const receive of [...listener]) receive(data);
}

export function sessionSubscriberCount(url: string): number {
  return listeners.get(url)?.size ?? 0;
}
import { useLayoutEffect } from 'react';

