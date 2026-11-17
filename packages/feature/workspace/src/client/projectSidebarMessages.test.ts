import { describe, expect, it, vi } from 'vitest';
import type { GlobalSession } from '@cockpit/feature-agent';
import { handleProjectSidebarMessage } from './projectSidebarMessages';

const sessions: GlobalSession[] = [
  { cwd: '/project-a', sessionId: 'a', status: 'loading', lastActive: 1 },
  { cwd: '/project-b', sessionId: 'b', status: 'unread', lastActive: 2 },
];

describe('project sidebar global-state messages', () => {
  it('preserves all project sessions when an unopened session refreshes its title', () => {
    let current: GlobalSession[] = [];
    const update = vi.fn((snapshot: GlobalSession[]) => { current = snapshot; });
    const reload = vi.fn();
    handleProjectSidebarMessage({ type: 'global-state', data: { sessions } }, update, reload);
    handleProjectSidebarMessage({ type: 'session-title-changed', data: {
      cwd: '/project-a', sessionId: 'a', title: 'Delegated session', titleRevision: 1,
    } }, update, reload);

    expect(current).toBe(sessions);
    expect(update).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('accepts an explicitly empty global snapshot', () => {
    const update = vi.fn();
    handleProjectSidebarMessage({ type: 'global-state', data: { sessions: [] } }, update, vi.fn());
    expect(update).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('reloads scheduled tasks without replacing the session snapshot', () => {
    const update = vi.fn();
    const reload = vi.fn();
    handleProjectSidebarMessage({ type: 'task-fired', data: { sessions: [] } }, update, reload);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    null, undefined, 'invalid',
    { type: 'ping' },
    { type: 'project-state-changed', cwd: '/project-a' },
    { type: 'unknown', data: { sessions: [] } },
    { data: { sessions: [] } },
    { type: 'global-state' },
    { type: 'global-state', data: {} },
    { type: 'global-state', data: { sessions: null } },
    { type: 'global-state', data: { sessions: {} } },
  ])('ignores unrelated or malformed messages: %j', (message) => {
    const update = vi.fn();
    const reload = vi.fn();
    handleProjectSidebarMessage(message, update, reload);
    expect(update).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
