import { chatHistoryReducer, emptyChatHistory } from '../client/chatHistoryState';
import { describe, expect, it } from 'vitest';
import { historyWindow, historyReferences } from './historyWindow';
import { parseCodexTranscriptFile, parseTranscriptFile } from './api/session/transcriptParsers';

describe('source identity independent of later projection updates', () => {
  const codexUser = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const parse = async (rows: unknown[]) => (await parseCodexTranscriptFile({ text: rows.map((row) => JSON.stringify(row)).join('\n') })).messages;

  it('keeps a legacy input addressable when steering changes its task count', async () => {
    const rows = [{ type: 'event_msg', payload: { type: 'task_started' } }, codexUser('Original')];
    const before = await parse(rows);
    const target = historyReferences(before)[0].sourceRef!;
    const after = await parse([...rows, codexUser('Steering')]);
    expect(after[0].turnUserCount).toBe(2);
    expect(historyWindow(after, { target }).targetStatus).toBe('found');
    const boundary = historyWindow(before, { fromTurnIndex: 1 }).beforeProof;
    expect(historyWindow(after, { fromTurnIndex: 1, expectedStartProof: boundary }).replacesWindow).toBe(true);
    expect(historyWindow(after, { target, coordinateEpoch: 'rewritten' }).targetStatus).toBe('stale');
    expect(historyWindow(await parse([rows[0], codexUser('Edited'), codexUser('Steering')]), { target }).targetStatus).toBe('stale');
  });

  it('keeps a legacy input addressable after an earlier tool receives a late result', async () => {
    const rows = [
      { type: 'user', message: { role: 'user', content: 'First' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } },
      { type: 'user', message: { role: 'user', content: 'Second' } },
    ];
    const parseClaude = async (input: unknown[]) => (await parseTranscriptFile({ text: input.map((row) => JSON.stringify(row)).join('\n') })).messages;
    const before = await parseClaude(rows);
    const target = historyReferences(before).find((row) => row.content === 'Second')!.sourceRef!;
    const first = historyWindow(before, { limit: 1 });
    const after = await parseClaude([...rows, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Late result' }] } }]);
    expect(after.find((row) => row.toolCalls?.length)?.toolCalls?.[0].result).toBe('Late result');
    expect(historyWindow(after, { target }).targetStatus).toBe('found');
    expect(historyWindow(after, { limit: 1, beforeTurnIndex: 1, expectedBeforeProof: first.beforeProof }).replacesWindow).toBe(true);
    const edited = await parseClaude([rows[0], { ...rows[1], message: { role: 'assistant', content: [{ type: 'text', text: 'Changed source' }] } }, rows[2]]);
    expect(historyWindow(edited, { target }).targetStatus).toBe('stale');
  });
});

async function messages(count = 20, removed = -1, native = true) {
  return (await parseCodexTranscriptFile({ text: Array.from({ length: count }, (_, i) => i === removed ? [] : [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: `task-${i}` } },
    { type: 'response_item', payload: { type: 'message', ...(native ? { id: `input-${i}` } : {}), role: 'user', content: [{ type: 'input_text', text: 'Again' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `A${i}` }] } },
  ]).flat().map((row) => JSON.stringify(row)).join('\n') })).messages;
}

describe('source-coordinate proofs and message references', () => {
  it('keeps ordinary paging incremental across appends', async () => {
    const first = historyWindow(await messages(), { limit: 10 });
    const older = historyWindow(await messages(21), { beforeTurnIndex: 10, limit: 10, expectedBeforeProof: first.beforeProof });
    expect(older.replacesWindow).toBe(false);
    expect(older.messages).toHaveLength(20);
    expect(older.totalTurns).toBe(21);
  });
  it('rebuilds after prefix deletion and preserves the last task', async () => {
    const original = await messages();
    const first = historyWindow(original, { limit: 10 });
    const changed = original.filter((row) => row.sourceTaskId !== 'task-5');
    const older = historyWindow(changed, { limit: 10, beforeTurnIndex: 10, expectedBeforeProof: first.beforeProof });
    expect(older.replacesWindow).toBe(true);
    expect(older.totalTurns).toBe(19);
    expect(older.messages.at(-1)?.content).toBe('A19');
    expect(older.messages.filter((row) => row.role === 'user')).toHaveLength(10);
  });
  it('detects same-length prefix rewrites', async () => {
    const original = await messages();
    const first = historyWindow(original, { limit: 10 });
    const changed = original.map((row, i) => i === 0 ? { ...row, content: 'Edited' } : row);
    expect(historyWindow(changed, { limit: 10, beforeTurnIndex: 10, expectedBeforeProof: first.beforeProof }).replacesWindow).toBe(true);
  });
  it('invalidates coordinates when a managed rewrite preserves identical contents', async () => {
    const rows = await messages();
    const before = historyWindow(rows, { limit: 10, coordinateEpoch: 'original' });
    const after = historyWindow(rows, { limit: 10, beforeTurnIndex: 10, expectedBeforeProof: before.beforeProof, coordinateEpoch: 'rewritten' });
    expect(after.replacesWindow).toBe(true);
  });
  it.each(['prepend', 'incremental'] as const)('bounds %s recovery after an epoch change and resumes ordinary paging', async (mode) => {
    const rows = await messages(1000);
    const first = historyWindow(rows, { limit: 10, coordinateEpoch: 'old-process' });
    const loaded = chatHistoryReducer(emptyChatHistory, { type: 'page', sessionId: 's', mode: 'replace', page: first });
    const recovered = historyWindow(rows, {
      limit: 10, coordinateEpoch: 'new-process',
      ...(mode === 'prepend' ? { beforeTurnIndex: 990, expectedBeforeProof: first.beforeProof }
        : { fromTurnIndex: 990, expectedStartProof: first.beforeProof }),
    });
    expect(recovered.replacesWindow).toBe(true);
    expect(recovered.startTurnIndex).toBe(990);
    expect(recovered.messages.filter((row) => row.role === 'user')).toHaveLength(10);
    const state = chatHistoryReducer(loaded, { type: 'page', sessionId: 's', mode, endTurnIndex: mode === 'prepend' ? 990 : undefined, page: recovered });
    expect(state.diskTurns).toHaveLength(10);
    const older = historyWindow(rows, { limit: 10, coordinateEpoch: 'new-process', beforeTurnIndex: state.diskCursor!.index, expectedBeforeProof: state.diskCursor!.proof });
    expect(older.replacesWindow).toBe(false);
    expect(older.startTurnIndex).toBe(980);
    expect(older.messages.filter((row) => row.role === 'user')).toHaveLength(10);
  });
  it('resolves native identity after IDs and coordinates have changed', async () => {
    const original = await messages();
    const target = historyReferences(original).find((row) => row.sourceId === 'input-15')!.sourceRef!;
    const changed = original.filter((row) => row.sourceTaskId !== 'task-5').map((row, i) => ({ ...row, id: `renumbered-${i}` }));
    const result = historyWindow(changed, { fromTurnIndex: 15, target });
    expect(result.targetStatus).toBe('found');
    expect(result.messages[0].sourceId).toBe('input-15');
    expect(result.resolvedMessageId).toBe(result.messages[0].id);
  });
  it('does not recover stale ordinal-ID tails after a jump across a deletion', async () => {
    const initial = historyWindow(await messages(), { limit: 10 });
    const loaded = chatHistoryReducer(emptyChatHistory, { type: 'page', sessionId: 'session', mode: 'replace', page: initial });
    const fresh = historyWindow(await messages(20, 5), { fromTurnIndex: 0 });
    const jumped = chatHistoryReducer(loaded, { type: 'page', sessionId: 'session', mode: 'jump', page: fresh });
    expect(jumped.messages.filter((row) => row.sourceId === 'input-19')).toHaveLength(1);
    expect(jumped.messages).toHaveLength(38);
  });
  it('rejects deleted and ambiguous legacy targets without matching repeated text', async () => {
    const original = await messages(20, -1, false);
    const target = historyReferences(original)[20].sourceRef!;
    const changed = await messages(20, 5, false);
    expect(historyWindow(changed, { target }).targetStatus).toBe('stale');
    const native = historyReferences(await messages())[20].sourceRef!;
    expect(historyWindow((await messages()).filter((row) => row.sourceId !== native.sourceId), { target: native }).targetStatus).toBe('missing');
  });
});

it('keeps legacy references stable across independent parses including assistant and system rows', async () => {
  const { parseTranscriptFile } = await import('./api/session/transcriptParsers');
  const source = { text: [
    { type: 'user', message: { role: 'user', content: 'First' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'Context changed' } },
    { type: 'user', message: { role: 'user', content: 'Again' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } },
  ].map((row) => JSON.stringify(row)).join('\n') };
  const first = historyWindow((await parseTranscriptFile(source)).messages, { limit: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const again = (await parseTranscriptFile(source)).messages;
  const older = historyWindow(again, { limit: 1, beforeTurnIndex: first.startTurnIndex, expectedBeforeProof: first.beforeProof });
  expect(older.replacesWindow).toBe(false);
  const target = first.messages.find((message) => message.role === 'user')!.sourceRef!;
  expect(historyWindow(again, { target }).targetStatus).toBe('found');
  expect(new Set(again.map((message) => message.id)).size).toBe(again.length);
});

it('retains distinct same-text inputs and deduplicates only a repeated native record', async () => {
  const { parseTranscriptFile } = await import('./api/session/transcriptParsers');
  const first = { type: 'user', uuid: 'first', timestamp: '2026-11-07T00:00:00.000Z', message: { role: 'user', content: 'Again' } };
  const second = { ...first, uuid: 'second', timestamp: '2026-11-07T00:00:00.100Z' };
  const parsed = await parseTranscriptFile({ text: [first, second, second].map((row) => JSON.stringify(row)).join('\n') });
  expect(parsed.messages.filter((message) => message.role === 'user').map((message) => message.sourceId)).toEqual(['first', 'second']);
});

it('applies an actual empty source at boundary zero without needing a replacement flag', async () => {
  const populated = historyWindow(await messages(2), {});
  const loaded = chatHistoryReducer(emptyChatHistory, { type: 'page', sessionId: 'session', mode: 'replace', page: populated });
  const empty = historyWindow([], { fromTurnIndex: 0, expectedStartProof: populated.beforeProof });
  expect(empty.replacesWindow).toBe(false);
  const cleared = chatHistoryReducer(loaded, { type: 'page', sessionId: 'session', mode: 'incremental', page: { ...empty, stable: true } });
  expect(cleared.messages).toEqual([]);
  expect(cleared.totalTurns).toBe(0);
});


it('keeps a disk cursor paired with its proof when replay extends the visible window', async () => {
  const { parseTranscriptFile } = await import('./api/session/transcriptParsers');
  const origin = 1700000000000;
  const rows = Array.from({ length: 100 }, (_, index) => [
    { type: 'user', uuid: `user-${index}`, timestamp: new Date(origin + index * 1000).toISOString(), message: { role: 'user', content: `Q${index}` } },
    { type: 'assistant', uuid: `answer-${index}`, timestamp: new Date(origin + index * 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `A${index}` }] } },
  ]).flat();
  const disk = (await parseTranscriptFile({ text: rows.map((row) => JSON.stringify(row)).join('\n') })).messages;
  const first = historyWindow(disk, { limit: 10 });
  let state = chatHistoryReducer(emptyChatHistory, { type: 'page', sessionId: 's', mode: 'replace', page: first });
  state = chatHistoryReducer(state, { type: 'replay-start', run: { id: 'run', startedAt: origin + 89000 } });
  state = chatHistoryReducer(state, { type: 'run-messages', runId: 'run', update: disk.slice(178).map((row) => ({ ...row, id: `live-${row.id}` })) });
  expect(state.startTurnIndex).toBe(89);
  expect(state.diskCursor).toEqual({ index: 90, proof: first.beforeProof });
  const older = historyWindow(disk, { limit: 10, beforeTurnIndex: state.diskCursor!.index, expectedBeforeProof: state.diskCursor!.proof });
  expect(older.replacesWindow).toBe(false);
  expect(older.startTurnIndex).toBe(80);
  expect(older.messages.filter((row) => row.role === 'user')).toHaveLength(10);
  const merged = chatHistoryReducer(state, { type: 'page', sessionId: 's', mode: 'prepend', endTurnIndex: 90, page: older });
  expect(merged.startTurnIndex).toBe(80);
  expect(merged.messages.filter((row) => row.role === 'user')).toHaveLength(20);
  expect(merged.diskCursor).toEqual({ index: 80, proof: older.beforeProof });
});
