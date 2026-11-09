import { createServer, type Server } from 'node:http';
import { splitTurns } from '../shared/chatTurns';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureBrowserDom } from './__tests__/browserDom';
import { build } from 'esbuild';
import { deleteCodexTurnLines } from '../server/api/session/codexFork';
import { parseCodexTranscriptFile, parseTranscriptFile } from '../server/api/session/transcriptParsers';
import { historyWindow } from '../server/historyWindow';
import { addRunListener, markRunIdle, releaseRun, startRun } from '../server/sessionRunHub';
import { Effect } from 'effect';
import { dispatchChat } from '../server/engines/orchestrator';
import { makePiRunInput } from '../effect/piRunInputLive';

// Exercise the production SDK adapter and registry; replace only the external CLI.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<{ uuid: string }> }) => (async function* () {
    const input = prompt[Symbol.asyncIterator]();
    const first = await input.next();
    yield { type: 'system', subtype: 'init' };
    await input.next();
    yield { type: 'stream_event', user_message_uuid: first.value.uuid, event: { type: 'message_start' } };
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Owned by first input' } } };
    yield { type: 'result', is_error: true, user_message_uuid: first.value.uuid, errors: ['Failure before queued consumption'] };
  })(),
}));

const browser = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((candidate): candidate is string => !!candidate && existsSync(candidate));

// Actual React/history/live hooks; only HTTP and WS delivery are controlled.
// CHROME_BIN enables this suite on runners without a browser at a standard path.
describe.skipIf(!browser)('history and live replay in a browser', () => {
  let directory: string;
  let historyServer: Server;
  let results: Record<string, string>;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cockpit-history-integration-'));
    const lifecycle: Record<string, { type: string; message: unknown }> = {};
    startRun(directory, directory, undefined, 'run');
    const off = addRunListener(directory, (event) => {
      lifecycle[(event.message as { type: string }).type] = { type: 'run-event', message: event.message };
    });
    markRunIdle(directory);
    releaseRun(directory);
    off();
    const hub = await import('../server/sessionRunHub');
    const { runSdkLoop } = await import('../server/engines/shared/sdkLoop');
    const sdkId = 'sdk-browser-run';
    hub.startRun(sdkId, directory, 'Q19', sdkId, 'claude');
    try {
      await runSdkLoop({ prompt: 'Q19', images: undefined, sessionId: undefined, cwd: directory, params: { runId: sdkId }, signal: new AbortController().signal,
        currentKey: () => sdkId, rekey: () => {}, acceptInput: sink => hub.setRunInjector(sdkId, sink),
        emit: event => {
          hub.appendRun(sdkId, event);
          if (event.type === 'system' && event.subtype === 'init') {
            expect(hub.injectRun(sdkId, { text: 'Keep queued input' }, 'unconsumed')).toBe('ok');
          }
        },
      }, () => ({}));
    } catch (error) {
      expect(error).toMatchObject({ message: 'Failure before queued consumption' });
      hub.appendRun(sdkId, { type: 'error', error: String((error as Error).message) });
    }
    hub.markRunIdle(sdkId, 'error'); hub.releaseRun(sdkId);
    const claudeEvents = hub.getRunSnapshot(sdkId)!.events;
    // Control only the runner's SDK timing. Admission, Stop, settlement delivery,
    // writer handoff and reconnect snapshots use the production dispatch path.
    const stoppedId = 'stopped-browser-run';
    const stopFrames: unknown[] = [];
    const stopped: { snapshot: ReturnType<typeof hub.getRunSnapshot> } = { snapshot: null };
    const stopOff = hub.addRunListener(stoppedId, event => {
      stopFrames.push({ type: 'run-event', message: event.message });
      if ((event.message as { type: string }).type === 'run-settled') {
        stopped.snapshot = hub.getRunSnapshot(stoppedId);
        stopOff();
      }
    });
    let finish!: () => void;
    let ready!: () => void;
    const drain = new Promise<void>(resolve => { finish = resolve; });
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const image = { type: 'base64' as const, media_type: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR8sAAAAASUVORK5CYII=' };
    let successorSnapshot: object;
    let beforeSettlement: number;
    try {
      await dispatchChat({ name: 'ollama', runner: { run: ctx => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const input = yield* makePiRunInput(ctx, pending => Effect.sync(() => ctx.emit({ type: 'error',
          error: 'Input did not complete because the run was cancelled.', undeliveredInputs: pending })));
        yield* input.next;
        ctx.emit({ type: 'system', subtype: 'input_started', inputId: stoppedId });
        ctx.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Observed before Stop' } } });
        ready();
        yield* Effect.promise(() => drain);
        ctx.emit({ type: 'system', subtype: 'input_binding', inputId: stoppedId, sourceId: 'user-19' });
      }))) } }, { prompt: 'Q19', runId: stoppedId });
      await entered;
      expect(hub.injectRun(stoppedId, { images: [image] }, 'image-input')).toBe('ok');
      hub.requestStop(stoppedId);
      beforeSettlement = stopFrames.length;
      const successor = dispatchChat({ name: 'ollama', runner: { run: ctx => {
        ctx.emit({ type: 'system', subtype: 'init', session_id: stoppedId });
        return new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
      } } }, { prompt: 'New input', sessionId: stoppedId, runId: 'successor-browser-run' });
      finish();
      expect(await hub.waitForWriter(stoppedId, 1000)).toBe(true);
      expect(stopped.snapshot).toMatchObject({ status: 'error', writerActive: false });
      expect((await successor).ok).toBe(true);
      successorSnapshot = { type: 'run-snapshot', ...hub.getRunSnapshot(stoppedId), recoveries: hub.getRunRecoveries(stoppedId) };
      expect(hub.getRunRecoveries(stoppedId)).toHaveLength(1);
    } finally {
      stopOff(); finish(); hub.requestStop(stoppedId); await hub.waitForWriter(stoppedId, 1000);
    }
    const stoppedRun = { frames: stopFrames, beforeSettlement, snapshot: { type: 'run-snapshot', ...stopped.snapshot }, successor: successorSnapshot, image };
    const runStart = Date.parse('2026-11-06T00:00:00Z');
    const pages = (messages: Awaited<ReturnType<typeof parseCodexTranscriptFile>>['messages'], version: string, engine = 'codex') => ({
      engine, version, full: historyWindow(messages, {}),
      first: historyWindow(messages, { limit: 10 }),
    });
    const makeFixture = async (count: number, mode: string, activeTask = 19, removed = -1) => {
      const rows: unknown[] = [];
      for (let n = 0; n < count; n++) {
        if (n === removed) continue;
        const timestamp = new Date(runStart + (n - activeTask) * 1000 + 100).toISOString();
        const message = (role: string, text: string) => ({
          type: 'response_item', timestamp,
          payload: { type: 'message', role, ...(mode === 'native' ? { id: `${role}-${n}` } : {}), content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
        });
        rows.push({ type: 'event_msg', timestamp, payload: { type: 'task_started' } });
        if (!(mode === 'noUser' && n === activeTask)) rows.push(message('user', `Q${n}`));
        if (mode === 'steering' && n === activeTask) rows.push(message('user', 'steering'));
        rows.push(message('assistant', `A${n}`));
        if (mode === 'failed' && n === activeTask) rows.push({ type: 'event_msg', timestamp, payload: { type: 'task_complete', error: { message: 'Selected model is at capacity.' } } });
      }
      const { messages } = await parseCodexTranscriptFile({ text: rows.map((row) => JSON.stringify(row)).join('\n') });
      return pages(messages, `${mode}-${count}`);
    };
    const claudeRows = Array.from({ length: 20 }, (_, n) => [
      { type: 'user', uuid: `user-${n}`, timestamp: new Date(runStart + (n - 19) * 1000 + 100).toISOString(), message: { role: 'user', content: `Q${n}` } },
      { type: 'assistant', uuid: `answer-${n}`, timestamp: new Date(runStart + (n - 19) * 1000 + 200).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `A${n}` }] } },
    ]).flat();
    const claude = await parseTranscriptFile({ text: claudeRows.map((row) => JSON.stringify(row)).join('\n') });
    const claudeDeleted = await parseTranscriptFile({ text: claudeRows.filter((_, i) => i < 20 || i >= 22).map((row) => JSON.stringify(row)).join('\n') });

    const toolRows = [
      { type: 'event_msg', timestamp: new Date(runStart).toISOString(), payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn', arguments: '{"message":"Review"}' } },
      { type: 'event_msg', payload: { type: 'sub_agent_activity', event_id: 'spawn', agent_thread_id: 'child', agent_path: '/root/child', kind: 'started' } },
      { type: 'response_item', payload: { type: 'agent_message', author: '/root/child', content: 'old report' } },
    ];
    const toolBefore = await parseCodexTranscriptFile({ text: toolRows.map((row) => JSON.stringify(row)).join('\n') });
    const toolAfter = await parseCodexTranscriptFile({ text: [...toolRows, { type: 'response_item', payload: { type: 'agent_message', author: '/root/child', content: 'new report' } }].map((row) => JSON.stringify(row)).join('\n') });

    const deletionRows = Array.from({ length: 20 }, (_, n) => {
      const timestamp = new Date(runStart + (n - 19) * 1000 + 100).toISOString();
      return [
        { type: 'event_msg', timestamp, payload: { type: 'task_started' } },
        ...['user', 'assistant'].map((role) => ({ type: 'response_item', timestamp, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: `${role === 'user' ? 'Q' : 'A'}${n}` }] } })),
      ];
    }).flat().map((row) => JSON.stringify(row));
    const deletion = deleteCodexTurnLines([JSON.stringify({ type: 'session_meta', payload: { id: 'deleted-fixture' } }), ...deletionRows], 'codex-user-10');
    expect(deletion.targetMissed).toBe(false);
    const deleted = await parseCodexTranscriptFile({ text: deletion.newLines.join('\n') });
    expect(splitTurns(deleted.messages)).toHaveLength(19);
    const toolLongRows = [...toolRows, ...deletionRows.map((line) => JSON.parse(line))];
    const toolLongBefore = await parseCodexTranscriptFile({ text: toolLongRows.map((row) => JSON.stringify(row)).join('\n') });
    const toolLongAfter = await parseCodexTranscriptFile({ text: [...toolLongRows,
      { type: 'response_item', payload: { type: 'agent_message', author: '/root/child', content: 'new report' } },
    ].map((row) => JSON.stringify(row)).join('\n') });
    const fixtures = {
      failed20: await makeFixture(20, 'failed'),
      native20: await makeFixture(20, 'native'), nativeDeleted19: await makeFixture(20, 'native', 19, 18),
      nativeShifted19: await makeFixture(20, 'native', 19, 5),
      deleted19: pages(deleted.messages, 'deleted-19'), ordinary21: await makeFixture(21, 'ordinary'),
      ordinary19: await makeFixture(19, 'ordinary'), ordinary20: await makeFixture(20, 'ordinary'),
      steering20: await makeFixture(20, 'steering'), steering21: await makeFixture(21, 'steering'),
      steering35: await makeFixture(35, 'steering'), noUser20: await makeFixture(20, 'noUser'),
      claude20: pages(claude.messages, 'claude-20', 'claude'),
      claudeDeleted19: pages(claudeDeleted.messages, 'claude-deleted-19', 'claude'),
      piQueued: pages(claude.messages, 'pi-queued', 'ollama'),
      toolBefore: pages(toolBefore.messages, 'tool-before'), toolAfter: pages(toolAfter.messages, 'tool-after'),
      toolLongBefore: pages(toolLongBefore.messages, 'tool-long-before'), toolLongAfter: pages(toolLongAfter.messages, 'tool-long-after'),
      ordinary22: await makeFixture(22, 'ordinary'),
      ordinary36: await makeFixture(36, 'ordinary'),
      short: await makeFixture(2, 'ordinary', 1),
      empty: await makeFixture(0, 'ordinary'),
    };
    historyServer = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      if (req.method === 'OPTIONS') { res.end(); return; }
      let text = '';
      for await (const chunk of req) text += chunk;
      const { fixture: fixtureKey, request, index } = JSON.parse(text);
      const fixture = fixtures[fixtureKey as keyof typeof fixtures];
      const page = historyWindow(fixture.full.messages, request);
      const result = index ? { messages: splitTurns(fixture.full.messages).flatMap((turn, turnIndex) =>
        turn.filter((message) => message.role === 'user').map((message) => ({ ...message, turnIndex }))) } : page;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) => historyServer.listen(0, '127.0.0.1', resolve));
    const address = historyServer.address() as { port: number };
    const historyEndpoint = `http://127.0.0.1:${address.port}`;
    const runtime = join(directory, 'runtime.ts');
    await writeFile(runtime, "import {Effect} from 'effect'; export const BrowserRuntime={runPromiseExit:Effect.runPromiseExit,runPromise:Effect.runPromise};");
    const ui = join(directory, 'ui.tsx');
    await writeFile(ui, `export * from ${JSON.stringify(fileURLToPath(new URL('./__tests__/chatHistoryTransport.ts', import.meta.url)))};
      export const Portal=({children}:any)=>children; export const AIBridgeProvider=Portal;
      export const MODAL_SHELL_CLASS_IN_PROJECT='modal'; export const useEscToClose=()=>{}; export const DEFAULT_QUICK_REPLY_KEYS=[[]];
      export const toast=()=>{}; export const ToolbarRenderer=()=>null; export const AddCommentInput=()=>null; export const SendToAIInput=()=>null;`);
    const comments = join(directory, 'comments.ts');
    await writeFile(comments, `const noop=()=>{}; export const useComments=()=>({addComment:noop,refresh:noop}); export const fetchAllCommentsWithCode=async()=>[];
      export const buildAIMessage=noop; export const clearAllComments=noop; export const sendReferenceToAI=noop; export const CHAT_COMMENT_FILE='chat';`);
    const bubble = join(directory, 'bubble.tsx');
    await writeFile(bubble, `import React from 'react'; export const MessageBubble=({message}:any)=><div style={{minHeight:80}}>{message.content}</div>;`);
    await build({
      entryPoints: [fileURLToPath(new URL('./__tests__/chatHistoryBrowser.tsx', import.meta.url))],
      outfile: join(directory, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife',
      nodePaths: [resolve('node_modules')],
      plugins: [{ name: 'isolate-message-content', setup(build) { build.onResolve({ filter: /MessageBubble$/ }, () => ({ path: bubble })); } }],
      define: { 'process.env.NODE_ENV': '"development"', __STOPPED_RUN__: JSON.stringify(stoppedRun), __CLAUDE_RECOVERY_EVENTS__: JSON.stringify(claudeEvents), __HISTORY_FIXTURES__: JSON.stringify(fixtures), __WRITER_LIFECYCLE__: JSON.stringify(lifecycle), __HISTORY_ENDPOINT__: JSON.stringify(historyEndpoint) },
      alias: {
        '@cockpit/effect-runtime': runtime,
        '@cockpit/effect-core': resolve('packages/shared/effect-core/src/errors.ts'),
        '@cockpit/shared-ui': ui, '@cockpit/feature-comments': comments,
      },
    });
    await writeFile(join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><style>.absolute{position:absolute}.relative{position:relative}.fixed{position:fixed}.hidden{display:none}.shrink-0{flex-shrink:0}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.min-h-0{min-height:0}.overflow-y-auto{overflow-y:auto}.overflow-hidden{overflow:hidden}.py-4{padding-top:16px;padding-bottom:16px}.px-8{padding-left:32px;padding-right:32px}</style><div id="root"></div><pre id="result">RUNNING</pre><script src="./bundle.js"></script>');
    const stdout = await captureBrowserDom(browser!, directory);
    await writeFile(join(directory, 'dom.html'), stdout);
    const output = /<pre id="result">([\s\S]*?)<\/pre>/.exec(await readFile(join(directory, 'dom.html'), 'utf8'))?.[1];
    if (!output || output === 'RUNNING') throw new Error(`Browser did not finish; artifacts: ${directory}`);
    results = JSON.parse(output.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  }, 60_000);
  afterAll(async () => { if (historyServer) await new Promise<void>((resolve) => historyServer.close(() => resolve())); if (directory) await rm(directory, { recursive: true, force: true }); });

  it('passes every browser scenario', () => {
    const scenarios = Object.entries(results);
    expect(scenarios.length).toBeGreaterThan(0);
    for (const [name, result] of scenarios) expect.soft(result, name).toBe('PASS');
  });
});
