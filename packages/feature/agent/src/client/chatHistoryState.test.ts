import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { chatHistoryReducer, emptyChatHistory, type ChatHistoryState, type HistoryPage, type LiveHistoryRun } from './chatHistoryState';
import type { ChatMessage } from './types';
import { applyStreamEvent, type StreamEvent } from './applyStreamEvent';
import { historyWindow } from '../server/historyWindow';

const origin = Date.parse('2026-11-06T00:00:00Z');
const time = (n: number) => origin + n * 1000;
const task = (n: number, inputs = 1, live = false): ChatMessage[] => {
  const metadata = { sourceTaskId: `task-${n}`, turnId: `${live ? 'live' : 'disk'}-task-${n}`, turnStartedAt: new Date(time(n) + (live ? 0 : 100)).toISOString(), ...(live ? { liveRunId: 'run' } : {}) };
  return [
    ...Array.from({ length: inputs }, (_, input) => ({ id: `${live ? 'live' : 'disk'}-user-${n}-${input}`, role: 'user' as const, content: `Q${n}-${input}`, timestamp: metadata.turnStartedAt, ...metadata })),
    { id: `${live ? 'live' : 'disk'}-answer-${n}`, role: 'assistant', content: `A${n}`, timestamp: metadata.turnStartedAt, ...metadata },
  ];
};
const page = (start: number, end = 20, inputs = 1): HistoryPage => ({
  messages: Array.from({ length: end - start }, (_, i) => task(start + i, inputs)).flat(), totalTurns: end, startTurnIndex: start, hasMore: start > 0,
});
function apply(state: ChatHistoryState, data: HistoryPage, mode: 'replace' | 'incremental' | 'jump' | 'prepend' = 'replace', before = state.diskCursor?.index) {
  return chatHistoryReducer(state, { type: 'page', page: data, mode, sessionId: 'session', endTurnIndex: mode === 'prepend' ? before : undefined, reconciles: state.runs.filter((run) => run.phase === 'released').map((run) => run.id) });
}
function replay(state: ChatHistoryState, messages: ChatMessage[], run: LiveHistoryRun = { id: 'run', startedAt: time(19) }) {
  const next = chatHistoryReducer(state, { type: 'replay-start', run });
  return chatHistoryReducer(next, { type: 'run-messages', runId: run.id, update: messages });
}
const answers = (state: ChatHistoryState) => state.messages.filter((message) => /^A\d+$/.test(message.content)).map((message) => Number(message.content.slice(1)));

it.each([true, false])('keeps history when a failed run releases before the next send: %s', (releaseFirst) => {
  let state = apply(emptyChatHistory, page(0, 1));
  state = replay(state, [{ id: 'failed', role: 'user', content: 'Failed' }], { id: 'a', startedAt: time(1) });
  const end = () => { state = chatHistoryReducer(state, { type: 'run-end', runId: 'a', writerActive: false, failed: true }); };
  if (releaseFirst) end();
  state = chatHistoryReducer(state, { type: 'sender-start', run: { id: 'b', startedAt: time(2) } });
  state = chatHistoryReducer(state, { type: 'run-messages', runId: 'b', update: [{ id: 'next', role: 'user', content: 'Next' }] });
  if (!releaseFirst) end();
  expect(state.messages.map(row => row.content)).toEqual(['Q0-0', 'A0', 'Next']);
  expect(state.failures).toHaveLength(1);
});

describe('canonical history coordinates and live overlays', () => {
  for (const location of ['disk', 'released-run']) it(`routes later tool updates to ${location} without moving text or replaying recovery into history`, () => {
    const old: ChatMessage[] = [
      { id: 'old-user', role: 'user', content: 'Old question' },
      { id: 'answer', role: 'assistant', content: 'Old answer', toolCalls: [{ id: 'old-tool', name: 'Bash', input: {}, isLoading: true }] },
    ];
    let state = apply(emptyChatHistory, { messages: old, totalTurns: 1, startTurnIndex: 0 });
    if (location === 'released-run') state = replay(state, old, { id: 'old', startedAt: time(0) });
    state = replay(state, [{ id: 'new-user', role: 'user', content: 'New question' },
      { id: 'new-answer', role: 'assistant', content: '' }], { id: 'next', startedAt: time(1) });
    const event = (ev: StreamEvent, runId = 'next') => {
      state = chatHistoryReducer(state, { type: 'run-messages', runId, update: { event: ev, assistantId: 'new-answer', engine: 'codex' } });
    };
    const result = (content: string): StreamEvent => ({ type: 'user', message: { content: [{ tool_use_id: 'old-tool', content }] } });
    const tool = () => state.messages.find(row => row.toolCalls?.length)?.toolCalls?.[0];
    event({ type: 'tool_progress', tool_call_id: 'old-tool', progress_text: 'Working' });
    expect(tool()).toMatchObject({ result: 'Working', isLoading: true });
    event(result('Done')); event(result('Done'));
    event({ type: 'tool_progress', tool_call_id: 'old-tool', progress_text: 'Stale progress' });
    event({ ...result('Nested output'), parent_tool_use_id: 'parent' });
    event(result('Retired run output'), 'missing-run');
    expect(tool()).toMatchObject({ result: 'Done', isLoading: false });
    event({ type: 'system', subtype: 'task_notification', tool_use_id: 'old-tool', task_id: 'task', status: 'completed' });
    expect(tool()?.task).toMatchObject({ status: 'completed', id: 'task' });
    event({ type: 'assistant', message: { content: [{ type: 'text', text: 'New answer' }] } });
    expect(state.messages.map(row => row.content)).toEqual(['Old question', 'Old answer', 'New question', 'New answer']);
    state = replay(state, old, { id: 'failure', startedAt: time(0), recovery: true });
    event(result('Archived output'), 'failure');
    expect(state.failures[0].messages[1].toolCalls?.[0].result).toBe('Archived output');
    expect(tool()?.result).toBe('Done');
    event(result('Latest output'));
    expect(tool()?.result).toBe('Latest output');
    expect(state.failures[0].messages[1].toolCalls?.[0].result).toBe('Archived output');
    state = chatHistoryReducer(state, { type: 'run-end', runId: 'next', writerActive: false });
    state = apply(state, { messages: old.map(row => row.toolCalls ? { ...row, toolCalls: row.toolCalls.map(tc => ({ ...tc, result: 'Persisted', isLoading: false })) } : row), totalTurns: 1, startTurnIndex: 0 });
    expect(tool()?.result).toBe('Persisted');
    expect(state.runs).toHaveLength(0);
    expect(state.failures).toHaveLength(1);
  });

  it('keeps complete failed output separate from partial or later complete history', () => {
    const live = task(19, 2, true).map((row) => row.role === 'assistant'
      ? { ...row, content: 'Saved A; unsaved B', streamError: 'Failure' } : row);
    let state = replay(apply(emptyChatHistory, page(10, 19)), live);
    state = chatHistoryReducer(state, { type: 'run-end', runId: 'run', writerActive: true, failed: true });
    expect(state.messages.some((row) => row.content.includes('unsaved B'))).toBe(true);
    expect(state.failures).toHaveLength(0);
    state = chatHistoryReducer(state, { type: 'run-end', runId: 'run', writerActive: false });
    for (const stable of [false, true]) {
      state = apply(state, { ...page(19), stable }, 'incremental');
      expect(state.messages.filter((row) => row.content === 'Q19-0')).toHaveLength(1);
      expect(state.messages.some((row) => row.content.includes('unsaved B'))).toBe(false);
      expect(state.failures[0].messages.map((row) => row.content)).toEqual(live.map((row) => row.content));
    }
    state = apply(state, page(0), 'replace');
    expect(state.failures).toHaveLength(1);
    expect(state.runs).toHaveLength(0);
  });

  it('preserves failed and rejected copies through a successor send, rejection and admission', () => {
    let state = replay(emptyChatHistory, task(19, 1, true));
    state = chatHistoryReducer(state, { type: 'run-end', runId: 'run', writerActive: false, failed: true });
    state = apply(state, page(19));
    state = chatHistoryReducer(state, { type: 'sender-start', run: { id: 'rejected', startedAt: time(20) } });
    state = chatHistoryReducer(state, { type: 'run-messages', runId: 'rejected', update: task(20, 1, true) });
    state = chatHistoryReducer(state, { type: 'send-failed', runId: 'rejected' });
    state = replay(state, task(21, 1, true), { id: 'next', startedAt: time(21) });
    expect(state.failures.map((copy) => copy.id)).toEqual(['run', 'rejected']);
    expect(state.messages.some((row) => row.content === 'Q20-0')).toBe(false);
    expect(state.runs.find((run) => run.id === 'next')?.phase).toBe('active');
  });

  it('captures a draining failure when successor admission supplies the missing release', () => {
    let state = replay(apply(emptyChatHistory, page(10)), task(19, 1, true));
    state = chatHistoryReducer(state, { type: 'run-end', runId: 'run', writerActive: true, failed: true });
    state = chatHistoryReducer(state, { type: 'sender-start', run: { id: 'next', startedAt: time(20) } });
    state = chatHistoryReducer(state, { type: 'run-accepted', run: { id: 'next', startedAt: time(20) } });
    expect(state.failures[0].messages.map((row) => row.content)).toEqual(['Q19-0', 'A19']);
    state = apply(state, page(10));
    expect(state.failures).toHaveLength(1);
  });

  it('replays an archived failure without releasing or covering the active successor', () => {
    let state = replay(apply(emptyChatHistory, page(10)), task(20, 1, true), { id: 'next', startedAt: time(20) });
    const before = state.messages;
    for (let i = 0; i < 2; i++) {
      state = replay(state, task(19, 1, true), { id: 'old', startedAt: time(19), recovery: true });
      state = chatHistoryReducer(state, { type: 'run-end', runId: 'old', writerActive: false, failed: true });
      expect(state.messages).toEqual(before);
      expect(state.runs.find((run) => run.id === 'next')?.phase).toBe('active');
      expect(state.writerIdle).toBe(false);
      expect(state.failures).toHaveLength(1);
    }
  });

  it('does not infer deletion from an unloaded source or a changed history prefix', () => {
    let state = replay(emptyChatHistory, task(2, 1, true), { id: 'run', startedAt: time(2) });
    state = chatHistoryReducer(state, { type: 'run-end', runId: 'run', writerActive: false, failed: true });
    state = apply(state, { ...page(10), replacesWindow: true });
    expect(state.failures[0].messages).toHaveLength(2);
    state = apply(state, page(0));
    expect(state.messages.filter((row) => row.content === 'Q2-0')).toHaveLength(1);
    expect(state.failures[0].messages[0].content).toBe('Q2-0');
  });

  it('deletes only the related recovery turn and retains remapped surviving identities', () => {
    const live: ChatMessage[] = [0, 1, 2].flatMap((n) => [
      { id: `u${n}`, sourceId: `native-${n}`, role: 'user', content: 'Continue' },
      { id: `a${n}`, role: 'assistant', content: `Partial ${n}` },
    ]);
    let state = replay(emptyChatHistory, live);
    state = chatHistoryReducer(state, { type: 'run-end', runId: 'run', writerActive: false, failed: true });
    state = chatHistoryReducer(state, { type: 'recovery-deleted', deletion: { sourceIds: ['native-0'], taskIds: [], sourceRemap: { 'native-1': 'rebased-1' } } });
    state = chatHistoryReducer(state, { type: 'recovery-deleted', deletion: { sourceIds: ['rebased-1'], taskIds: [] } });
    state = apply(state, { messages: [], totalTurns: 0, startTurnIndex: 0, stable: true, replacesWindow: true });
    expect(state.failures[0].messages.map((row) => row.id)).toEqual(['u2', 'a2']);
  });

  it('drops copies of runs started at or before a compaction marker and keeps later ones', () => {
    const copy = (id: string, startedAt: number) => ({ id, startedAt, messages: [{ id: `${id}-u`, role: 'user' as const, content: id }] });
    let state = chatHistoryReducer(emptyChatHistory, { type: 'input-rejected', sessionId: 's', copy: copy('old', time(1)) });
    state = chatHistoryReducer(state, { type: 'input-rejected', sessionId: 's', copy: copy('edge', time(2)) });
    state = chatHistoryReducer(state, { type: 'input-rejected', sessionId: 's', copy: copy('new', time(3)) });
    state = chatHistoryReducer(state, { type: 'recovery-deleted', deletion: { sourceIds: [], taskIds: [], clearsBefore: time(2) } });
    expect(state.failures.map((failure) => failure.id)).toEqual(['new']);
  });

  it('empties a released failed run started before a compaction marker', () => {
    let state = replay(emptyChatHistory, [{ id: 'u', sourceId: 'native-u', role: 'user', content: 'Q' }, { id: 'a', role: 'assistant', content: 'Partial' }],
      { id: 'run', startedAt: time(5) });
    state = chatHistoryReducer(state, { type: 'run-end', runId: 'run', writerActive: false, failed: true });
    expect(state.failures).toHaveLength(1);
    state = chatHistoryReducer(state, { type: 'recovery-deleted', deletion: { sourceIds: [], taskIds: [], clearsBefore: time(5) } });
    expect(state.failures).toEqual([]);
    expect(state.runs.find((run) => run.id === 'run')?.messages ?? []).toEqual([]);
  });

  it('removes an entire Codex task while retaining an unrelated failed task', () => {
    let state = replay(emptyChatHistory, [...task(18, 2, true), ...task(19, 2, true)]);
    state = chatHistoryReducer(state, { type: 'run-end', runId: 'run', writerActive: false, failed: true });
    state = chatHistoryReducer(state, { type: 'recovery-deleted', deletion: { sourceIds: [], taskIds: ['task-18'] } });
    expect(state.failures[0].messages.map((row) => row.sourceTaskId)).toEqual(['task-19', 'task-19', 'task-19']);
    state = apply(state, page(0));
    state = chatHistoryReducer(state, { type: 'page', sessionId: 'another', mode: 'replace', page: page(0) });
    expect(state.failures).toEqual([]);
  });

  it('does not override a native input identity with an equal timestamp or an earlier inferred anchor', () => {
    const disk = [
      { id: 'old', sourceId: 'old', role: 'user' as const, content: 'Earlier', timestamp: new Date(time(0)).toISOString() },
      { id: 'same-text', sourceId: 'old-native', role: 'user' as const, content: 'Continue', timestamp: new Date(time(2)).toISOString() },
    ];
    const live = { id: 'live', liveInputId: 'input', role: 'user' as const, content: 'Continue', timestamp: new Date(time(2)).toISOString() };
    for (const inferred of [false, true]) {
      let state = replay(apply(emptyChatHistory, historyWindow(disk, {})), [{ ...live, ...(inferred ? {} : { sourceId: 'new-native' }) }], { id: 'run', startedAt: time(2) });
      if (inferred) state = chatHistoryReducer(state, { type: 'run-messages', runId: 'run', update: (rows) => applyStreamEvent(rows,
        { type: 'system', subtype: 'input_binding', inputId: 'input', sourceId: 'new-native' }, { assistantId: '' }) });
      expect(state.messages.map((row) => row.id)).toEqual(['old', 'same-text', 'live']);
      state = apply(state, historyWindow([...disk, { ...live, id: 'persisted', sourceId: 'new-native' }], {}), 'incremental');
      expect(state.messages.map((row) => row.id)).toEqual(['old', 'same-text', 'live']);
      expect(state.runs[0].start).toBe(2);
    }
  });

  it.each([false, true])('does not count queued inputs as already persisted: repeated=%s', (repeated) => {
    const text = (n: number) => repeated ? 'Continue' : `Input ${n}`;
    const disk = [
      { id: 'old-0', role: 'user' as const, content: 'Old 0', timestamp: new Date(time(0)).toISOString() },
      { id: 'old-1', role: 'user' as const, content: 'Old 1', timestamp: new Date(time(1)).toISOString() },
      { id: 'native-0', sourceId: 'native-0', role: 'user' as const, content: text(0), timestamp: new Date(time(3)).toISOString() },
    ];
    const live = [0, 1, 2].map((n) => ({ id: `live-${n}`, role: 'user' as const, content: text(n), timestamp: new Date(time(2) + n).toISOString() }));
    const state = replay(apply(emptyChatHistory, historyWindow(disk, {})), live, { id: 'run', startedAt: time(2) });
    expect(state.messages.map((row) => row.content)).toEqual(['Old 0', 'Old 1', ...live.map((row) => row.content)]);
    expect(state.runs[0].start).toBe(2);
  });

  it.each([0, 1, 2])('uses task coordinates with %s user inputs per task', (inputs) => {
    const state = apply(emptyChatHistory, page(10, 20, inputs));
    expect(state.startTurnIndex).toBe(10);
    expect(answers(state)).toEqual(Array.from({ length: 10 }, (_, n) => n + 10));
  });

  it('applies the known disk prefix without duplicating an assistant-only current task', () => {
    const state = replay(emptyChatHistory, task(19, 0, true));
    const loaded = apply(state, page(10, 20, 0), 'incremental');
    expect(loaded.startTurnIndex).toBe(10);
    expect(answers(loaded)).toEqual(Array.from({ length: 10 }, (_, n) => n + 10));
    expect(loaded.messages.filter((m) => m.content === 'A19').map((m) => m.id)).toEqual(['live-answer-19']);
  });

  it('expands the start when replay adds an earlier round of the same run', () => {
    const state = apply(emptyChatHistory, page(19), 'jump');
    const replayed = replay(state, [...task(18, 1, true), ...task(19, 1, true)], { id: 'run', startedAt: time(18) });
    expect(replayed.startTurnIndex).toBe(18);
    const older = apply(replayed, { ...page(8, 18), totalTurns: 20 }, 'prepend');
    expect(older.startTurnIndex).toBe(8);
    expect(answers(older)).toEqual(Array.from({ length: 12 }, (_, n) => n + 8));
  });

  it('reconnect replay is idempotent and steering does not create another task', () => {
    const state = apply(emptyChatHistory, page(19, 20, 2));
    const once = replay(state, task(19, 2, true));
    const twice = replay(once, task(19, 2, true));
    expect(twice.startTurnIndex).toBe(19);
    expect(answers(twice)).toEqual([19]);
  });

  it('makes every middle task reachable after a stale cache and a newer live run', () => {
    const cached = apply(emptyChatHistory, page(10));
    const live = replay(cached, task(34, 1, true), { id: 'run', startedAt: time(34) });
    let state = apply(live, page(25, 35), 'incremental');
    expect(state.startTurnIndex).toBe(25);
    state = apply(state, { ...page(15, 25), totalTurns: 35 }, 'prepend');
    expect(state.startTurnIndex).toBe(10);
    state = apply(state, { ...page(0, 10), totalTurns: 35 }, 'prepend');
    expect(answers(state)).toEqual(Array.from({ length: 35 }, (_, n) => n));
    expect(state.hasMore).toBe(false);
  });

  it('updates an unpersisted live boundary when the cache was older than the server tail', () => {
    const cached = replay(apply(emptyChatHistory, page(10)), task(34, 1, true), { id: 'run', startedAt: time(34) });
    const refreshed = apply(cached, page(24, 34), 'incremental');
    expect(answers(refreshed)).toEqual(Array.from({ length: 11 }, (_, n) => n + 24));
    expect(refreshed.messages.filter((m) => m.content === 'A20')).toHaveLength(0);
  });

  it('rejects a page that belongs to the window before a jump', () => {
    const old = apply(emptyChatHistory, page(10));
    const jumped = apply(old, page(5), 'jump');
    expect(apply(jumped, { ...page(0, 10), totalTurns: 20 }, 'prepend', 10)).toBe(jumped);
  });

  it('retains prior tasks when a late tool timestamp is newer than the current run', () => {
    const prior = task(18, 0).map((m) => ({ ...m, timestamp: new Date(time(19) + 500).toISOString() }));
    const state = replay(emptyChatHistory, task(19, 0, true));
    const loaded = apply(state, { messages: [...prior, ...task(19, 0)], startTurnIndex: 18, totalTurns: 20 }, 'incremental');
    expect(answers(loaded)).toEqual([18, 19]);
  });

  it('converges an ended overlay to canonical IDs on the next tail read', () => {
    const active = replay(apply(emptyChatHistory, page(10)), task(19, 1, true));
    const ended = chatHistoryReducer(active, { type: 'run-end', runId: 'run', writerActive: false });
    const canonical = apply(ended, page(10), 'incremental');
    expect(canonical.runs).toHaveLength(0);
    expect(canonical.messages.some((m) => m.liveRunId)).toBe(false);
    expect(answers(canonical)).toEqual(Array.from({ length: 10 }, (_, n) => n + 10));
  });

  it('preserves originator updates after a viewer run ends', () => {
    const active = replay(apply(emptyChatHistory, page(10)), task(19, 1, true));
    const ended = chatHistoryReducer(active, { type: 'run-end', runId: 'run', writerActive: false });
    const originator: ChatMessage = { id: 'user-next-run', role: 'user', content: 'Next prompt' };
    const sending = chatHistoryReducer(ended, { type: 'sender-start', run: { id: 'sender', startedAt: time(20) } });
    const updated = chatHistoryReducer(sending, { type: 'run-messages', runId: 'sender', update: (messages) => [...messages, originator] });
    expect(updated.messages.at(-1)).toBe(originator);
  });

  it.each(['prepend', 'jump'] as const)('preserves the originator streaming tail on %s', (mode) => {
    const state = apply(emptyChatHistory, page(10));
    const tail: ChatMessage[] = [
      { id: 'user-new-run', role: 'user', content: 'Next prompt' },
      { id: 'assistant-new-run', role: 'assistant', content: 'Still streaming', isStreaming: true },
    ];
    const pending = chatHistoryReducer(state, { type: 'sender-start', run: { id: 'sender', startedAt: time(20) } });
    const sending = chatHistoryReducer(pending, { type: 'run-messages', runId: 'sender', update: (messages) => [...messages, ...tail] });
    const expanded = apply(sending, mode === 'prepend' ? { ...page(0, 10), totalTurns: 20 } : page(0), mode);
    expect(expanded.messages.slice(-2)).toEqual(tail);
    expect(expanded.startTurnIndex).toBe(0);
    expect(answers(expanded)).toEqual(Array.from({ length: 20 }, (_, n) => n));
  });

  it('reuses unchanged canonical bubbles during a tail refresh', () => {
    const state = apply(emptyChatHistory, page(10));
    const refreshed = apply(state, page(10), 'incremental');
    expect(refreshed.messages[0]).toBe(state.messages[0]);
  });

  it('retains a fully loaded prefix across incremental suffix reads', () => {
    const state = apply(apply(emptyChatHistory, page(0)), page(11, 21), 'incremental');
    expect(state.startTurnIndex).toBe(0);
    expect(state.hasMore).toBe(false);
    expect(answers(state)).toEqual(Array.from({ length: 21 }, (_, n) => n));
  });

  it('preserves empty incremental reads, clears full empty reads, and stops empty paging', () => {
    const state = apply(emptyChatHistory, page(10));
    const empty = { messages: [], totalTurns: 0, startTurnIndex: 0, hasMore: false, stable: false };
    expect(apply(state, empty, 'incremental').messages).toBe(state.messages);
    expect(apply(state, { ...empty, stable: true }).messages).toEqual([]);
    expect(apply(state, empty, 'prepend').hasMore).toBe(state.hasMore);
  });

  it.each(['incremental', 'jump', 'prepend'] as const)('keeps the disk coordinates after an ignored empty %s', (mode) => {
    const state = apply(emptyChatHistory, page(10));
    const retained = apply(state, { messages: [], totalTurns: 0, startTurnIndex: 0, hasMore: false, stable: false }, mode);
    expect(retained.diskTurns).toBe(state.diskTurns);
    expect(retained.totalTurns).toBe(20);
    expect(retained.startTurnIndex).toBe(10);
    const next = replay(retained, task(20, 1, true), { id: 'run', startedAt: time(20) });
    expect(answers(next)).toEqual(Array.from({ length: 11 }, (_, n) => n + 10));
  });

  it('transfers an active viewer window to the sender without dropping visible history', () => {
    const watching = replay(apply(emptyChatHistory, page(10)), task(19, 1, true));
    const sending = chatHistoryReducer(watching, { type: 'sender-start', run: { id: 'sender', startedAt: time(40) } });
    expect(sending.messages.map((m) => m.content)).toEqual(watching.messages.map((m) => m.content));
    expect(sending.messages.find((m) => m.role === 'user' && m.content === 'Q19-0')?.id).toBe('live-user-19-0');
    expect(sending.runs[0].phase).toBe('active');
    expect(sending.runs[0].messages).toBe(watching.runs[0].messages);
    const next = chatHistoryReducer(sending, { type: 'run-messages', runId: 'sender', update: (messages) => [...messages,
      { id: 'user-next', role: 'user', content: 'Next prompt' },
    ] });
    expect(next.messages.at(-1)?.content).toBe('Next prompt');
    const older = apply(next, { ...page(0, 10), totalTurns: 20 }, 'prepend');
    expect(answers(older)).toEqual(Array.from({ length: 20 }, (_, n) => n));
    expect(older.messages.at(-1)?.content).toBe('Next prompt');
    const settled = chatHistoryReducer(chatHistoryReducer(older, { type: 'run-end', runId: 'sender', writerActive: false }), { type: 'run-end', runId: 'run', writerActive: false });
    expect(apply(settled, page(0, 21), 'incremental').messages.every((m) => !m.liveRunId)).toBe(true);
  });

  it('retains an ended run until the writer settles and a tail read applies', () => {
    const watching = replay(apply(emptyChatHistory, page(10, 19)), task(19, 1, true));
    const pending = chatHistoryReducer(watching, { type: 'run-end', runId: 'run', writerActive: true });
    const interim = apply(pending, page(10, 19), 'incremental');
    expect(answers(interim)).toEqual(Array.from({ length: 10 }, (_, n) => n + 10));
    const settled = chatHistoryReducer(interim, { type: 'run-end', runId: 'run', writerActive: false });
    expect(settled.messages.some((m) => m.liveRunId)).toBe(true);
    const canonical = apply(settled, page(10), 'incremental');
    expect(canonical.messages.every((m) => !m.liveRunId)).toBe(true);
    expect(answers(canonical)).toEqual(Array.from({ length: 10 }, (_, n) => n + 10));
  });

  it('keeps known live coordinates as writes become visible through prefix pages', () => {
    fc.assert(fc.property(fc.integer({ min: 3, max: 30 }), fc.integer({ min: 1, max: 4 }), (total, liveCount) => {
      const window = apply(emptyChatHistory, page(total - 2, total));
      const live = Array.from({ length: liveCount }, (_, i) => task(total + i, 2, true)).flat();
      let state = replay(window, live, { id: 'run', startedAt: time(total) });
      state = apply(state, { ...page(0, total - 2), totalTurns: total + liveCount }, 'prepend');
      expect(state.runs[0].start).toBe(total);
      expect(answers(state)).toEqual(Array.from({ length: total + liveCount }, (_, n) => n));
      state = chatHistoryReducer(state, { type: 'sender-start', run: { id: 'sender', startedAt: time(40) } });
      state = chatHistoryReducer(state, { type: 'run-messages', runId: 'sender', update: (messages) => [...messages,
        { id: 'sender-new', role: 'assistant', content: `A${total + liveCount}` },
      ] });
      state = apply(state, page(0, total + liveCount), 'jump');
      expect(answers(state)).toEqual(Array.from({ length: total + liveCount + 1 }, (_, n) => n));
      state = chatHistoryReducer(state, { type: 'run-end', runId: 'run', writerActive: false });
      state = chatHistoryReducer(state, { type: 'run-end', runId: 'sender', writerActive: false });
      state = apply(state, page(0, total + liveCount + 1), 'incremental');
      expect(answers(state)).toEqual(Array.from({ length: total + liveCount + 1 }, (_, n) => n));
      expect(state.messages.every((m) => !m.liveRunId)).toBe(true);
    }), { numRuns: 200, seed: 20261107 });
  });

  it('falls back to server task counts when old responses omit startTurnIndex', () => {
    const data = page(10, 20, 2); delete data.startTurnIndex;
    expect(apply(emptyChatHistory, data).startTurnIndex).toBe(10);
  });

  it('keeps every generated visible range contiguous, ordered and unique', () => {
    fc.assert(fc.property(
      fc.record({ total: fc.integer({ min: 1, max: 40 }), fraction: fc.nat(100), window: fc.nat(100), extra: fc.integer({ min: 0, max: 3 }), inputs: fc.integer({ min: 0, max: 3 }) }),
      ({ total, fraction, window, extra, inputs }) => {
        const runStart = fraction % (total + 1);
        const diskStart = window % total;
        const liveEnd = total + extra;
        const overlay = Array.from({ length: liveEnd - runStart }, (_, offset) => task(runStart + offset, inputs, true)).flat();
        const disk = apply(emptyChatHistory, page(diskStart, total, inputs));
        const state = replay(disk, overlay, { id: 'run', startedAt: time(runStart) });
        const first = overlay.length > 0 ? Math.min(diskStart, runStart) : diskStart;
        expect(answers(state)).toEqual(Array.from({ length: Math.max(total, liveEnd) - first }, (_, offset) => first + offset));
        expect(state.startTurnIndex).toBe(first);
        expect(state.hasMore).toBe(first > 0);
      },
    ), { numRuns: 250, seed: 20261106 });
  });
});


describe('run handoff before canonical reconciliation', () => {
  it('retains the preceding viewer run until a read after handoff covers it', () => {
    let state = replay(apply(emptyChatHistory, page(10, 19)), task(19, 1, true));
    state = chatHistoryReducer(state, { type: 'run-end', runId: 'run', writerActive: true });
    const nextMessages = task(20, 1, true).map((message) => ({ ...message, liveRunId: 'next' }));
    state = replay(state, nextMessages, { id: 'next', startedAt: time(20) });
    expect(answers(state)).toEqual(Array.from({ length: 11 }, (_, i) => i + 10));
    const stale = chatHistoryReducer(state, { type: 'page', sessionId: 'session', mode: 'incremental', page: page(10, 19) });
    expect(stale.messages.some((message) => message.content === 'Q19-0')).toBe(true);
    state = chatHistoryReducer(state, { type: 'page', sessionId: 'session', mode: 'incremental', page: page(10, 20), reconciles: ['run'] });
    expect(state.runs.some((run) => run.id === 'run')).toBe(false);
    expect(state.messages.filter((message) => message.content === 'Q19-0')).toHaveLength(1);
    expect(state.messages.some((message) => message.content === 'Q20-0')).toBe(true);
  });
});


it('applies an authoritative empty replacement after deletion without retaining old coordinates', () => {
  const loaded = apply(emptyChatHistory, page(10));
  const empty = apply(loaded, { messages: [], totalTurns: 0, startTurnIndex: 0, hasMore: false, replacesWindow: true }, 'incremental');
  expect(empty.messages).toEqual([]);
  expect(empty.diskTurns).toEqual([]);
  expect(empty.totalTurns).toBe(0);
});


it('aligns an adopted later task with its offset inside a multi-task run', () => {
  const state = apply(emptyChatHistory, page(19));
  const messages = [...task(18, 1, true), ...task(19, 1, true).map((row) => row.role === 'user' ? { ...row, id: 'disk-user-19-0' } : row)];
  const result = replay(state, messages, { id: 'run', startedAt: time(18) });
  expect(result.startTurnIndex).toBe(18);
  expect(answers(result)).toEqual([18, 19]);
});

it('only retires a released run for a read started after release, leaving the next run intact', () => {
  let state = apply(emptyChatHistory, page(0, 19));
  const old = { id: 'old', startedAt: time(19) };
  const next = { id: 'next', startedAt: time(20) };
  state = replay(state, task(19, 1, true), old);
  state = chatHistoryReducer(state, { type: 'run-end', runId: old.id, writerActive: true });
  state = chatHistoryReducer(state, { type: 'sender-start', run: next });
  state = chatHistoryReducer(state, { type: 'run-messages', runId: next.id, update: task(20, 1, true) });
  expect(state.runs.find((run) => run.id === old.id)?.phase).toBe('draining');
  state = chatHistoryReducer(state, { type: 'run-accepted', run: next });
  const beforeRead = state;
  state = chatHistoryReducer(state, { type: 'page', sessionId: 'session', mode: 'incremental', page: page(0, 20) });
  expect(state.runs).toHaveLength(2);
  state = chatHistoryReducer(state, { type: 'page', sessionId: 'session', mode: 'incremental', page: page(0, 20), reconciles: [old.id] });
  expect(state.runs.map((run) => run.id)).toEqual([next.id]);
  expect(state.messages.find((row) => row.content === 'A19')?.id).toBe('disk-answer-19');
  expect(state.messages.find((row) => row.content === 'A20')?.id).toBe('live-answer-20');
  const late = chatHistoryReducer(beforeRead, { type: 'run-end', runId: old.id, writerActive: true });
  expect(late.runs.find((run) => run.id === old.id)?.phase).toBe('released');
  expect(late.runs.find((run) => run.id === next.id)?.phase).toBe('active');
});


describe('read stability and first writer observations', () => {
  it('treats a replacement prefix response as a fresh tail while preserving an unrelated sender', () => {
    let state = replay(apply(emptyChatHistory, { ...page(10), stable: false }), task(19, 1, true));
    state = chatHistoryReducer(state, { type: 'run-end', runId: 'run', writerActive: false });
    state = chatHistoryReducer(state, { type: 'sender-start', run: { id: 'next', startedAt: time(20) } });
    const recovered = apply(state, { ...page(10), stable: true, replacesWindow: true }, 'prepend');
    expect(recovered.needsStableRead).toBe(false);
    expect(recovered.runs.map((run) => [run.id, run.phase])).toEqual([['next', 'pending']]);
    expect(recovered.diskTurns).toHaveLength(10);
  });
  it.each([false, true])('reconciles an unobserved writer regardless of idle-first ordering: %s', (idleFirst) => {
    const idle = { type: 'run-end', runId: 'unobserved', writerActive: false } as const;
    let state = idleFirst ? chatHistoryReducer(emptyChatHistory, idle) : emptyChatHistory;
    state = apply(state, { ...page(10), stable: false });
    if (!idleFirst) state = chatHistoryReducer(state, idle);
    expect(state.runs).toEqual([]);
    expect(state.writerIdle).toBe(true);
    expect(state.needsStableRead).toBe(true);
    const stable = apply(state, { ...page(10), stable: true }, 'incremental');
    expect(stable.needsStableRead).toBe(false);
  });
  it('keeps an unstable read pending across cached and prefix-only responses', () => {
    const partial = apply(emptyChatHistory, { ...page(10), stable: false });
    const cached = chatHistoryReducer(partial, { type: 'page', sessionId: 'session', mode: 'replace', fromCache: true, page: { ...page(10), stable: true } });
    expect(cached.needsStableRead).toBe(true);
    const prefix = apply(cached, { ...page(0, 10), totalTurns: 20, stable: true }, 'prepend');
    expect(prefix.needsStableRead).toBe(true);
    expect(apply(prefix, { ...page(0, 20), stable: true }, 'incremental').needsStableRead).toBe(false);
  });
  it('scopes idle observations to the displayed session and preserves newer runs', () => {
    let state = apply(emptyChatHistory, { ...page(10), stable: false });
    state = chatHistoryReducer(state, { type: 'sender-start', run: { id: 'new', startedAt: time(20) } });
    state = chatHistoryReducer(state, { type: 'run-end', runId: 'old', writerActive: false });
    expect(state.writerIdle).toBe(false);
    expect(state.runs[0].phase).toBe('pending');
    expect(chatHistoryReducer(state, { type: 'writer-idle', sessionId: 'other' })).toBe(state);
    const switched = chatHistoryReducer(state, { type: 'page', sessionId: 'other', mode: 'replace', page: { ...page(0, 1), stable: false } });
    expect(switched.writerIdle).toBe(false);
    expect(switched.runs).toEqual([]);
  });
});
