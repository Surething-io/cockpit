import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types';
import { buildReviewTurns, defaultRangeStart } from './reviewTurns';

const user = (id: string, content: string, timestamp?: string): ChatMessage => ({ id, role: 'user', content, ...(timestamp ? { timestamp } : {}) });
const assistant = (id: string, toolIds: string[]): ChatMessage => ({
  id,
  role: 'assistant',
  content: '',
  toolCalls: toolIds.map((t) => ({ id: t, name: 'Edit', input: {} })),
});

describe('buildReviewTurns', () => {
  it('groups assistant tool calls under the preceding user message', () => {
    const turns = buildReviewTurns([
      assistant('a0', ['orphan']), // before any user message: ignored
      user('u1', '\n  fix the bug\nmore', '2026-11-09T10:00:00Z'),
      assistant('a1', ['t1']),
      { id: 's', role: 'system', content: 'notice' },
      assistant('a2', ['t2', 't3']),
      user('u2', 'next'),
    ]);
    expect(turns).toEqual([
      { id: 'u1', text: 'fix the bug', at: '2026-11-09T10:00:00Z', toolIds: ['t1', 't2', 't3'] },
      { id: 'u2', text: 'next', toolIds: [] },
    ]);
  });
});

describe('defaultRangeStart', () => {
  const turns = [
    { id: 'u1', text: '', at: '2026-11-09T10:00:00Z', toolIds: ['t1'] },
    { id: 'u2', text: '', at: '2026-11-09T11:00:00Z', toolIds: [] },
    { id: 'u3', text: '', at: '2026-11-09T12:00:00Z', toolIds: ['t3'] },
    { id: 'u4', text: '', at: '2026-11-09T13:00:00Z', toolIds: ['t4'] },
  ];

  it('starts after the last fully accepted turn', () => {
    expect(defaultRangeStart(turns, new Set(['t1', 't3']), undefined)).toBe(3);
  });

  it('a partially accepted turn is not covered', () => {
    expect(defaultRangeStart([{ id: 'u', text: '', toolIds: ['a', 'b'] }], new Set(['a']), undefined)).toBe(0);
  });

  it('with nothing accepted, starts where decision mode was turned on', () => {
    expect(defaultRangeStart(turns, new Set(), Date.parse('2026-11-09T11:30:00Z'))).toBe(2);
    expect(defaultRangeStart(turns, new Set(), Date.parse('2026-11-10T00:00:00Z'))).toBe(4);
    expect(defaultRangeStart(turns, new Set(), undefined)).toBe(0);
  });
});
