import { describe, expect, it } from 'vitest';
import { recentSessionToTouch } from './recentNavigationPolicy';

describe('recentSessionToTouch', () => {
  it('records the session being left on a cross-session jump', () => {
    expect(recentSessionToTouch(
      { cwd: '/a', sessionId: 'source' },
      { cwd: '/a', sessionId: 'target' },
    )).toEqual({ cwd: '/a', sessionId: 'source' });
  });

  it('records the source on a cross-project jump', () => {
    expect(recentSessionToTouch(
      { cwd: '/a', sessionId: 'source' },
      { cwd: '/b', sessionId: 'target' },
    )).toEqual({ cwd: '/a', sessionId: 'source' });
  });

  it('ignores re-selecting the current session or project', () => {
    expect(recentSessionToTouch(
      { cwd: '/a', sessionId: 'source' },
      { cwd: '/a', sessionId: 'source' },
    )).toBeNull();
    expect(recentSessionToTouch(
      { cwd: '/a', sessionId: 'source' },
      { cwd: '/a', sessionId: undefined },
    )).toBeNull();
  });

  it('ignores a blank source session', () => {
    expect(recentSessionToTouch(
      { cwd: '/a', sessionId: null },
      { cwd: '/b', sessionId: 'target' },
    )).toBeNull();
  });
});
