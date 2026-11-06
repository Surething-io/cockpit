import { describe, expect, it } from 'vitest';
import { acceptSessionTitle, acceptSessionTitles, effectiveTitle, subscribeTitles, titleKey, titleSnapshot } from './sessionTitleState';

describe('title response reconciliation', () => {
  it('publishes a title batch with one notification', () => {
    let notifications = 0;
    const unsubscribe = subscribeTitles(() => { notifications++; });
    try {
      const changes = ['batch-a', 'batch-b'].map((sessionId) => ({ cwd: '/batch', sessionId, title: sessionId, defaultTitle: sessionId, customTitle: null, titleRevision: 0 }));
      acceptSessionTitles(changes, titleSnapshot());
      expect(notifications).toBe(1);
      expect(titleSnapshot().get(titleKey('/batch', 'batch-b'))?.title).toBe('batch-b');
      acceptSessionTitles(changes);
      expect(notifications).toBe(1);
    } finally { unsubscribe(); }
  });

  it('keeps native title updates received while the initial batch was in flight', () => {
    const base = { cwd: '/batch', sessionId: 'native-race', customTitle: null, titleRevision: 0 };
    const baseline = titleSnapshot();
    acceptSessionTitle({ ...base, title: 'New native title', defaultTitle: 'New native title' });
    acceptSessionTitles([{ ...base, title: 'Old native title', defaultTitle: 'Old native title' }], baseline);
    expect(titleSnapshot().get(titleKey(base.cwd, base.sessionId))?.title).toBe('New native title');
  });

  it('accepts a newer rename revision even when another update arrived during bootstrap', () => {
    const base = { cwd: '/batch', sessionId: 'rename-race', defaultTitle: 'Native title' };
    const baseline = titleSnapshot();
    acceptSessionTitle({ ...base, title: 'Earlier rename', customTitle: 'Earlier rename', titleRevision: 1 });
    acceptSessionTitles([{ ...base, title: 'Latest rename', customTitle: 'Latest rename', titleRevision: 2 }], baseline);
    expect(titleSnapshot().get(titleKey(base.cwd, base.sessionId))?.title).toBe('Latest rename');
  });

  it('keeps a rename when an older transcript request finishes later', () => {
    const base = { cwd: '/project', sessionId: 'rename', defaultTitle: 'Prompt' };
    acceptSessionTitle({ ...base, title: 'Named', customTitle: 'Named', titleRevision: 2 });
    acceptSessionTitle({ ...base, title: 'Prompt', customTitle: null, titleRevision: 0 });
    expect(effectiveTitle(titleSnapshot(), base.cwd, base.sessionId, 'Stale', 0)).toBe('Named');
  });
  it('does not resurrect a cleared title and accepts refreshed native fallback at the same revision', () => {
    const base = { cwd: '/project', sessionId: 'reset', defaultTitle: 'Prompt' };
    acceptSessionTitle({ ...base, title: 'Named', customTitle: 'Named', titleRevision: 1 });
    acceptSessionTitle({ ...base, title: 'Prompt', customTitle: null, titleRevision: 2 });
    expect(effectiveTitle(titleSnapshot(), base.cwd, base.sessionId, 'Named', 1)).toBe('Prompt');
    expect(effectiveTitle(titleSnapshot(), base.cwd, base.sessionId, 'Updated native title', 2)).toBe('Updated native title');
  });
});
