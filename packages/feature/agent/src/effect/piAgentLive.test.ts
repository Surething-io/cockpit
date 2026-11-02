// Exercise the real Pi SDK against a local faux OpenAI server, without paid models.
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import type { RunCtx, RunEvent } from '../server/engines/types';

let home: string;
let server: Server;
let baseUrl: string;
let runPiAgent: typeof import('./piAgentLive').runPiAgent;
let sessions: typeof import('./piSessionLive');
let edits: typeof import('./piSessionEditLive');
let parser: typeof import('../server/api/session/transcriptParsers');
const previousHome = process.env.COCKPIT_HOME;
const requests: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }> = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'cockpit-pi-'));
  process.env.COCKPIT_HOME = home;
  ({ runPiAgent } = await import('./piAgentLive'));
  sessions = await import('./piSessionLive');
  edits = await import('./piSessionEditLive');
  parser = await import('../server/api/session/transcriptParsers');
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (body.messages.some((message: { content: unknown }) => message.content === null)) {
      res.writeHead(400); res.end(JSON.stringify({ error: { message: 'Ollama requires non-null content' } })); return;
    }
    const text = JSON.stringify(body.messages);
    if (text.includes('fail-auth')) { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'Invalid test API key' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant' });
    if (text.includes('hang-stream')) { send({ content: 'waiting' }); return; }
    if (text.includes('use-bash') && !body.messages.some((m: { role: string }) => m.role === 'tool')) {
      send({ tool_calls: [{ index: 0, id: 'test-call', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf "run=%s cwd=%s port=%s" "$COCKPIT_RUN_ID" "$COCKPIT_CWD" "$PORT"' }) } }] });
      send({}, 'tool_calls');
    } else {
      send({ content: 'Finished.' });
      send({}, 'stop');
    }
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local test port');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (home) await rm(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.COCKPIT_HOME;
  else process.env.COCKPIT_HOME = previousHome;
});

function context(id: string, prompt: string, sessionId?: string) {
  const events: RunEvent[] = [];
  const abort = new AbortController();
  let sink: Parameters<RunCtx['acceptInput']>[0] = null;
  const ctx: RunCtx = {
    cwd: home, prompt, sessionId, images: undefined,
    params: { model: 'test-model' }, signal: abort.signal,
    currentKey: () => sessionId ?? id, rekey: () => {}, emit: (event) => events.push(event),
    acceptInput: (input) => { sink = input; },
  };
  return { ctx, events, abort, input: (text: string) => sink?.({ text }) };
}

describe('embedded Pi runtime', () => {
  it('persists native history, switches providers in one session, and restores UI messages', async () => {
    const first = context('switch-session', 'first task');
    await Effect.runPromise(runPiAgent(first.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    const initial = await Effect.runPromise(sessions.findPiSession(home, 'switch-session'));
    expect(initial?.path).toContain(join(home, 'pi', 'sessions'));
    expect(initial?.engine).toBe('ollama');
    const second = context('unused', 'second task', 'switch-session');
    second.ctx.params.model = 'other-model';
    await Effect.runPromise(runPiAgent(second.ctx, { engine: 'deepseek', baseUrl, apiKey: 'test' }));
    const resumed = await Effect.runPromise(sessions.findPiSession(home, 'switch-session'));
    expect(resumed?.path).toBe(initial?.path);
    expect(resumed?.engine).toBe('deepseek');
    expect(resumed?.model).toBe('other-model');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('first task');
    const parsed = await parser.parseTranscriptFile(resumed!.path);
    expect(parsed.totalTurns).toBe(2);
    expect(parsed.model).toBe('other-model');
    expect(parsed.usage?.input_tokens).toBe(10);
    const { transcriptSnapshot } = await import('./transcriptIndexLive');
    const snapshot = await Effect.runPromise(transcriptSnapshot(resumed!.path, 'pi'));
    expect(snapshot?.engine).toBe('deepseek');
    expect(snapshot?.stats.modelUsage['other-model'].inputTokens).toBe(10);
    expect(parsed.messages.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['Finished.', 'Finished.']);
    const lines = (await readFile(resumed!.path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: 'session', version: 3, id: 'switch-session' });
    expect(lines.some((line) => line.type === 'model_change' && line.provider === 'deepseek')).toBe(true);
    expect((await readdir(home)).some((dir) => dir.endsWith('-sessions'))).toBe(false);
  });

  it('executes native tools with Cockpit environment and projects matching tool ids after reload', async () => {
    const run = context('tool-session', 'use-bash');
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    const tool = run.events.find((e) => e.type === 'assistant');
    expect(tool).toMatchObject({ message: { content: [{ type: 'tool_use', id: 'test-call', name: 'Bash' }] } });
    const result = run.events.find((e) => e.type === 'user');
    expect(JSON.stringify(result)).toContain(`run=tool-session cwd=${home} port=`);
    const file = await Effect.runPromise(sessions.findPiSession(home, 'tool-session'));
    const parsed = await parser.parseTranscriptFile(file!.path);
    const call = parsed.messages.flatMap((m) => m.toolCalls ?? [])[0];
    expect(call.id).toBe('test-call');
    expect(call.result).toContain('run=tool-session');
    expect(run.events.filter((event) => event.type === 'usage_update').map((event) => event.output_tokens)).toEqual([2, 4]);
    expect(run.events.find((event) => event.type === 'result')).toMatchObject({ usage: { input_tokens: 20, output_tokens: 4 } });
  });

  it('accepts input while the SDK initializes and delivers it after the launch prompt', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const initializing = new Promise<void>((resolve) => { entered = resolve; });
    const create = ModelRuntime.create;
    const spy = vi.spyOn(ModelRuntime, 'create').mockImplementationOnce(async (options) => {
      entered();
      await gate;
      return create(options);
    });
    const run = context('init-input-session', 'launch prompt');
    const pending = Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    await initializing;
    const accepted = run.input('during initialization');
    release();
    await pending.finally(() => spy.mockRestore());
    expect(accepted).toBe(true);
    const file = await Effect.runPromise(sessions.findPiSession(home, 'init-input-session'));
    const parsed = await parser.parseTranscriptFile(file!.path);
    expect(parsed.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['launch prompt', 'during initialization']);
  });

  it('retains accepted inputs in native storage when cancelled before the first prompt', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const initializing = new Promise<void>((resolve) => { entered = resolve; });
    const create = ModelRuntime.create;
    const spy = vi.spyOn(ModelRuntime, 'create').mockImplementationOnce(async (options) => {
      entered(); await gate; return create(options);
    });
    const hub = await import('../server/sessionRunHub');
    const id = 'cancel-init-session';
    const run = context(id, 'initial unprocessed input');
    expect(hub.startRun(id, home, run.ctx.prompt, id, 'ollama')).toBe(true);
    hub.setRunAbort(id, () => run.abort.abort());
    run.ctx.emit = (event) => hub.appendRun(id, event);
    run.ctx.acceptInput = (sink) => hub.setRunInjector(id, sink);
    const pending = Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    await initializing;
    expect(hub.injectRun(id, { text: 'accepted while initializing' }, 'injected')).toBe('ok');
    expect(hub.requestStop(id)).toBe(true);
    release();
    await pending.finally(() => { spy.mockRestore(); hub.releaseRun(id); });
    expect(hub.getRunSnapshot(id)?.status).toBe('idle');
    const file = await Effect.runPromise(sessions.findPiSession(home, 'cancel-init-session'));
    expect(file).toBeDefined();
    const restored = SessionManager.open(file!.path);
    expect(JSON.stringify(restored.getEntries())).toContain('accepted while initializing');
    expect(restored.buildSessionContext().messages).toEqual([]);
    const parsed = await parser.parseTranscriptFile(file!.path);
    expect(parsed.messages.some((message) => message.role === 'system' && message.content.includes('accepted while initializing'))).toBe(true);
    const resumed = context('unused', 'new explicit task', id);
    await Effect.runPromise(runPiAgent(resumed.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('accepted while initializing');
    const afterResume = await parser.parseTranscriptFile(file!.path);
    expect(afterResume.messages.some((message) => message.role === 'system' && message.content.includes('accepted while initializing'))).toBe(true);
  });

  it('delivers every input accepted at SDK settlement boundaries before closing', async () => {
    const run = context('settled-input-session', 'initial task');
    const subscribe = AgentSession.prototype.subscribe;
    let accepted = 0;
    const spy = vi.spyOn(AgentSession.prototype, 'subscribe').mockImplementation(function (this: AgentSession, listener) {
      return subscribe.call(this, (event) => {
        listener(event);
        if (event.type === 'agent_settled' && accepted < 3) {
          const next = accepted + 1;
          if (run.input(`settled input ${next}`)) accepted = next;
        }
      });
    });
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' })).finally(() => spy.mockRestore());
    expect(accepted).toBe(3);
    const file = await Effect.runPromise(sessions.findPiSession(home, 'settled-input-session'));
    const parsed = await parser.parseTranscriptFile(file!.path);
    expect(parsed.totalTurns).toBe(4);
    expect(parsed.messages.filter((message) => message.role === 'assistant')).toHaveLength(4);
    expect(run.events.filter((event) => event.type === 'result')).toHaveLength(1);
  });

  it.each(['tool_execution_start', 'tool_execution_end', 'message_end', 'agent_end'] as const)(
    'delivers a queued input accepted at %s without overlapping Pi prompts', async (boundary) => {
      const run = context(`boundary-${boundary}`, 'use-bash');
      const subscribe = AgentSession.prototype.subscribe;
      let injected = false;
      const spy = vi.spyOn(AgentSession.prototype, 'subscribe').mockImplementation(function (this: AgentSession, listener) {
        return subscribe.call(this, (event) => {
          listener(event);
          if (!injected && event.type === boundary) {
            injected = true;
            expect(run.input(`input at ${boundary}`)).toBe(true);
          }
        });
      });
      await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' })).finally(() => spy.mockRestore());
      expect(injected).toBe(true);
      const file = await Effect.runPromise(sessions.findPiSession(home, `boundary-${boundary}`));
      const parsed = await parser.parseTranscriptFile(file!.path);
      expect(parsed.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['use-bash', `input at ${boundary}`]);
      expect(run.events.some((event) => event.type === 'error')).toBe(false);
      expect(run.events.find((event) => event.type === 'result')).toMatchObject({ usage: { output_tokens: 6 } });
    },
  );

  it('reports and retains accepted input that cancellation prevents from completing', async () => {
    const run = context('cancelled-queued-session', 'hang-stream');
    const emit = run.ctx.emit;
    let injected = false;
    run.ctx.emit = (event) => {
      emit(event);
      if (!injected && event.type === 'stream_event' && (event.event as { type: string }).type === 'content_block_delta') {
        injected = true;
        expect(run.input('accepted before cancellation')).toBe(true);
        run.abort.abort();
      }
    };
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    expect(run.events.some((event) => event.type === 'error' && String(event.error).includes('accepted before cancellation'))).toBe(true);
    const file = await Effect.runPromise(sessions.findPiSession(home, 'cancelled-queued-session'));
    const parsed = await parser.parseTranscriptFile(file!.path);
    expect(parsed.messages.some((message) => message.role === 'system' && message.content.includes('accepted before cancellation'))).toBe(true);
    expect(JSON.stringify(SessionManager.open(file!.path).buildSessionContext().messages)).not.toContain('accepted before cancellation');
    expect(run.input('after close')).toBeUndefined();
  });

  it('hands an HTTP send after input closure to a new run after the old writer releases', async () => {
    const project = await mkdtemp(join(home, 'http-project-'));
    const { dispatchChat } = await import('../server/engines/orchestrator');
    const { waitForWriter } = await import('../server/sessionRunHub');
    let releaseTitle!: () => void;
    let reachedTitle!: () => void;
    let secondEntered!: () => void;
    const titleGate = new Promise<void>((resolve) => { releaseTitle = resolve; });
    const closing = new Promise<void>((resolve) => { reachedTitle = resolve; });
    const entered = new Promise<void>((resolve) => { secondEntered = resolve; });
    let titles = 0;
    const spec = {
      name: 'ollama',
      runner: {
        async run(ctx: RunCtx) {
          // Omit dispatch cwd to keep unrelated background snapshots out of this
          // delivery test; the real SDK still works in an isolated project.
          await Effect.runPromise(runPiAgent({ ...ctx, cwd: project }, { engine: 'ollama', baseUrl, apiKey: 'test' }));
          if (++titles === 1) { reachedTitle(); await titleGate; }
        },
      },
    };
    const api = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const pending = dispatchChat(spec, body);
      if (body.inject) secondEntered();
      const result = await pending;
      res.writeHead(result.ok ? 200 : result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const address = api.address();
    if (!address || typeof address === 'string') throw new Error('Missing local API port');
    const post = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${address.port}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test-model', ...body }), signal: AbortSignal.timeout(5000),
    });
    try {
      expect((await post({ prompt: 'first HTTP task', runId: 'http-closed-session' })).status).toBe(200);
      await closing;
      const second = post({ prompt: 'second HTTP task', sessionId: 'http-closed-session', inject: true });
      await entered;
      const file = await Effect.runPromise(sessions.findPiSession(project, 'http-closed-session'));
      expect((await parser.parseTranscriptFile(file!.path)).totalTurns).toBe(1);
      releaseTitle();
      const response = await second;
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty('injected', true);
      expect(await waitForWriter('http-closed-session', 5000)).toBe(true);
      expect((await parser.parseTranscriptFile(file!.path)).totalTurns).toBe(2);
    } finally {
      releaseTitle();
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  });

  it('preserves known Kimi protocol metadata when registering the Cockpit endpoint', async () => {
    const run = context('kimi-catalog-session', 'check catalog configuration');
    run.ctx.params.model = 'k3';
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'kimi', baseUrl, apiKey: 'test', temperature: null }));
    // Kimi requires max_tokens; an unrecognized provider alias would send max_completion_tokens.
    expect(requests.at(-1)).toHaveProperty('max_tokens');
    expect(requests.at(-1)).not.toHaveProperty('max_completion_tokens');
    expect(requests.at(-1)).not.toHaveProperty('temperature');
  });

  it('omits previous context for independent tasks while retaining display history', async () => {
    const run = context('unused', 'independent task', 'switch-session');
    run.ctx.params.noHistory = true;
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'kimi', baseUrl, apiKey: 'test', temperature: null }));
    const sent = JSON.stringify(requests.at(-1)?.messages);
    expect(sent).toContain('independent task');
    expect(sent).not.toContain('first task');
    const file = await Effect.runPromise(sessions.findPiSession(home, 'switch-session'));
    expect((await parser.parseTranscriptFile(file!.path)).totalTurns).toBe(3);
  });

  it('accepts a mid-run follow-up and waits for its response before completing', async () => {
    const run = context('followup-session', 'initial task');
    const emit = run.ctx.emit;
    let injected = false;
    run.ctx.emit = (event) => {
      emit(event);
      if (!injected && event.type === 'stream_event' && (event.event as { type: string }).type === 'content_block_delta') {
        injected = true;
        expect(run.input('follow-up task')).toBe(true);
      }
    };
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    const file = await Effect.runPromise(sessions.findPiSession(home, 'followup-session'));
    const parsed = await parser.parseTranscriptFile(file!.path);
    expect(parsed.totalTurns).toBe(2);
    expect(parsed.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
    expect(run.events.filter((event) => event.type === 'result')).toHaveLength(1);
    expect(run.input('too late')).toBeUndefined();
  });

  it('restores Pi compaction for model context while retaining browsable history', async () => {
    await Effect.runPromise(runPiAgent(context('compact-session', 'old task before compaction').ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    await Effect.runPromise(runPiAgent(context('unused', 'retained task', 'compact-session').ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    const file = await Effect.runPromise(sessions.findPiSession(home, 'compact-session'));
    const manager = SessionManager.open(file!.path);
    const retained = manager.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'user' && JSON.stringify(entry.message.content).includes('retained task'))!;
    manager.appendCompaction('Earlier work was summarized here.', retained.id, 20000);
    await Effect.runPromise(runPiAgent(context('unused', 'continue after compaction', 'compact-session').ctx, { engine: 'glm', baseUrl, apiKey: 'test' }));
    const sent = JSON.stringify(requests.at(-1)?.messages);
    expect(sent).toContain('Earlier work was summarized here.');
    expect(sent).not.toContain('old task before compaction');
    const parsed = await parser.parseTranscriptFile(file!.path);
    expect(parsed.totalTurns).toBe(3);
    expect(parsed.messages.some((message) => message.content === 'old task before compaction')).toBe(true);
    // Deletion must also remove summaries that could retain deleted information.
    const old = parsed.messages.find((message) => message.content === 'old task before compaction')!;
    await Effect.runPromise(edits.deletePiTurn(file!.path, old.id));
    expect(SessionManager.open(file!.path).getBranch().some((entry) => entry.type === 'compaction')).toBe(false);
  });

  it('forks native sessions and deletes a complete turn without corrupting resume context', async () => {
    const file = await Effect.runPromise(sessions.findPiSession(home, 'switch-session'));
    const parsed = await parser.parseTranscriptFile(file!.path);
    const target = parsed.messages.find((m) => m.content === 'second task')!.id;
    const fork = await Effect.runPromise(edits.forkPiSession(file!.path, target, 'single'));
    const copy = await Effect.runPromise(sessions.findPiSession(home, fork!.newSessionId));
    expect((await parser.parseTranscriptFile(copy!.path)).totalTurns).toBe(1);
    const prefix = await Effect.runPromise(edits.forkPiSession(file!.path, target));
    const prefixFile = await Effect.runPromise(sessions.findPiSession(home, prefix!.newSessionId));
    expect((await parser.parseTranscriptFile(prefixFile!.path)).totalTurns).toBe(2);
    await Effect.runPromise(edits.deletePiTurn(file!.path, target));
    const restored = SessionManager.open(file!.path).buildSessionContext();
    expect(JSON.stringify(restored.messages)).not.toContain('second task');
    expect((await parser.parseTranscriptFile(file!.path)).totalTurns).toBe(2);
  });

  it('preserves edits to selected messages even when appended in later turns', async () => {
    const run = context('context-edit-session', 'original task');
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    const file = await Effect.runPromise(sessions.findPiSession(home, 'context-edit-session'));
    const source = SessionManager.open(file!.path);
    const first = source.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'user')!;
    const assistant = source.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'assistant')!;
    source.appendMessage({ role: 'user', content: 'later task', timestamp: Date.now() });
    source.appendContextEdit(first.id, { content: 'edited original task' });
    source.appendContextEdit(assistant.id, null);
    const fork = await Effect.runPromise(edits.forkPiSession(file!.path, first.id, 'single'));
    const copyFile = await Effect.runPromise(sessions.findPiSession(home, fork!.newSessionId));
    const copy = SessionManager.open(copyFile!.path);
    expect(copy.buildSessionContext().messages).toEqual(source.buildSessionContext().messages.filter((message) => message.role === 'user').slice(0, 1));
    expect(JSON.stringify(copy.buildSessionContext().messages)).not.toContain('Finished.');
    const entries = copy.getBranch();
    for (const edit of entries.filter((entry) => entry.type === 'context_edit')) {
      expect(entries.some((entry) => entry.id === edit.targetId)).toBe(true);
      expect([first.id, assistant.id]).not.toContain(edit.targetId);
    }
    expect(entries.filter((entry) => entry.type === 'context_edit')).toHaveLength(2);
  });

  it('surfaces provider failures and retains their reason after reload', async () => {
    const run = context('error-session', 'fail-auth');
    await expect(Effect.runPromise(runPiAgent(run.ctx, { engine: 'glm', baseUrl, apiKey: 'test' }))).rejects.toThrow();
    expect(run.events.some((event) => event.type === 'result')).toBe(false);
    const file = await Effect.runPromise(sessions.findPiSession(home, 'error-session'));
    expect(JSON.stringify((await parser.parseTranscriptFile(file!.path)).messages)).toContain('Invalid test API key');
  });

  it('aborts a streaming request and releases the input sink', async () => {
    const run = context('abort-session', 'hang-stream');
    const emit = run.ctx.emit;
    run.ctx.emit = (event) => { emit(event); if (event.type === 'stream_event') run.abort.abort(); };
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    expect(run.abort.signal.aborted).toBe(true);
    expect(run.input('too late')).toBeUndefined();
    expect(run.events.some((e) => e.type === 'result')).toBe(false);
  });
});
