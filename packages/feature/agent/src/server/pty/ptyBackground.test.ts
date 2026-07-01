// Unit coverage for PTY background-task persistence:
//  - mapLineToEvents surfaces a task-notification transcript line as a system/task_notification event
//  - trackBackgroundLifecycle adds on the "running in background" marker and drains on the notification
// Both are pure; the stateful driver integration (stop_hook stay-resident, idle suppression, turn
// boundaries) is verified on a real machine.
import { describe, it, expect } from 'vitest';
import { mapLineToEvents } from './ptySseMapper';
import { trackBackgroundLifecycle, type TranscriptLine } from './claudePtyDriver';

const notifLine = (over: Partial<TranscriptLine> = {}): TranscriptLine => ({
  type: 'user',
  origin: { kind: 'task-notification' },
  message: {
    role: 'user',
    content:
      '<task-notification>\n' +
      '<task-id>b7bp62e63</task-id>\n' +
      '<tool-use-id>toolu_01</tool-use-id>\n' +
      '<output-file>/tmp/tasks/b7bp62e63.output</output-file>\n' +
      '<status>completed</status>\n' +
      '<summary>Background command "sleep 5" completed (exit code 0)</summary>\n' +
      '</task-notification>',
  },
  ...over,
} as TranscriptLine);

describe('mapLineToEvents — task notification', () => {
  it('maps a task-notification user line to a system/task_notification event', () => {
    const out = mapLineToEvents(notifLine(), 'sess-1');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'system',
      subtype: 'task_notification',
      session_id: 'sess-1',
      task_id: 'b7bp62e63',
      status: 'completed',
      summary: 'Background command "sleep 5" completed (exit code 0)',
      output_file: '/tmp/tasks/b7bp62e63.output',
    });
  });

  it('does not treat an ordinary user tool_result as a notification', () => {
    const out = mapLineToEvents(
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } } as TranscriptLine,
      'sess-1',
    );
    expect(out[0]).toMatchObject({ type: 'user' });
    expect(out.some((e) => e.subtype === 'task_notification')).toBe(false);
  });

  it('still maps assistant text to a stream_event (regression)', () => {
    const out = mapLineToEvents(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } as TranscriptLine,
      'sess-1',
    );
    expect(out[0]).toMatchObject({ type: 'stream_event' });
  });
});

describe('trackBackgroundLifecycle', () => {
  it('adds a task on the "running in background" marker and drains it on the notification', () => {
    const pending = new Set<string>();

    trackBackgroundLifecycle(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: b7bp62e63. Output is being written to: /tmp/x' }],
        },
      } as TranscriptLine,
      pending,
    );
    expect(pending.has('b7bp62e63')).toBe(true);

    trackBackgroundLifecycle(notifLine(), pending);
    expect(pending.size).toBe(0);
  });

  it('is a no-op for unrelated lines', () => {
    const pending = new Set<string>();
    trackBackgroundLifecycle({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } } as TranscriptLine, pending);
    expect(pending.size).toBe(0);
  });
});
