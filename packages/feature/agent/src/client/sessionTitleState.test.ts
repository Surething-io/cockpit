import { describe, expect, it } from 'vitest';
import { acceptSessionTitle, effectiveTitle, titleSnapshot } from './sessionTitleState';

describe('title response reconciliation', () => {
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
