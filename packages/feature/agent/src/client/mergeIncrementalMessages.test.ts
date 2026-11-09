import { describe, it, expect } from 'vitest';
import { reuseMessages } from './mergeIncrementalMessages';
import type { ChatMessage } from './types';

const msg = (id: string, content = `content-${id}`): ChatMessage =>
  ({ id, role: 'assistant', content } as ChatMessage);

describe('mergeIncrementalMessages', () => {
  it('refreshes tool results even when the message text and identity are unchanged', () => {
    const prev = [{ ...msg('a'), toolCalls: [{ id: 'spawn', name: 'Task', input: {}, result: 'old report' }] }];
    const incoming = [{ ...prev[0], toolCalls: [{ ...prev[0].toolCalls[0], result: 'new report' }] }];
    expect(reuseMessages(prev, incoming)[0].toolCalls?.[0].result).toBe('new report');
  });

  it('refreshes structured text/tool order and tool lifecycle metadata', () => {
    const prev: ChatMessage[] = [{ ...msg('a'), parts: [{ type: 'text', text: 'answer' }] }];
    const incoming: ChatMessage[] = [{ ...prev[0], parts: [{ type: 'text', text: 'answer' }, { type: 'tool', id: 'spawn' }],
      toolCalls: [{ id: 'spawn', name: 'Task', input: {}, isLoading: true }] }];
    expect(reuseMessages(prev, incoming)).toEqual(incoming);
  });

  it('keeps unchanged nested JSON bubbles stable regardless of input key order', () => {
    const prev = [{ ...msg('a'), toolCalls: [{ id: 'tool', name: 'Tool', input: { a: 1, b: ['x'] }, result: 'done' }] }];
    const incoming = [{ ...prev[0], toolCalls: [{ id: 'tool', name: 'Tool', input: { b: ['x'], a: 1 }, result: 'done' }] }];
    expect(reuseMessages(prev, incoming)).toBe(prev);
  });
  it('refreshes task membership and the input count when steering arrives', () => {
    const prev = [{ ...msg('a'), turnId: 'task-1', turnUserCount: 1 }];
    const window = [{ ...msg('a'), turnId: 'task-1', turnUserCount: 2 }, msg('steer')];
    expect(reuseMessages(prev, window)).toEqual(window);
    expect(reuseMessages(prev, [{ ...msg('a'), turnId: 'task-2', turnUserCount: 1 }])[0].turnId).toBe('task-2');
  });

  it('preserves unchanged rows while applying an authoritative replacement', () => {
    const before = [msg('a'), msg('b')];
    const after = reuseMessages(before, [msg('b'), msg('c')]);
    expect(after.map((row) => row.id)).toEqual(['b', 'c']);
    expect(after[0]).toBe(before[1]);
    expect(reuseMessages(before, [])).toEqual([]);
  });
});
