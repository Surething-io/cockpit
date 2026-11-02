// Real dependency CLI against an isolated local provider, never a paid endpoint.
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect } from 'effect';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { ModelRuntime, type ExtensionAPI, type ToolDefinition, type ExtensionToolContext } from '@earendil-works/pi-coding-agent';

let home: string, baseUrl: string, server: Server;
let tool: ToolDefinition;
const key = 'test-literal-$key!';
const requests: Array<{ model: string; messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }> = [];
const previousHome = process.env.COCKPIT_HOME;
const previousRoot = process.env.COCKPIT_ROOT;
const parentAbort = new AbortController();
let runtime: ModelRuntime;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'cockpit-pi-children-'));
  process.env.COCKPIT_HOME = home;
  process.env.COCKPIT_ROOT = process.cwd();
  await mkdir(join(home, 'pi'), { recursive: true });
  const ids = ['test-model', 'other-model', 'parent-model', 'first-model', 'second-model', 'k3'];
  const models = ids.map((id) => ({ id, contextWindow: 1000000, maxTokens: 32768, input: ['text'], reasoning: id === 'k3' }));
  await writeFile(join(home, 'pi', 'models.json'), JSON.stringify({ providers: Object.fromEntries(['ollama', 'deepseek', 'kimi', 'glm'].map((p) => [p, { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models }])) }));

  runtime = await ModelRuntime.create({ authPath: join(home, 'pi', 'auth.json'), modelsPath: null, refreshOnCreate: false });
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (req.headers.authorization !== `Bearer ${key}` || body.messages.some((m: { content: unknown }) => m.content === null)) {
      res.writeHead(401); res.end(JSON.stringify({ error: { message: 'Wrong credential or null content' } })); return;
    }
    if (JSON.stringify(body.messages).includes('fail-child')) { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'Rejected child task' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant' });
    const text = JSON.stringify(body.messages);
    if (text.includes('long-child')) { send({ content: 'x'.repeat(60000) + 'FULL-RESULT-END' }); send({}, 'stop'); res.write('data: [DONE]\n\n'); res.end(); return; }
    if (text.includes('truncate-child')) { send({ content: 'Partial child answer' }); send({}, 'length'); res.write('data: [DONE]\n\n'); res.end(); return; }
    if (text.includes('hang-child')) { send({ content: 'Waiting' }); return; }
    if (text.includes('try-nested-pi') && !body.messages.some((m: { role: string }) => m.role === 'tool')) {
      send({ tool_calls: [{ index: 0, id: 'nested-child-call', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `printf started > '${join(home, 'nested-shell-started')}'; node '${join(home, 'fake', 'pi', 'dist', 'cli.js')}' -p review` }) } }] });
      send({}, 'tool_calls');
    } else if (text.includes('call-child-bash') && !body.messages.some((m: { role: string }) => m.role === 'tool')) {
      send({ tool_calls: [{ index: 0, id: 'child-call', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'printf "dir=%s key=%s" "$PI_CODING_AGENT_DIR" "$COCKPIT_PI_SUBAGENT_API_KEY"' }) } }] });
      send({}, 'tool_calls');
    } else { send({ content: `Child finished: ${JSON.stringify(body.messages.findLast((m: { role: string }) => m.role === 'user')?.content)}` }); send({}, 'stop'); }
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('No test port');
  baseUrl = `http://127.0.0.1:${addr.port}/v1`;
  const { makePiSubagentExtension } = await import('./piSubagentLive');
  const extension = await Effect.runPromise(makePiSubagentExtension({ engine: 'ollama', baseUrl, apiKey: key }, runtime, 'parent-model', parentAbort.signal, 'parent-run', join(home, 'pi', 'sessions', '--parent--', 'parent.jsonl')));
  await extension({ registerTool: (registered: ToolDefinition) => { tool = registered; } } as unknown as ExtensionAPI);
}, 30000);
afterAll(async () => {
  if (previousRoot === undefined) delete process.env.COCKPIT_ROOT; else process.env.COCKPIT_ROOT = previousRoot;
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (home) await rm(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.COCKPIT_HOME; else process.env.COCKPIT_HOME = previousHome;
});
const execute = (params: unknown, signal?: AbortSignal, update?: (result: unknown) => void) => tool.execute('call', params, signal, update,
  { cwd: home, model: { provider: 'ollama', id: 'parent-model' }, thinkingLevel: 'off' } as ExtensionToolContext);

it('dynamically creates an agent with inherited model/key, isolated context and correct CLI root', async () => {
  const updates: unknown[] = [];
  const result = await execute({ task: 'call-child-bash', instructions: 'Unique dynamic instructions', name: 'New role never defined' }, undefined, (u) => updates.push(u));
  expect(result.isError, JSON.stringify(result)).toBe(false);
  expect(JSON.stringify(result)).toContain('Child finished');
  expect(JSON.stringify(requests)).toContain('Unique dynamic instructions');
  expect(JSON.stringify(requests)).toContain(`dir=${join(home, 'pi')} key=`);
  expect(JSON.stringify(requests)).not.toContain(key);
  expect(requests.every((request) => request.model === 'parent-model')).toBe(true);
  expect(requests.every((request) => !request.tools?.some((t) => t.function.name === 'subagent'))).toBe(true);
  expect(updates.length).toBeGreaterThan(1);
  expect((await readdir(join(home, 'pi', 'tmp')))).toEqual([]);
  const { subagents } = result.details as { subagents: Array<{ id: string; sessionPath: string }> };
  const path = join(home, 'pi', 'sessions', '--parent--', 'parent-run', subagents[0].sessionPath);
  const transcript = await readFile(path, 'utf8');
  expect(transcript).toContain('Unique dynamic instructions');
  expect(transcript).toContain('call-child-bash');
  expect(transcript).toContain('Child finished');
  expect(transcript).not.toContain(key);
  const header = JSON.parse(transcript.split('\n')[0]);
  expect(header.id).toBe(subagents[0].id);
}, 30000);

it('allows a direct Pi CLI path through the child native Bash tool', async () => {
  const fakeDir = join(home, 'fake', 'pi', 'dist');
  await mkdir(fakeDir, { recursive: true });
  await writeFile(join(fakeDir, 'cli.js'), 'console.log("direct-child-pi-ran")');
  const result = await execute({ task: 'try-nested-pi' });
  expect(result.isError).toBe(false);
  expect(await readFile(join(home, 'nested-shell-started'), 'utf8')).toBe('started');
  const { subagents } = result.details as { subagents: Array<{ sessionPath: string }> };
  const path = join(home, 'pi', 'sessions', '--parent--', 'parent-run', subagents[0].sessionPath);
  expect(await readFile(path, 'utf8')).toContain('direct-child-pi-ran');
  expect(JSON.stringify(requests.at(-1)?.messages)).toContain('direct-child-pi-ran');
}, 30000);

it('returns explicit truncation, partial output and native child status to the parent', async () => {
  const result = await execute({ task: 'truncate-child', tools: [] });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('stopReason=length');
  expect(JSON.stringify(result)).toContain('Partial child answer');
  const { subagents } = result.details as { subagents: Array<{ sessionPath: string; status: string; stopReason: string }> };
  expect(subagents[0]).toMatchObject({ status: 'truncated', stopReason: 'length' });
  const path = join(home, 'pi', 'sessions', '--parent--', 'parent-run', subagents[0].sessionPath);
  const { dirname } = await import('node:path');
  expect(JSON.parse(await readFile(join(dirname(path), 'meta.json'), 'utf8')).status).toBe('truncated');
}, 30000);

it('supports parallel dynamic tasks with distinct models and ordered results', async () => {
  const result = await execute({ tasks: [{ task: 'parallel one', model: 'first-model' }, { task: 'parallel two', model: 'ollama/second-model', tools: [] }] });
  expect(result.isError).toBe(false);
  const details = result.details as { subagents: Array<{ model: string; task: string }> };
  expect(details.subagents.map((r) => r.task)).toEqual(['parallel one', 'parallel two']);
  expect(details.subagents.map((r) => r.model)).toEqual(['ollama/first-model', 'ollama/second-model']);
}, 30000);

it('passes a previous result into the next chain step', async () => {
  const result = await execute({ chain: [{ task: 'chain first' }, { task: 'chain second {previous}' }] });
  expect(result.isError).toBe(false);
  const details = result.details as { subagents: Array<{ task: string; output: string }> };
  expect(details.subagents[1].task).toBe(`chain second ${details.subagents[0].output}`);
  expect(JSON.stringify(requests.at(-1)?.messages)).toContain('chain second');
}, 30000);

it('cancels a real hanging CLI and waits for temporary-resource cleanup', async () => {
  const abort = new AbortController();
  const pending = execute({ task: 'hang-child' }, abort.signal, (result) => {
    if (JSON.stringify(result).includes('Waiting')) abort.abort();
  });
  await expect(pending).rejects.toThrow();
  expect(await readdir(join(home, 'pi', 'tmp'))).toEqual([]);
  const { listPiChildren } = await import('./piSubagentSessionLive');
  const children = await Effect.runPromise(listPiChildren(join(home, 'pi', 'sessions', '--parent--', 'parent.jsonl'), 'parent-run'));
  const cancelled = children.filter((c) => c.task === 'hang-child');
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0].status).toBe('cancelled');
  const path = join(home, 'pi', 'sessions', '--parent--', 'parent-run', cancelled[0].sessionPath);
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const entries = SessionManager.open(path).getBranch();
  expect(entries.some((e) => e.type === 'message' && e.message.role === 'assistant' && e.message.stopReason === 'aborted' && JSON.stringify(e.message.content).includes('Waiting'))).toBe(true);
}, 30000);

it('rejects invalid dispatch modes and tool names before starting a process', async () => {
  expect((await execute({ task: 'one', tasks: [{ task: 'two' }] })).isError).toBe(true);
  expect((await execute({ task: 'one', tools: ['subagent'] })).isError).toBe(true);
});

it('stops chains on failure and preserves independent parallel successes', async () => {
  const chain = await execute({ chain: [{ task: 'fail-child' }, { task: 'must not execute' }] });
  expect(chain.isError).toBe(true);
  expect((chain.details as { subagents: unknown[] }).subagents).toHaveLength(1);
  expect(JSON.stringify(requests)).not.toContain('must not execute');
  const parallel = await execute({ tasks: [{ task: 'fail-child' }, { task: 'successful sibling' }] });
  expect(parallel.isError).toBe(true);
  expect((parallel.details as { subagents: Array<{ status: string }> }).subagents.map((r) => r.status)).toEqual(['failed', 'done']);
}, 30000);

it('uses another configured provider with its own key and native model compatibility', async () => {
  const { kimiApiKey } = await import('../server/engines/credentials');
  const endpoints = await import('../server/engines/anthropicCompat');
  const keySpy = vi.spyOn(kimiApiKey, 'read').mockResolvedValue(key);
  const endpointSpy = vi.spyOn(endpoints, 'readEngineEndpoints').mockResolvedValue({ openAiBaseUrl: baseUrl });
  try {
    const result = await execute({ task: 'kimi child', model: 'kimi/k3', tools: [] });
    expect(result.isError).toBe(false);
    expect(requests.at(-1)).toHaveProperty('model', 'k3');
    expect(requests.at(-1)).toHaveProperty('max_tokens');
    expect(requests.at(-1)).not.toHaveProperty('temperature');
  } finally { keySpy.mockRestore(); endpointSpy.mockRestore(); }
}, 30000);

it('marks host truncation in parallel and chain results while retaining the full native history', async () => {
  for (const mode of ['tasks', 'chain'] as const) {
    const before = requests.length;
    const result = await execute({ [mode]: [{ task: 'long-child', tools: [] }, { task: 'after-long-result {previous}', tools: [] }] });
    expect(result.isError).toBe(true);
    const { subagents } = result.details as { subagents: Array<{ sessionPath: string; status: string; error: string }> };
    expect(subagents[0]).toMatchObject({ status: 'truncated', error: expect.stringContaining('host output limit') });
    const path = join(home, 'pi', 'sessions', '--parent--', 'parent-run', subagents[0].sessionPath);
    expect(await readFile(path, 'utf8')).toContain('FULL-RESULT-END');
    const { dirname } = await import('node:path');
    expect(JSON.parse(await readFile(join(dirname(path), 'meta.json'), 'utf8')).status).toBe('truncated');
    expect(subagents).toHaveLength(mode === 'chain' ? 1 : 2);
    expect(requests.slice(before)).toHaveLength(mode === 'chain' ? 1 : 2);
  }
}, 30000);
