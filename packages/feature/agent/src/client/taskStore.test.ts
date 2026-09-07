/**
 * The live task store — the half of task state that the message tree cannot hold.
 *
 * Its reason to exist is depth: a sub-agent's own sub-agent is spawned by a tool call that
 * lives in the sub-agent's transcript, so no message in this session's list can carry its
 * state, and the sub-agent's transcript records neither the structured launch receipt nor any
 * completion notification for it. The live stream is the only source, and this is where it goes.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTaskStore } from './taskStore';
import type { StreamEvent } from './applyStreamEvent';

const ev = (subtype: string, toolUseId: string, extra: Partial<StreamEvent> = {}): StreamEvent => ({
  type: 'system',
  subtype,
  tool_use_id: toolUseId,
  ...extra,
});

describe('taskStore', () => {
  it('records a task whose spawning call no message could ever hold', () => {
    const store = createTaskStore();
    store.applyEvent(ev('task_started', 'toolu_nested', { task_id: 'agent-9' }));
    // `toolu_nested` belongs to a sub-agent's transcript. applyStreamEvent would have dropped
    // this event for want of a matching row; here it survives.
    expect(store.getTask('toolu_nested')).toEqual({ status: 'running', id: 'agent-9' });
    expect(store.getTask('toolu_unrelated')).toBeUndefined();
  });

  it('folds progress and settles on notification, preserving a failure', () => {
    const store = createTaskStore();
    store.applyEvent(ev('task_started', 't1', { task_id: 'a1' }));
    store.applyEvent(ev('task_progress', 't1', { last_tool_name: 'WebFetch', usage: { tool_uses: 37, duration_ms: 9000 } }));
    expect(store.getTask('t1')).toMatchObject({ status: 'running', lastToolName: 'WebFetch', toolUses: 37, durationMs: 9000 });

    store.applyEvent(ev('task_notification', 't1', { status: 'failed' }));
    // Terminal state replaces `running` but keeps what progress reported.
    expect(store.getTask('t1')).toMatchObject({ status: 'failed', lastToolName: 'WebFetch', toolUses: 37 });
  });

  it('ignores ambient housekeeping and unkeyed events', () => {
    const store = createTaskStore();
    store.applyEvent(ev('task_started', 't1', { ambient: true }));
    store.applyEvent({ type: 'system', subtype: 'task_started', task_id: 'a1' });
    expect(store.getTask('t1')).toBeUndefined();
  });

  it('settles running tasks when the run ends, and only those', () => {
    const store = createTaskStore();
    store.applyEvent(ev('task_started', 'live', {}));
    store.applyEvent(ev('task_started', 'done', {}));
    store.applyEvent(ev('task_notification', 'done', { status: 'completed' }));

    store.settleRunning();

    // Same invariant as settleRunningTasks: the owning process is gone, so nothing it spawned
    // is still working. Without this the store outlives the run and keeps a spinner turning.
    expect(store.getTask('live')?.status).toBe('unknown');
    expect(store.getTask('done')?.status).toBe('completed');
  });

  it('replaces entries per key, so an unrelated tick cannot re-render a row', () => {
    // Load-bearing for useLiveTask: it selects per id through useSyncExternalStore, which bails
    // out on Object.is. If a write to one key rebuilt the others, every tool row in the session
    // would re-render on every task_progress tick.
    const store = createTaskStore();
    store.applyEvent(ev('task_started', 'a', {}));
    const before = store.getTask('a');

    store.applyEvent(ev('task_progress', 'b', { last_tool_name: 'Bash' }));

    expect(store.getTask('a')).toBe(before);
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const store = createTaskStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.applyEvent(ev('task_started', 't1', {}));
    expect(listener).toHaveBeenCalledTimes(1);

    // No running task ⇒ nothing changed ⇒ no notification.
    store.applyEvent(ev('task_notification', 't1', { status: 'completed' }));
    listener.mockClear();
    store.settleRunning();
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    store.applyEvent(ev('task_started', 't2', {}));
    expect(listener).not.toHaveBeenCalled();
  });
});
