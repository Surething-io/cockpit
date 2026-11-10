import { describe, expect, it } from 'vitest';
import { buildDecisionContext, injectedKeys, splitDecisionContext, stripDecisionContext } from './decisionContext';

const items = [
  { id: 'dec-abc-12345678', rev: 17, choice: 'Keep dedupe ids\nin memory', premises: ['restarts are rare', 'single process'] },
  { id: 'dec-def-87654321', rev: 3, choice: 'Window is 5 minutes', premises: [] },
];

describe('decision context block', () => {
  it('round-trips: build → split gives the items and the untouched user text', () => {
    const msg = `${buildDecisionContext(items)}fix the send path\n\nplease`;
    const s = splitDecisionContext(msg);
    expect(s.body).toBe('fix the send path\n\nplease');
    expect(s.items).toEqual([
      { key: 'dec-abc-12345678@17', text: 'Keep dedupe ids in memory Holds while: restarts are rare; single process.' },
      { key: 'dec-def-87654321@3', text: 'Window is 5 minutes' },
    ]);
    expect(msg).toContain('do not silently follow either side');
  });

  it('a message without a block, or with one later in the text, is left alone', () => {
    expect(splitDecisionContext('hello')).toEqual({ items: [], body: 'hello' });
    const quoted = 'look at this: <cockpit-decisions>x</cockpit-decisions>';
    expect(stripDecisionContext(quoted)).toBe(quoted);
  });

  it('nothing to inject → empty string, so the message is sent unchanged', () => {
    expect(buildDecisionContext([])).toBe('');
  });

  it('collects id@rev across the session, so an edited decision is injected again', () => {
    const keys = injectedKeys([`${buildDecisionContext(items)}a`, 'b', `${buildDecisionContext([{ ...items[1], rev: 4 }])}c`]);
    expect([...keys].sort()).toEqual(['dec-abc-12345678@17', 'dec-def-87654321@3', 'dec-def-87654321@4']);
  });
});

describe('titles and previews never show the injected block', () => {
  it('both title filters strip it', async () => {
    const { filterCommandTags: titleFilter } = await import('../server/sessionTitle');
    const { filterCommandTags: previewFilter } = await import('../server/transcriptViews');
    const msg = `${buildDecisionContext(items)}fix the send path`;
    expect(titleFilter(msg)).toBe('fix the send path');
    expect(previewFilter(msg)).toBe('fix the send path');
  });
});
