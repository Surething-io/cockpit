import type { SessionTitleChange } from '../shared/sessionTitle';

// UI state only: the server metadata remains authoritative. A revision protects
// against a pre-save transcript request arriving after the mutation or WS event.
let snapshot: ReadonlyMap<string, SessionTitleChange> = new Map();
const listeners = new Set<() => void>();
const tracked = new Map<string, { cwd: string; sessionId: string; count: number }>();
const empty: ReadonlyMap<string, SessionTitleChange> = new Map();
export const titleKey = (cwd: string, id: string) => `${cwd}\n${id.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\.jsonl)?$/i)?.[1] ?? id}`;
export const titleSnapshot = () => snapshot;
export const serverTitleSnapshot = () => empty;
export const subscribeTitles = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function acceptSessionTitle(change: SessionTitleChange): void {
  const key = titleKey(change.cwd, change.sessionId);
  const prev = snapshot.get(key);
  if (prev && (prev.titleRevision > change.titleRevision || JSON.stringify(prev) === JSON.stringify(change))) return;
  snapshot = new Map(snapshot).set(key, change);
  listeners.forEach((listener) => listener());
}
export function effectiveTitle(
  data: ReadonlyMap<string, SessionTitleChange>, cwd: string, sessionId: string, fallback: string, revision = -1,
): string {
  const entry = data.get(titleKey(cwd, sessionId));
  if (!entry || revision > entry.titleRevision) return fallback;
  if (entry.customTitle !== null) return entry.customTitle;
  return revision >= entry.titleRevision ? fallback : entry.title;
}
export function trackTitle(cwd: string, sessionId: string): () => void {
  const key = titleKey(cwd, sessionId);
  const entry = tracked.get(key) ?? { cwd, sessionId, count: 0 };
  entry.count++;
  tracked.set(key, entry);
  return () => { if (--entry.count === 0) tracked.delete(key); };
}
export const trackedTitles = () => [...tracked.values()];
