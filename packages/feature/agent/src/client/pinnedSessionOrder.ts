export type DropSide = 'before' | 'after';

export const pinnedDropSide = (pointerY: number, bounds: { top: number; height: number }): DropSide =>
  pointerY < bounds.top + bounds.height / 2 ? 'before' : 'after';

/** Resolve the anchor after removing the source, so moving up and down use
 * the same insertion rule as the line shown in the UI. */
export function insertPinnedSession<T extends { sessionId: string }>(
  items: readonly T[], sourceId: string, targetId: string, side: DropSide,
): T[] {
  const source = items.find((item) => item.sessionId === sourceId);
  if (!source || sourceId === targetId || !items.some((item) => item.sessionId === targetId)) return [...items];
  const remaining = items.filter((item) => item.sessionId !== sourceId);
  const anchor = remaining.findIndex((item) => item.sessionId === targetId);
  remaining.splice(anchor + (side === 'after' ? 1 : 0), 0, source);
  return remaining;
}
