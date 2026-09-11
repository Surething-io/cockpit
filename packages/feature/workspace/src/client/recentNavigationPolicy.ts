export interface SessionLocation {
  cwd: string;
  sessionId: string | null | undefined;
}

/**
 * Global navigation records the work context being left, never the destination.
 * Local tab switches do not call this policy at all.
 */
export function recentSessionToTouch(
  source: SessionLocation | undefined,
  target: SessionLocation,
): { cwd: string; sessionId: string } | null {
  if (!source?.cwd || !source.sessionId) return null;

  // Selecting the current session (or re-selecting its project without a concrete
  // target) is not a departure and must not manufacture a recency event.
  if (source.cwd === target.cwd && (!target.sessionId || source.sessionId === target.sessionId)) {
    return null;
  }

  return { cwd: source.cwd, sessionId: source.sessionId };
}
