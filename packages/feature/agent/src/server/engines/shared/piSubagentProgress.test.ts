import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { createSubagentProgressGuard } from '../../../../../../../bin/pi-subagent-progress.mjs';

const round = (command = 'query', text = 'same result', id = 'fresh-id') => ({
  message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', id, arguments: { command } }] } as unknown as AgentMessage,
  results: [{ role: 'toolResult', toolCallId: id, toolName: 'bash', content: [{ type: 'text', text }], isError: false }] as ToolResultMessage[],
});
const feed = (guard: ReturnType<typeof createSubagentProgressGuard>, command?: string, text?: string, id?: string) => {
  const { message, results } = round(command, text, id); return guard.observe(message, results);
};
describe('child progress contracts', () => {
  it('warns on the third identical result and stops on the next despite fresh call IDs', () => {
    const guard = createSubagentProgressGuard();
    expect(feed(guard, 'query', 'same', '1')).toBeUndefined();
    expect(feed(guard, 'query', 'same', '2')).toBeUndefined();
    expect(feed(guard, 'query', 'same', '3')).toMatchObject({ action: 'warn', cycle: 1 });
    expect(feed(guard, 'query', 'same', '4')).toMatchObject({ action: 'stop', reason: 'no_progress' });
  });
  it('warns and stops alternating cycles', () => {
    const guard = createSubagentProgressGuard();
    for (const command of ['A', 'B', 'A', 'B', 'A']) expect(feed(guard, command)).toBeUndefined();
    expect(feed(guard, 'B')).toMatchObject({ action: 'warn', cycle: 2 });
    expect(feed(guard, 'A')).toMatchObject({ action: 'stop' });
  });
  it('permits changed results and a final answer after a warning', () => {
    const guard = createSubagentProgressGuard();
    for (let i = 0; i < 1000; i++) expect(feed(guard, 'poll', String(i))).toBeUndefined();
    feed(guard); feed(guard);
    expect(feed(guard)?.action).toBe('warn');
    const result = guard.observe({ role: 'assistant', content: [{ type: 'text', text: 'Finished' }] } as unknown as AgentMessage, []);
    expect(result).toBeUndefined();
  });
  it('does not reset the warning allowance when a new command or cycle appears', () => {
    const guard = createSubagentProgressGuard();
    feed(guard, 'A'); feed(guard, 'A'); expect(feed(guard, 'A')?.action).toBe('warn');
    feed(guard, 'B'); feed(guard, 'B'); expect(feed(guard, 'B')?.action).toBe('stop');
  });
  it('allows genuine changed work after a warning without granting a second warning', () => {
    const guard = createSubagentProgressGuard();
    feed(guard, 'A'); feed(guard, 'A'); expect(feed(guard, 'A')?.action).toBe('warn');
    expect(feed(guard, 'B')).toBeUndefined();
    expect(feed(guard, 'A')).toBeUndefined();
    expect(feed(guard, 'A')).toBeUndefined();
    expect(feed(guard, 'A')?.action).toBe('stop');
  });
});

it('clears finished-query continuity but preserves the one-warning allowance', () => {
  const guard = createSubagentProgressGuard();
  feed(guard); feed(guard); expect(feed(guard)?.action).toBe('warn');
  guard.observe({ role: 'assistant', content: [{ type: 'text', text: 'Completed' }] } as unknown as AgentMessage, []);
  expect(feed(guard)).toBeUndefined();
  expect(feed(guard)).toBeUndefined();
  expect(feed(guard)?.action).toBe('stop');
});
