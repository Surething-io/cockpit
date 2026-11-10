import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import { captureBrowserDom } from './__tests__/browserDom';

const browser = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((path): path is string => !!path && existsSync(path));
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const row = (role: 'user' | 'assistant', id: string, text: string, time = Date.now()) => JSON.stringify({
  type: role, uuid: id, timestamp: new Date(time).toISOString(),
  message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
}) + '\n';

// Only the model producer is replaced. HTTP routes, persistence, run registry,
// WS handler, shared socket client and React history/stream hooks all execute.
describe.skipIf(!browser)('history ownership through real HTTP and WebSocket boundaries', () => {
  let directory: string;
  let cwd: string;
  let server: Server;
  let sockets: WebSocketServer;
  let port: number;
  let hub: typeof import('../server/sessionRunHub');
  let history: typeof import('../server/api/session-by-path').POST;
  let chat: typeof import('../server/api/chat/grok').POST;
  let pathFor: typeof import('../effect/grokSessionLive').grokSessionPath;
  let spec: typeof import('../server/engines/grok').grokSpec;
  let originalRunner: typeof spec.runner.run;
  let mode = '';
  let session = '';
  let path = '';
  let firstRead = false;
  let socketReady = gate();
  let idleSeen = gate();
  let written = gate();
  let finish = gate();
  let requests: { stable?: boolean; fromTurnIndex?: number; beforeTurnIndex?: number; replacesWindow?: boolean; notModified?: boolean; turns: number }[] = [];
  let admission: { startedAt?: number } | undefined;
  let failures: string[] = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cockpit-history-transport-'));
    vi.stubEnv('COCKPIT_HOME', join(directory, 'data'));
    cwd = join(directory, 'project'); await mkdir(cwd);
    hub = await import('../server/sessionRunHub');
    ({ POST: history } = await import('../server/api/session-by-path'));
    ({ POST: chat } = await import('../server/api/chat/grok'));
    ({ grokSessionPath: pathFor } = await import('../effect/grokSessionLive'));
    ({ grokSpec: spec } = await import('../server/engines/grok'));
    const { runSessionStreamHandler } = await import('../../../../../src/lib/effect/sessionStreamHandler');
    originalRunner = spec.runner.run;
    spec.runner.run = async (context) => {
      if (mode.startsWith('failure')) {
        if (mode === 'failure-persisted' || mode.includes('output')) await appendFile(path, row('user', 'new-user', 'New prompt'));
        if (mode.includes('output')) {
          context.emit({ type: 'system', subtype: 'init', session_id: session });
          context.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial' } } });
          await appendFile(path, row('assistant', 'final-output', 'Final stored output'));
        }
        written.open();
        throw new Error('Initialization failed');
      }
      const done = finish.promise;
      await appendFile(path, row('user', 'new-user', 'New prompt'));
      context.emit({ type: 'system', subtype: 'init', session_id: session });
      context.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Streaming answer' } } });
      written.open();
      await done;
    };
    const runtime = join(directory, 'runtime.ts');
    await writeFile(runtime, `import {Effect} from ${JSON.stringify(resolve('node_modules/effect'))}; export const BrowserRuntime={runPromiseExit:Effect.runPromiseExit,runPromise:Effect.runPromise};`);
    const core = join(directory, 'core.ts');
    await writeFile(core, `export * from ${JSON.stringify(resolve('packages/shared/effect-core/src/errors.ts'))}; export * from ${JSON.stringify(resolve('packages/shared/effect-core/src/schedule.ts'))};`);
    const ui = join(directory, 'ui.ts');
    await writeFile(ui, `export {useWebSocket} from ${JSON.stringify(resolve('packages/shared/ui/src/useWebSocket.ts'))}; export const toast=()=>{};`);
    await build({
      entryPoints: [fileURLToPath(new URL('./__tests__/historyTransportBrowser.tsx', import.meta.url))],
      outfile: join(directory, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', nodePaths: [resolve('node_modules')],
      define: { 'process.env.NODE_ENV': '"development"', __TEST_CWD__: JSON.stringify(cwd) },
      alias: { '@cockpit/effect-runtime': runtime, '@cockpit/effect-core': core, '@cockpit/shared-ui': ui },
    });
    server = createServer(async (req, res) => {
      try {
        if (req.url === '/bundle.js') { res.end(await readFile(join(directory, 'bundle.js'))); return; }
        if (req.url === '/stats') { res.end(JSON.stringify({ requests, admission, failures, snapshot: hub.getRunSnapshot(session) })); return; }
        if (req.url === '/connect') { socketReady.open(); res.end('ok'); return; }
        if (req.url === '/idle-seen') { idleSeen.open(); res.end('ok'); return; }
        if (req.url === '/rewrite') {
          const contents = await readFile(path, 'utf8');
          const replacement = mode.startsWith('rewrite') ? contents.split('\n').slice(2).join('\n') : contents;
          await writeFile(path + '.replacement', replacement);
          await rename(path + '.replacement', path);
          res.end('ok'); return;
        }
        if (req.url === '/advance-sender') {
          for (const client of sockets.clients) client.terminate();
          await appendFile(path, row('assistant', 'answer-a-final', 'A final'));
          finish.open();
          if (!await hub.waitForWriter(session, 5000)) throw new Error('A writer did not release');
          if (!hub.startRun(session, cwd, 'Input B', 'run-b', 'grok')) throw new Error('B admission failed');
          await appendFile(path, row('user', 'input-b', 'Input B'));
          hub.appendRun(session, { type: 'system', subtype: 'init', session_id: session });
          hub.appendRun(session, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'B partial' } } });
          if (mode.endsWith('-draining') || mode.endsWith('-completed')) hub.markRunIdle(session);
          if (mode.endsWith('-completed')) {
            await appendFile(path, row('assistant', 'answer-b', 'B final'));
            hub.releaseRun(session);
          }
          res.end('ok'); return;
        }
        if (req.url === '/disconnect') {
          for (let attempt = 0; sockets.clients.size && attempt < 100; attempt++) await pause(10);
          if (sockets.clients.size) throw new Error('Viewer did not unsubscribe');
          res.end('ok'); return;
        }
        if (req.url === '/finish-a') {
          await appendFile(path, row('assistant', 'answer-a', 'A final'));
          hub.markRunIdle(session); hub.releaseRun(session);
          res.end('ok'); return;
        }
        if (req.url === '/advance') {
          await appendFile(path, row('assistant', 'answer-a', 'A final'));
          if (mode === 'reentry-failed') hub.appendRun(session, { type: 'error', error: 'Failed A' });
          hub.markRunIdle(session, mode === 'reentry-failed' ? 'error' : 'idle'); hub.releaseRun(session);
          if (!hub.startRun(session, cwd, 'Input B', 'run-b', 'grok')) throw new Error('B admission failed');
          await appendFile(path, row('user', 'input-b', 'Input B'));
          hub.appendRun(session, { type: 'system', subtype: 'init', session_id: session });
          hub.appendRun(session, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'B partial' } } });
          if (!['reentry-running', 'reentry-failed'].includes(mode)) hub.markRunIdle(session);
          if (!['reentry-running', 'reentry-failed'].includes(mode) && mode !== 'reentry-draining') {
            await appendFile(path, row('assistant', 'answer-b', 'B final'));
            hub.releaseRun(session);
          }
          res.end('ok'); return;
        }
        if (req.url === '/settle-b') {
          await appendFile(path, row('assistant', 'answer-b', 'B final'));
          hub.markRunIdle(session); hub.releaseRun(session);
          res.end('ok'); return;
        }
        if (req.url?.startsWith('/api/')) {
          let body = ''; for await (const chunk of req) body += chunk;
          const request = new Request(`http://localhost${req.url}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
          let response: Response;
          if (req.url === '/api/chat/grok') {
            response = await chat(request);
            admission = await response.clone().json();
            if (mode !== 'rejection-drain') await written.promise;
            await pause(80);
            if (mode === 'sender-legacy-response') {
              const data = await response.json(); delete data.startedAt;
              response = Response.json(data);
            }
          } else {
            response = await history(request);
            const data = await response.clone().json();
            const query = JSON.parse(body);
            if (mode === 'rewrite-legacy' && data.replacesWindow && query.beforeTurnIndex !== undefined) {
              delete data.beforeProof; delete data.replacesWindow;
              response = Response.json(data);
            }
            requests.push({ stable: data.stable, fromTurnIndex: query.fromTurnIndex, beforeTurnIndex: query.beforeTurnIndex,
              replacesWindow: data.replacesWindow, notModified: data.notModified,
              turns: data.messages?.filter((message: { role: string }) => message.role === 'user').length ?? 0 });
            if (mode.startsWith('cold') && !firstRead) {
              firstRead = true;
              await appendFile(path, row('assistant', 'cold-answer', 'Final drained answer'));
              hub.releaseRun(session);
              if (mode === 'cold-idle-first') {
                socketReady.open();
                await idleSeen.promise;
              }
            }
          }
          res.statusCode = response.status; res.setHeader('Content-Type', 'application/json'); res.end(await response.text());
          return;
        }
        res.end('<!doctype html><div id="root"></div><pre id="result">RUNNING</pre><script src="/bundle.js"></script>');
      } catch (error) { failures.push(String(error)); res.statusCode = 500; res.end(String(error)); }
    });
    sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const sessionId = new URL(req.url!, 'http://localhost').searchParams.get('sessionId')!;
      void socketReady.promise.then(() => {
        if (!socket.destroyed) sockets.handleUpgrade(req, socket, head, (ws) => runSessionStreamHandler(ws, sessionId));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    finish.open(); socketReady.open(); idleSeen.open(); written.open();
    if (spec) spec.runner.run = originalRunner;
    if (sockets) { for (const client of sockets.clients) client.terminate(); await new Promise<void>((resolve) => sockets.close(() => resolve())); }
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(['sender-reconnect-successor-shared', 'sender-reconnect-successor', 'sender-reconnect-successor-draining', 'sender-reconnect-successor-completed', 'sender-delayed', 'sender-clock-skew', 'sender-legacy-response', 'cold-page-first', 'cold-idle-first',
    'failure-event', 'failure-snapshot', 'failure-sender', 'failure-persisted',
    'failure-output-sender', 'failure-output-snapshot', 'rejection-drain',
    'reentry-failed', 'reentry-terminal', 'reentry-draining', 'reentry-running', 'reentry-pending', 'reentry-accepted',
    'epoch-prepend', 'epoch-refresh', 'rewrite-prepend', 'rewrite-legacy'])('%s', async (scenario) => {
    mode = scenario; session = scenario; path = pathFor(cwd, session);
    firstRead = false; requests = []; failures = []; admission = undefined;
    socketReady = gate(); idleSeen = gate(); written = gate(); finish = gate();
    await mkdir(dirname(path), { recursive: true });
    const oldTime = Date.now() - 60000;
    const total = mode.startsWith('epoch') || mode.startsWith('rewrite') ? 100 : 20;
    const oldRows = Array.from({ length: total }, (_, index) => row('user', `old-user-${index}`, `Old prompt ${index}`, oldTime)
      + row('assistant', `old-answer-${index}`, `Old answer ${index}`, oldTime)).join('');
    await writeFile(path, oldRows);
    if (mode.startsWith('cold')) {
      expect(hub.startRun(session, cwd, 'Cold prompt', 'cold-run', 'grok')).toBe(true);
      await appendFile(path, row('user', 'cold-user', 'Cold prompt'));
      hub.markRunIdle(session);
    } else {
      if (mode.startsWith('reentry') || mode === 'rejection-drain' || (mode.startsWith('failure') && !mode.endsWith('sender'))) {
        expect(hub.startRun(session, cwd, 'Input A', 'run-a', 'grok')).toBe(true);
        await appendFile(path, row('user', 'input-a', 'Input A'));
        hub.appendRun(session, { type: 'system', subtype: 'init', session_id: session });
        hub.appendRun(session, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A partial' } } });
        if (mode === 'rejection-drain') hub.markRunIdle(session);
      }
      socketReady.open();
    }
    const browserDir = join(directory, scenario); await mkdir(browserDir);
    const url = `http://127.0.0.1:${port}/?mode=${scenario}&session=${session}`;
    try {
      const dom = await captureBrowserDom(browser!, browserDir, url);
      const output = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom)![1];
      const result = JSON.parse(output.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
      expect(result.error, JSON.stringify(result)).toBeUndefined();
      expect(result.stats.failures).toEqual([]);
      if (scenario.startsWith('sender-reconnect-successor')) {
        expect(result.isLoading).toBe(false);
        expect(result.messages).toContain('B final');
      } else if (scenario.startsWith('failure')) {
        expect(result.stats.snapshot.status).toBe('error');
        expect(result.stats.snapshot.writerActive).toBe(false);
        expect(result.recovery.filter((text: string) => text.includes('Initialization failed'))).toHaveLength(1);
        expect(result.recovery.filter((text: string) => text === 'New prompt')).toHaveLength(1);
        expect(result.messages.filter((text: string) => text === 'New prompt')).toHaveLength(mode === 'failure-persisted' || mode.includes('output') ? 1 : 0);
        expect(result.messages).toContain('Old prompt 0');
        const source = await readFile(path, 'utf8');
        expect(source).not.toContain('Initialization failed');
        expect(source.includes('New prompt')).toBe(mode === 'failure-persisted' || mode.includes('output'));
        if (mode.includes('output')) {
          expect(result.messages).toContain('Final stored output');
          expect(result.messages.some((text: string) => text.includes('Partial'))).toBe(false);
          expect(result.jump.status).toBe('ready');
        }
      } else if (scenario === 'rejection-drain') {
        expect(result.stats.admission.error).toBe('previous run is still stopping');
        expect(result.recovery).toContain('New rejected prompt');
        expect(result.recovery.some((text: string) => text.includes('still stopping'))).toBe(true);
        expect(result.messages).toContain('Input A');
        expect(await readFile(path, 'utf8')).not.toContain('New rejected prompt');
      } else if (scenario.startsWith('sender')) {
        expect(result.stats.admission.startedAt).toEqual(expect.any(Number));
        expect(result.messages.filter((text: string) => text === 'New prompt')).toHaveLength(1);
        expect(result.messages).toContain('Streaming answer');
        expect(result.messages).toContain('Old prompt 0');
      } else if (scenario.startsWith('reentry')) {
        if (scenario === 'reentry-failed') {
          expect(result.recovery.some((text: string) => text.includes('A partial') && text.includes('Failed A'))).toBe(true);
          expect(result.recovery.filter((text: string) => text === 'Input A')).toHaveLength(1);
        }
        expect(result.messages).toContain('A final');
        expect(result.messages).toContain('B final');
        expect(result.messages).not.toContain('A partial');
        expect(result.messages.filter((text: string) => text === 'Input A')).toHaveLength(1);
        expect(result.messages.filter((text: string) => text === 'Input B')).toHaveLength(1);
        if (scenario === 'reentry-pending' || scenario === 'reentry-accepted') expect(result.messages).toContain('C streaming');
      } else if (scenario.startsWith('epoch') || scenario.startsWith('rewrite')) {
        const counts = result.stats.requests.map((read: { turns: number }) => read.turns);
        if (scenario === 'rewrite-legacy') {
          expect(counts).toEqual([10, 10, 10, 10, 0, 10, 20]);
          expect(result.stats.requests[3].fromTurnIndex).toBeUndefined();
          expect(result.stats.requests[4].notModified).toBe(true);
        } else {
          expect(counts).toEqual([10, 10, 10, scenario === 'epoch-refresh' ? 0 : 10, 10, 20]);
          if (scenario === 'epoch-refresh') expect(result.stats.requests[3].notModified).toBe(true);
          expect(result.stats.requests[2].replacesWindow).toBe(true);
        }
        expect(result.messages.filter((text: string) => text === 'Old prompt 80')).toHaveLength(1);
        expect(result.messages).toContain('Old answer 99');
      } else {
        expect(result.messages).toContain('Final drained answer');
        expect(result.stats.requests.map((read: { stable: boolean }) => read.stable)).toEqual([false, true]);
      }
    } finally {
      finish.open(); socketReady.open(); idleSeen.open(); written.open();
      if (scenario.startsWith('sender')) expect(await hub.waitForWriter(session, 5000)).toBe(true);
      else { hub.markRunIdle(session); hub.releaseRun(session); }
    }
  }, 15000);
});
