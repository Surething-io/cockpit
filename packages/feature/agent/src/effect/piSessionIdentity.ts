import { createHash } from 'node:crypto';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
const payloadOf = (entry: SessionEntry) => canonical(Object.fromEntries(Object.entries(entry)
  .filter(([key]) => !['id', 'parentId', 'firstKeptEntryId', 'fromId', 'targetId'].includes(key))));
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

export function legacyPiSnapshot(sessionId: string, entries: SessionEntry[]): { count: number; digest: string } {
  return { count: entries.length, digest: digest([sessionId, entries.map(payloadOf)]) };
}

/** Validate the original prefix as well as the target: duplicate messages are not identities. */
export function legacyPiEntryId(sessionId: string, index: number, entry: SessionEntry,
  snapshot: { count: number; digest: string },
): string {
  return `pi-v1-${index}-${snapshot.count}-${snapshot.digest}-${digest([sessionId, payloadOf(entry)])}`;
}

export function resolvePiEntryId(sessionId: string, entries: SessionEntry[], target: string): string | undefined {
  if (entries.some((entry) => entry.id === target)) return target;
  const match = /^pi-v1-(0|[1-9]\d*)-([1-9]\d*)-([0-9a-f]{32})-([0-9a-f]{32})$/.exec(target);
  if (!match) return undefined;
  const index = Number(match[1]), count = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index >= count || count > entries.length) return undefined;
  const snapshot = legacyPiSnapshot(sessionId, entries.slice(0, count));
  const entry = entries[index];
  return snapshot.digest === match[3] && legacyPiEntryId(sessionId, index, entry, snapshot) === target ? entry.id : undefined;
}
