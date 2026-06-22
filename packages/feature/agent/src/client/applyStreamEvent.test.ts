// Regression net for the engine-agnostic stream reducer (#10). Run with `npm test`
// (vitest) or `npx vitest run <this file>`.
import { describe, it, expect } from 'vitest';
import { applyStreamEvent, type StreamEvent } from './applyStreamEvent';
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
});
