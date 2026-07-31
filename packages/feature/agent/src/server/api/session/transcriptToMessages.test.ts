// The reload half of the #parts contract. The live reducer
// (client/applyStreamEvent.test.ts) pins the same invariants for the streaming
// path; both must agree or a page refresh reflows the turn.
import { describe, it, expect } from 'vitest';
import { convertToChatMessages } from './transcriptToMessages';
import { deriveContent } from '../../../shared/assistantText';

const assistant = (uuid: string, content: unknown[]) => ({
  type: 'assistant',
  uuid,
  message: { role: 'assistant', content },
}) as Parameters<typeof convertToChatMessages>[0][number];

const text = (t: string) => ({ type: 'text', text: t });
const tool = (id: string) => ({ type: 'tool_use', id, name: 'Read', input: {} });
const userTurn = (uuid: string, content: string) => ({
  type: 'user',
  uuid,
  message: { role: 'user', content },
}) as Parameters<typeof convertToChatMessages>[0][number];

const kinds = (parts: unknown) =>
  ((parts as Array<{ type: string; text?: string; id?: string }>) || []).map((p) =>
    p.type === 'text' ? `t:${p.text}` : `x:${p.id}`
  );

describe('convertToChatMessages #parts', () => {
  it('interleaves narration and tool calls in transcript order', () => {
    const out = convertToChatMessages([
      userTurn('u1', 'go'),
      assistant('a1', [text('one'), tool('t1')]),
      assistant('a2', [text('two'), tool('t2')]),
      assistant('a3', [text('three')]),
    ]);
    const turn = out[1];
    expect(kinds(turn.parts)).toEqual(['t:one', 'x:t1', 't:two', 'x:t2', 't:three']);
    expect(turn.toolCalls?.map((tc) => tc.id)).toEqual(['t1', 't2']);
  });

  it('reproduces content byte for byte from parts', () => {
    const out = convertToChatMessages([
      userTurn('u1', 'go'),
      assistant('a1', [text('**1/5**'), tool('t1')]),
      assistant('a2', [text('**2/5**'), tool('t2')]),
      assistant('a3', [text('**3/5**')]),
    ]);
    expect(out[1].content).toBe('**1/5**\n\n**2/5**\n\n**3/5**');
    expect(deriveContent(out[1].parts)).toBe(out[1].content);
  });

  it('text with no tool between it stays ONE part (no forged boundary)', () => {
    const out = convertToChatMessages([
      userTurn('u1', 'go'),
      assistant('a1', [text('half ')]),
      assistant('a2', [text('a thought')]),
    ]);
    expect(kinds(out[1].parts)).toEqual(['t:half a thought']);
    expect(deriveContent(out[1].parts)).toBe(out[1].content);
  });

  // A tool_use block missing its id is dropped from toolCalls but still flips the
  // parser's break flag. parts must follow the SAME flag, or the string would
  // break where the skeleton did not and deriveContent would drift.
  it('a malformed tool_use keeps content and parts in agreement', () => {
    const out = convertToChatMessages([
      userTurn('u1', 'go'),
      assistant('a1', [text('before'), { type: 'tool_use', name: 'Read', input: {} }]),
      assistant('a2', [text('after')]),
    ]);
    expect(out[1].content).toBe('before\n\nafter');
    expect(deriveContent(out[1].parts)).toBe(out[1].content);
  });

  it('a turn that is only tool calls carries an empty skeleton, not a phantom text part', () => {
    const out = convertToChatMessages([userTurn('u1', 'go'), assistant('a1', [tool('t1')])]);
    expect(kinds(out[1].parts)).toEqual(['x:t1']);
    expect(deriveContent(out[1].parts)).toBe('');
    expect(out[1].content).toBe('');
  });
});
