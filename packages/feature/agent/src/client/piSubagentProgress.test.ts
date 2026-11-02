import { expect, it } from 'vitest';
import { applyStreamEvent } from './applyStreamEvent';
import type { ChatMessage } from './types';

it('shows child progress without settling the parent tool and replaces it with the final result', () => {
  const messages: ChatMessage[] = [{ id: 'parent', role: 'assistant', content: '', timestamp: new Date().toISOString(), toolCalls: [{ id: 'call', name: 'subagent', input: {}, isLoading: true }] }];
  const progress = applyStreamEvent(messages, { type: 'tool_progress', tool_call_id: 'call', progress_text: '[running] Dynamic child' }, { assistantId: 'parent' });
  expect(progress[0].toolCalls?.[0]).toMatchObject({ isLoading: true, result: '[running] Dynamic child' });
  const finished = applyStreamEvent(progress, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: '[done] Child result' }] } }, { assistantId: 'parent' });
  expect(finished[0].toolCalls?.[0]).toMatchObject({ isLoading: false, result: '[done] Child result' });
  expect(applyStreamEvent(finished, { type: 'tool_progress', tool_call_id: 'call', progress_text: 'late' }, { assistantId: 'parent' })).toEqual(finished);
});
