import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useChatHistory } from '../useChatHistory';
import { useChatStream } from '../useChatStream';
import { useLiveStream } from '../useLiveStream';
import { useWebSocket } from '@cockpit/shared-ui';
import { deriveContent } from '../../shared/assistantText';

declare const __TEST_CWD__: string;
const params = new URL(location.href).searchParams;
const mode = params.get('mode')!;
const session = params.get('session')!;
const request = globalThis.fetch.bind(globalThis);
const wire: unknown[] = [];
const NativeSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NativeSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener('message', (event) => wire.push(JSON.parse(String(event.data))));
  }
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clock = Date.now;
if (mode === 'sender-clock-skew') Date.now = () => clock() + 60000;
let current!: ReturnType<typeof useChatHistory>;
let sender!: ReturnType<typeof useChatStream>;
let idleSeen = false;
let jump: Awaited<ReturnType<typeof current.ensureTurnLoaded>> | undefined;
let setViewerEnabled!: (enabled: boolean) => void;
function App() {
  const [sid, setSid] = useState<string | null>(session);
  const [viewerEnabled, setEnabled] = useState(true);
  const history = useChatHistory(sid, { cwd: __TEST_CWD__, initialSessionId: session, onSessionId: setSid });
  const stream = useChatStream(history.messages, history.setRunMessages, {
    sessionId: sid, cwd: __TEST_CWD__, engine: 'grok', onSessionId: setSid, onFetchTitle: () => {},
    onSendStart: history.onSenderStart, onRunAccepted: history.onRunAccepted,
    onRunEnd: history.onLiveRunEnd, onRecoveryDeleted: history.onRecoveryDeleted, onSendFailure: history.onSendFailure, onInputRejected: history.onInputRejected,
  });
  useLiveStream(history.loadedSessionId || sid, history.setRunMessages, viewerEnabled && !stream.isLoading && !!sid, 'grok', {
    onSnapshotStart: history.onLiveSnapshotStart, onRunEnd: history.onLiveRunEnd, onRecoveryDeleted: history.onRecoveryDeleted,
    onWriterIdle: (id) => {
      history.onWriterIdle(id);
      if (!idleSeen) { idleSeen = true; void request('/idle-seen'); }
    },
  });
  // Keep a second consumer on the session URL across the sender/viewer handoff.
  useWebSocket({ url: `/ws/session-stream?sessionId=${encodeURIComponent(session)}`,
    enabled: mode === 'sender-reconnect-successor-shared', onMessage: () => {} });
  useLayoutEffect(() => { current = history; sender = stream; setViewerEnabled = setEnabled; }, [history, stream]);
  return <div>{stream.drainingSubscriptions}{history.messages.map((message) => <p key={message.id}>{message.content}</p>)}</div>;
}
async function until(condition: () => boolean) {
  const deadline = clock() + 5000;
  while (!condition()) {
    if (clock() > deadline) throw new Error(`Timed out in ${mode}`);
    await pause(10);
  }
}
createRoot(document.getElementById('root')!).render(<App />);
void (async () => {
  try {
    if (mode === 'rejection-drain') {
      await until(() => current?.messages.some((row) => row.content === 'Input A') === true);
      const snapshots = () => wire.filter((frame) => (frame as { type: string }).type === 'run-snapshot').length;
      const before = snapshots();
      await sender.handleSend('New rejected prompt');
      await until(() => snapshots() > before);
    } else if (mode.startsWith('failure')) {
      await until(() => !!current?.loadedSessionId);
      if (!mode.endsWith('sender')) {
        await until(() => current.messages.some((row) => row.content === 'A partial'));
        await request('/finish-a');
        await until(() => current.messages.some((row) => row.content === 'A final'));
        if (mode.endsWith('snapshot') || mode === 'failure-persisted') {
          setViewerEnabled(false);
          await request('/disconnect');
        }
        await request('/api/chat/grok', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd: __TEST_CWD__, sessionId: session, runId: 'failed-run', prompt: 'New prompt' }) });
        if (mode.endsWith('snapshot') || mode === 'failure-persisted') setViewerEnabled(true);
      } else await sender.handleSend('New prompt');
      await until(() => current.recoveryCopies.some((copy) => copy.messages.some((row) => row.content.includes('Initialization failed')))
        && (!mode.includes('output') || current.messages.some((row) => row.content === 'Final stored output')));
      if (!mode.includes('output')) await current.loadHistoryByCwdAndSessionId(__TEST_CWD__, session, true, 10, undefined, true);
      for (let page = 0; page < 3 && current.hasMoreHistory; page++) { await current.loadMoreHistory(); await pause(10); }
      await until(() => current.messages.some((row) => row.content === 'Old prompt 0'));
      if (!current.recoveryCopies.some((copy) => copy.messages.some((row) => row.content.includes('Initialization failed')))) throw new Error('Disk reconciliation erased the startup error');
      if (mode.includes('output')) {
        const response = await request('/api/session-by-path', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd: __TEST_CWD__, sessionId: session }) });
        const data = await response.json();
        const target = data.messages.find((row: { content: string }) => row.content === 'New prompt');
        jump = await current.ensureTurnLoaded(data.totalTurns - 1, target.sourceRef);
        if (jump.status !== 'ready' || !jump.messageId) throw new Error(`Persisted input is not addressable: ${jump.status}`);
        const resolvedId = jump.messageId;
        await until(() => current.hasMoreHistory && current.messages.some((row) => row.id === resolvedId)
          && !current.messages.some((row) => row.content === 'Old prompt 0'));
        for (let page = 0; page < 3 && current.hasMoreHistory; page++) { await current.loadMoreHistory(); await pause(10); }
        await until(() => current.messages.some((row) => row.content === 'Old prompt 0'));
        for (let reconnect = 0; reconnect < 2; reconnect++) {
          const readCount = (await (await request('/stats')).json()).requests.length;
          setViewerEnabled(false);
          await request('/disconnect');
          const snapshots = wire.filter((frame) => (frame as { type: string }).type === 'run-snapshot').length;
          setViewerEnabled(true);
          await until(() => wire.filter((frame) => (frame as { type: string }).type === 'run-snapshot').length > snapshots
            && current.messages.some((row) => row.content === 'Final stored output')
            && !current.messages.some((row) => row.content.includes('Partial')));
          await pause(80);
          const reads = (await (await request('/stats')).json()).requests.length;
          if (reads !== readCount + 1) throw new Error(`Reconnect must perform one reconciliation: ${readCount} -> ${reads}`);
          if (current.recoveryCopies.flatMap((copy) => copy.messages).filter((row) => row.content.includes('Initialization failed')).length !== 1) throw new Error('Reconnect duplicated the error');
        }
      }
    } else if (mode.startsWith('sender-reconnect-successor')) {
      await until(() => !!current?.loadedSessionId);
      await sender.handleSend('New prompt');
      await until(() => current.messages.some((row) => row.content === 'Streaming answer'));
      const snapshots = wire.filter((frame) => (frame as { type: string }).type === 'run-snapshot').length;
      await request('/advance-sender');
      await until(() => wire.filter((frame) => (frame as { type: string }).type === 'run-snapshot').length > snapshots);
      if (!mode.endsWith('-completed')) {
        await until(() => !sender.isLoading && current.messages.some((row) => row.content === 'B partial'));
        await request('/settle-b');
      }
      await until(() => !sender.isLoading && current.messages.some((row) => row.content === 'B final'));
      const evidence = { isLoading: sender.isLoading, messages: current.messages.map((row) => row.content), wire,
        stats: await (await request('/stats')).json() };
      document.getElementById('result')!.textContent = JSON.stringify(evidence);
      return;
    } else if (mode.startsWith('sender')) {
      await until(() => !!current?.loadedSessionId);
      await sender.handleSend('New prompt');
      await until(() => current.messages.some((row) => row.content === 'Streaming answer'));
      await current.loadMoreHistory();
      await until(() => current.messages.some((row) => row.content === 'Old prompt 0'));
    } else if (mode.startsWith('reentry')) {
      await until(() => !!current?.loadedSessionId && current.messages.some((row) => row.content === 'A partial'));
      setViewerEnabled(false);
      await request('/disconnect');
      await request('/advance');
      // The replacement snapshot must only retire the viewer's prior writer;
      // a concurrent local send has a separate identity even with clock skew.
      if (mode === 'reentry-pending' || mode === 'reentry-accepted') {
        const run = { id: 'run-c', startedAt: 1 };
        current.onSenderStart(run);
        current.setRunMessages(run.id, [{ id: 'c-answer', role: 'assistant', content: 'C streaming', isStreaming: true }]);
        if (mode === 'reentry-accepted') current.onRunAccepted({ ...run, startedAt: clock() });
      }
      setViewerEnabled(true);
      await until(() => current.messages.some((row) => row.content === 'A final'));
      if (['reentry-draining', 'reentry-running', 'reentry-failed'].includes(mode)) {
        await until(() => current.messages.some((row) => row.content === 'B partial'));
        await request('/settle-b');
      }
      await until(() => current.messages.some((row) => row.content === 'B final'));
    } else if (mode.startsWith('epoch') || mode.startsWith('rewrite')) {
      await until(() => !!current?.loadedSessionId);
      await current.loadMoreHistory();
      await until(() => current.messages.some((row) => row.content === 'Old prompt 80'));
      const target = current.messages.find((row) => row.content === 'Old prompt 80')!.sourceRef!;
      await request('/rewrite');
      if (mode === 'epoch-refresh') await current.loadHistoryByCwdAndSessionId(__TEST_CWD__, session, true, 10, undefined, true);
      else await current.loadMoreHistory();
      await until(() => current.messages.filter((row) => row.role === 'user').length === 10);
      // A discarded request boundary must not widen the next background refresh.
      await current.loadHistoryByCwdAndSessionId(__TEST_CWD__, session, true, 10, undefined, true);
      await current.loadMoreHistory();
      await until(() => current.messages.filter((row) => row.role === 'user').length === 20);
      const jump = await current.ensureTurnLoaded(80, target);
      if (jump.status !== 'ready') throw new Error(`Native target was not recovered: ${jump.status}`);
      await until(() => current.messages.some((row) => row.id === jump.messageId));
    } else {
      if (mode === 'cold-page-first') {
        await until(() => !!current?.messages.some((row) => row.content === 'Cold prompt'));
        await request('/connect');
      }
      await until(() => !!current?.messages.some((row) => row.content === 'Final drained answer'));
    }
    for (const row of current.messages) {
      if (row.parts?.length && deriveContent(row.parts) !== row.content) throw new Error('Rendered message parts differ from content');
    }
    // A stable result must not keep scheduling reconciliation reads.
    await pause(80);
    const stats = await (await request('/stats')).json();
    document.getElementById('result')!.textContent = JSON.stringify({ messages: current.messages.map((row) => row.content), recovery: current.recoveryCopies.flatMap((copy) => copy.messages).map((row) => row.content), jump, stats });
  } catch (error) {
    document.getElementById('result')!.textContent = JSON.stringify({ error: String(error), messages: current?.messages.map((row) => row.content), wire, stats: await (await request('/stats')).json() });
  }
})();
