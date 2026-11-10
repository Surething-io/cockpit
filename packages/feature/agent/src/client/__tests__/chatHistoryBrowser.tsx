import React, { act as reactAct, StrictMode, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useChatHistory } from '../useChatHistory';
import { useLiveStream } from '../useLiveStream';
import { useChatStream } from '../useChatStream';
import { MessageList, type MessageListHandle } from '../MessageList';
import { UserMessagesModal } from '../UserMessagesModal';
import { useMessageNavigation } from '../useMessageNavigation';
import { removeMessageTurn } from '../../shared/chatTurns';
import type { HistoryPage } from '../chatHistoryState';
import { deliverSessionMessage, sessionSubscriberCount } from './chatHistoryTransport';

interface Fixture {
  engine: 'codex' | 'claude' | 'ollama';
  version: string;
  full: HistoryPage;
  first: HistoryPage;
}
declare const __STOPPED_RUN__: {
  frames: Array<{ type: string; message: Record<string, unknown> }>;
  beforeSettlement: number;
  snapshot: Record<string, unknown>;
  successor: Record<string, unknown>;
  image: { data: string };
};
function stoppedRun(id: string, nextId = 'successor-browser-run'): typeof __STOPPED_RUN__ {
  return JSON.parse(JSON.stringify(__STOPPED_RUN__).replaceAll('stopped-browser-run', id).replaceAll('successor-browser-run', nextId));
}
declare const __CLAUDE_RECOVERY_EVENTS__: Array<Record<string, unknown>>;
declare const __HISTORY_FIXTURES__: Record<string, Fixture>;
declare const __WRITER_LIFECYCLE__: Record<string, { type: string; message: Record<string, unknown> }>;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const fixtures = __HISTORY_FIXTURES__;
declare const __HISTORY_ENDPOINT__: string;
const nativeFetch = globalThis.fetch.bind(globalThis);
const transportReads = new Set<Promise<unknown>>();
async function act(work: () => unknown | Promise<unknown>) {
  await reactAct(async () => { await work(); });
  while (transportReads.size) await reactAct(async () => { await Promise.all([...transportReads]); });
}
async function waitForNavigation(settled: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!settled()) {
    check(performance.now() < deadline, `Navigation did not finish: ${document.body.dataset.scenario}`);
    // Keep flushing React while waiting for the browser's viewport acknowledgement.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 16)));
  }
}
async function readWindow(request: object, index = false): Promise<object> {
  const reading = nativeFetch(__HISTORY_ENDPOINT__, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fixture: Object.keys(fixtures).find((key) => fixtures[key] === fixture), request, index }),
  }).then((response) => response.json());
  transportReads.add(reading);
  try { return await reading; } finally { transportReads.delete(reading); }
}
const startedAt = Date.parse('2026-11-06T00:00:00Z');
const onSessionId = () => {};
let current: ReturnType<typeof useChatHistory>;
let sender: ReturnType<typeof useChatStream>;
let viewerEnabled = true;
let realList = false;
let realModal = false;
let navigationActive = true;
let scrolls: { id: string; text: string | null }[] = [];
let selections: string[] = [];
let holdSend = false;
let rejectSend = false;
let hydrateSession = false;
let loadOnMount = true;
let selectSession: (id: string) => void;
let failRead = false;
let sendRelease: (() => void) | undefined;
let navigate: ReturnType<typeof useMessageNavigation>;
let senderRunId = '';
let root: Root | undefined;
let sid = '';
let fixture = fixtures.ordinary20;
let requests: Record<string, number | string>[] = [];
let requestSignals: (AbortSignal | null | undefined)[] = [];
let provisionalKeys = false;
let holdInitial = false;
let holdBefore = false;
let holdJump = false;
let jumpReleases: (() => void)[] = [];
let beforeReleases: (() => void)[] = [];
let completionLimit: number | undefined = 10;
let notModified = false;
let validationStable = true;
let emptyResponse = false;
let legacyResponse = false;
let releases: (() => void)[] = [];

globalThis.fetch = async (_url, options) => {
  if (String(_url).startsWith('/api/chat')) {
    const body = JSON.parse(String(options?.body));
    if (String(_url) === '/api/chat/stop') return { ok: true, json: async () => ({ ok: true }) } as Response;
    if (body.runId && String(_url) !== '/api/chat/stop') senderRunId = body.runId;
    if (holdSend && String(_url) !== '/api/chat/stop') await new Promise<void>((resolve) => { sendRelease = resolve; });
    if (rejectSend) return { ok: false, json: async () => ({ error: 'Admission rejected' }) } as Response;
    return { ok: true, json: async () => ({ runKey: provisionalKeys ? body.runId : 'new-sender-run', startedAt: startedAt + (Number(String(body.prompt).match(/^Q(\d+)/)?.[1] ?? 20) - 19) * 1000 }) } as Response;
  }
  if (String(_url).includes('/user-messages')) return { ok: true, json: async () => readWindow({}, true) } as Response;
  const body = options?.body ? JSON.parse(String(options.body)) as Record<string, number | string> : {};
  requests.push(body);
  requestSignals.push(options?.signal);
  let data: object;
  if (!options?.body) data = { messages: fixture.full.messages };
  else if (notModified && body.ifFingerprint === `${sid}-${fixture.version}`) data = { notModified: true, stable: validationStable, fingerprint: `${sid}-${fixture.version}` };
  else if (emptyResponse) data = { messages: [], totalTurns: 0, startTurnIndex: 0, hasMore: false, stable: false, fingerprint: `${sid}-${fixture.version}` };
  else {
    const source = { sessionId: sid, engine: fixture.engine, fingerprint: `${sid}-${fixture.version}` };
    const page = await readWindow(body);
    data = { ...page, stable: true, ...source };
    if (legacyResponse) delete (data as Partial<HistoryPage>).startTurnIndex;
  }
  const response = { ok: !failRead, json: async () => data } as Response;
  if (holdInitial && body.fromTurnIndex === undefined && body.beforeTurnIndex === undefined) {
    return new Promise<Response>((resolve) => { releases.push(() => resolve(response)); });
  }
  if (holdJump && body.fromTurnIndex !== undefined) return new Promise<Response>((resolve) => { jumpReleases.push(() => resolve(response)); });
  if (holdBefore && body.beforeTurnIndex !== undefined) return new Promise<Response>((resolve) => { beforeReleases.push(() => resolve(response)); });
  return response;
};

function Harness() {
  const [modalOpen, setModalOpen] = React.useState(realModal);
  const list = useRef<MessageListHandle>(null);
  const scroll = React.useCallback((id: string) => {
    scrolls.push({ id, text: document.querySelector(`[data-message-id="${id}"]`)?.textContent ?? null });
    return list.current?.scrollToMessage(id) ?? false;
  }, []);
  const [sessionId, setSessionId] = React.useState<string | null>(hydrateSession ? null : sid);
  const history = useChatHistory(sessionId, { cwd: '/isolated-history-test', initialSessionId: loadOnMount ? sid : undefined, onSessionId: setSessionId, reconcileLimit: completionLimit ?? null });
  const stream = useChatStream(history.messages, history.setRunMessages, {
    sessionId: provisionalKeys ? sessionId : sid, cwd: '/isolated-history-test', engine: fixture.engine,
    onSessionId: provisionalKeys ? setSessionId : onSessionId, onFetchTitle: onSessionId, onSendStart: history.onSenderStart, onRunAccepted: history.onRunAccepted, onSendFailure: history.onSendFailure, onInputRejected: history.onInputRejected,
    onRunEnd: history.onLiveRunEnd,
    onRecoveryDeleted: history.onRecoveryDeleted,
  });
  useLiveStream(sid, history.setRunMessages, viewerEnabled && !stream.isLoading, fixture.engine, {
    onSnapshotStart: history.onLiveSnapshotStart,
    onWriterIdle: history.onWriterIdle,

    onRunEnd: history.onLiveRunEnd,
    onRecoveryDeleted: history.onRecoveryDeleted,
  });
  const jump = useMessageNavigation(`${history.loadedSessionId ?? sessionId}`, history.messages, navigationActive, history.ensureTurnLoaded, scroll, history.cancelTurnLoad);
  useLayoutEffect(() => {
    selectSession = setSessionId;
    navigate = jump;
    current = history; sender = stream;
  }, [history, stream]);
  const closeModal = React.useCallback(() => { jump.cancel(); setModalOpen(false); }, [jump]);
  const select = React.useCallback(async (entry: Parameters<typeof jump>[0]) => {
    const result = await jump(entry); selections.push(result.status); return result;
  }, [jump]);
  if (realList) return <>{stream.drainingSubscriptions}<UserMessagesModal isOpen={modalOpen} onClose={closeModal} cwd="/isolated-history-test" sessionId={sid} onSelectMessage={select} /><div style={{ height: 300, width: 600, display: "flex", flexDirection: "column" }}><MessageList ref={list} messages={history.messages} recoveryCopies={history.recoveryCopies} /></div></>;
  return <main>{stream.drainingSubscriptions}{history.messages.map((message, i) => <div key={i}>{message.content}</div>)}</main>;
}

function snapshot(steering = false, question = 19) {
  return {
    type: 'run-snapshot', status: 'running', runId: 'run', startedAt,
    events: [
      { type: 'user', _human: true, _turnId: 'run', _ts: startedAt, message: { content: `Q${question}` } },
      { type: 'system', subtype: 'init', _ts: startedAt },
      ...(steering ? [{ type: 'user', _human: true, _turnId: 'steering', _ts: startedAt + 1, message: { content: 'steering' } }] : []),
    ],
  };
}

function writerFrame(type: 'run-ended' | 'run-settled', runId = 'run') {
  const frame = __WRITER_LIFECYCLE__[type];
  return { ...frame, message: { ...frame.message, runId } };
}
async function finishRun(wire?: string) {
  await act(async () => {
    const runId = wire ? senderRunId : 'run';
    deliverSessionMessage(writerFrame('run-ended', runId), wire);
    deliverSessionMessage(writerFrame('run-settled', runId), wire);
  });
}

async function mount(name: string, data = fixtures.steering20) {
  sid = name;
  fixture = data;
  requests = [];
  requestSignals = [];
  root = createRoot(document.getElementById('root')!);
  await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
}
async function more() { await act(async () => current.loadMoreHistory()); }
async function loadAll() {
  for (let round = 0; current.hasMoreHistory; round++) {
    check(round < 8, 'History paging did not converge');
    await more();
  }
}
async function refresh(incremental = true) {
  await act(async () => current.loadHistoryByCwdAndSessionId('/isolated-history-test', sid, incremental, 10, undefined, true));
}
function check(value: unknown, message: string) { if (!value) throw new Error(message); }
function allAnswers(count: number) {
  const answers = current.messages.filter((m) => /^A\d+$/.test(m.content)).map((m) => Number(m.content.slice(1)));
  return answers.length === count && answers.every((n, i) => n === i);
}

const results: Record<string, string> = {};
async function run(name: string, test: () => Promise<void>) {
  document.body.dataset.scenario = name;
  provisionalKeys = false;
  viewerEnabled = true;
  rejectSend = hydrateSession = failRead = false;
  loadOnMount = true;
  realList = false; realModal = false; selections = []; holdSend = false; sendRelease = undefined;
  navigationActive = true; scrolls = [];
  holdJump = false; jumpReleases = [];
  holdInitial = holdBefore = notModified = emptyResponse = legacyResponse = false;
  validationStable = true;
  beforeReleases = [];
  completionLimit = 10;
  releases = [];
  try { await test(); results[name] = 'PASS'; }
  catch (error) { results[name] = error instanceof Error ? error.stack ?? error.message : String(error); }
  finally { if (root) await act(async () => root!.unmount()); root = undefined; }
}

async function main() {
  await run('inflight-page-preserves-live-tool-update', async () => {
    await mount('inflight-page-preserves-live-tool-update', fixtures.toolBefore);
    await act(() => deliverSessionMessage({ type: 'run-snapshot', status: 'running', writerActive: true,
      runId: 'new-run', startedAt: startedAt + 100000, events: [
        { type: 'user', _human: true, _turnId: 'new-run', message: { content: 'Next task' } },
        { type: 'system', subtype: 'init' },
      ] }));
    holdJump = true; validationStable = false;
    let reading!: Promise<void>;
    await act(() => { reading = current.loadHistoryByCwdAndSessionId('/isolated-history-test', sid, true, 10, undefined, true); });
    await act(() => deliverSessionMessage({ type: 'run-event', message: { type: 'user', message: {
      content: [{ type: 'tool_result', tool_use_id: 'spawn', content: 'Newest live result' }],
    } } }));
    const tool = () => current.messages.flatMap(row => row.toolCalls ?? []).find(tool => tool.id === 'spawn');
    check(tool()?.result === 'Newest live result', 'The live tool result must reach the visible history');
    await act(async () => { jumpReleases.shift()!(); await reading; });
    check(tool()?.result === 'Newest live result', 'An older page must retain the latest tool state');
  });
  for (const delivery of ['live', 'snapshot', 'idle', 'switch']) await run(`new-session-stop-resend-${delivery}`, async () => {
    provisionalKeys = true; loadOnMount = false; hydrateSession = true;
    await mount(`new-session-stop-resend-${delivery}`, fixtures.piQueued);
    await act(() => sender.handleSend('First startup input'));
    const first = senderRunId;
    const firstWire = `/ws/session-stream?sessionId=${first}`;
    const firstInput = { type: 'user', _human: true, _turnId: first, message: { content: 'First startup input' } };
    await act(() => deliverSessionMessage({ type: 'run-snapshot', status: 'running', writerActive: true,
      runId: first, startedAt, events: [firstInput] }, firstWire));
    await act(() => sender.handleStop());
    await act(() => sender.handleSend('Second startup input'));
    const second = senderRunId;
    const secondWire = `/ws/session-stream?sessionId=${second}`;
    if (delivery === 'switch' || delivery === 'idle') {
      check(sessionSubscriberCount(firstWire) === 1, 'The stopped writer must retain a settlement subscription');
      if (delivery === 'switch') await act(() => selectSession('another-session'));
      else await act(() => deliverSessionMessage({ type: 'run-idle' }, firstWire));
      check(sessionSubscriberCount(firstWire) === 0, 'Leaving the view or observing idle must release the subscription');
      check(sender.isLoading, 'Old subscription cleanup must not stop the new sender');
      return;
    }
    const initSecond = () => act(() => deliverSessionMessage({ type: 'run-snapshot', status: 'running', writerActive: true,
      runId: second, startedAt: startedAt + 1000, events: [
        { type: 'user', _human: true, _turnId: second, message: { content: 'Second startup input' } },
        { type: 'system', subtype: 'init', session_id: sid },
      ] }, secondWire));
    const failure = { type: 'error', error: 'Input cancelled', undeliveredInputs: [{ inputId: first, text: 'First startup input' }] };
    if (delivery === 'snapshot') {
      // The successor rekeys this view before the old subscription reconnects.
      await initSecond();
      await act(() => deliverSessionMessage({ type: 'run-snapshot', status: 'error', writerActive: false,
        runId: first, startedAt, events: [firstInput, failure] }, firstWire));
    } else {
      await act(() => deliverSessionMessage({ type: 'run-snapshot', status: 'idle', writerActive: true,
        runId: first, startedAt, events: [firstInput] }, firstWire));
      await act(() => deliverSessionMessage({ type: 'run-event', message: failure }, firstWire));
      await act(() => deliverSessionMessage({ type: 'run-event', message: { type: 'run-settled', runId: first, status: 'error' } }, firstWire));
    }
    check(sender.isLoading, 'Old settlement must not stop the new sender');
    check(sessionSubscriberCount(firstWire) === 0, 'A settled writer must release its retained subscription');
    if (delivery === 'live') await initSecond();
    await act(() => deliverSessionMessage({ type: 'run-event', message: { type: 'run-settled', status: 'idle', runId: second } }, secondWire));
    await refresh(false);
    check(!current.messages.some(row => row.content === 'First startup input'), 'Successor history removed the first input');
    check(current.recoveryCopies.some(copy => copy.messages.some(row => row.content === 'First startup input')), 'Old-key recovery must be retained');
  });

  for (const actor of ['sender', 'viewer']) for (const delivery of ['live', 'snapshot']) {
    await run(`codex-unconfirmed-delete-${actor}-${delivery}`, async () => {
      await mount(`codex-unconfirmed-delete-${actor}-${delivery}`, fixtures.ordinary20);
      if (actor === 'sender') await act(() => sender.handleSend('Q19'));
      const id = actor === 'sender' ? senderRunId : 'run';
      const wire = actor === 'sender' ? '/ws/session-stream?sessionId=new-sender-run' : undefined;
      const image = __STOPPED_RUN__.image;
      const events = [
        { type: 'user', _human: true, _turnId: id, message: { content: 'Q19' } },
        { type: 'system', subtype: 'init' },
        { type: 'user', _human: true, _turnId: 'queued', _images: [image], message: { content: 'queued' } },
        { type: 'system', subtype: 'task_binding', taskId: 'native-task' },
        { type: 'error', error: 'Not delivered', undeliveredInputs: [{ inputId: 'queued', text: 'queued', images: [image] }] },
      ];
      if (delivery === 'live') await act(() => {
        for (const message of events) deliverSessionMessage({ type: 'run-event', message }, wire);
        deliverSessionMessage({ type: 'run-event', message: { type: 'run-settled', runId: id, status: 'error' } }, wire);
      });
      else await act(() => deliverSessionMessage({ type: 'run-snapshot', runId: id, startedAt, status: 'error', writerActive: false, events }, wire));
      const deletion = { sourceIds: [], taskIds: ['native-task'] };
      await act(() => current.onRecoveryDeleted(deletion));
      const checkCopy = () => {
        const rows = current.recoveryCopies.flatMap(copy => copy.messages);
        check(rows.length === 2 && rows.every(row => row.liveInputId === 'queued'), 'Only the unconfirmed input and its reason must survive task deletion');
        check(rows[0].images?.[0].data === image.data, 'Queued image must survive deletion');
      };
      checkCopy();
      await refresh(false); checkCopy();
      await act(() => deliverSessionMessage({ type: 'run-snapshot', runId: id, startedAt, status: 'error', writerActive: false, events, recoveryDeletions: [deletion] }));
      checkCopy();
    });
    await run(`claude-consumption-delete-${actor}-${delivery}`, async () => {
      await mount(`claude-consumption-delete-${actor}-${delivery}`, fixtures.claude20);
      if (actor === 'sender') await act(() => sender.handleSend('Q19'));
      const id = actor === 'sender' ? senderRunId : 'run';
      const wire = actor === 'sender' ? '/ws/session-stream?sessionId=new-sender-run' : undefined;
      const events = JSON.parse(JSON.stringify(__CLAUDE_RECOVERY_EVENTS__).replaceAll('sdk-browser-run', id)) as Array<Record<string, unknown>>;
      const nativeInput = events.find(event => event.subtype === 'input_binding' && event.inputId === id)!.sourceId as string;
      if (delivery === 'live') await act(() => {
        for (const message of events) deliverSessionMessage({ type: 'run-event', message }, wire);
        deliverSessionMessage({ type: 'run-event', message: { type: 'run-ended', runId: id, status: 'error', writerActive: true } }, wire);
        deliverSessionMessage({ type: 'run-event', message: { type: 'run-settled', runId: id, status: 'error' } }, wire);
      });
      else await act(() => deliverSessionMessage({ type: 'run-snapshot', runId: id, startedAt, status: 'error', writerActive: false, events }, wire));
      check(current.recoveryCopies.some(copy => copy.messages.some(row => row.content.includes('Owned by first input'))), 'Failed output must first be recoverable');
      const deletion = { sourceIds: [nativeInput], taskIds: [] };
      await act(() => current.onRecoveryDeleted(deletion));
      check(current.recoveryCopies[0].messages.every(row => row.liveInputId === 'unconsumed') && current.recoveryCopies[0].messages.some(row => row.content === 'Keep queued input'), 'Deletion must remove only the consumed turn including its output and error');
      await act(() => deliverSessionMessage({ type: 'run-snapshot', runId: id, startedAt, status: 'error', writerActive: false, events, recoveryDeletions: [deletion] }));
      check(current.recoveryCopies[0].messages.every(row => row.liveInputId === 'unconsumed') && current.recoveryCopies[0].messages.some(row => row.content === 'Keep queued input'), 'Reconnect must preserve deletion ownership');
    });
    await run(`pi-stopped-inputs-${actor}-${delivery}`, async () => {
      realList = true;
      await mount(`pi-stopped-inputs-${actor}-${delivery}`, fixtures.piQueued);
      if (actor === 'sender') await act(() => sender.handleSend('Q19'));
      const id = actor === 'sender' ? senderRunId : 'run';
      const wire = actor === 'sender' ? '/ws/session-stream?sessionId=new-sender-run' : undefined;
      const stopped = stoppedRun(id);
      const image = stopped.image;
      if (delivery === 'live') await act(() => {
        for (const frame of stopped.frames) deliverSessionMessage(frame, wire);
      });
      else await act(() => deliverSessionMessage(stopped.snapshot, wire));
      await refresh(false);
      // A stop is the user's decision, not a failure: inputs it left undelivered are
      // reported inline while live, but no recovery copy is pinned above the chat.
      const checkNoCopy = () => {
        check(current.recoveryCopies.length === 0, 'A stopped run must not retain a recovery copy');
        check(!current.messages.some(row => row.images?.length), 'Undelivered input must stay outside canonical history');
        check(document.querySelectorAll('[data-recovery-id]').length === 0, 'No recovery UI after a stop');
      };
      checkNoCopy();
      for (let i = 0; i < 2; i++) {
        await act(() => deliverSessionMessage(stopped.snapshot));
        checkNoCopy();
      }
      check(!!image, 'Fixture carries the undelivered image');
    });
  }

  await run('stopped-input-settlement-after-resend', async () => {
    await mount('stopped-input-settlement-after-resend', fixtures.piQueued);
    await act(() => sender.handleSend('Q19'));
    const oldId = senderRunId;
    const wire = '/ws/session-stream?sessionId=new-sender-run';
    const stopped = stoppedRun(oldId);
    await act(() => {
      for (const frame of stopped.frames.slice(0, stopped.beforeSettlement)) deliverSessionMessage(frame, wire);
    });
    await act(() => sender.handleSend('New input'));
    const currentRun = stoppedRun(oldId, senderRunId).successor;
    for (let i = 0; i < 2; i++) {
      await act(() => deliverSessionMessage(currentRun, wire));
      check(current.recoveryCopies.length === 0, 'A successor snapshot must not turn a stop into a recovery copy');
      check(sender.isLoading, 'Old settlement must not stop the new sender');
    }
    await act(() => deliverSessionMessage({ type: 'run-event', message: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'New output' } } } }, wire));
    await act(() => deliverSessionMessage({ type: 'run-event', message: { type: 'result' } }, wire));
    check(current.messages.some(row => row.content === 'New output'), 'New sender must still own its output');
  });
  for (const actor of ['sender', 'viewer']) await run(`idle-reconnect-cleans-recovery-${actor}`, async () => {
    await mount(`idle-reconnect-cleans-recovery-${actor}`, fixtures.claude20);
    await act(() => current.onInputRejected(sid, { id: 'retained-copy', startedAt, messages: [
      { id: 'copy-input', role: 'user', sourceId: 'old-id', content: 'Deleted input' },
      { id: 'copy-answer', role: 'assistant', content: 'Deleted answer' },
      { id: 'unrelated-input', role: 'user', sourceId: 'other-id', content: 'Keep unrelated' },
      { id: 'unconsumed-input', role: 'user', content: 'Keep unconsumed' },
    ] }));
    if (actor === 'sender') await act(() => sender.handleSend('Q20'));
    const recoveryDeletions = [
      { sourceIds: [], taskIds: [], sourceRemap: { 'old-id': 'middle-id' } },
      { sourceIds: [], taskIds: [], sourceRemap: { 'middle-id': 'new-id' } },
      { sourceIds: ['new-id'], taskIds: [] },
    ];
    await act(() => deliverSessionMessage({ type: 'run-idle', recoveryDeletions },
      actor === 'sender' ? '/ws/session-stream?sessionId=new-sender-run' : undefined));
    for (let replay = 0; replay < 2; replay++) await act(() => deliverSessionMessage({ type: 'run-idle', recoveryDeletions }));
    const copy = current.recoveryCopies.find(row => row.id === 'retained-copy');
    check(JSON.stringify(copy?.messages.map(row => row.content)) === JSON.stringify(['Keep unrelated', 'Keep unconsumed']),
      'Idle reconnect must apply ordered deletions without removing unrelated or unconsumed inputs');
    check(!current.messages.some(row => row.content.startsWith('Deleted')), 'Recovery cleanup must not move content into normal history');
  });
  for (const actor of ['sender', 'viewer']) await run(`late-tool-result-${actor}`, async () => {
    await mount(`late-tool-result-${actor}`, fixtures.toolLongBefore);
    await loadAll();
    const original = current.messages.find(row => row.toolCalls?.some(tool => tool.id === 'spawn'))!;
    check(original?.toolCalls?.[0].result === 'old report', 'Setup must load the original tool outside the current run');
    const wire = actor === 'sender' ? '/ws/session-stream?sessionId=new-sender-run' : undefined;
    if (actor === 'sender') await act(() => sender.handleSend('Q20'));
    else await act(() => deliverSessionMessage({ ...snapshot(false, 20), startedAt: startedAt + 1000,
      events: snapshot(false, 20).events.map(event => ({ ...event, _ts: startedAt + 1000 })) }));
    const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'spawn', content: 'late output' }] } };
    for (let replay = 0; replay < 2; replay++) await act(() => deliverSessionMessage({ type: 'run-event', message: result }, wire));
    const card = () => current.messages.find(row => row.id === original.id)?.toolCalls?.[0];
    check(card()?.result === 'late output' && card()?.isLoading === false, 'The later run must update the original card by tool identity');
    await act(() => deliverSessionMessage({ type: 'run-event', message: {
      type: 'system', subtype: 'task_notification', tool_use_id: 'spawn', task_id: 'child', status: 'completed', summary: 'Finished',
    } }, wire));
    check(card()?.task?.status === 'completed', 'Related task state must reach the same original card');
    await act(() => deliverSessionMessage({ type: 'run-event', message: {
      type: 'assistant', message: { content: [{ type: 'text', text: 'Current answer' }] },
    } }, wire));
    check(current.messages.find(row => row.content === 'Current answer')?.liveRunId
      && current.messages.find(row => row.id === original.id)?.content === original.content, 'Text output must remain isolated to the current run');
    check(current.messages.filter(row => row.toolCalls?.some(tool => tool.id === 'spawn')).length === 1, 'Replayed results must not duplicate the original card');
    fixture = fixtures.toolLongAfter;
    await refresh();
    check(card()?.result === 'new report' && current.messages.some(row => row.content === 'Current answer'), 'A fresh disk read must remain authoritative and preserve current output');
  });
  for (const idleDuringRead of [false, true]) await run(`failed-final-read-reconnect-${idleDuringRead}`, async () => {
    await mount(`failed-final-read-reconnect-${idleDuringRead}`, fixtures.ordinary19);
    await act(() => deliverSessionMessage(snapshot()));
    failRead = true; holdJump = idleDuringRead;
    const before = requests.length;
    await finishRun();
    check(requests.length === before + 1, 'Writer release must start one final read');
    const idle = { ...snapshot(), status: 'idle', writerActive: false };
    await act(() => deliverSessionMessage(idle));
    if (idleDuringRead) {
      check(requests.length === before + 1, 'Reconnect must not overlap the in-flight final read');
      holdJump = false;
      await act(() => jumpReleases.splice(0).forEach(release => release()));
    }
    check(requests.length === before + 2, 'A new idle observation must retry the failed final read once');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    check(requests.length === before + 2, 'A repeated failure must not create a retry loop');
    failRead = false; fixture = fixtures.ordinary20;
    await act(() => deliverSessionMessage(idle));
    check(requests.length === before + 3 && current.messages.some(row => row.content === 'A19')
      && !current.messages.some(row => row.liveRunId), 'The next reconnect must recover and retire the released run');
    await act(() => deliverSessionMessage(idle));
    check(requests.length === before + 3, 'An already reconciled idle run must not trigger another read');
  });
  await run('sender-recovers-failure-after-successor', async () => {
    await mount('sender-recovers-failure-after-successor', fixtures.piQueued);
    await act(() => sender.handleSend('Q19'));
    const recovery = { type: 'run-snapshot', recovery: true, status: 'error', writerActive: false,
      runId: senderRunId, startedAt, events: [
        { type: 'user', _human: true, _turnId: senderRunId, message: { content: 'Q19' } },
        { type: 'system', subtype: 'init', session_id: sid },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Lost sender output' } } },
        { type: 'error', error: 'Sender failed offline' },
      ] };
    const successor = { ...snapshot(), runId: 'other-run', recoveries: [recovery], events: [
      { type: 'user', _human: true, _turnId: 'other-run', message: { content: 'Other client input' } },
      { type: 'system', subtype: 'init' },
    ] };
    await act(() => deliverSessionMessage(successor, '/ws/session-stream?sessionId=new-sender-run'));
    check(!sender.isLoading, 'The originating sender must finish its own archived failure');
    check(current.recoveryCopies.length === 1 && current.recoveryCopies[0].messages.some((row) => row.content.includes('Lost sender output')), 'Buffered sender output must remain recoverable');
    await act(() => deliverSessionMessage(successor));
    check(current.recoveryCopies.length === 1, 'Viewer handoff must not duplicate the sender recovery');
    check(current.messages.some((row) => row.content === 'Other client input'), 'Viewer must follow the successor after sender release');
  });
  await run('recovery-copy-lifecycle', async () => {
    realList = true;
    await mount('recovery-copy-lifecycle', fixtures.piQueued);
    const successor = { ...snapshot(), runId: 'next', events: [
      { type: 'user', _human: true, _turnId: 'next', _ts: startedAt + 1000, message: { content: 'Next question' } },
      { type: 'system', subtype: 'init' },
    ] };
    await act(() => deliverSessionMessage(successor));
    const recovery = { ...snapshot(), runId: 'previous', status: 'error', writerActive: false, recovery: true,
      events: [
        { type: 'user', _human: true, _turnId: 'input-A', message: { content: 'Q19' } },
        { type: 'user', _human: true, _turnId: 'input-B', message: { content: 'Queued input' } },
        { type: 'system', subtype: 'input_started', inputId: 'input-A' },
        { type: 'system', subtype: 'input_binding', inputId: 'input-A', sourceId: 'user-19' },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Unsaved second response' } } },
        { type: 'error', error: 'Provider failed' },
      ] };
    await act(() => { deliverSessionMessage({ ...successor, recoveries: [recovery] }); });
    check(current.messages.some((row) => row.content === 'Next question'), 'Recovery must not replace the successor');
    check(!current.messages.some((row) => row.content === 'Queued input'), 'Recovery must remain outside normal history');
    check(current.recoveryCopies.length === 1, 'Exactly one recovery copy is retained');
    const details = document.querySelector('[data-recovery-id="previous"]') as HTMLDetailsElement;
    check(details && !details.open, 'The copy should initially be collapsed');
    await act(() => (details.querySelector('summary') as HTMLElement).click());
    check(details.open && details.textContent?.includes('Unsaved second response'), 'The copy can be opened to recover partial output');
    check(!details.querySelector('[data-message-id]'), 'Recovery rows cannot become history navigation targets');
    const deletion = { sourceIds: ['user-19'], taskIds: [] };
    await act(() => deliverSessionMessage({ type: 'run-event', message: { type: 'recovery-deleted', deletion } }));
    check(current.recoveryCopies[0].messages.map((row) => row.content).join() === 'Queued input', 'Deleting the saved turn must preserve its unconsumed sibling input');
    await act(() => { deliverSessionMessage({ ...successor, recoveries: [{ ...recovery, recoveryDeletions: [deletion] }] }); });
    check(current.recoveryCopies[0].messages.map((row) => row.content).join() === 'Queued input', 'Reconnect must not restore deleted recovery content');
    await act(() => deliverSessionMessage({ type: 'run-event', message: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Next output' } } } }));
    check(current.messages.some((row) => row.content === 'Next output'), 'The successor must still accept live output');
  });
  for (const source of ['sender', 'viewer']) for (const delivery of ['live', 'snapshot']) {
    await run(`settlement-queued-${source}-${delivery}`, async () => {
      await mount(`settlement-queued-${source}-${delivery}`, fixtures.piQueued);
      if (source === 'sender') await act(() => sender.handleSend('Q19'));
      const inputId = source === 'sender' ? senderRunId : 'run';
      const wire = source === 'sender' ? '/ws/session-stream?sessionId=new-sender-run' : undefined;
      const events = [
        { type: 'user', _human: true, _turnId: inputId, _ts: startedAt, message: { content: 'Q19' } },
        { type: 'user', _human: true, _turnId: 'queued', _ts: startedAt + 1, message: { content: 'Q19' } },
        { type: 'system', subtype: 'init', session_id: sid },
        { type: 'system', subtype: 'input_started', inputId },
        { type: 'system', subtype: 'input_binding', inputId, sourceId: 'user-19' },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Old partial' } } },
        { type: 'error', error: 'Provider failed' },
      ];
      if (delivery === 'snapshot') {
        await act(() => deliverSessionMessage({ type: 'run-snapshot', runId: inputId, startedAt,
          status: 'error', writerActive: false, events }, wire));
      } else {
        await act(() => {
          for (const message of events) deliverSessionMessage({ type: 'run-event', message }, wire);
          deliverSessionMessage({ type: 'run-event', message: { type: 'run-ended', runId: inputId, status: 'error', writerActive: true } }, wire);
          deliverSessionMessage({ type: 'run-event', message: { type: 'run-settled', runId: inputId, status: 'error' } }, wire);
        });
      }
      await refresh(false);
      check(current.messages.filter((row) => row.content === 'Q19').length === 1, 'Only the persisted input belongs to normal history');
      check(current.recoveryCopies[0].messages.filter((row) => row.content === 'Q19').length === 2, 'The recovery copy must preserve consumed and queued inputs');
      check(current.recoveryCopies[0].messages.some((row) => row.content.includes('Old partial')), 'Partial output must remain recoverable');
      check(current.messages.filter((row) => row.content === 'A19').length === 1, 'Canonical output must appear once');
      check(!current.messages.some((row) => row.content.includes('Old partial')), 'Persisted output must replace the actual consumer output');
      check(current.recoveryCopies.flatMap((copy) => copy.messages).filter((row) => row.streamError === 'Provider failed').length === 1, 'The consumer error must remain once');
    });
  }
  for (const source of ['sender', 'viewer']) await run(`delete-before-failure-retirement-${source}`, async () => {
    await mount(`delete-before-failure-retirement-${source}`, fixtures.claude20);
    holdJump = true;
    if (source === 'sender') await act(() => sender.handleSend('Q19'));
    const inputId = source === 'sender' ? senderRunId : 'run';
    const frames = snapshot().events.map((event) => event.type === 'user' ? { ...event, _turnId: inputId } : event);
    await act(() => deliverSessionMessage({ ...snapshot(), runId: inputId, status: 'error', writerActive: false,
      events: [...frames,
        { type: 'system', subtype: 'input_binding', inputId, sourceId: 'user-19' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Partial' }] } },
        { type: 'error', error: 'Provider failed' },
      ] }, source === 'sender' ? '/ws/session-stream?sessionId=new-sender-run' : undefined));
    check(current.recoveryCopies[0].messages.some((row) => row.role === 'user' && row.sourceId === 'user-19'), 'The recovery input must receive its native binding');
    fixture = fixtures.claudeDeleted19;
    await act(() => current.setMessages((messages) => removeMessageTurn(messages, 'user-10')));
    await refresh(false);
    holdJump = false;
    await act(() => jumpReleases.forEach((release) => release()));
    check(current.messages.filter((row) => row.content === 'Q19').length === 1, 'Prefix deletion must not duplicate the persisted input');
    check(current.messages.some((row) => row.content === 'A19') && !current.messages.some((row) => row.content.includes('Partial')), 'The canonical answer must replace the failed projection');
    check(current.recoveryCopies.flatMap((copy) => copy.messages).filter((row) => row.content.includes('Provider failed')).length === 1, 'The unpersisted error must survive exactly once');
  });
  for (const repeated of [false, true]) await run(`queued-input-replay-${repeated}`, async () => {
    await mount(`queued-input-replay-${repeated}`, fixtures.piQueued);
    const events = [0, 1, 2].map((n) => ({ type: 'user', _human: true, _turnId: `input-${n}`, _ts: startedAt + n,
      message: { content: repeated ? 'Q19' : `Q${19 + n}` } }));
    const replay = { ...snapshot(), events: [...events, { type: 'system', subtype: 'init' }] };
    for (let reconnect = 0; reconnect < 2; reconnect++) {
      await act(() => deliverSessionMessage(replay));
      check(current.messages.some((row) => row.content === 'Q18'), 'Queued admission must never hide preceding disk history');
      await act(() => deliverSessionMessage({ type: 'run-event', message: { type: 'system', subtype: 'input_binding', inputId: 'input-0', sourceId: 'user-19' } }));
      check(current.messages.find((row) => row.liveInputId === 'input-0')?.sourceId === 'user-19', 'Native identity must reach the live input');
      check(current.messages.filter((row) => row.liveInputId?.startsWith('input-')).length === 3, 'Repeated text must retain every admitted input');
    }
    await finishRun();
    check(current.messages.some((row) => row.content === 'A19'), 'Successful settlement must restore canonical disk output');
  });
  for (const timing of ['settled', 'batched', 'inflight', 'failed']) await run(`failed-replay-${timing}`, async () => {
    await mount(`failed-replay-${timing}`, fixtures.ordinary19);
    const replay = { ...snapshot(), status: 'error', writerActive: false,
      events: [...snapshot().events, { type: 'assistant', message: { content: [{ type: 'text', text: 'Partial streamed output' }] } },
        { type: 'error', error: 'Provider failed' }] };
    fixture = fixtures.ordinary20;
    if (timing === 'batched') holdJump = true;
    await act(() => deliverSessionMessage(replay));
    if (timing === 'batched') {
      let reading!: Promise<void>;
      await act(() => { reading = current.loadHistoryByCwdAndSessionId('/isolated-history-test', sid, true, 10, undefined, true); });
      const before = requests.length;
      holdJump = false;
      await act(async () => {
        jumpReleases.forEach((release) => release());
        await reading;
        // Retirement and recreation occur before React can commit an empty-demand render.
        deliverSessionMessage(replay);
      });
      check(requests.length === before + 1, 'Batched retirement/replay must create one new reconciliation');
    } else {
      check(current.messages.some((row) => row.content === 'A19'), 'The first reconciliation must complete before reconnect');
      let reading: Promise<void> | undefined;
      if (timing === 'inflight') {
        holdJump = true;
        await act(() => { reading = current.loadHistoryByCwdAndSessionId('/isolated-history-test', sid, true, 10, undefined, true); });
      }
      if (timing === 'failed') failRead = true;
      const before = requests.length;
      await act(() => deliverSessionMessage(replay));
      if (timing === 'inflight') {
        check(requests.length === before, 'Replay must not steal an effective read');
        holdJump = false;
        await act(async () => { jumpReleases.forEach((release) => release()); await reading; });
      }
      check(requests.length === before + 1, 'A recreated completed projection needs exactly one new read');
      if (timing === 'failed') {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
        check(requests.length === before + 1, 'A failed read must not create a self-retry loop without a new idle observation');
        failRead = false; await refresh();
      }
    }
    check(current.messages.some((row) => row.content === 'A19') && !current.messages.some((row) => row.content.includes('Partial streamed output')), 'Final disk output must replace the replayed partial');
    check(current.recoveryCopies.flatMap((copy) => copy.messages).filter((row) => row.content.includes('Provider failed')).length === 1, 'The necessary local error must survive exactly once');
    const settled = requests.length;
    await act(() => deliverSessionMessage(replay));
    check(requests.length === settled + 1 && current.messages.some((row) => row.content === 'A19'), 'Repeated reconnection must also converge without explicit refresh');
  });
  for (const source of ['sender', 'viewer']) await run(`persisted-error-${source}`, async () => {
    await mount(`persisted-error-${source}`, fixtures.ordinary19);
    const error = 'Selected model is at capacity.';
    const wire = source === 'sender' ? '/ws/session-stream?sessionId=new-sender-run' : undefined;
    if (source === 'sender') {
      await act(() => sender.handleSend('Q19'));
      await act(() => deliverSessionMessage({ type: 'run-event', message: { type: 'system', subtype: 'init', session_id: sid } }, wire));
    } else await act(() => deliverSessionMessage(snapshot()));
    const runId = source === 'sender' ? senderRunId : 'run';
    await act(() => {
      deliverSessionMessage({ type: 'run-event', message: { type: 'error', error } }, wire);
      deliverSessionMessage({ type: 'run-event', message: { type: 'run-ended', runId, status: 'error', writerActive: true } }, wire);
    });
    check(current.messages.filter((row) => row.content.includes(error)).length === 1, 'The streaming failure must be visible before persistence');
    fixture = fixtures.failed20;
    await act(() => deliverSessionMessage(writerFrame('run-settled', runId), wire));
    const assertCanonical = () => {
      check(current.messages.filter((row) => row.content.includes(error)).length === 1, 'The persisted and live copies must render only one error');
      check(current.messages.some((row) => row.content.includes('A19') && row.content.includes(error) && !row.liveRunId), 'The canonical answer and its persisted error must remain visible');
      check((document.querySelector('main')?.textContent?.split(error).length ?? 0) === 2, 'The committed message list must contain exactly one error');
    };
    assertCanonical();
    await refresh(); await more();
    assertCanonical();
  });
  for (const mode of ['changed', 'unchanged', 'mobile']) await run(`cache-hydration-${mode}`, async () => {
    hydrateSession = true;
    completionLimit = mode === 'mobile' ? undefined : 10;
    const name = `cache-hydration-${mode}`;
    await mount(name, fixtures.ordinary20);
    await act(() => root!.unmount()); root = undefined;
    holdInitial = true;
    notModified = mode === 'unchanged';
    await mount(name, mode === 'unchanged' ? fixtures.ordinary20 : fixtures.ordinary21);
    check(current.loadedSessionId === name && current.messages.some((m) => m.content === 'A19'), 'The cached page must commit before validation resolves');
    check(requests.some((request) => request.ifFingerprint), 'Reentry must actually use the cache');
    holdInitial = false;
    await act(() => releases.forEach((release) => release()));
    check(current.messages.some((m) => m.content === (mode === 'unchanged' ? 'A19' : 'A20')), 'Validation must survive null-to-loaded session hydration');
    await more();
    check(requests.at(-1)?.beforeTurnIndex !== undefined && current.messages.some((m) => m.content === (mode === 'unchanged' ? 'Q0' : 'Q1')), 'Validation completion must release paging ownership');
  });
  for (const replacement of ['rejected-send', 'cancelled-navigation', 'failed-refresh']) await run(`reconcile-after-${replacement}`, async () => {
    hydrateSession = true;
    await mount(`reconcile-after-${replacement}`, fixtures.ordinary19);
    const live = snapshot();
    live.events.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'PARTIAL A' }] } } as never);
    await act(() => deliverSessionMessage(live));
    fixture = fixtures.ordinary20;
    holdJump = true;
    await finishRun();
    check(jumpReleases.length === 1, 'Run release must start a held reconciliation');
    const before = requests.length;
    if (replacement === 'rejected-send') {
      holdSend = rejectSend = true;
      let sending!: Promise<void>;
      await act(() => { sending = sender.handleSend('Input B'); });
      check(requests.length === before, 'Pending admission must block reconciliation');
      holdJump = holdSend = false;
      await act(async () => { sendRelease?.(); await sending; });
      await act(() => deliverSessionMessage({ type: 'run-snapshot', status: 'idle', runId: 'run', writerActive: false, events: [] }));
      check(current.recoveryCopies.some((copy) => copy.messages.some((m) => m.content === 'Input B') && copy.messages.some((m) => m.streamError === 'Admission rejected')), 'Rejected input and reason must remain recoverable');
    } else if (replacement === 'cancelled-navigation') {
      let outcome: { status: string } | undefined;
      await act(() => { void current.ensureTurnLoaded(0).then((result) => { outcome = result; }); });
      holdJump = false;
      await act(() => current.cancelTurnLoad());
      check(outcome?.status === 'cancelled', 'Explicit navigation cancellation must remain terminal');
    } else {
      failRead = true;
      let reading!: Promise<void>;
      await act(() => { reading = current.loadHistoryByCwdAndSessionId('/isolated-history-test', sid, true, 10, undefined, true); });
      failRead = holdJump = false;
      await act(async () => { jumpReleases[1](); await reading; });
    }
    check(current.messages.some((m) => m.content === 'A19') && !current.messages.some((m) => m.content === 'PARTIAL A'), 'Unfinished reconciliation must resume after its replacement releases ownership');
    const completed = requests.length;
    await act(() => jumpReleases.forEach((release) => release()));
    check(requests.length === completed && current.messages.find((m) => m.content === 'A19')?.liveRunId === undefined && !current.messages.some((m) => m.content === 'PARTIAL A'), 'Late responses must neither overwrite completion nor restart reads');
  });
  await run('first-run-reconciliation-adopts-session', async () => {
    hydrateSession = true; loadOnMount = false;
    await mount('first-run-reconciliation-adopts-session', fixtures.ordinary20);
    check(requests.length === 0, 'A fresh tab must not read a session before it exists');
    await act(() => selectSession(sid));
    await act(() => deliverSessionMessage(snapshot()));
    await finishRun();
    check(current.loadedSessionId === sid && current.messages.some((m) => m.content === 'A19'), 'The first released run must establish its history target and converge');
    check(!current.messages.some((m) => m.liveRunId), 'The first read must retire the completed live projection');
  });
  await run('reconcile-failure-does-not-poll', async () => {
    await mount('reconcile-failure-does-not-poll', fixtures.ordinary19);
    await act(() => deliverSessionMessage(snapshot()));
    failRead = true;
    const before = requests.length;
    await finishRun();
    check(requests.length === before + 1, 'A failed reconciliation must not retry itself');
    failRead = false; fixture = fixtures.ordinary20;
    await refresh();
    check(current.messages.some((m) => m.content === 'A19') && !current.messages.some((m) => m.liveRunId), 'An explicit refresh must still recover the retained demand');
  });
  for (const fresh of [false, true]) await run(`session-switch-cancels-navigation-${fresh ? 'fresh' : 'loaded'}`, async () => {
    loadOnMount = !fresh;
    await mount(`session-switch-old-${fresh}`, fixtures.ordinary36);
    holdJump = true;
    let outcome: { status: string } | undefined;
    await act(() => { void current.ensureTurnLoaded(0).then((result) => { outcome = result; }); });
    sid = 'session-switch-new'; fixture = fixtures.ordinary20; holdInitial = true;
    let reading!: Promise<void>;
    await act(() => { reading = current.loadHistoryByCwdAndSessionId('/isolated-history-test', sid, false, 10, undefined, true); });
    check(outcome?.status === 'cancelled', 'Changing the read target must cancel the previous session navigation before the new response');
    await act(() => jumpReleases.forEach((release) => release()));
    check(current.isLoadingHistory, 'Old navigation cleanup must not release the new session read');
    holdInitial = holdJump = false;
    await act(async () => { releases.forEach((release) => release()); await reading; });
    check(current.loadedSessionId === sid && current.messages[0].content === 'Q10', 'Only the new session response may commit');
    await more();
    check(allAnswers(20), 'The new session must remain pageable');
  });
  await run('cancelled-navigation-releases-paging-before-http', async () => {
    await mount('cancelled-navigation-releases-paging-before-http', fixtures.ordinary36);
    holdJump = true;
    let outcome: { status: string } | undefined;
    let pending!: Promise<unknown>;
    let page!: Promise<void>;
    try {
      await act(async () => { pending = current.ensureTurnLoaded(0).then((result) => { outcome = result; }); });
      check(jumpReleases.length === 1 && current.isLoadingMore, 'Navigation must reach the held HTTP boundary');
      const signal = requestSignals.at(-1);
      await act(async () => current.cancelTurnLoad());
      check(signal?.aborted, 'Cancellation must interrupt the fetch even if the transport ignores abort');
      check(!current.isLoadingMore, 'Cancellation must release the navigation spinner before HTTP finishes');
      check(outcome?.status === 'cancelled', 'Cancellation must complete the data operation without waiting for HTTP');
      holdBefore = true;
      await act(async () => { page = current.loadMoreHistory(); });
      check(beforeReleases.length === 1 && current.isLoadingMore, 'Paging must start while cancelled HTTP is still pending');
      await act(async () => { jumpReleases.forEach((release) => release()); await pending; });
      check(current.isLoadingMore, 'Late navigation cleanup must not release the newer page spinner');
      check(current.messages[0].content === 'Q26', 'A cancelled response must not widen the window');
      holdBefore = false;
      await act(async () => { beforeReleases.forEach((release) => release()); await page; });
      check(current.messages[0].content === 'Q16' && !current.isLoadingMore, 'The new page must finish normally');
      await more();
      check(current.messages[0].content === 'Q6', 'Subsequent paging must retain its cursor');
    } finally {
      holdJump = holdBefore = false;
      await act(async () => { jumpReleases.forEach((release) => release()); beforeReleases.forEach((release) => release()); await pending; await page; });
    }
  });
  for (const end of ['unmount', 'replacement']) await run(`navigation-http-${end}`, async () => {
    await mount(`navigation-http-${end}`, fixtures.ordinary36);
    holdJump = true;
    let first: { status: string } | undefined;
    let second: { status: string } | undefined;
    try {
      await act(async () => { void current.ensureTurnLoaded(0).then((result) => { first = result; }); });
      const signal = requestSignals.at(-1);
      await act(async () => {
        if (end === 'unmount') { root!.unmount(); root = undefined; }
        else void current.ensureTurnLoaded(5).then((result) => { second = result; });
      });
      check(first?.status === 'cancelled' && signal?.aborted, 'An abandoned navigation must finish and abort its request');
      await act(async () => jumpReleases[0]());
      if (end === 'replacement') {
        check(!second && current.isLoadingMore && current.messages[0].content === 'Q26', 'The old response must not finish or apply over its replacement');
        holdJump = false;
        await act(async () => jumpReleases[1]());
        check(second?.status === 'ready' && current.messages[0].content === 'Q5', 'The replacement must own the result');
      }
    } finally {
      holdJump = false;
      await act(async () => jumpReleases.forEach((release) => release()));
    }
  });
  await run('legacy-index-reference-survives-steering', async () => {
    realList = true;
    await mount('legacy-index-reference-survives-steering', fixtures.ordinary20);
    const index = await readWindow({}, true) as { messages: { id: string; turnIndex: number; sourceRef: NonNullable<Parameters<typeof current.ensureTurnLoaded>[1]>; content: string }[] };
    const target = index.messages.find((row) => row.content === 'Q19')!;
    fixture = fixtures.steering20;
    await act(async () => { check((await current.ensureTurnLoaded(target.turnIndex, target.sourceRef)).status === 'ready', 'The old index reference must resolve after steering is appended'); });
    let outcome: { status: string } | undefined;
    await act(async () => { void navigate(target).then((result) => { outcome = result; }); });
    await waitForNavigation(() => outcome !== undefined);
    check(outcome?.status === 'scrolled' && scrolls.at(-1)?.text?.includes('Q19'), 'Navigation must reach the same human input after the new page commits');
  });
  await run('cancelled-navigation-preserves-new-refresh-owner', async () => {
    await mount('cancelled-navigation-preserves-new-refresh-owner', fixtures.ordinary36);
    holdJump = true;
    let pending!: Promise<unknown>;
    let reading!: Promise<void>;
    try {
      await act(async () => { pending = current.ensureTurnLoaded(0); });
      await act(async () => { reading = current.loadHistoryByCwdAndSessionId('/isolated-history-test', sid, true, 10, undefined, true); });
      check(jumpReleases.length === 2, 'Refresh must supersede the navigation request');
      await act(async () => current.cancelTurnLoad());
      const count = requests.length;
      await more();
      check(requests.length === count, 'Cancelling navigation must not release a boundary owned by refresh');
      await act(async () => jumpReleases[0]());
      await more();
      check(requests.length === count, 'Late cancelled completion must not release the refresh boundary');
      holdJump = false;
      await act(async () => { jumpReleases[1](); await reading; await pending; });
      await more();
      check(current.messages[0].content === 'Q16', 'Paging must resume after the actual owner completes');
    } finally {
      holdJump = false;
      await act(async () => { jumpReleases.forEach((release) => release()); await reading; await pending; });
    }
  });
  for (const entry of ['event-error', 'event-content', 'snapshot-error']) await run(`viewer-next-run-${entry}`, async () => {
    await mount(`viewer-next-run-${entry}`, fixtures.ordinary20);
    await act(async () => {
      deliverSessionMessage(snapshot());
      deliverSessionMessage({ type: 'run-event', message: { type: 'system', subtype: 'task_binding', taskId: 'old-task' } });
      deliverSessionMessage({ type: 'run-event', message: { type: 'result', result: 'A19' } });
    });
    holdJump = true;
    try {
      await finishRun();
      const events = [
        { type: 'user', _human: true, _turnId: 'next-run', _ts: startedAt + 1000, message: { content: 'Q20' } },
        entry === 'event-content' ? { type: 'assistant', message: { content: [{ type: 'text', text: 'Early content' }] } }
          : { type: 'error', error: 'Initialization failed' },
      ];
      await act(async () => {
        if (entry === 'snapshot-error') deliverSessionMessage({ type: 'run-snapshot', status: 'running', runId: 'next-run', startedAt: startedAt + 1000, events });
        else for (const message of events) deliverSessionMessage({ type: 'run-event', message });
      });
      const assistant = current.messages.find((row) => row.liveRunId === 'next-run' && row.role === 'assistant');
      check(assistant?.content.includes(entry === 'event-content' ? 'Early content' : 'Initialization failed'), 'The next run must display its own pre-init output: ' + JSON.stringify(current.messages));
      check(assistant && !assistant.sourceTaskId && assistant.turnId === 'live-task-next-run-0', 'New run metadata must not inherit the previous task');
      check(current.messages.find((row) => row.content === 'A19')?.liveRunId !== 'next-run', 'The previous reply must keep its own owner');
      if (entry !== 'event-content') {
        holdJump = false;
        await act(async () => jumpReleases.forEach((release) => release()));
        await act(async () => {
          for (const type of ['run-ended', 'run-settled'] as const) {
            const frame = writerFrame(type, 'next-run');
            deliverSessionMessage({ ...frame, message: { ...frame.message, status: 'error' } });
          }
        });
        await refresh();
        check(current.recoveryCopies.flatMap((copy) => copy.messages).some((row) => row.liveRunId === 'next-run' && row.content.includes('Initialization failed')), 'An unpersisted startup failure must remain recoverable after release');
      }
    } finally {
      holdJump = false;
      await act(async () => jumpReleases.forEach((release) => release()));
    }
  });
  await run('failed-page-releases-range', async () => {
    await mount('failed-page-releases-range', fixtures.ordinary36);
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      return body.beforeTurnIndex !== undefined ? { ok: false } as Response : fetchBefore(url, options);
    };
    try { await more(); } finally { globalThis.fetch = fetchBefore; }
    await refresh();
    check(requests.at(-1)?.fromTurnIndex === 26, 'A failed page must release its temporary range');
    check(current.messages.filter((row) => row.role === 'user').length === 10, 'A later refresh must not retry an abandoned prefix');
  });
  for (const status of ['missing', 'stale', 'failed', 'cancelled']) await run(`navigation-range-${status}`, async () => {
    await mount(`navigation-range-${status}`, fixtures.ordinary20);
    const fetchBefore = globalThis.fetch;
    if (status === 'failed') globalThis.fetch = async (url, options) => {
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      return body.target ? { ok: false } as Response : fetchBefore(url, options);
    };
    holdJump = status === 'cancelled';
    let pending!: Promise<{ status: string }>;
    try {
      const target = { id: 'absent', prefix: 'invalid', ...(status === 'stale' ? {} : { sourceId: 'absent' }) };
      if (status === 'cancelled') {
        await act(async () => { pending = current.ensureTurnLoaded(0, target); });
        await act(async () => current.cancelTurnLoad());
      } else await act(async () => { check((await current.ensureTurnLoaded(0, target)).status === status, 'Expected navigation outcome'); });
      holdJump = false;
      await refresh();
      check(requests.at(-1)?.fromTurnIndex === 10, 'Finished navigation must not widen the background window: ' + JSON.stringify(requests.at(-1)));
      check(current.messages.filter((row) => row.role === 'user').length === 10, 'Background refresh must retain only the committed window');
    } finally {
      holdJump = false; globalThis.fetch = fetchBefore;
      await act(async () => { jumpReleases.forEach((release) => release()); if (pending) await pending; });
    }
  });
  await run('navigation-preserves-pending-page', async () => {
    await mount('navigation-preserves-pending-page', fixtures.ordinary36);
    holdBefore = true;
    let pending!: Promise<void>;
    await act(async () => { pending = current.loadMoreHistory(); });
    await act(async () => current.ensureTurnLoaded(0, { id: 'absent', sourceId: 'absent', prefix: 'invalid' }));
    await refresh();
    check(requests.at(-1)?.fromTurnIndex === 16, 'Failed navigation must preserve the independent pending page boundary');
    holdBefore = false;
    await act(async () => { beforeReleases.forEach((release) => release()); await pending; });
    check(current.messages.filter((row) => row.role === 'user').length === 20, 'Requested prefix must still be loaded');
  });
  for (const stage of ['inactive', 'frame', 'delayed-frame']) for (const kind of ['legacy', 'native-deleted', 'native-moved']) {
    await run(`navigation-identity-${stage}-${kind}`, async () => {
      realList = true; navigationActive = stage !== 'inactive';
      await mount(`navigation-identity-${stage}-${kind}`, kind === 'legacy' ? fixtures.ordinary20 : fixtures.native20);
      const target = current.messages.find((row) => row.content === 'Q18')!;
      const raf = globalThis.requestAnimationFrame, caf = globalThis.cancelAnimationFrame;
      const frames = new Map<number, FrameRequestCallback>(); let frameId = 1000000;
      let delayedFrame: ReturnType<typeof setTimeout> | undefined;
      if (stage !== 'inactive') {
        globalThis.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
        globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
      }
      let outcome: { status: string } | undefined;
      try {
        await act(async () => { void navigate({ id: target.id, turnIndex: 18, sourceRef: target.sourceRef }).then((result) => { outcome = result; }); });
        fixture = kind === 'legacy' ? fixtures.deleted19 : kind === 'native-deleted' ? fixtures.nativeDeleted19 : fixtures.nativeShifted19;
        await refresh(false);
        navigationActive = true;
        await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
        const flushFrames = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach((callback) => callback(performance.now())); };
        if (stage === 'frame') await act(flushFrames);
        else if (stage === 'delayed-frame') {
          // Exercise a busy runner delivering its frame after a short assertion delay.
          delayedFrame = setTimeout(flushFrames, 150);
        }
        await waitForNavigation(() => outcome !== undefined);
        const expected = kind === 'legacy' ? 'stale' : kind === 'native-deleted' ? 'missing' : 'scrolled';
        check(outcome?.status === expected, `Expected ${expected}, got ${JSON.stringify({ outcome, scrolls })}`);
        if (expected === 'scrolled') check(scrolls.length === 1 && scrolls[0].text?.includes('Q18'), 'Native identity must resolve its new rendered ID');
        else check(scrolls.length === 0, 'An invalid target must never reach the scroll callback');
      } finally { clearTimeout(delayedFrame); globalThis.requestAnimationFrame = raf; globalThis.cancelAnimationFrame = caf; }
    });
  }
  await run('prepend-after-live-first-persist', async () => {
    await mount('prepend-after-live-first-persist', fixtures.ordinary19);
    await act(async () => deliverSessionMessage(snapshot()));
    fixture = fixtures.ordinary20;
    await more();
    check(current.messages.some((m) => m.content === 'Q0') && current.messages.some((m) => m.content === 'Q18'), 'Persisting the live task must not move its coordinate during prepend');
    check(current.messages.filter((m) => m.content === 'Q19').length === 1, 'The live task must remain visible once');
  });
  for (const persisted of [false, true]) await run(persisted ? 'sender-current-persisted-before-prepend' : 'sender-after-viewer-then-prepend', async () => {
    await mount(`sender-viewer-prepend-${persisted}`, fixtures.ordinary20);
    await act(async () => deliverSessionMessage(snapshot()));
    viewerEnabled = false; await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
    provisionalKeys = false;
  viewerEnabled = true; await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
    await act(async () => sender.handleSend('Q20'));
    if (persisted) fixture = fixtures.steering21;
    await more();
    check(current.messages.filter((m) => m.content === 'Q19').length === 1, 'Pending viewer identity must survive sender takeover and prepend');
    check(current.messages.filter((m) => m.content === 'Q20').length === 1 && current.messages.at(-1)?.isStreaming, 'The current sender tail must survive prepend exactly once');
    check(current.messages.some((m) => m.id === fixtures.ordinary20.full.messages.find((item) => item.content === 'Q19')?.id), 'Known canonical user identity must remain available for modal jumps after handoff');
    const wire = '/ws/session-stream?sessionId=new-sender-run';
    fixture = fixtures.steering21;
    await finishRun(wire);
    check(allAnswers(21) && !current.messages.some((m) => m.liveRunId), 'Final canonical read must retire both pending sources');
  });
  await run('sender-jump-beyond-previous-viewer', async () => {
    await mount('sender-jump-beyond-previous-viewer', fixtures.ordinary20);
    await act(async () => deliverSessionMessage(snapshot()));
    viewerEnabled = false; await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
    provisionalKeys = false;
  viewerEnabled = true; await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
    await act(async () => sender.handleSend('Q35'));
    fixture = fixtures.steering35;
    await act(async () => current.ensureTurnLoaded(25));
    check(current.messages.some((m) => m.content === 'Q25') && !current.messages.some((m) => m.content === 'Q19'), 'A later window must not be overwritten by the previous viewer task');
    check(current.messages.some((m) => m.content === 'Q35') && current.messages.at(-1)?.isStreaming, 'A jump must retain the sender tail: ' + JSON.stringify(current.messages.map(({content,liveRunId,isStreaming})=>({content,liveRunId,isStreaming}))));
    fixture = fixtures.ordinary36;
    await finishRun('/ws/session-stream?sessionId=new-sender-run');
    check(current.messages.some((m) => m.content === 'A35') && !current.messages.some((m) => m.liveRunId), 'Final reconciliation must retire pending provenance after the jump');
  });
  await run('stop-waits-for-writer', async () => {
    await mount('stop-waits-for-writer', fixtures.ordinary19);
    await act(async () => deliverSessionMessage(snapshot()));
    const count = requests.length;
    await act(async () => deliverSessionMessage(writerFrame('run-ended')));
    check(requests.length === count && current.messages.some((m) => m.content === 'Q19'), 'Stop must retain pending content until the writer is released');
    await refresh();
    check(current.messages.some((m) => m.content === 'Q19'), 'An interim disk read must not retire pending live content');
    await act(async () => current.loadMoreHistory());
    fixture = fixtures.ordinary20;
    await act(async () => deliverSessionMessage(writerFrame('run-settled')));
    check(allAnswers(20) && !current.hasMoreHistory && !current.messages.some((m) => m.liveRunId), 'Writer release must reconcile canonical content and the range requested while flushing');
  });
  await run('prefix-growth-after-cache-revalidation-failure', async () => {
    const name = 'prefix-growth-after-cache-revalidation-failure';
    await mount(name, fixtures.ordinary20);
    await act(async () => root!.unmount()); root = undefined;
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      if (body.beforeTurnIndex === undefined && body.fromTurnIndex === undefined && String(url) === '/api/session-by-path') {
        return { ok: false } as Response;
      }
      return fetchBefore(url, options);
    };
    try {
      await mount(name, fixtures.steering35);
      await act(async () => deliverSessionMessage({ ...snapshot(), startedAt: startedAt + 15000, events: [
        { type: 'user', _human: true, _turnId: 'run', _ts: startedAt + 15000, message: { content: 'Q34' } },
        { type: 'system', subtype: 'init', _ts: startedAt + 15000 },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'A34' }] } },
      ] }));
      await more();
      check(allAnswers(35) && !current.hasMoreHistory, 'Growth observed through a prefix page must fill the unseen tail after a failed cache revalidation');
    } finally { globalThis.fetch = fetchBefore; }
  });
  await run('tool-report-only-refresh', async () => {
    await mount('tool-report-only-refresh', fixtures.toolBefore);
    check(current.messages.some((m) => m.toolCalls?.[0]?.result === 'old report'), 'Setup must use the actual parser tool report');
    fixture = fixtures.toolAfter; await refresh();
    check(current.messages.some((m) => m.toolCalls?.[0]?.result === 'new report'), 'A late agent report must update the existing tool bubble');
  });
  await run('loaded-prefix-tool-report-refresh', async () => {
    await mount('loaded-prefix-tool-report-refresh', fixtures.toolLongBefore);
    await loadAll();
    check(current.messages.some((m) => m.toolCalls?.[0]?.result === 'old report'), 'The first loaded task must contain the old report');
    check(!fixtures.toolLongAfter.first.messages.some((m) => m.toolCalls?.length), 'The changed tool must be outside the latest ten tasks');
    fixture = fixtures.toolLongAfter;
    await refresh();
    check(current.messages.some((m) => m.toolCalls?.[0]?.result === 'new report'), 'Refresh must update a loaded prefix even when the tail is unchanged');
    check(allAnswers(20), 'Refreshing the early report must preserve the entire loaded history');
  });
  await run('sender-stop-waits-for-writer', async () => {
    await mount('sender-stop-waits-for-writer');
    await act(async () => sender.handleSend('Q20'));
    const wire = '/ws/session-stream?sessionId=new-sender-run';
    const count = requests.length;
    await act(async () => sender.handleStop());
    await act(async () => deliverSessionMessage(writerFrame('run-ended', senderRunId), wire));
    check(!sender.isLoading && requests.length === count && current.messages.some((m) => m.content === 'Q20'), 'Stop must end the sender spinner while retaining the pending message and subscription');
    await refresh();
    check(current.messages.some((m) => m.content === 'Q20') && !sender.isLoading, 'Interim refreshes must retain the sender projection while the writer drains');
    fixture = fixtures.steering21;
    await act(async () => deliverSessionMessage(writerFrame('run-settled', senderRunId), wire));
    check(current.messages.some((m) => m.content === 'A20') && !current.messages.some((m) => m.id.startsWith('user-')), 'The retained sender subscription must reconcile after writer release');
  });
  await run('sender-starts-before-old-writer-release', async () => {
    await mount('sender-starts-before-old-writer-release');
    await act(async () => sender.handleSend('Q20'));
    const oldRunId = senderRunId;
    await act(async () => sender.handleStop());
    holdSend = true;
    let nextSend: Promise<void>;
    await act(async () => { nextSend = sender.handleSend('Q21'); });
    check(current.messages.some((m) => m.content === 'Q20'), 'The previous sender must survive while admission waits for its writer');
    fixture = fixtures.ordinary21; holdSend = false;
    await act(async () => { sendRelease?.(); await nextSend!; });
    check(current.messages.find((m) => m.content === 'A20')?.liveRunId === undefined && current.messages.some((m) => m.content === 'A20'), 'Admission must reconcile the previous writer final output');
    const wire = '/ws/session-stream?sessionId=new-sender-run';
    const count = requests.length;
    await act(async () => deliverSessionMessage(writerFrame('run-settled', oldRunId), wire));
    check(sender.isLoading && requests.length === count && current.messages.some((m) => m.content === 'Q21'), 'An older writer must not finalize the new sender');
    fixture = fixtures.ordinary22;
    await finishRun(wire);
    check(current.messages.some((m) => m.content === 'A21') && current.messages.some((m) => m.content === 'A20') && current.messages.every((m) => !m.liveRunId), 'Both senders must converge to their final persisted output');
  });
  for (const released of [false, true]) await run(released ? 'reconnect-after-writer-release' : 'reconnect-before-writer-release', async () => {
    await mount(`reconnect-${released}`, fixtures.ordinary19);
    await act(async () => deliverSessionMessage(snapshot()));
    await act(async () => deliverSessionMessage(writerFrame('run-ended')));
    viewerEnabled = false; await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
    provisionalKeys = false;
  viewerEnabled = true; await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
    if (released) fixture = fixtures.ordinary20;
    await act(async () => deliverSessionMessage({ type: 'run-snapshot', status: 'idle', runId: 'run', writerActive: !released, events: [] }));
    if (!released) {
      check(current.messages.some((m) => m.content === 'Q19'), 'Reconnect while flushing must preserve pending content');
      fixture = fixtures.ordinary20;
      await act(async () => deliverSessionMessage(writerFrame('run-settled')));
    }
    check(current.messages.some((m) => m.content === 'A19') && !current.messages.some((m) => m.liveRunId), 'Reconnect must converge whether release was observed live or through a snapshot');
  });
  await run('late-settlement-does-not-end-new-viewer', async () => {
    await mount('late-settlement-does-not-end-new-viewer');
    await act(async () => deliverSessionMessage({ ...snapshot(), runId: 'newer', events: [
      { type: 'user', _human: true, _turnId: 'newer', _ts: startedAt + 1000, message: { content: 'Q20' } },
      { type: 'system', subtype: 'init', _ts: startedAt + 1000 },
    ], startedAt: startedAt + 1000 }));
    const count = requests.length;
    await act(async () => deliverSessionMessage(writerFrame('run-settled', 'older')));
    check(requests.length === count && current.messages.some((m) => m.content === 'Q20'), 'Settlement from a prior run must not end the active viewer');
  });
  await run('empty-then-unpersisted-run', async () => {
    await mount('empty-then-unpersisted-run'); emptyResponse = true; await refresh(); emptyResponse = false;
    await act(async () => deliverSessionMessage({ ...snapshot(false, 20), startedAt: startedAt + 1000,
      events: [{ type: 'user', _human: true, _turnId: 'new-run', _ts: startedAt + 1000, message: { content: 'Q20' } }, { type: 'system', subtype: 'init' }] }));
    check(current.messages.some((m) => m.content === 'Q20'), 'Empty incremental read must not hide the next unpersisted run');
    check(current.messages.some((m) => m.content === 'A19'), 'Prior disk history must remain visible');
  });
  for (const mode of ['jump', 'page', 'full'] as const) await run(`unchanged-refresh-${mode}`, async () => {
    await mount(`unchanged-refresh-${mode}`); notModified = true;
    const fetchBefore = globalThis.fetch;
    let release = () => {};
    let held = false;
    globalThis.fetch = async (url, options) => {
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      const response = await fetchBefore(url, options);
      if (!held && !body.ifFingerprint && (body.fromTurnIndex === 0 || body.beforeTurnIndex === 10)) {
        held = true;
        return new Promise<Response>((resolve) => { release = () => resolve(response); });
      }
      return response;
    };
    try {
      let pending: Promise<unknown> = Promise.resolve();
      if (mode !== 'full') await act(async () => { pending = mode === 'jump' ? current.ensureTurnLoaded(0) : current.loadMoreHistory(); });
      await act(async () => current.loadHistoryByCwdAndSessionId('/isolated-history-test', sid, true, mode === 'full' ? undefined : 10, undefined, true));
      await act(async () => { release(); await pending; });
      check(allAnswers(20) && !current.hasMoreHistory, 'Unchanged file fingerprint must not suppress an unloaded range');
    } finally { globalThis.fetch = fetchBefore; }
  });
  for (const pendingPage of [false, true]) await run(pendingPage ? 'sender-invalidates-old-page' : 'sender-after-hidden-viewer', async () => {
    await mount(pendingPage ? 'sender-invalidates-old-page' : 'sender-after-hidden-viewer');
    await act(async () => deliverSessionMessage(snapshot()));
    viewerEnabled = false; await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
    provisionalKeys = false;
  viewerEnabled = true; await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
    let pending: Promise<unknown> = Promise.resolve();
    if (pendingPage) {
      holdBefore = true;
      await act(async () => { pending = current.loadMoreHistory(); });
    }
    await act(async () => sender.handleSend('Q20'));
    if (pendingPage) {
      holdBefore = false;
      await act(async () => { beforeReleases.forEach((release) => release()); await pending; });
      check(!current.isLoadingMore, 'Sender takeover must release superseded paging');
    }
    check(current.messages.some((m) => m.content === 'Q20'), 'Sender must take ownership before adding its prompt');
    const wire = '/ws/session-stream?sessionId=new-sender-run';
    await act(async () => deliverSessionMessage({ type: 'run-event', message: { type: 'system', subtype: 'init', session_id: sid } }, wire));
    await act(async () => deliverSessionMessage({ type: 'run-event', message: { type: 'result', result: 'A20' } }, wire));
    check(current.messages.some((m) => m.role === 'assistant' && m.content === 'A20'), 'Sender stream must still find and update its assistant');
    fixture = fixtures.steering21;
    await finishRun(wire);
    check(current.messages.some((m) => m.content === 'A20') && current.messages.every((m) => !m.liveRunId && !m.id.startsWith('user-') && !m.id.startsWith('assistant-')), 'Sender completion must converge to canonical disk identities');
  });
  await run('cold-open-while-writer-drains', async () => {
    holdInitial = true;
    await mount('cold-open-while-writer-drains', fixtures.ordinary20);
    await act(async () => deliverSessionMessage({ ...snapshot(), status: 'idle', writerActive: true }));
    holdInitial = false;
    await act(async () => releases.forEach((release) => release()));
    check(current.messages.some((message) => message.content === 'Q10'), 'A draining snapshot must not discard the first history response');
    check(current.messages.filter((message) => message.content === 'Q19').length === 1, 'A draining snapshot must restore its complete input projection');
    await act(async () => deliverSessionMessage(writerFrame('run-settled')));
    check(current.messages.some((message) => message.content === 'A19') && !current.messages.some((message) => message.liveRunId), 'Release must atomically converge the cold-open projection');
  });
  await run('failed-stop-preserves-stream-and-paging', async () => {
    await mount('failed-stop-preserves-stream-and-paging', fixtures.ordinary20);
    await act(async () => sender.handleSend('Q20'));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url) === '/api/chat/stop') throw new Error('Controlled stop failure');
      return previousFetch(url, options);
    };
    try { await act(async () => sender.handleStop()); } finally { globalThis.fetch = previousFetch; }
    check(sender.isLoading, 'A failed stop must not end the active sender');
    await more();
    check(current.messages.some((message) => message.content === 'Q0'), 'A failed stop must not latch history reads');
    const wire = '/ws/session-stream?sessionId=new-sender-run';
    await act(async () => deliverSessionMessage({ type: 'run-event', message: { type: 'result', result: 'A20' } }, wire));
    check(current.messages.some((message) => message.content === 'A20'), 'A failed stop must keep receiving the run output');
  });
  await run('modal-latest-selection-owns-completion', async () => {
    realList = realModal = true;
    await mount('modal-latest-selection', fixtures.ordinary20);
    holdJump = true;
    await act(async () => { (document.querySelector('button[data-tooltip="Q0"]') as HTMLButtonElement).click(); });
    holdJump = false;
    await act(async () => { (document.querySelector('button[data-tooltip="Q1"]') as HTMLButtonElement).click(); });
    await waitForNavigation(() => selections.length === 2);
    check(selections.join(',') === 'cancelled,scrolled', 'Only the latest selection may complete or close: ' + selections.join(','));
    check(!document.querySelector('button[data-tooltip="Q1"]'), 'Successful selection must close the actual modal');
    await act(async () => jumpReleases.forEach((release) => release()));
    check(selections.join(',') === 'cancelled,scrolled', 'Late history must not revive a cancelled selection');
  });
  await run('active-target-waits-for-own-run', async () => {
    realList = true;
    await mount('active-target', fixtures.ordinary20);
    await act(async () => deliverSessionMessage(snapshot()));
    const target = fixture.full.messages.find((row) => row.content === 'Q19')!;
    let outcome: { status: string } | undefined;
    await act(async () => { void navigate({ id: target.id, turnIndex: 19, sourceRef: target.sourceRef }).then((result) => { outcome = result; }); });
    check(!outcome, 'An active overlay cannot claim a hidden canonical target is ready');
    await finishRun();
    await waitForNavigation(() => outcome !== undefined);
    check(outcome?.status === 'scrolled', 'The target must become navigable after its own run is reconciled');
  });
  for (const end of ['release', 'cancel', 'unmount'] as const) await run(`waiter-cleanup-${end}`, async () => {
    await mount(`waiter-cleanup-${end}`, fixtures.ordinary20);
    await act(async () => deliverSessionMessage(snapshot()));
    const add = Set.prototype.add;
    const registered: { set: Set<unknown>; value: unknown }[] = [];
    Set.prototype.add = function (value: unknown) {
      if (typeof value === 'function' && /^check\d*$/.test(value.name)) registered.push({ set: this, value });
      return add.call(this, value);
    };
    let pending: ReturnType<typeof current.ensureTurnLoaded>;
    try { await act(async () => { pending = current.ensureTurnLoaded(19); }); }
    finally { Set.prototype.add = add; }
    check(registered.length > 0, 'The real navigation waiter must have subscribed');
    if (end === 'release') await act(async () => deliverSessionMessage(writerFrame('run-settled')));
    if (end === 'cancel') await act(async () => current.cancelTurnLoad());
    if (end === 'unmount') { await act(async () => root!.unmount()); root = undefined; }
    await act(async () => { await pending; });
    check(registered.every(({ set, value }) => !set.has(value)), 'Settled navigation must release every registered callback');
  });
  await run('partial-read-cannot-become-authoritative-cache', async () => {
    await mount('partial-read-cache', fixtures.ordinary20);
    fixture = fixtures.empty;
    emptyResponse = true;
    await refresh(false);
    check(current.messages.length > 0, 'An incomplete source must preserve the visible history');
    emptyResponse = false;
    notModified = true;
    await act(async () => current.loadHistoryByCwdAndSessionId('/isolated-history-test', sid, false, 10));
    check(current.messages.length === 0 && !current.hasMoreHistory, 'Reopening must read an authoritative source instead of validating a partial cached page');
  });
  await run('transport-timeout-does-not-release-writer', async () => {
    await mount('transport-timeout', fixtures.ordinary20);
    const schedule = globalThis.setTimeout;
    let watchdog: (() => void) | undefined;
    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
      if (timeout === 15000 && typeof handler === 'function') watchdog = () => handler(...args);
      return schedule(handler, timeout, ...args);
    }) as typeof globalThis.setTimeout;
    try { await act(async () => sender.handleSend('Q20')); }
    finally { globalThis.setTimeout = schedule; }
    const count = requests.length;
    check(watchdog, 'The sender must arm its connection watchdog');
    await act(async () => watchdog!());
    check(sender.isLoading && requests.length === count && current.messages.some((row) => row.content === 'Q20'), 'Transport failure must retain run ownership and must not trigger final reconciliation');
    const wire = '/ws/session-stream?sessionId=new-sender-run';
    await act(async () => deliverSessionMessage({ ...snapshot(false, 20), runId: senderRunId }, wire));
    fixture = fixtures.ordinary21;
    await finishRun(wire);
    check(current.messages.some((row) => row.content === 'A20') && current.messages.every((row) => !row.liveRunId), 'Reconnection and actual writer release must converge to disk');
  });
  await run('navigation-waits-for-target-in-multi-run-window', async () => {
    realList = true;
    await mount('navigation-multi-run-window', fixtures.ordinary20);
    await act(async () => deliverSessionMessage(snapshot()));
    fixture = fixtures.ordinary21;
    holdJump = true;
    await act(async () => sender.handleSend('Q20'));
    const target = fixture.full.messages.find((row) => row.content === 'Q20')!;
    let outcome: { status: string } | undefined;
    await act(async () => { void navigate({ id: target.id, turnIndex: 20, sourceRef: target.sourceRef }).then((result) => { outcome = result; }); });
    holdJump = false;
    await act(async () => jumpReleases.forEach((release) => release()));
    check(!outcome, 'An earlier released run in the requested window must not complete the active target');
    await finishRun('/ws/session-stream?sessionId=new-sender-run');
    await waitForNavigation(() => outcome !== undefined);
    check(outcome?.status === 'scrolled', 'Navigation must wait for the owner of the target, independently of the response start');
  });
  await run('navigation-survives-refresh', async () => {
    realList = true;
    await mount('navigation-survives-refresh', fixtures.ordinary20);
    holdJump = true;
    let outcome: { status: string } | undefined;
    await act(async () => { void navigate({ id: fixture.full.messages[0].id, turnIndex: 0 }).then((result) => { outcome = result; }); });
    holdJump = false;
    await refresh();
    await act(async () => jumpReleases.forEach((release) => release()));
    await waitForNavigation(() => outcome !== undefined);
    check(outcome?.status === 'scrolled', 'Background data supersession must not cancel the navigation intent');
  });
  await run('navigation-cancel-before-release', async () => {
    realList = true;
    await mount('navigation-cancel-before-release', fixtures.ordinary20);
    await act(async () => { deliverSessionMessage(snapshot()); deliverSessionMessage(writerFrame('run-ended')); });
    let outcome: { status: string } | undefined;
    const count = requests.length;
    await act(async () => { void navigate({ id: fixture.full.messages.find((row) => row.content === 'Q19')!.id, turnIndex: 19 }).then((result) => { outcome = result; }); });
    await act(async () => navigate.cancel());
    check(outcome?.status === 'cancelled', 'Cancelling must finish the user operation before writer release');
    await act(async () => deliverSessionMessage(writerFrame('run-settled')));
    check(outcome?.status === 'cancelled' && requests.slice(count).every((request) => !request.target), 'A cancelled navigation must stay cancelled while ordinary reconciliation proceeds');
  });
  await run('real-list-navigation-after-writer', async () => {
    realList = true;
    await mount('real-list-navigation-after-writer', fixtures.ordinary20);
    await act(async () => { deliverSessionMessage(snapshot()); deliverSessionMessage(writerFrame('run-ended')); });
    let outcome: { status: string } | undefined;
    await act(async () => { void navigate({ id: fixture.full.messages.find((row) => row.content === 'Q19')!.id, turnIndex: 19 }).then((result) => { outcome = result; }); });
    check(!outcome, 'Navigation must remain pending while the target is unavailable');
    await act(async () => deliverSessionMessage(writerFrame('run-settled')));
    await waitForNavigation(() => outcome !== undefined);
    check(outcome?.status === 'scrolled', 'Navigation must acknowledge the real MessageList scroll: '+JSON.stringify(outcome));
    const row = document.querySelector(`[data-message-id="${fixture.full.messages.find((row) => row.content === 'Q19')!.id}"]`)!;
    const container = row.parentElement!.closest('.overflow-y-auto')!;
    check(row.getBoundingClientRect().top >= container.getBoundingClientRect().top && row.getBoundingClientRect().bottom <= container.getBoundingClientRect().bottom, 'Selected row must be at the actual viewport landing position: '+JSON.stringify({ row: row.getBoundingClientRect().top, container: container.getBoundingClientRect().top, scroll: container.scrollTop, height: container.clientHeight, content: container.scrollHeight }));
  });
  await run('persisted-steering-before-delayed-inputs', async () => {
    await mount('persisted-steering-before-delayed-inputs', fixtures.steering20);
    await act(async () => deliverSessionMessage({ type: 'run-idle' }));
    for (const [id, content, offset] of [['run', 'Q19', 0], ['steer', 'steering', 1]] as const) {
      await act(async () => deliverSessionMessage({ type: 'run-event', message: { type: 'user', _human: true, _turnId: id, _ts: startedAt + offset, message: { content } } }));
    }
    await act(async () => deliverSessionMessage({ type: 'run-event', message: { type: 'system', subtype: 'init', _ts: startedAt + 2 } }));
    check(current.messages.filter((message) => message.content === 'Q19').length === 1, 'A delayed launch input must not adopt a later steering input');
    check(current.messages.filter((message) => message.content === 'steering').length === 1, 'Steering input identity must remain independent');
  });
  await run('persisted-user-before-live-init', async () => {
    await mount('persisted-user-before-live-init', fixtures.ordinary20);
    await act(async () => deliverSessionMessage({ type: 'run-idle' }));
    await act(async () => deliverSessionMessage({ type: 'run-event', message: { type: 'user', _human: true, _turnId: 'run', _ts: startedAt, message: { content: 'Q19' } } }));
    await act(async () => deliverSessionMessage({ type: 'run-event', message: { type: 'system', subtype: 'init', _ts: startedAt + 1 } }));
    check(current.messages.filter((message) => message.content === 'Q19').length === 1, 'Adopted disk user must remain in the live task');
  });
  await run('sender-persisted-before-jump', async () => {
    await mount('sender-persisted-before-jump', fixtures.ordinary20);
    await act(async () => sender.handleSend('Q20'));
    fixture = fixtures.ordinary21;
    await act(async () => current.ensureTurnLoaded(0));
    check(current.messages.filter((message) => message.content === 'Q20').length === 1, 'Disk and sender must not publish duplicate inputs');
    check(current.messages.at(-1)?.isStreaming, 'The sender projection must keep its unfinished output');
  });
  await run('pending-jump-lifecycle', async () => {
    await mount('pending-jump-lifecycle', fixtures.ordinary20);
    await act(async () => { deliverSessionMessage(snapshot()); deliverSessionMessage(writerFrame('run-ended')); });
    let resolved = false;
    let pending: Promise<unknown>;
    await act(async () => { pending = current.ensureTurnLoaded(19).then((result) => { resolved = true; return result; }); });
    check(!resolved, 'An unconfirmed writer boundary must not complete the jump');
    await act(async () => { deliverSessionMessage(writerFrame('run-settled')); await pending!; });
    check(resolved && current.messages.some((message) => message.content === 'Q19'), 'Jump must resume through its own data read');
  });
  await run('deleted-prefix-then-next-run', async () => {
    await mount('deleted-prefix-then-next-run', fixtures.ordinary20);
    fixture = fixtures.deleted19;
    await more();
    check(current.messages.some((message) => message.content === 'Q19'), 'Replacement page must contain the previous tail: ' + JSON.stringify({ messages: current.messages.map((row) => row.content), requests }));
    await act(async () => deliverSessionMessage({ type: 'run-event', message: { type: 'user', _human: true, _turnId: 'next', _ts: startedAt + 1000, message: { content: 'Q20' } } }));
    await act(async () => deliverSessionMessage({ type: 'run-event', message: { type: 'system', subtype: 'init', _ts: startedAt + 1050 } }));
    check(current.messages.some((message) => message.content === 'Q19'), 'Source rewrite must preserve the final prior task: ' + JSON.stringify({ messages: current.messages.map((row) => [row.content, row.turnStartedAt]), requests }));
    check(!current.messages.some((message) => message.content === 'Q5'), 'Deleted tasks must not return from an old coordinate window');
  });
  for (const mode of ['ordinary', 'steering', 'noUser']) {
    await run(`initial-${mode}`, async () => {
      await mount(`initial-${mode}`, fixtures[`${mode}20`]);
      await more();
      check(requests.at(-1)?.beforeTurnIndex === 10 && allAnswers(20), 'First backward page must load all tasks exactly once');
      check(!current.hasMoreHistory, 'All older history is loaded');
    });
  }
  for (const variant of ['ordinary', 'steering', 'unpersisted', 'short']) {
    await run(`live-first-${variant}`, async () => {
      holdInitial = true;
      await mount(`live-first-${variant}`, variant === 'unpersisted' ? fixtures.ordinary19
        : variant === 'short' ? fixtures.short : fixtures[`${variant}20`]);
      await act(async () => deliverSessionMessage(snapshot(variant === 'steering', variant === 'short' ? 1 : 19)));
      await act(async () => releases.forEach((release) => release()));
      holdInitial = false;
      check(current.messages.some((m) => m.content === (variant === 'short' ? 'Q0' : 'Q18')), 'Protected first load must apply the known history prefix');
      const liveIds = current.messages.map((m) => m.id);
      await more();
      const expected = variant === 'short' ? 1 : 19;
      if (variant !== 'short') check(!current.hasMoreHistory, 'Paging must reach the start without gaps');
      check(current.messages.some((m) => m.content === `Q${expected - 1}`), 'Task directly before the live task is visible');
      check(liveIds.every((id) => current.messages.some((m) => m.id === id)), 'History must preserve every live bubble');
    });
  }
  await run('replay-after-jump', async () => {
    await mount('replay-after-jump');
    await act(async () => current.ensureTurnLoaded(19));
    await act(async () => deliverSessionMessage(snapshot(true)));
    await act(async () => deliverSessionMessage(snapshot(true)));
    await more();
    check(requests.at(-1)?.beforeTurnIndex === 19, 'Replay must retain the known task cursor');
    check(current.messages.filter((m) => m.content === 'Q18').length === 1, 'Task 18 must appear exactly once');
  });
  await run('overlapping-incremental', async () => {
    await mount('overlapping-incremental');
    await act(async () => current.ensureTurnLoaded(5));
    fixture = fixtures.steering21;
    await refresh(); await more();
    check(allAnswers(21), 'Retained older prefix must keep its cursor');
  });
  await run('non-overlapping-incremental', async () => {
    await mount('non-overlapping-incremental');
    fixture = fixtures.steering35;
    await refresh(); await more();
    check(requests.at(-1)?.beforeTurnIndex === 10 || requests.at(-1)?.beforeTurnIndex === undefined, 'Background reads must cover the requested window');
    await more(); await more();
    check(allAnswers(35) && !current.hasMoreHistory, 'Replacement can recover all history without gaps');
  });
  await run('fully-loaded-incremental', async () => {
    await mount('fully-loaded-incremental'); await more(); fixture = fixtures.steering21; await refresh();
    const count = requests.length; await more();
    check(allAnswers(21) && !current.hasMoreHistory && requests.length === count, 'Incremental suffix must not reopen a fully loaded window');
  });
  await run('forced-reload', async () => {
    await mount('forced-reload'); await more(); await refresh(false); await more();
    check(requests.at(-1)?.beforeTurnIndex === 10 && allAnswers(20), 'Forced reload must reset the visible boundary');
  });
  await run('cached-not-modified', async () => {
    await mount('cached-not-modified');
    await act(() => root!.unmount()); root = undefined;
    notModified = true;
    await mount('cached-not-modified'); await more();
    check(requests.some((request) => request.ifFingerprint), 'Expected a first-page cache hit');
    check(requests.at(-1)?.beforeTurnIndex === 10 && allAnswers(20), 'Cached pagination must retain the server cursor');
  });
  await run('empty-incremental', async () => {
    await mount('empty-incremental'); emptyResponse = true; await refresh(); emptyResponse = false; await more();
    check(requests.at(-1)?.beforeTurnIndex === 10 && allAnswers(20), 'Empty suffix must preserve the window');
  });
  await run('legacy-cursor', async () => {
    legacyResponse = true; await mount('legacy-cursor'); await more();
    check(requests.at(-1)?.beforeTurnIndex === 10 && allAnswers(20), 'Legacy response must use task counts');
  });
  await run('live-first-no-user', async () => {
    holdInitial = true;
    await mount('live-first-no-user', fixtures.noUser20);
    const event = snapshot();
    event.events.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'A19' }] } } as never);
    await act(async () => deliverSessionMessage(event));
    await act(async () => releases.forEach((release) => release())); holdInitial = false;
    await loadAll();
    check(current.messages.filter((m) => m.content === 'A19').length === 1, 'Assistant-only current task must appear once');
    check(allAnswers(20), 'Assistant-only live task must retain every prior task');
  });
  await run('multi-task-jump-replay', async () => {
    await mount('multi-task-jump-replay', fixtures.claude20);
    await act(async () => current.ensureTurnLoaded(19));
    const event = {
      type: 'run-snapshot', status: 'running', runId: 'resident', startedAt: startedAt - 1000,
      events: [
        { type: 'user', _human: true, _turnId: 'first', _ts: startedAt - 1000, message: { content: 'Q18' } },
        { type: 'system', subtype: 'init' }, { type: 'result', result: 'A18' },
        { type: 'user', _human: true, _turnId: 'second', _ts: startedAt, message: { content: 'Q19' } },
        { type: 'system', subtype: 'init' },
      ],
    };
    await act(async () => deliverSessionMessage(event)); await more();
    check(requests.at(-1)?.beforeTurnIndex === 19, 'Multi-round replay must preserve the disk paging boundary');
    check(current.messages.filter((m) => m.content === 'Q18').length === 1, 'Round 18 must appear once');
  });
  await run('cached-live-gap', async () => {
    await mount('cache-gap', fixtures.ordinary20);
    await act(() => root!.unmount()); root = undefined;
    holdInitial = true; await mount('cache-gap', fixtures.steering35);
    const event = snapshot(false, 34); event.startedAt = startedAt + 15000; event.events[0]._ts = startedAt + 15000;
    await act(async () => deliverSessionMessage(event));
    await act(async () => releases.forEach((release) => release())); holdInitial = false;
    await loadAll();
    for (let i = 0; i < 34; i++) check(current.messages.filter((m) => m.content === `Q${i}`).length === 1, `Missing or duplicated task ${i}`);
  });
  await run('pagination-jump-race', async () => {
    await mount('pagination-jump-race'); holdBefore = true;
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => { pending = current.loadMoreHistory(); });
    await act(async () => current.ensureTurnLoaded(5));
    holdBefore = false; await act(async () => { beforeReleases.forEach((release) => release()); await pending; });
    check(current.messages.filter((m) => m.content === 'Q5').length === 1, 'A stale before-page must not duplicate the jump window');
    check(current.hasMoreHistory, 'Jump start must remain 5 after the stale response');
  });
  for (const mobile of [false, true]) await run(mobile ? 'mobile-full-completion' : 'protected-fingerprint-completion', async () => {
    holdInitial = true; completionLimit = mobile ? undefined : 10;
    await mount(`completion-${mobile}`, fixtures.ordinary20);
    await act(async () => deliverSessionMessage(snapshot()));
    await act(async () => releases.forEach((release) => release())); holdInitial = false; notModified = true;
    await act(async () => deliverSessionMessage({ type: 'run-event', message: { type: 'result', result: 'A19', subtype: 'success' } }));
    await finishRun();
    check(!requests.at(-1)?.ifFingerprint, 'Completion must read unapplied canonical content');
    check(current.messages.some((m) => m.content === 'A19') && !current.messages.some((m) => m.id.startsWith('live-')), 'Completion must converge to persisted IDs');
    if (mobile) check(allAnswers(20), 'No-limit completion must apply the full response');
  });
  await run('duplicate-page-call', async () => {
    await mount('duplicate-page-call'); const count = requests.length;
    await act(async () => { await Promise.all([current.loadMoreHistory(), current.loadMoreHistory()]); });
    check(requests.length === count + 1 && allAnswers(20), 'Same-tick paging must issue exactly one request');
  });
  await run('live-without-human-seed', async () => {
    holdInitial = true; await mount('live-without-human-seed', fixtures.noUser20);
    await act(async () => deliverSessionMessage({ type: 'run-snapshot', status: 'running', runId: 'empty-prompt', startedAt,
      events: [{ type: 'system', subtype: 'init', _ts: startedAt }, { type: 'assistant', message: { content: [{ type: 'text', text: 'A19' }] } }] }));
    await act(async () => releases.forEach((release) => release())); holdInitial = false;
    await loadAll();
    check(allAnswers(20), 'A run without a synthetic human seed must align its assistant to the persisted task');
  });
  await run('autonomous-multi-task-replay', async () => {
    await mount('autonomous-multi-task-replay', fixtures.noUser20); await act(async () => current.ensureTurnLoaded(19));
    await act(async () => deliverSessionMessage({ type: 'run-snapshot', status: 'running', runId: 'autonomous', startedAt: startedAt - 1000,
      events: [
        { type: 'system', subtype: 'init', _ts: startedAt - 1000 }, { type: 'assistant', message: { content: [{ type: 'text', text: 'A18' }] } },
        { type: 'result', result: 'A18' }, { type: 'system', subtype: 'init', _ts: startedAt },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'A19' }] } },
      ] }));
    await more();
    check(requests.at(-1)?.beforeTurnIndex === 19, 'Autonomous rounds must not replace the disk paging boundary');
    check(current.messages.filter((m) => m.content === 'A18').length === 1, 'Autonomous round 18 must appear once');
  });
  await run('full-get', async () => {
    await mount('full-get'); await act(async () => current.loadHistoryByCwdAndSessionId('/isolated-history-test', sid, false, undefined, undefined, true));
    check(allAnswers(20) && !current.hasMoreHistory, 'Legacy full GET must apply every task');
  });
  await run('live-full-get', async () => {
    await mount('live-full-get'); await act(async () => deliverSessionMessage(snapshot()));
    await act(async () => current.loadHistoryByCwdAndSessionId('/isolated-history-test', sid, false, undefined, undefined, true));
    check(current.messages.some((m) => m.content === 'Q0'), 'Full GET must apply the complete prior prefix');
    check(current.messages.some((m) => m.id.startsWith('live-')), 'Full GET must preserve the current live task');
    check(current.messages.filter((m) => m.content === 'Q19').length === 1, 'Full GET must not duplicate the current task');
  });
  await run('completion-before-old-response', async () => {
    holdInitial = true; await mount('completion-before-old-response', fixtures.ordinary20);
    await act(async () => deliverSessionMessage(snapshot())); holdInitial = false;
    await finishRun();
    await act(async () => releases.forEach((release) => release()));
    check(current.messages.some((m) => m.content === 'A19') && !current.messages.some((m) => m.liveRunId), 'A late initial page must not undo completion');
  });
  await run('refresh-supersedes-page', async () => {
    await mount('refresh-supersedes-page'); holdBefore = true;
    let pending: Promise<unknown> = Promise.resolve(); await act(async () => { pending = current.loadMoreHistory(); });
    fixture = fixtures.steering35; await refresh(); holdBefore = false;
    await act(async () => { beforeReleases.forEach((release) => release()); await pending; });
    check(allAnswers(35) && !current.hasMoreHistory && !current.isLoadingMore, 'A superseding read must satisfy the requested range and release paging');
  });
  await run('full-get-supersedes-page', async () => {
    await mount('full-get-supersedes-page'); holdBefore = true;
    let pending: Promise<unknown> = Promise.resolve(); await act(async () => { pending = current.loadMoreHistory(); });
    await act(async () => current.loadHistoryByCwdAndSessionId('/isolated-history-test', sid, false, undefined, undefined, true)); holdBefore = false;
    await act(async () => { beforeReleases.forEach((release) => release()); await pending; });
    check(allAnswers(20) && !current.hasMoreHistory && !current.isLoadingMore, 'A full GET must release superseded paging and ignore its stale response');
  });
  await run('originator-paging', async () => {
    await mount('originator-paging');
    await act(async () => { current.onSenderStart({ id: 'test-sender', startedAt: startedAt + 1000 }); current.setRunMessages('test-sender', (messages) => [...messages,
      { id: 'user-new-run', role: 'user', content: 'Next prompt' },
      { id: 'assistant-new-run', role: 'assistant', content: 'Still streaming', isStreaming: true },
    ]); });
    await more();
    check(allAnswers(20) && !current.hasMoreHistory, 'Originator paging must retain the complete canonical prefix');
    check(current.messages.at(-1)?.content === 'Still streaming' && current.messages.at(-1)?.isStreaming, 'Originator paging must preserve the unpersisted reply');
  });
  await run('rejected-injection-preserves-input-and-active-writer', async () => {
    await mount('rejected-injection', fixtures.claude20);
    await act(async () => sender.handleSend('Active prompt'));
    const activeId = senderRunId;
    rejectSend = true;
    let rejected = false;
    await act(async () => { await sender.injectMessage('Rejected injection', [{ media_type: 'image/png', data: 'aGVsbG8=', id: 'img', preview: 'data:image/png;base64,aGVsbG8=' }], sid).catch(() => { rejected = true; }); });
    check(rejected && sender.isLoading, 'Rejection must not end the active writer');
    const copy = current.recoveryCopies.at(-1);
    if (!copy) throw new Error('Rejected input must create a recovery copy');
    check(copy.messages[0].content === 'Rejected injection' && copy.messages[0].images?.[0].data === 'aGVsbG8=', 'Recovery must retain text and attachment');
    check(copy.messages.some(row => row.streamError === 'Admission rejected'), 'Recovery must retain the rejection reason');
    check(!current.messages.some(row => row.content === 'Rejected injection'), 'Rejected input must stay outside history');
    await act(async () => deliverSessionMessage({ type: 'run-event', message: { type: 'run-ended', runId: activeId, writerActive: false, status: 'idle' } }));
    check(!sender.isLoading && current.recoveryCopies.some(row => row.id === copy.id), 'Writer completion must preserve the rejected copy');
    rejectSend = false;
    await act(async () => sender.handleSend('Next prompt'));
    check(current.recoveryCopies.some(row => row.id === copy.id), 'Next admission must preserve the rejected copy');
  });
  for (const idleFirst of [false, true]) await run(`cached-unobserved-writer-${idleFirst}`, async () => {
    const name = `cached-unobserved-writer-${idleFirst}`;
    await mount(name, fixtures.ordinary20);
    await act(async () => root!.unmount()); root = undefined;
    notModified = true; validationStable = false; holdInitial = idleFirst;
    await mount(name, fixtures.ordinary20);
    check(requests.some(request => 'ifFingerprint' in request), 'Reentry must revalidate the cached fingerprint');
    fixture = fixtures.ordinary21;
    const reads = requests.length;
    holdInitial = false;
    await act(async () => { deliverSessionMessage({ type: 'run-snapshot', status: 'idle', writerActive: false, runId: 'unobserved', startedAt: startedAt + 1000, events: [] }); });
    if (idleFirst) await act(async () => { releases.splice(0).forEach(release => release()); });
    check(current.messages.some(row => row.content === 'Q20'), 'Idle must reconcile the completed unseen writer');
    check(requests.length === reads + 1, 'One final read must satisfy the unstable validation');
    validationStable = true; notModified = false;
  });
  await run('rejected-injection-on-viewer-and-new-session', async () => {
    loadOnMount = false; hydrateSession = true;
    await mount('rejected-injection-new-session', fixtures.claude20);
    await act(async () => selectSession(sid));
    rejectSend = true;
    await act(async () => sender.injectMessage('Input before first history read', undefined, sid).catch(() => {}));
    check(current.recoveryCopies.length === 1 && !sender.isLoading, 'A new session without disk history must retain a rejected input');
    holdSend = true;
    let pending!: Promise<void>;
    await act(() => { pending = sender.injectMessage('Old view request', undefined, sid).catch(() => {}); });
    await act(async () => selectSession('different-session'));
    holdSend = false;
    await act(async () => { sendRelease!(); await pending; });
    check(current.recoveryCopies.length === 1, 'A late rejection must not enter a different session');
  });
  await run('unstable-validation-waits-for-next-idle-without-polling', async () => {
    const name = 'unstable-validation-repeat';
    await mount(name, fixtures.ordinary20);
    await act(async () => deliverSessionMessage({ type: 'run-idle' }));
    notModified = true; validationStable = false; emptyResponse = true;
    await act(async () => current.loadHistoryByCwdAndSessionId('/isolated-history-test', sid, false, 10));
    const reads = requests.length;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    check(requests.length === reads, 'An unstable read must not poll the writer');
    emptyResponse = false; notModified = false; validationStable = true; fixture = fixtures.ordinary21;
    await act(async () => deliverSessionMessage({ type: 'run-idle' }));
    check(requests.length === reads + 1 && current.messages.some(row => row.content === 'Q20'), 'A new idle observation must permit the final read');
  });
  document.getElementById('result')!.textContent = JSON.stringify(results);
}
void main().catch((error) => { document.getElementById('result')!.textContent = JSON.stringify({ fatal: String(error) }); });
