import { describe, expect, it } from 'vitest';
import { buildCodexForkLines } from './codexFork';

const OLD_ID = '019fecf2-99ce-7af0-9a20-69df24f4fe32';
const NEW_ID = '7f94d8e0-d91e-4396-898d-28c53f01edd2';

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

const user = (text: string) => line({
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  },
});

const assistant = (text: string) => line({
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  },
});

const rollout = [
  line({
    type: 'session_meta',
    payload: {
      id: OLD_ID,
      cwd: '/tmp/project',
      source: 'exec',
      cli_version: '0.141.0',
    },
  }),
  line({ type: 'event_msg', payload: { type: 'task_started' } }),
  user('alpha prompt'),
  assistant('alpha answer'),
  line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'alpha answer' } }),
  line({ type: 'event_msg', payload: { type: 'task_started' } }),
  line({ type: 'response_item', payload: { type: 'function_call', name: 'wait_agent', call_id: 'wait-1' } }),
  line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'wait-1', output: '[]' } }),
  user('beta prompt'),
  assistant('beta answer'),
  line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'beta answer' } }),
];

describe('buildCodexForkLines', () => {
  it('keeps the conversation through the target turn for prefix forks', () => {
    const result = buildCodexForkLines(rollout, OLD_ID, NEW_ID, 'codex-assistant-1', 'prefix');

    expect(result.targetMissed).toBe(false);
    expect(result.newLines).toHaveLength(5);
    expect(result.newLines.join('\n')).toContain(NEW_ID);
    expect(result.newLines.join('\n')).not.toContain(OLD_ID);
    expect(result.newLines.join('\n')).toContain('alpha answer');
    expect(result.newLines.join('\n')).not.toContain('beta answer');
  });

  it('keeps only the target turn for single-turn excerpts', () => {
    const result = buildCodexForkLines(rollout, OLD_ID, NEW_ID, 'codex-user-2', 'single');

    expect(result.targetMissed).toBe(false);
    expect(result.newLines).toHaveLength(7);
    expect(result.newLines[0]).toContain(NEW_ID);
    expect(result.newLines.join('\n')).not.toContain(OLD_ID);
    expect(result.newLines.join('\n')).not.toContain('alpha prompt');
    expect(result.newLines.join('\n')).toContain('beta prompt');
    expect(result.newLines.join('\n')).toContain('beta answer');
  });

  it('reports a missed target instead of copying the full rollout', () => {
    const result = buildCodexForkLines(rollout, OLD_ID, NEW_ID, 'codex-user-99', 'prefix');

    expect(result.targetMissed).toBe(true);
    expect(result.newLines).toEqual([]);
  });
});
