import { describe, expect, it } from 'vitest';
import { buildPrompts, labelInput, mergeChunks, normalizeForQuote, validateExtraction } from './extraction';
import { parseJsonAnswer } from './oneShot';

const input = labelInput(
  [
    { id: 'u1', role: 'user', text: '先别落盘，重启丢了无所谓', tools: [] },
    { id: 'a1', role: 'agent', text: 'I set the dedupe window to 5 minutes, which covers typical reconnects.', tools: ['Edit src/send.ts'] },
  ],
  [{ path: 'src/send.ts', status: 'modified', additions: 10, deletions: 2 }],
  [{ toolId: 'r1', command: 'npm test', state: 'verified' }],
);

const decision = (over: Record<string, unknown>) => ({
  choice: 'x', alternatives: [], rationale: '', tradeoffs: '', premises: [], quote: '', ref: '', files: [], ...over,
});

describe('validateExtraction', () => {
  it('source is the role of the message the verbatim quote is found in', () => {
    const r = validateExtraction(
      {
        goal: 'Fix duplicate sends',
        summary: [],
        decisions: [
          decision({ choice: 'Keep dedupe ids in memory only', quote: '先别落盘', ref: 'M1', files: ['F1', 'F9'] }),
          // whitespace / curly quotes differ, still the same words
          decision({ choice: '5 minute window', quote: 'set the dedupe  window to 5 minutes', ref: '[M2]' }),
        ],
      },
      input,
      'S1',
    );
    expect(r.candidates[0].source).toEqual({ kind: 'user', quote: '先别落盘', messageId: 'u1', sessionId: 'S1' });
    expect(r.candidates[0].files).toEqual(['src/send.ts']); // unknown F9 dropped
    expect(r.candidates[1].source.kind).toBe('agent');
  });

  it('a quote the message does not contain — or a model claiming the user said it — becomes inferred', () => {
    const r = validateExtraction(
      {
        goal: '',
        summary: [],
        decisions: [
          decision({ choice: 'a', quote: 'the user insisted on disk persistence', ref: 'M1' }),
          decision({ choice: 'b', quote: 'set the dedupe window to 5 minutes', ref: 'M1' }), // real text, wrong message
          decision({ choice: 'c', quote: '', ref: 'M2' }),
          decision({ choice: '', quote: '先别落盘', ref: 'M1' }), // no choice → dropped
        ],
      },
      input,
      undefined,
    );
    expect(r.candidates.map((c) => c.source.kind)).toEqual(['inferred', 'inferred', 'inferred']);
  });

  it('summary keeps only evidence that exists; an item without any is kept and flagged by empty evidence', () => {
    const r = validateExtraction(
      { goal: 'g', summary: [{ text: 'Adds dedupe', refs: ['F1', 'R1', 'M2', 'X7'] }, { text: 'Fixes cross-process', refs: ['F5'] }, { text: '  ', refs: [] }], decisions: [] },
      input,
      undefined,
    );
    expect(r.summary).toEqual([
      { text: 'Adds dedupe', evidence: [
        { kind: 'file', id: 'src/send.ts', label: 'F1' },
        { kind: 'run', id: 'r1', label: 'R1' },
        { kind: 'message', id: 'a1', label: 'M2' },
      ] },
      { text: 'Fixes cross-process', evidence: [] },
    ]);
  });

  it('strips evidence labels a model wrote into prose', () => {
    const r = validateExtraction({ goal: 'Fix duplicate sends. [M1]', summary: [{ text: 'Adds dedupe [F1] [R1]', refs: ['F1'] }], decisions: [] }, input, undefined);
    expect(r.goal).toBe('Fix duplicate sends.');
    expect(r.summary[0].text).toBe('Adds dedupe');
  });

  it('survives garbage', () => {
    expect(validateExtraction(null, input, undefined)).toEqual({ goal: '', summary: [], candidates: [] });
    expect(validateExtraction({ decisions: 'nope', summary: [1, null] }, input, undefined)).toEqual({ goal: '', summary: [], candidates: [] });
  });
});

describe('buildPrompts', () => {
  it('keeps user text whole and splits messages in order when over budget', () => {
    const long = labelInput(
      Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, role: 'user' as const, text: `msg ${i} ${'x'.repeat(1500)}`, tools: [] })),
      [{ path: 'a.ts', status: 'added', additions: 1, deletions: 0 }],
      [],
    );
    const one = buildPrompts(long, 100_000);
    expect(one).toHaveLength(1);
    const many = buildPrompts(long, 3500);
    expect(many.length).toBeGreaterThan(1);
    expect(many.join('\n')).toContain('x'.repeat(1500)); // never truncated
    for (const p of many) expect(p).toContain('[F1] a.ts (added +1 -0)');
    expect(many[0]).toContain('[M1]');
    expect(many[many.length - 1]).toContain('[M5]');
  });
});

describe('helpers', () => {
  it('mergeChunks keeps the first goal and unique keys', () => {
    const c = { key: 'c0', content: { choice: 'x', alternatives: [], rationale: '', tradeoffs: '', premises: [] }, source: { kind: 'inferred' as const }, files: [] };
    const m = mergeChunks([{ goal: '', summary: [], candidates: [c] }, { goal: 'g2', summary: [], candidates: [c] }]);
    expect(m.goal).toBe('g2');
    expect(m.candidates.map((x) => x.key)).toEqual(['0-c0', '1-c0']);
  });
  it('normalizeForQuote and fenced JSON', () => {
    expect(normalizeForQuote('“a”\n  b')).toBe('"a" b');
    expect(parseJsonAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
});
