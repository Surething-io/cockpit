// Exercise the real Pi SDK against a local faux OpenAI server, without paid models.
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
const observedHeaders: Array<{ tenant: string | undefined; route: string | undefined; request: (typeof requests)[number] }> = [];
const previousHome = process.env.COCKPIT_HOME;
const previousRoot = process.env.COCKPIT_ROOT;
const requests: Array<{ max_tokens?: number; model: string; messages: Array<{ role: string; content: unknown }> }> = [];

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'cockpit-pi-'));
  process.env.COCKPIT_HOME = home;
  process.env.COCKPIT_ROOT = process.cwd();
  await mkdir(join(home, 'pi'), { recursive: true });
  const ids = ['test-model', 'other-model', 'parent-model', 'first-model', 'second-model', 'k3'];
  const models = ids.map((id) => ({ id, contextWindow: 1000000, maxTokens: 32768, input: ['text'], reasoning: id === 'k3' }));
  await writeFile(join(home, 'pi', 'models.json'), JSON.stringify({ providers: Object.fromEntries(['ollama', 'deepseek', 'kimi', 'glm'].map((p) => [p, { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models }])) }));

  ({ runPiAgent } = await import('./piAgentLive'));
  sessions = await import('./piSessionLive');
  edits = await import('./piSessionEditLive');
  parser = await import('../server/api/session/transcriptParsers');
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    observedHeaders.push({ tenant: req.headers['x-tenant'] as string | undefined, route: req.headers['x-route'] as string | undefined, request: body });
    if (body.messages.some((message: { content: unknown }) => message.content === null)) {
      res.writeHead(400); res.end(JSON.stringify({ error: { message: 'Ollama requires non-null content' } })); return;
    }
    const text = JSON.stringify(body.messages);
    if (text.includes('fail-auth')) { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'Invalid test API key' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant' });
    if (text.includes('truncate-parent')) { send({ content: 'Partial parent answer' }); send({}, 'length'); res.write('data: [DONE]\n\n'); res.end(); return; }
    if (text.includes('hang-stream')) { send({ content: 'waiting' }); return; }
    if (text.includes('parent-repeat-six')) {
      const rounds = body.messages.filter((m: { role: string }) => m.role === 'tool').length;
      if (rounds < 6) {
        send({ tool_calls: [{ index: 0, id: `parent-repeat-${rounds}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf parent-result' }) } }] });
        send({}, 'tool_calls');
      } else { send({ content: 'Parent finished normally.' }); send({}, 'stop'); }
    } else if (text.includes('try-unmanaged-pi') && !body.messages.some((m: { role: string }) => m.role === 'tool')) {
      send({ tool_calls: [{ index: 0, id: 'blocked-pi-call', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `printf started > '${join(home, 'shell-started')}'; PI='${join(home, 'fake', 'pi')}'; nohup "$PI" -p review` }) } }] });
      send({}, 'tool_calls');
    } else if (text.includes('use-hanging-subagent') && !body.messages.some((m: { role: string }) => m.role === 'tool')) {
      send({ tool_calls: [{ index: 0, id: 'hanging-child-call', type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ task: 'hang-stream', tools: [] }) } }] });
      send({}, 'tool_calls');
    } else if (text.includes('use-dynamic-subagent') && !body.messages.some((m: { role: string }) => m.role === 'tool')) {
      send({ tool_calls: [{ index: 0, id: 'subagent-call', type: 'function', function: { name: 'subagent', arguments: JSON.stringify({ task: 'independent child task', instructions: 'Return the result.', tools: [] }) } }] });
      send({}, 'tool_calls');
    } else if (text.includes('use-bash') && !body.messages.some((m: { role: string }) => m.role === 'tool')) {
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
  if (previousRoot === undefined) delete process.env.COCKPIT_ROOT; else process.env.COCKPIT_ROOT = previousRoot;
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
    params: { model: 'test-model', runId: id }, signal: abort.signal,
    currentKey: () => sessionId ?? id, rekey: () => {}, emit: (event) => events.push(event),
    acceptInput: (input) => { sink = input; },
  };
  return { ctx, events, abort, input: (text: string, inputId?: string) => sink?.({ text, inputId }) };
}

describe('embedded Pi runtime', () => {
  it('sends selected thinking controls and restores changed native settings on subsequent turns', async () => {
    const config = { engine: 'deepseek' as const, baseUrl, apiKey: 'test' };
    const id = 'thinking-native-persistence';
    for (const [index, level] of (['off', 'high', undefined, 'max', 'off', undefined] as const).entries()) {
      const run = context(id, `thinking turn ${index}`, index ? id : undefined);
      run.ctx.params.model = 'deepseek-flash';
      run.ctx.params.piThinkingLevel = level;
      await Effect.runPromise(runPiAgent(run.ctx, config));
      const payload = requests.at(-1);
      const expected = level ?? (index === 2 ? 'high' : 'off');
      expect(payload).toHaveProperty('thinking', { type: expected === 'off' ? 'disabled' : 'enabled' });
      if (expected === 'off') expect(payload).not.toHaveProperty('reasoning_effort');
      else expect(payload).toHaveProperty('reasoning_effort', expected);
      const file = await Effect.runPromise(sessions.findPiSession(home, id));
      const native = await Effect.runPromise(sessions.readPiSession(file!.path));
      expect(native.entries.findLast((entry) => entry.type === 'thinking_level_change')).toMatchObject({ thinkingLevel: expected });
    }
  });

  it.each([
    ['deepseek', 'deepseek-flash', 'medium'],
    ['glm', 'glm-5.3', 'off'],
  ] as const)('rejects unsupported thinking before generating: %s/%s/%s', async (engine, model, level) => {
    const before = requests.length;
    const run = context(`invalid-thinking-${engine}`, 'must not reach the provider');
    run.ctx.params.model = model;
    run.ctx.params.piThinkingLevel = level;
    await expect(Effect.runPromise(runPiAgent(run.ctx, { engine, baseUrl, apiKey: 'test' }).pipe(Effect.mapError((error) => error.cause)))).rejects.toThrow('Unsupported Pi thinking level');
    expect(requests).toHaveLength(before);
  });

  it('keeps displayed legacy IDs through the real resume writer and later excerpt', async () => {
    const { getPiSessionsDir } = await import('@cockpit/shared-utils');
    const id = 'legacy-resume-identity';
    const native = SessionManager.create(home, getPiSessionsDir(home), { id });
    native.appendModelChange('ollama', 'test-model');
    native.appendMessage({ role: 'user', content: 'legacy original', timestamp: 1 });
    native.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'legacy answer' }], api: 'openai-completions', provider: 'ollama', model: 'test-model', stopReason: 'stop', timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const file = native.getSessionFile()!;
    const legacyEntries = native.getEntries().map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'id' && key !== 'parentId')));
    await writeFile(file, [{ ...native.getHeader(), version: 1 }, ...legacyEntries].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const before = await readFile(file);
    const displayed = await Effect.runPromise(sessions.readPiSession(file));
    const original = displayed.entries.find((entry) => entry.type === 'message' && entry.message.role === 'user')!;
    expect(await readFile(file)).toEqual(before);
    const resumed = context('unused', 'continued legacy input', id);
    await Effect.runPromise(runPiAgent(resumed.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    expect(SessionManager.open(file).getEntry(original.id)).toBeDefined();
    const copy = await Effect.runPromise(edits.forkPiSession(file, original.id, 'single'));
    expect(copy).toBeDefined();
    const child = await Effect.runPromise(sessions.findPiSession(home, copy!.newSessionId));
    expect(JSON.stringify(SessionManager.open(child!.path).buildSessionContext().messages)).toContain('legacy original');
    expect(JSON.stringify(SessionManager.open(file).buildSessionContext().messages)).toContain('continued legacy input');
  });

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

  it('exposes the dynamic subagent tool to the real parent SDK and persists its result', async () => {
    const run = context('parent-child-session', 'use-dynamic-subagent');
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    const call = run.events.find((event) => event.type === 'assistant' && JSON.stringify(event).includes('subagent-call'));
    expect(call).toBeDefined();
    expect(run.events.some((event) => event.type === 'tool_progress')).toBe(true);
    const file = await Effect.runPromise(sessions.findPiSession(home, 'parent-child-session'));
    const parsed = await parser.parseTranscriptFile(file!.path);
    const result = parsed.messages.flatMap((message) => message.toolCalls ?? []).find((tool) => tool.id === 'subagent-call');
    expect(result?.result).toContain('[done]');
    expect(result?.result).toContain('Finished.');
    const { listPiChildren } = await import('./piSubagentSessionLive');
    const children = await Effect.runPromise(listPiChildren(file!.path, 'parent-child-session', 'subagent-call'));
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe('done');
    const child = await parser.parseTranscriptFile(join(dirname(file!.path), 'parent-child-session', children[0].sessionPath));
    expect(JSON.stringify(child.messages)).toContain('independent child task');
    expect(JSON.stringify(child.messages)).toContain('Finished.');
  }, 30000);

  it('sends a valid small-window output budget through real parent SDK and child CLI requests', async () => {
    const start = requests.length;
    const run = context('small-window-parent-child', 'use-dynamic-subagent');
    await Effect.runPromise(runPiAgent(run.ctx, {
      engine: 'ollama', baseUrl, apiKey: 'test', outputBudget: 512,
      modelDefinitions: { 'test-model': { id: 'test-model', contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ['text'], samplingParams: { top_p: 0.8 } } },
    }));
    const observed = requests.slice(start);
    expect(observed).toHaveLength(3);
    // Pi may lower the requested ceiling further for the actual prompt size.
    const budgets = observed.map((r) => r.max_tokens ?? (r as unknown as { max_completion_tokens?: number }).max_completion_tokens);
    expect(budgets.every((budget) => budget !== undefined && budget > 0 && budget <= 512)).toBe(true);
    expect(new Set(budgets).size).toBe(1);
    for (const request of observed) {
      expect(request).toHaveProperty('top_p', 0.8);
      expect(Number('max_tokens' in request) + Number('max_completion_tokens' in request)).toBe(1);
    }
    expect(observed.some((r) => JSON.stringify(r.messages).includes('independent child task'))).toBe(true);
  }, 30000);

  it.each(['max_tokens', 'max_completion_tokens', 'model'])('rejects sampling payload ownership overrides before any HTTP request: %s', async (field) => {
    const start = requests.length;
    const run = context(`bad-sampling-${field}`, 'must not reach provider');
    await expect(Effect.runPromise(runPiAgent(run.ctx, {
      engine: 'ollama', baseUrl, apiKey: 'test', outputBudget: 512,
      modelDefinitions: { 'test-model': { id: 'test-model', contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ['text'], samplingParams: { [field]: 99999 } } },
    }))).rejects.toThrow();
    expect(requests.length).toBe(start);
  });

  it('sends identical provider/model headers through the real parent SDK and child CLI', async () => {
    const path = join(home, 'pi', 'models.json');
    const original = await readFile(path, 'utf8');
    const models = JSON.parse(original);
    models.providers.ollama.headers = { 'X-Tenant': 'provider-tenant', 'X-Route': 'test-route' };
    models.providers.ollama.models.find((m: { id: string }) => m.id === 'test-model').headers = { 'X-Tenant': 'model-tenant' };
    const start = observedHeaders.length;
    try {
      await writeFile(path, JSON.stringify(models));
      const run = context('header-parent-child', 'use-dynamic-subagent');
      await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
      const requests = observedHeaders.slice(start);
      expect(requests).toHaveLength(3);
      expect(requests.every((r) => r.tenant === 'model-tenant' && r.route === 'test-route')).toBe(true);
      expect(requests.some((r) => r.request.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('independent child task')))).toBe(true);
    } finally { await writeFile(path, original); }
  }, 30000);

  it('sends the audited DeepSeek alias contract on a context larger than the removed 32K fallback', async () => {
    const run = context('deepseek-alias-context', 'long-context-check ' + 'token '.repeat(30000));
    run.ctx.params.model = 'deepseek-v4-flash';
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'deepseek', baseUrl, apiKey: 'test' }));
    const request = requests.findLast((r) => r.model === 'deepseek-v4-flash');
    expect(request?.max_tokens).toBe(32768);
    expect(run.events.some((e) => e.type === 'result')).toBe(true);
  });

  it('does not report a truncated native reply as success and preserves its partial output through clone/cut', async () => {
    const run = context('truncated-parent', 'truncate-parent');
    await expect(Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }).pipe(Effect.mapError((e) => e.cause)))).rejects.toThrow('stopReason=length');
    expect(run.events.some((e) => e.type === 'result')).toBe(false);
    const file = (await Effect.runPromise(sessions.findPiSession(home, 'truncated-parent')))!;
    const original = SessionManager.open(file.path);
    const user = original.getBranch().find((e) => e.type === 'message' && e.message.role === 'user')!;
    for (const scope of ['prefix', 'single'] as const) {
      const fork = await Effect.runPromise(edits.forkPiSession(file.path, user.id, scope));
      const copy = (await Effect.runPromise(sessions.findPiSession(home, fork!.newSessionId)))!;
      const parsed = await parser.parseTranscriptFile(copy.path);
      expect(JSON.stringify(parsed.messages)).toContain('Partial parent answer');
      expect(JSON.stringify(parsed.messages)).toContain('stopReason=length');
      const branch = SessionManager.open(copy.path).getBranch();
      if (branch.some((e) => e.type === 'context_edit' && e.replacement === null)) {
        expect(JSON.stringify(parsed.messages)).toContain('excluded this response');
      }
    }
  }, 30000);

  it('allows a direct Pi-named executable through the native Bash tool', async () => {
    await mkdir(join(home, 'fake'), { recursive: true });
    await writeFile(join(home, 'fake', 'pi'), '#!/bin/sh\nprintf direct-pi-ran\n', { mode: 0o700 });
    const run = context('direct-pi-session', 'try-unmanaged-pi');
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    expect(await readFile(join(home, 'shell-started'), 'utf8')).toBe('started');
    const file = await Effect.runPromise(sessions.findPiSession(home, 'direct-pi-session'));
    const tool = SessionManager.open(file!.path).getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === 'blocked-pi-call');
    expect(tool).toMatchObject({ type: 'message', message: { role: 'toolResult', isError: false } });
    expect(JSON.stringify(tool)).toContain('direct-pi-ran');
    expect(run.events.some((event) => event.type === 'result')).toBe(true);
  });

  it('freezes running native child histories during prefix and single forks without inheriting execution state', async () => {
    const run = context('fork-running-child', 'use-hanging-subagent');
    let ready!: () => void;
    const streamed = new Promise<void>((resolve) => { ready = resolve; });
    const emit = run.ctx.emit;
    run.ctx.emit = (event) => {
      emit(event);
      if (event.type === 'tool_progress' && String(event.progress_text).includes('waiting')) ready();
    };
    const pending = Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    const snapshots: Array<{ path: string; id: string; transcript: string; childPath: string }> = [];
    const { listPiChildren } = await import('./piSubagentSessionLive');
    try {
      await Effect.runPromise(Effect.promise(() => streamed).pipe(Effect.timeout('10 seconds')));
      const source = (await Effect.runPromise(sessions.findPiSession(home, 'fork-running-child')))!;
      const user = SessionManager.open(source.path).getBranch().find((e) => e.type === 'message' && e.message.role === 'user')!;
      for (const scope of ['prefix', 'single'] as const) {
        const fork = await Effect.runPromise(edits.forkPiSession(source.path, user.id, scope));
        const copy = (await Effect.runPromise(sessions.findPiSession(home, fork!.newSessionId)))!;
        const children = await Effect.runPromise(listPiChildren(copy.path, copy.id));
        expect(children).toHaveLength(1);
        expect(children[0].status).toBe('interrupted');
        const childPath = join(dirname(copy.path), copy.id, children[0].sessionPath);
        const transcript = await readFile(childPath, 'utf8');
        for (const line of transcript.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
        expect(transcript).toContain('Frozen child history');
        snapshots.push({ path: copy.path, id: copy.id, transcript, childPath });
      }
    } finally { run.abort.abort(); await pending; }
    for (const snapshot of snapshots) {
      expect((await Effect.runPromise(listPiChildren(snapshot.path, snapshot.id)))[0].status).toBe('interrupted');
      expect(await readFile(snapshot.childPath, 'utf8')).toBe(snapshot.transcript);
    }
  }, 30000);

  it('waits for child cancellation and cleanup when the parent run is stopped', async () => {
    const run = context('parent-abort-child', 'use-hanging-subagent');
    const emit = run.ctx.emit;
    run.ctx.emit = (event) => {
      emit(event);
      if (event.type === 'tool_progress' && String(event.progress_text).includes('waiting')) run.abort.abort();
    };
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    expect(run.abort.signal.aborted).toBe(true);
    expect(await readdir(join(home, 'pi', 'tmp'))).toEqual([]);
    expect(run.events.some((event) => event.type === 'result')).toBe(false);
    const file = await Effect.runPromise(sessions.findPiSession(home, 'parent-abort-child'));
    const { listPiChildren } = await import('./piSubagentSessionLive');
    const children = await Effect.runPromise(listPiChildren(file!.path, 'parent-abort-child', 'hanging-child-call'));
    expect(children).toHaveLength(1);
    expect(children[0].status).toBe('cancelled');
    expect(await readFile(join(dirname(file!.path), 'parent-abort-child', children[0].sessionPath), 'utf8')).toContain('hang-stream');
  }, 30000);

  it('executes native tools with Cockpit environment and projects matching tool ids after reload', async () => {
    const run = context('tool-session', 'use-bash');
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    const tool = run.events.find((e) => e.type === 'assistant');
    expect(tool).toMatchObject({ message: { content: [{ type: 'tool_use', id: 'test-call', name: 'Bash' }] } });
    const result = run.events.find((e) => e.type === 'user');
    expect(result).toMatchObject({ message: { content: [{
      type: 'tool_result', content: expect.stringContaining(`run=tool-session cwd=${home} port=`),
    }] } });
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
    const hub = await import('../server/sessionRunHub');
    hub.startRun('init-input-session', home, 'launch prompt', 'init-input-session', 'ollama');
    run.ctx.acceptInput = (sink) => hub.setRunInjector('init-input-session', sink);
    run.ctx.emit = (event) => { run.events.push(event); hub.appendRun('init-input-session', event); };
    const pending = Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    await initializing;
    const accepted = hub.injectRun('init-input-session', { text: 'during initialization' }, 'queued-input');
    release();
    await pending.finally(() => { spy.mockRestore(); hub.markRunIdle('init-input-session'); hub.releaseRun('init-input-session'); });
    expect(accepted).toBe('ok');
    const file = await Effect.runPromise(sessions.findPiSession(home, 'init-input-session'));
    const parsed = await parser.parseTranscriptFile(file!.path);
    expect(parsed.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['launch prompt', 'during initialization']);
    const inputs = parsed.messages.filter((message) => message.role === 'user');
    expect(run.events.filter((event) => event.subtype === 'input_binding')).toEqual([
      { type: 'system', subtype: 'input_binding', inputId: 'init-input-session', sourceId: inputs[0].sourceId },
      { type: 'system', subtype: 'input_binding', inputId: 'queued-input', sourceId: inputs[1].sourceId },
    ]);
  });

  it('settles actual consumption identities when initialization queues an input before a length failure', async () => {
    const hub = await import('../server/sessionRunHub');
    const { chatHistoryReducer: reduce, emptyChatHistory } = await import('../client/chatHistoryState');
    const { applyStreamEvent } = await import('../client/applyStreamEvent');
    const { historyWindow } = await import('../server/historyWindow');
    const id = 'queued-length-settlement';
    const run = context(id, 'truncate-parent');
    hub.startRun(id, home, run.ctx.prompt, id, 'ollama');
    run.ctx.acceptInput = (sink) => {
      hub.setRunInjector(id, sink);
      if (sink) expect(hub.injectRun(id, { text: 'truncate-parent' }, 'queued-length')).toBe('ok');
    };
    run.ctx.emit = (event) => hub.appendRun(id, event);
    await expect(Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }))).rejects.toThrow();
    const events = hub.getRunSnapshot(id)!.events as RunEvent[];
    expect(events.filter((event) => event.subtype === 'input_started').map((event) => event.inputId)).toEqual([id]);
    hub.markRunIdle(id, 'error'); hub.releaseRun(id);
    let messages: import('../client/types').ChatMessage[] = [];
    let assistantId = '';
    for (const event of events) {
      if (event._human) messages.push({ id: String(event._turnId), liveInputId: String(event._turnId), role: 'user', content: 'truncate-parent' });
      else {
        if (event.subtype === 'input_started') assistantId = `answer-${event.inputId}`;
        messages = applyStreamEvent(messages, event, { engine: 'ollama', assistantId });
      }
    }
    let state = reduce(emptyChatHistory, { type: 'replay-start', run: { id, startedAt: Date.now() } });
    state = reduce(state, { type: 'run-messages', runId: id, update: messages });
    state = reduce(state, { type: 'run-end', runId: id, writerActive: false, failed: true });
    const file = await Effect.runPromise(sessions.findPiSession(home, id));
    state = reduce(state, { type: 'page', sessionId: id, mode: 'replace', reconciles: [id],
      page: { ...historyWindow((await parser.parseTranscriptFile(file!.path)).messages, {}), stable: true } });
    expect(state.messages.filter((row) => row.content === 'truncate-parent')).toHaveLength(1);
    expect(state.failures[0].messages.filter((row) => row.content === 'truncate-parent')).toHaveLength(2);
    expect(state.messages.filter((row) => row.content.includes('Partial parent answer'))).toHaveLength(1);
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
    const { dispatchChat } = await import('../server/engines/orchestrator');
    const image = { type: 'base64' as const, media_type: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR8sAAAAASUVORK5CYII=' };
    try {
      expect((await dispatchChat({ name: 'ollama', runner: {
        // Keep dispatch ownership intact; omit its cwd to exclude unrelated Git snapshots.
        run: ctx => Effect.runPromise(runPiAgent({ ...ctx, cwd: home }, { engine: 'ollama', baseUrl, apiKey: 'test' })),
      } }, { prompt: 'initial unprocessed input', runId: id, model: 'test-model' })).ok).toBe(true);
      await initializing;
      expect(hub.injectRun(id, { text: 'accepted while initializing' }, 'injected')).toBe('ok');
      expect(hub.injectRun(id, { images: [image] }, 'image-input')).toBe('ok');
      expect(hub.requestStop(id)).toBe(true);
    } finally {
      release();
      await hub.waitForWriter(id, 3000);
      spy.mockRestore();
    }
    expect(hub.getRunSnapshot(id)?.writerActive).toBe(false);
    expect(hub.getRunSnapshot(id)?.status).toBe('idle');
    const file = await Effect.runPromise(sessions.findPiSession(home, 'cancel-init-session'));
    expect(file).toBeDefined();
    const restored = SessionManager.open(file!.path);
    expect(JSON.stringify(restored.getEntries())).toContain('accepted while initializing');
    expect(restored.buildSessionContext().messages).toEqual([]);
    expect(await readFile(file!.path, 'utf8')).toContain(image.data);
    const parsed = await parser.parseTranscriptFile(file!.path);
    expect(parsed.messages.some((message) => message.role === 'system' && message.content.includes('accepted while initializing'))).toBe(true);
    const resumed = context('unused', 'new explicit task', id);
    await Effect.runPromise(runPiAgent(resumed.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('accepted while initializing');
    const afterResume = await parser.parseTranscriptFile(file!.path);
    expect(afterResume.messages.some((message) => message.role === 'system' && message.content.includes('accepted while initializing'))).toBe(true);
    const { chatHistoryReducer, emptyChatHistory } = await import('../client/chatHistoryState');
    const { historyWindow } = await import('../server/historyWindow');
    const recovery = hub.getRunSnapshot(id)!.events.find(event => (event as { undeliveredInputs?: unknown }).undeliveredInputs) as import('../client/applyStreamEvent').StreamEvent;
    expect(recovery).toMatchObject({ undeliveredInputs: [{ inputId: id }, { inputId: 'injected' }, { inputId: 'image-input', images: [image] }] });
    let state = chatHistoryReducer(emptyChatHistory, { type: 'replay-start', run: { id, startedAt: Date.now() } });
    state = chatHistoryReducer(state, { type: 'run-messages', runId: id, update: [
      { id: 'first', role: 'user', content: 'initial unprocessed input', liveInputId: id },
      { id: 'queued', role: 'user', content: 'accepted while initializing', liveInputId: 'injected' },
      { id: 'image', role: 'user', content: '', images: [image], liveInputId: 'image-input' },
    ] });
    state = chatHistoryReducer(state, { type: 'run-messages', runId: id, update: { event: recovery, engine: 'ollama', assistantId: 'placeholder' } });
    state = chatHistoryReducer(state, { type: 'run-end', runId: id, writerActive: false, failed: true });
    state = chatHistoryReducer(state, { type: 'page', sessionId: id, mode: 'replace', reconciles: [id], page: { ...historyWindow(parsed.messages, {}), stable: true } });
    expect(state.runs).toHaveLength(0);
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0].messages.find(row => row.liveInputId === 'image-input' && row.role === 'user')?.images).toEqual([image]);
    expect(state.failures[0].messages.some(row => row.streamError?.includes('cancelled'))).toBe(true);
    expect(state.messages.some(row => row.images?.length)).toBe(false);

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
    const hub = await import('../server/sessionRunHub');
    const { dispatchChat } = await import('../server/engines/orchestrator');
    const id = 'cancelled-queued-session';
    let injected = false;
    const off = hub.addRunListener(id, ({ message }) => {
      const event = message as RunEvent;
      if (!injected && event.type === 'stream_event' && (event.event as { type: string }).type === 'content_block_delta') {
        injected = true;
        expect(hub.injectRun(id, { text: 'accepted before cancellation' }, 'queued-before-stop')).toBe('ok');
        hub.requestStop(id);
      }
    });
    try {
      expect((await dispatchChat({ name: 'ollama', runner: {
        run: ctx => Effect.runPromise(runPiAgent({ ...ctx, cwd: home }, { engine: 'ollama', baseUrl, apiKey: 'test' })),
      } }, { prompt: 'hang-stream', runId: id, model: 'test-model' })).ok).toBe(true);
      expect(await hub.waitForWriter(id, 3000)).toBe(true);
    } finally { off(); hub.requestStop(id); await hub.waitForWriter(id, 3000); }
    expect(injected).toBe(true);
    expect(hub.getRunSnapshot(id)?.status).toBe('idle');
    expect(hub.getRunSnapshot(id)?.events.find((event) => (event as RunEvent).type === 'error')).toMatchObject({
      error: 'Input did not complete because the run was cancelled.',
      // The prompt Pi was answering is already native history; only the queued input is undelivered.
      undeliveredInputs: [expect.objectContaining({ text: 'accepted before cancellation', inputId: 'queued-before-stop' })],
    });
    const file = await Effect.runPromise(sessions.findPiSession(home, 'cancelled-queued-session'));
    const parsed = await parser.parseTranscriptFile(file!.path);
    expect(parsed.messages.some((message) => message.role === 'system' && message.content.includes('accepted before cancellation'))).toBe(true);
    expect(JSON.stringify(SessionManager.open(file!.path).buildSessionContext().messages)).not.toContain('accepted before cancellation');
    expect(hub.injectRun(id, { text: 'after close' }, 'rejected-after-close')).toBe('idle');
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

  it('preserves later referenced edits in prefix clones without duplicating earlier edits or copying later turns', async () => {
    const run = context('prefix-late-edits', 'first source task');
    await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
    const file = (await Effect.runPromise(sessions.findPiSession(home, 'prefix-late-edits')))!;
    const source = SessionManager.open(file.path);
    const first = source.getBranch().find((e) => e.type === 'message' && e.message.role === 'user')!;
    const assistant = source.getBranch().find((e) => e.type === 'message' && e.message.role === 'assistant')!;
    source.appendContextEdit(assistant.id, { content: [{ type: 'text', text: 'earlier edit' }] });
    const later = source.appendMessage({ role: 'user', content: 'later turn', timestamp: Date.now() });
    source.appendContextEdit(first.id, { content: 'edited first source task' });
    source.appendContextEdit(assistant.id, null);
    source.appendContextEdit(assistant.id, { content: [{ type: 'text', text: 'restored' }] });
    source.appendContextEdit(assistant.id, null);
    source.appendContextEdit(later, { content: 'must not appear' });
    const result = await Effect.runPromise(edits.forkPiSession(file.path, first.id, 'prefix'));
    const copyFile = (await Effect.runPromise(sessions.findPiSession(home, result!.newSessionId)))!;
    const copy = SessionManager.open(copyFile.path);
    const branch = copy.getBranch();
    const contextEdits = branch.filter((e) => e.type === 'context_edit');
    expect(contextEdits).toHaveLength(5);
    expect(contextEdits.every((e) => branch.some((target) => target.type === 'message' && target.id === e.targetId))).toBe(true);
    expect(copy.buildSessionContext().messages.filter((m) => m.role !== 'system')).toEqual([
      expect.objectContaining({ role: 'user', content: 'edited first source task' }),
    ]);
    expect(JSON.stringify(branch)).not.toContain('later turn');
    expect(JSON.stringify(branch)).not.toContain('must not appear');
    expect(contextEdits.at(-1)?.replacement).toBeNull();
  });

  it('surfaces provider failures and retains their reason after reload', async () => {
    const run = context('error-session', 'fail-auth');
    await expect(Effect.runPromise(runPiAgent(run.ctx, { engine: 'glm', baseUrl, apiKey: 'test' }))).rejects.toThrow();
    expect(run.events.some((event) => event.type === 'result')).toBe(false);
    const file = await Effect.runPromise(sessions.findPiSession(home, 'error-session'));
    expect(JSON.stringify((await parser.parseTranscriptFile(file!.path)).messages)).toContain('Invalid test API key');
  });

  it('treats Stop mid-reply as a plain stop without recovery notes', async () => {
    const hub = await import('../server/sessionRunHub');
    const { dispatchChat } = await import('../server/engines/orchestrator');
    const id = 'plain-stop-session';
    let stopped = false;
    const received: RunEvent[] = [];
    const off = hub.addRunListener(id, ({ message }) => {
      const event = message as RunEvent;
      received.push(event);
      if (!stopped && event.type === 'stream_event' && (event.event as { type: string }).type === 'content_block_delta') {
        stopped = true;
        hub.requestStop(id);
      }
    });
    try {
      expect((await dispatchChat({ name: 'ollama', runner: {
        run: ctx => Effect.runPromise(runPiAgent({ ...ctx, cwd: home }, { engine: 'ollama', baseUrl, apiKey: 'test' })),
      } }, { prompt: 'hang-stream', runId: id, model: 'test-model' })).ok).toBe(true);
      expect(await hub.waitForWriter(id, 3000)).toBe(true);
    } finally { off(); hub.requestStop(id); await hub.waitForWriter(id, 3000); }
    expect(stopped).toBe(true);
    expect(received).toContainEqual(expect.objectContaining({ subtype: 'input_binding', inputId: id }));
    expect(hub.getRunSnapshot(id)?.status).toBe('idle');
    expect(received.some((event) => 'undeliveredInputs' in event)).toBe(false);
    expect(received.find((event) => event.type === 'run-settled')).toMatchObject({ status: 'idle' });
    const file = await Effect.runPromise(sessions.findPiSession(home, id));
    expect(await readFile(file!.path, 'utf8')).not.toContain('cockpit.undelivered-input');
    const parsed = await parser.parseTranscriptFile(file!.path);
    expect(parsed.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['hang-stream']);
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


it('leaves repeated parent tool calls on the native path without a child progress guard', async () => {
  const start = requests.length;
  const run = context('parent-no-progress-guard', 'parent-repeat-six');
  await Effect.runPromise(runPiAgent(run.ctx, { engine: 'ollama', baseUrl, apiKey: 'test' }));
  expect(requests.slice(start)).toHaveLength(7);
  expect(JSON.stringify(run.events)).not.toContain('Execution notice:');
  expect(run.events.at(-1)).toMatchObject({ type: 'result', subtype: 'success' });
}, 30000);
