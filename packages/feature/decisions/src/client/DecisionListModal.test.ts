import { describe, expect, it } from 'vitest';
import { revisionLines } from './DecisionListModal';

describe('revisionLines', () => {
  it('replays edits as before → after against the state at that point', () => {
    const lines = revisionLines([
      { type: 'created', at: 1, content: { choice: 'a', alternatives: [], rationale: 'r1', tradeoffs: '', premises: ['p'] }, source: { kind: 'manual' }, links: [] },
      { type: 'edited', at: 2, content: { choice: 'b' } },
      { type: 'reviewed', at: 3, taskId: 't', verdict: 'holds' },
      { type: 'edited', at: 4, content: { choice: 'c', premises: [] } },
    ]);
    expect(lines).toEqual([
      { at: 2, lines: ['choice: a → b'] },
      { at: 4, lines: ['choice: b → c', 'premises: p → ∅'] },
    ]);
  });
});
