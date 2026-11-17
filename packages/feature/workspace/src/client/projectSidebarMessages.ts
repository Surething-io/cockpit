import type { GlobalSession } from '@cockpit/feature-agent';

/** The global-state socket also carries title and project notifications. */
export function handleProjectSidebarMessage(
  message: unknown,
  onSessions: (sessions: GlobalSession[]) => void,
  onTaskFired: () => void,
): void {
  if (!message || typeof message !== 'object') return;
  const parsed = message as { type?: string; data?: { sessions?: GlobalSession[] } };
  if (parsed.type === 'task-fired') {
    onTaskFired();
    return;
  }
  if (parsed.type !== 'global-state' || !Array.isArray(parsed.data?.sessions)) return;
  onSessions(parsed.data.sessions);
}
