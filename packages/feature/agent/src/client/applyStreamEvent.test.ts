// Regression net for the engine-agnostic stream reducer (#10). Run with `npm test`
// (vitest) or `npx vitest run <this file>`.
import { describe, it, expect } from 'vitest';
import { applyStreamEvent, type StreamEvent } from './applyStreamEvent';
import { deriveContent } from '../shared/assistantText';
import type { ChatMessage } from './types';

const ID = 'asst-1';
const seed = (): ChatMessage[] => [{ id: ID, role: 'assistant', content: '', isStreaming: true }];
const reduce = (msgs: ChatMessage[], evs: StreamEvent[], engine?: string) =>
  evs.reduce((acc, ev) => applyStreamEvent(acc, ev, { engine, assistantId: ID }), msgs);

const delta = (text: string): StreamEvent => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});

describe('applyStreamEvent (#10 engine-agnostic reducer)', () => {
  it('claude deltas accumulate into the assistant bubble', () => {
    const out = reduce(seed(), [delta('Hel'), delta('lo'), delta(' world')]);
    expect(out[0].content).toBe('Hello world');
  });

  it('claude complete-text assistant is skipped (deltas own text; no dup)', () => {
    const out = reduce(seed(), [
      delta('Hi'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
    ]);
    expect(out[0].content).toBe('Hi');
  });

  it('codex/kimi/ollama complete-text assistant is rendered (no deltas for them)', () => {
    const out = reduce(seed(), [{ type: 'assistant', message: { content: [{ type: 'text', text: 'from codex' }] } }], 'codex');
    expect(out[0].content).toBe('from codex');
  });

  it('synthetic message text is read regardless of engine', () => {
    const out = reduce(seed(), [
      { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: '/x unavailable' }] } },
    ]);
    expect(out[0].content).toBe('/x unavailable');
  });

  it('tool_use deduped by id + tool_result merged', () => {
    const out = reduce(seed(), [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { p: 'x' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { p: 'x' } }] } }, // dup
      { type: 'user', message: { content: [{ tool_use_id: 't1', content: 'data' }] } },
    ]);
    expect(out[0].toolCalls?.length).toBe(1);
    expect(out[0].toolCalls?.[0].name).toBe('Read');
    expect(out[0].toolCalls?.[0].result).toBe('data');
    expect(out[0].toolCalls?.[0].isLoading).toBe(false);
  });

  it('result finalize: clears isStreaming + toolCall isLoading', () => {
    const out = reduce(seed(), [
      delta('done'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } },
      { type: 'result' },
    ]);
    expect(out[0].isStreaming).toBe(false);
    expect(out[0].toolCalls?.[0].isLoading).toBe(false);
  });

  it('result.result fills an empty bubble (trimmed)', () => {
    const out = reduce(seed(), [{ type: 'result', result: '  error text  ' }]);
    expect(out[0].content).toBe('error text');
  });

  it('result does NOT overwrite existing content', () => {
    const out = reduce(seed(), [delta('real'), { type: 'result', result: 'fallback' }]);
    expect(out[0].content).toBe('real');
  });

  it('events are scoped to assistantId — other messages untouched', () => {
    const msgs: ChatMessage[] = [{ id: 'user-1', role: 'user', content: 'q' }, ...seed()];
    const out = reduce(msgs, [delta('x')]);
    expect(out[0].content).toBe('q');
    expect(out[1].content).toBe('x');
  });

  // #paragraph-break: two narration segments separated by a tool_use must render
  // as separate paragraphs (blank line), not glue into `**a****b**`. Must match
  // the history parsers byte-for-byte so a page refresh does not reflow the turn.
  const toolUse = (id: string): StreamEvent => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
  });

  it('text segments separated by a tool_use break into paragraphs', () => {
    const out = reduce(seed(), [delta('**1/5**'), toolUse('t1'), delta('**2/5**'), toolUse('t2'), delta('**3/5**')]);
    expect(out[0].content).toBe('**1/5**\n\n**2/5**\n\n**3/5**');
  });

  it('consecutive deltas within one segment glue (no spurious break)', () => {
    const out = reduce(seed(), [toolUse('t1'), delta('Now '), delta('insert '), delta('the fn')]);
    // first delta after the tool breaks off the (empty) prior content → no leading blank line;
    // the rest of the same block glue verbatim.
    expect(out[0].content).toBe('Now insert the fn');
  });

  it('adjacent text with NO tool between stays glued (matches live streaming)', () => {
    const out = reduce(seed(), [delta('a'), delta('b')]);
    expect(out[0].content).toBe('ab');
  });

  it('codex complete-text segments separated by a tool_use also break', () => {
    const out = reduce(
      seed(),
      [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'step one' }] } },
        toolUse('t1'),
        { type: 'assistant', message: { content: [{ type: 'text', text: 'step two' }] } },
      ],
      'codex'
    );
    expect(out[0].content).toBe('step one\n\nstep two');
  });

  // #parts: the ordered text/tool skeleton the renderer needs to tell a mid-turn
  // narration segment from the turn's answer. It is built alongside `content`;
  // these tests pin BOTH the ordering and the fact that it stays a lossless
  // re-description of the same string (deriveContent === content).
  describe('#parts ordered skeleton', () => {
    const kinds = (m: ChatMessage) => (m.parts || []).map((p) => (p.type === 'text' ? `t:${p.text}` : `x:${p.id}`));

    it('interleaves text and tool parts in emission order', () => {
      const out = reduce(seed(), [delta('one'), toolUse('t1'), delta('two'), toolUse('t2'), delta('three')]);
      expect(kinds(out[0])).toEqual(['t:one', 'x:t1', 't:two', 'x:t2', 't:three']);
    });

    it('adjacent deltas with no tool between them stay ONE part', () => {
      const out = reduce(seed(), [delta('a'), delta('b'), delta('c')]);
      expect(kinds(out[0])).toEqual(['t:abc']);
    });

    it('a re-delivered tool_use adds no part (would forge a segment boundary)', () => {
      const out = reduce(seed(), [delta('a'), toolUse('t1'), toolUse('t1'), delta('b')]);
      expect(kinds(out[0])).toEqual(['t:a', 'x:t1', 't:b']);
    });

    it('the error banner is its own part, never folded into the narration', () => {
      const out = reduce(seed(), [delta('working'), { type: 'error', error: 'boom' }]);
      expect(kinds(out[0])).toEqual(['t:working', 't:⚠️ boom']);
    });

    it('result-filled fallback content produces a part too', () => {
      const out = reduce(seed(), [{ type: 'result', result: ' fallback ' }]);
      expect(kinds(out[0])).toEqual(['t:fallback']);
    });

    // The contract that lets step 2 drop `content` from the render path without
    // changing a pixel: parts carry everything the joined string carried.
    it('deriveContent(parts) reproduces content byte for byte', () => {
      const cases: StreamEvent[][] = [
        [delta('**1/5**'), toolUse('t1'), delta('**2/5**'), toolUse('t2'), delta('**3/5**')],
        [toolUse('t1'), delta('Now '), delta('insert '), delta('the fn')],
        [delta('a'), delta('b')],
        [delta('trailing\n\n'), toolUse('t1'), delta('after')],
        [delta('text'), toolUse('t1'), { type: 'error', error: 'boom' }],
        [delta('x'), toolUse('t1'), { type: 'result', result: 'ignored' }],
      ];
      for (const evs of cases) {
        const out = reduce(seed(), evs);
        expect(deriveContent(out[0].parts)).toBe(out[0].content);
      }
    });

    // Guards the repo's memo convention: MessageBubble hangs ~40 useMemo/useCallback
    // on [message.toolCalls]. If a text delta ever re-created that array, every tool
    // card would re-render on every token.
    it('a text delta leaves the toolCalls array identity untouched', () => {
      const withTool = reduce(seed(), [toolUse('t1')]);
      const before = withTool[0].toolCalls;
      const after = reduce(withTool, [delta('a'), delta('b')]);
      expect(after[0].toolCalls).toBe(before);
    });
  });
});
