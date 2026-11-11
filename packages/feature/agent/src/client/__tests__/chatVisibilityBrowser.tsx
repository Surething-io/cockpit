import React, { act as reactAct, useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useChatHistory } from '../useChatHistory';
import { useMessageSnapshotChanges } from '../useMessageSnapshotChanges';
import type { ChatMessage, ToolCallInfo } from '../types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const histories = new Map<string, ReturnType<typeof useChatHistory>>();
const requests: Array<{ sessionId: string; ifFingerprint?: string }> = [];
const snapshots: string[] = [];
const modes = new Map<string, 'empty' | 'hold' | 'fail'>();
const snapshotModes = new Map<string, 'empty' | 'hold'>();
const heldReads = new Map<string, () => void>();
const heldSnapshots = new Map<string, AbortSignal>();
const completedRuns = new Set<string>();
const mounted = new Map<string, number>();
const ids = Array.from({ length: 23 }, (_, index) => `visibility-${index}`);
const count = (id: string) => requests.filter((request) => request.sessionId === id).length;
const snapshotCount = (id: string) => snapshots.filter((sessionId) => sessionId === id).length;
const stamp = (time: number) => new Date(time).toISOString();
const row = (id: string, role: 'user' | 'assistant', content: string, time: number): ChatMessage => ({ id, role, content, timestamp: stamp(time) });
function diskMessages(id: string): ChatMessage[] {
  if (id === ids[5]) return [];
  return [row(`${id}-user`, 'user', 'Original prompt', 1000), row(`${id}-answer`, 'assistant', 'Original answer', 1001),
    ...(completedRuns.has(id) ? [row(`${id}-new-user`, 'user', 'Background prompt', 3000), row(`${id}-new-answer`, 'assistant', 'Background answer', 3001)] : [])];
}
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('/api/snapshots?')) {
    const id = new URL(String(url), 'http://test').searchParams.get('sessionKey')!;
    snapshots.push(id);
    if (snapshotModes.get(id) === 'hold') {
      heldSnapshots.set(id, init!.signal!);
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('Probe cancelled')), { once: true }));
    }
    return Response.json({ commits: snapshotModes.get(id) === 'empty' ? [] : [{ hash: 'snapshot', toolId: `${id}-tool` }] });
  }
  const body = JSON.parse(String(init?.body));
  requests.push(body);
  if (modes.get(body.sessionId) === 'fail') return new Response('', { status: 404 });
  const fingerprint = `${body.sessionId}-${completedRuns.has(body.sessionId) ? 2 : 1}`;
  const messages = diskMessages(body.sessionId);
  const response = Response.json(body.ifFingerprint === fingerprint ? { notModified: true, stable: true, fingerprint }
    : { messages, sessionId: body.sessionId, fingerprint, stable: true, totalTurns: messages.length / 2, startTurnIndex: 0, hasMore: false });
  if (modes.get(body.sessionId) === 'hold') return new Promise<Response>((resolve) => heldReads.set(body.sessionId, () => resolve(response)));
  return response;
};

function Conversation({ id, visible }: { id: string; visible: boolean }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const history = useChatHistory(sessionId, { cwd: '/visibility-test', initialSessionId: id, onSessionId: setSessionId, enabled: visible });
  const tools = useMemo<ToolCallInfo[]>(() => [{ id: `${id}-tool`, name: 'Bash', input: { command: 'touch output.txt' } }], [id]);
  const changed = useMessageSnapshotChanges('/visibility-test', id, tools, visible && history.loadedSessionId === id);
  useLayoutEffect(() => { histories.set(id, history); });
  useLayoutEffect(() => { mounted.set(id, (mounted.get(id) ?? 0) + 1); }, [id]);
  return <section hidden={!visible} data-session={id} data-changed={changed}>{history.messages.map((message) => <p key={message.id}>{message.content}</p>)}</section>;
}
const root = createRoot(document.getElementById('root')!);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function act(work: () => unknown | Promise<unknown>) {
  await reactAct(async () => { await work(); await pause(25); });
}
async function show(visible: string[]) {
  await act(() => root.render(<>{ids.map((id) => <Conversation key={id} id={id} visible={visible.includes(id)} />)}</>));
  await act(() => pause(30));
}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const results: Record<string, string> = {};
async function scenario(name: string, run: () => Promise<void>) {
  document.body.dataset.scenario = name;
  try { await run(); results[name] = 'PASS'; } catch (error) { results[name] = String(error); }
}
async function main() {
  await scenario('restore-23-loads-only-visible', async () => {
    await show([ids[0]]);
    check(requests.length === 1 && count(ids[0]) === 1, 'Only the selected session may load history');
    check(snapshots.length === 1 && snapshotCount(ids[0]) === 1, 'Only its message may probe snapshots');
    check(mounted.size === 23, 'All conversations must remain mounted');
  });
  await scenario('first-visit-once-and-hidden-retries-stop', async () => {
    snapshotModes.set(ids[1], 'empty');
    await show([ids[1]]);
    check(count(ids[1]) === 1 && snapshotCount(ids[1]) === 1, 'First visit must issue one initial read and one snapshot probe');
    await show([]);
    await act(() => pause(2100));
    check(snapshotCount(ids[1]) === 1, 'Hidden messages must stop their pending retries');
  });
  await scenario('revisit-retains-content-and-confirmed-snapshot', async () => {
    await show([ids[0]]);
    check(count(ids[0]) === 2 && !!requests.at(-1)?.ifFingerprint, 'Revisit must use one incremental validation');
    check(snapshotCount(ids[0]) === 1, 'A confirmed snapshot must not be queried again');
    check(histories.get(ids[0])!.messages.some((message) => message.content === 'Original answer'), 'Retain the loaded conversation');
  });
  await scenario('split-loads-both-and-hiding-project-starts-no-reads', async () => {
    await show([ids[0], ids[3]]);
    check(count(ids[3]) === 1 && count(ids[0]) === 2, 'Adding the other pane must load only that pane');
    const before = requests.length;
    await show([]);
    check(requests.length === before, 'Hiding the Agent panel or project must start no disk reads');
  });
  await scenario('inflight-read-survives-switch-without-hidden-snapshots', async () => {
    modes.set(ids[2], 'hold');
    await show([ids[2]]);
    check(heldReads.has(ids[2]), 'The first visible read must start');
    await show([ids[4]]);
    modes.delete(ids[2]);
    await act(() => heldReads.get(ids[2])!());
    check(histories.get(ids[2])!.loadedSessionId === ids[2], 'An admitted read can finish into its own retained state');
    check(snapshotCount(ids[2]) === 0 && count(ids[4]) === 1, 'The hidden result must not fan out into snapshot requests');
  });
  await scenario('empty-history-is-initialized', async () => {
    await show([ids[5]]); await show([]); await show([ids[5]]);
    check(count(ids[5]) === 2 && !!requests.at(-1)?.ifFingerprint, 'An empty response must be revisited as initialized history');
  });
  await scenario('hidden-completion-retains-live-copy-and-reconciles-on-return', async () => {
    const history = histories.get(ids[2])!;
    const before = count(ids[2]);
    await act(() => {
      history.onSenderStart({ id: 'background-run', startedAt: 2000 });
      history.onRunAccepted({ id: 'background-run', startedAt: 2000 });
      history.setRunMessages('background-run', [
        { ...row('live-user', 'user', 'Background prompt', 3000), sourceId: `${ids[2]}-new-user` },
        { ...row('live-answer', 'assistant', 'Background answer', 3001), sourceId: `${ids[2]}-new-answer` },
      ]);
      history.onLiveRunEnd(false, 'background-run');
    });
    check(count(ids[2]) === before, 'Hidden completion must defer disk reconciliation');
    check(histories.get(ids[2])!.messages.some((message) => message.id === 'live-answer'), 'The live copy must survive until a stable read replaces it');
    completedRuns.add(ids[2]);
    await show([ids[2]]);
    check(count(ids[2]) === before + 1, 'One return read must satisfy the released run and activation');
    check(histories.get(ids[2])!.messages.filter((message) => message.content === 'Background answer').length === 1, 'Completion must render once');
    check(!histories.get(ids[2])!.messages.some((message) => message.id === 'live-answer'), 'Stable disk output must retire the live copy');
  });
  await scenario('failed-first-visit-retries-on-next-visit', async () => {
    modes.set(ids[6], 'fail'); await show([ids[6]]); await show([]);
    check(count(ids[6]) === 1 && !histories.get(ids[6])!.loadedSessionId, 'A failed read must not mark the session initialized or poll');
    modes.delete(ids[6]); await show([ids[6]]);
    check(count(ids[6]) === 2 && histories.get(ids[6])!.loadedSessionId === ids[6], 'The next visit must recover');
  });
  await scenario('return-during-old-read-validates-after-it-settles', async () => {
    modes.set(ids[10], 'hold'); await show([ids[10]]);
    await show([ids[4]]); await show([ids[10]]);
    check(count(ids[10]) === 1, 'Returning must not race an outstanding first read');
    completedRuns.add(ids[10]); modes.delete(ids[10]);
    await act(() => heldReads.get(ids[10])!());
    await act(() => pause(30));
    check(count(ids[10]) === 2, 'A return visit must validate after the old response settles');
    check(histories.get(ids[10])!.messages.some((message) => message.content === 'Background answer'), 'Work completed while hidden must appear');
  });
  await scenario('hiding-aborts-inflight-snapshot', async () => {
    snapshotModes.set(ids[8], 'hold');
    await show([ids[8]]);
    check(heldSnapshots.has(ids[8]), 'Snapshot lookup must be in flight');
    const signal = heldSnapshots.get(ids[8])!;
    await show([]);
    check(signal.aborted, 'Hiding must abort the snapshot HTTP request');
  });
  await scenario('visible-snapshot-retries-are-bounded', async () => {
    snapshotModes.set(ids[9], 'empty');
    await show([ids[9]]);
    await act(() => pause(4250));
    check(snapshotCount(ids[9]) === 3, 'An uncommitted tool may receive only two delayed retries');
    await act(() => pause(2100));
    check(snapshotCount(ids[9]) === 3, 'A missing snapshot must not poll indefinitely');
  });
  check([...mounted.values()].every((mounts) => mounts === 1), 'Visibility changes must never remount conversations');
  await act(() => root.unmount());
  document.getElementById('result')!.textContent = JSON.stringify(results);
}
void main().catch((error) => { document.getElementById('result')!.textContent = JSON.stringify({ fatal: String(error) }); });
