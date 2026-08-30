import { describe, it, expect } from 'vitest';
import { startRun, markRunIdle } from '../sessionRunHub';
import { normalizeStatuses, type GlobalSession } from './globalState';

// The run registry is the single source of truth for "is this session running";
// state.json's 'loading' is only a cache of it. Uses the real registry, no mocks.
const sess = (sessionId: string, status: GlobalSession['status']): GlobalSession =>
  ({ cwd: '/x', sessionId, lastActive: 0, status });

describe('normalizeStatuses', () => {
  it('a live run overrides a client-written normal (the badge-click bug)', () => {
    startRun('s-live', '/x', 'p', 'r1');
    const list = [sess('s-live', 'normal')];
    normalizeStatuses(list);
    expect(list[0].status).toBe('loading');
    markRunIdle('s-live', 'idle');
  });

  it('stale loading with no live run reads as unread (stop / crash / restart)', () => {
    const list = [sess('s-dead', 'loading')];
    normalizeStatuses(list);
    expect(list[0].status).toBe('unread');
  });
});
