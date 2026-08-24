import { describe, it, expect } from 'vitest';
import { nextFileDiffRequest, type FileDiffRequest } from './fileDiffRequest';

const req = (messageId: string, n: number): FileDiffRequest => ({
  messageId,
  toolCalls: Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: 'Edit', input: {} })),
  cwd: '/repo',
});

describe('nextFileDiffRequest', () => {
  it('a click always opens the clicked message', () => {
    expect(nextFileDiffRequest(null, req('m1', 1), false)).toEqual(req('m1', 1));
    expect(nextFileDiffRequest(req('m1', 1), req('m2', 3), false)?.messageId).toBe('m2');
  });

  it('a live push grows the overlay showing that same message', () => {
    const grown = nextFileDiffRequest(req('m1', 1), req('m1', 4), true);
    expect(grown?.toolCalls).toHaveLength(4);
    expect(grown?.cwd).toBe('/repo');
  });

  it('a live push never opens a closed overlay', () => {
    expect(nextFileDiffRequest(null, req('m1', 4), true)).toBeNull();
  });

  it('a live push never steals an overlay showing another message', () => {
    const prev = req('m2', 2);
    expect(nextFileDiffRequest(prev, req('m1', 4), true)).toBe(prev);
  });
});
