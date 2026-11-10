import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types';
import { buildReviewTurns, defaultRangeStart, extractionMessages, rangeEvidence } from './reviewTurns';

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

describe('rangeEvidence', () => {
  it('collects runs and pass claims of the selected turns only', () => {
    const msgs: ChatMessage[] = [
      user('u1', 'first'),
      { id: 'a1', role: 'assistant', content: 'All tests pass now.', toolCalls: [{ id: 'x1', name: 'Bash', input: { command: 'npm test' }, isError: false, result: 'ok' }] },
      user('u2', 'second'),
      { id: 'a2', role: 'assistant', content: '改好了，测试全部通过', timestamp: '2026-11-10T01:00:00Z', toolCalls: [
        { id: 'e', name: 'Edit', input: {} },
        { id: 'x2', name: 'Bash', input: { command: 'npm run lint' }, isError: true, result: 'Exit code 1\nerr' },
      ] },
    ];
    const ev = rangeEvidence(msgs, new Set(['u2']));
    expect(ev.orderedToolIds).toEqual(['e', 'x2']);
    expect(ev.runs.map((r) => [r.toolId, r.order, r.outcome, r.at])).toEqual([['x2', 1, { kind: 'exit', code: 1 }, '2026-11-10T01:00:00Z']]);
    expect(ev.claimedPass).toBe(true);
    expect(rangeEvidence(msgs, new Set(['u1'])).claimedPass).toBe(true);
    const claim = (content: string) => rangeEvidence([user('u', 'x'), { id: 'a', role: 'assistant', content, toolCalls: [] }], new Set(['u'])).claimedPass;
    expect(claim('I could not make the tests pass')).toBe(false);
    expect(claim("The tests don't pass yet")).toBe(false);
    expect(claim('测试没有通过')).toBe(false);
    expect(claim('Fixed it — all tests pass.')).toBe(true);
    expect(claim('测试已经通过')).toBe(true);
  });
});

describe('extractionMessages', () => {
  it('keeps text whole and condenses tool calls of the selected turns', () => {
    const msgs: ChatMessage[] = [
      user('u0', 'old'),
      { id: 'a0', role: 'assistant', content: 'old answer' },
      user('u1', 'fix it\nplease'),
      { id: 'a1', role: 'assistant', content: 'Done.', toolCalls: [
        { id: 't1', name: 'Edit', input: { file_path: 'src/a.ts' } },
        { id: 't2', name: 'Bash', input: { command: 'npm test' }, isError: true, result: 'Exit code 1\nx' },
      ] },
      { id: 'a2', role: 'assistant', content: '   ' },
    ];
    expect(extractionMessages(msgs, new Set(['u1']))).toEqual([
      { id: 'u1', role: 'user', text: 'fix it\nplease', tools: [] },
      { id: 'a1', role: 'agent', text: 'Done.', tools: ['Edit src/a.ts', 'Bash `npm test` (exit 1)'] },
    ]);
  });
});
