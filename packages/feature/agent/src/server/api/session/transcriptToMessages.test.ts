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

// The reload half of the spawned-task contract. Its live counterpart is
// applyStreamEvent.test.ts's "spawned background tasks" block: both must agree, or a refresh
// mid-run flips a running agent to finished (or resurrects a finished one).
describe('convertToChatMessages spawned background tasks', () => {
  const agentCall = (uuid: string, id: string) =>
    assistant(uuid, [{ type: 'tool_use', id, name: 'Agent', input: { description: 'research' } }]);
  const launchReceipt = (uuid: string, toolUseId: string, agentId: string) => ({
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Async agent launched successfully.' }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId },
  }) as Parameters<typeof convertToChatMessages>[0][number];
  const notification = (uuid: string, toolUseId: string, taskId: string, status: string) => ({
    type: 'user',
    uuid,
    origin: { kind: 'task-notification' },
    message: {
      role: 'user',
      content:
        `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n` +
        `<status>${status}</status>\n<summary>Agent "research" finished</summary>\n</task-notification>`,
    },
  }) as Parameters<typeof convertToChatMessages>[0][number];

  const taskOf = (msgs: ReturnType<typeof convertToChatMessages>) =>
    msgs.find((m) => m.toolCalls?.length)?.toolCalls?.[0];

  it('an unsettled async launch reconstructs as UNKNOWN, never running', () => {
    const tc = taskOf(convertToChatMessages([
      userTurn('u1', 'go'),
      agentCall('a1', 'toolu_1'),
      launchReceipt('r1', 'toolu_1', 'agent-9'),
    ]));
    // The receipt IS the tool result — the old "no result ⇒ still working" test read this as
    // finished within 30ms of launch.
    expect(tc?.result).toContain('Async agent launched');
    // …and the fix must not overcorrect into "still running": the process that owned this task
    // is gone by the time anything reads the transcript. Reconstructing `running` here is what
    // would let an interrupted run's task re-spin during a LATER, unrelated run.
    expect(tc?.task).toEqual({ status: 'unknown', id: 'agent-9' });
  });

  it('the matching task-notification settles it, keyed by <tool-use-id>', () => {
    const tc = taskOf(convertToChatMessages([
      userTurn('u1', 'go'),
      agentCall('a1', 'toolu_1'),
      launchReceipt('r1', 'toolu_1', 'agent-9'),
      notification('n1', 'toolu_1', 'agent-9', 'completed'),
    ]));
    expect(tc?.task).toMatchObject({ status: 'completed', id: 'agent-9' });
  });

  it('a failure is preserved, not laundered into completed', () => {
    const tc = taskOf(convertToChatMessages([
      userTurn('u1', 'go'),
      agentCall('a1', 'toolu_1'),
      launchReceipt('r1', 'toolu_1', 'agent-9'),
      notification('n1', 'toolu_1', 'agent-9', 'failed'),
    ]));
    expect(tc?.task?.status).toBe('failed');
  });

  it("another agent's notification does not settle this call", () => {
    const tc = taskOf(convertToChatMessages([
      userTurn('u1', 'go'),
      agentCall('a1', 'toolu_1'),
      launchReceipt('r1', 'toolu_1', 'agent-9'),
      notification('n1', 'toolu_OTHER', 'agent-other', 'completed'),
    ]));
    expect(tc?.task?.status).toBe('unknown');
  });

  it('a synchronous tool call carries no task at all', () => {
    const tc = taskOf(convertToChatMessages([
      userTurn('u1', 'go'),
      assistant('a1', [tool('t1')]),
      {
        type: 'user',
        uuid: 'r1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
      } as Parameters<typeof convertToChatMessages>[0][number],
    ]));
    expect(tc?.task).toBeUndefined();
  });
});
