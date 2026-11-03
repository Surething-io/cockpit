import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';

describe('Grok native context operations', () => {
  let home: string;
  let native: typeof import('./grokNativeSessionLive');
  let display: typeof import('./grokSessionLive');
  let cwd: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'cockpit-grok-context-'));
    cwd = join(home, 'project with spaces', '用户');
    await mkdir(cwd, { recursive: true });
    vi.stubEnv('COCKPIT_HOME', join(home, 'cockpit'));
    vi.stubEnv('GROK_HOME', join(home, 'native'));
    vi.stubEnv('COCKPIT_ROOT', process.cwd());
    vi.resetModules();
    native = await import('./grokNativeSessionLive');
    display = await import('./grokSessionLive');
  });
  afterAll(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });
  const lines = (values: unknown[]) => values.map((item) => JSON.stringify(item)).join('\n') + '\n';
  async function fixture() {
    const id = randomUUID();
    const dir = native.grokNativeSessionPath(cwd, id);
    const path = display.grokSessionPath(cwd, id);
    await mkdir(dir, { recursive: true });
    await mkdir(join(path, '..'), { recursive: true });
    const summary = { info: { id, cwd }, agent_id: `ag1.${randomUUID().replaceAll('-', '')}`, attempt_id: `at1.${randomUUID().replaceAll('-', '')}`,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), num_messages: 6, num_chat_messages: 8,
      current_model_id: 'grok-4.7', chat_format_version: 1, next_trace_turn: 4 };
    const preamble = [{ type: 'system', content: 'Test agent' }, { type: 'user', content: [{ type: 'text', text: '<user_info>Project</user_info>' }] }];
    const chat = [...preamble, ...[0, 1, 2].flatMap((i) => [
      { type: 'user', prompt_index: i, content: [{ type: 'text', text: `QUESTION-${i}` }] },
      { type: 'assistant', content: '', tool_calls: [{ id: `call-${i}`, name: 'read_file', arguments: '{}' }] },
      { type: 'tool_result', tool_call_id: `call-${i}`, content: `RESULT-${i}` },
      { type: 'assistant', content: `ANSWER-${i}` },
    ])];
    const updates = [0, 1, 2].flatMap((i) => [
      { method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `QUESTION-${i}` }, _meta: { promptIndex: i } } } },
      { method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ANSWER-${i}` } } } },
    ]);
    const transcript = [0, 1, 2].flatMap((i) => [
      { uuid: `u-${i}`, type: 'user', sessionId: id, cwd, message: { role: 'user', content: `QUESTION-${i}` } },
      { uuid: `a-${i}`, type: 'assistant', sessionId: id, cwd, message: { role: 'assistant', content: `ANSWER-${i}` } },
    ]);
    await writeFile(join(dir, 'summary.json'), JSON.stringify(summary));
    await writeFile(join(dir, 'chat_history.jsonl'), lines(chat));
    await writeFile(join(dir, 'updates.jsonl'), lines(updates));
    await writeFile(path, lines(transcript));
    return { id, dir, path, summary, chat, updates, preamble };
  }
  const readLines = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

  it.each(['prefix', 'single'] as const)('forks %s with complete native tool pairs and new identity', async (scope) => {
    const source = await fixture();
    const before = await readFile(join(source.dir, 'chat_history.jsonl'), 'utf8');
    const result = await Effect.runPromise(native.editGrokTurn(cwd, source.id, 'a-1', scope));
    expect(result).toBeDefined();
    const target = native.grokNativeSessionPath(cwd, result!.newSessionId);
    const chat = await readFile(join(target, 'chat_history.jsonl'), 'utf8');
    expect(chat).toContain('QUESTION-1'); expect(chat).toContain('RESULT-1'); expect(chat).toContain('call-1');
    expect(chat).not.toContain('QUESTION-2');
    expect(chat.includes('QUESTION-0')).toBe(scope === 'prefix');
    expect((await readLines(join(target, 'chat_history.jsonl'))).filter((entry) => 'prompt_index' in entry).map((entry) => entry.prompt_index)).toEqual(scope === 'prefix' ? [0, 1] : [0]);
    const updates = await readLines(join(target, 'updates.jsonl'));
    expect(updates.every((entry) => entry.params.sessionId === result!.newSessionId)).toBe(true);
    const summary = JSON.parse(await readFile(join(target, 'summary.json'), 'utf8'));
    expect(summary.info.id).toBe(result!.newSessionId); expect(summary.agent_id).not.toBe(source.summary.agent_id);
    expect(await readFile(join(source.dir, 'chat_history.jsonl'), 'utf8')).toBe(before);
    expect((await readLines(display.grokSessionPath(cwd, result!.newSessionId))).every((entry) => entry.sessionId === result!.newSessionId)).toBe(true);
  });

  it('deletes a middle turn from model context, replay and display; resets derived state', async () => {
    const source = await fixture();
    await writeFile(join(source.dir, 'plan.json'), JSON.stringify({ secret: 'QUESTION-1' }));
    await writeFile(join(source.dir, 'rewind_points.jsonl'), 'old-file-checkpoints');
    await mkdir(join(source.dir, 'goal'));
    await mkdir(join(source.dir, 'workflows', 'workflow-1'), { recursive: true });
    await writeFile(join(source.dir, 'goal', 'state.json'), JSON.stringify({ secret: 'QUESTION-1' }));
    await writeFile(join(source.dir, 'workflows', 'workflow-1', 'state.json'), JSON.stringify({ secret: 'QUESTION-1' }));
    await Effect.runPromise(native.editGrokTurn(cwd, source.id, 'a-1', 'delete'));
    for (const path of ['chat_history.jsonl', 'updates.jsonl']) {
      const text = await readFile(join(source.dir, path), 'utf8');
      expect(text).not.toContain('QUESTION-1'); expect(text).toContain('QUESTION-0'); expect(text).toContain('QUESTION-2');
    }
    const chat = await readLines(join(source.dir, 'chat_history.jsonl'));
    expect(chat.filter((entry) => 'prompt_index' in entry).map((entry) => entry.prompt_index)).toEqual([0, 1]);
    expect(await readFile(source.path, 'utf8')).not.toContain('QUESTION-1');
    expect(await readdir(source.dir)).not.toContain('plan.json');
    expect(await readFile(join(source.dir, 'rewind_points.jsonl'), 'utf8')).toBe('');
    expect(await readdir(join(source.dir, 'goal'))).not.toContain('state.json');
    expect(await readFile(join(source.dir, 'workflows', 'workflow-1', 'cleared'), 'utf8')).toBe('');
  });

  it('sends independent turns to an empty native branch and merges once, including crash recovery', async () => {
    const source = await fixture();
    const branch = await Effect.runPromise(native.prepareGrokContext(cwd, source.id, true));
    const dir = native.grokNativeSessionPath(cwd, branch);
    const empty = await readFile(join(dir, 'chat_history.jsonl'), 'utf8');
    expect(empty).toContain('<user_info>'); expect(empty).not.toContain('QUESTION-'); expect(empty).not.toContain('ANSWER-');
    expect(await readFile(join(dir, 'updates.jsonl'), 'utf8')).toBe('');
    await writeFile(join(dir, 'chat_history.jsonl'), empty + lines([
      { type: 'user', prompt_index: 0, content: [{ type: 'text', text: 'INDEPENDENT-QUESTION' }] },
      { type: 'assistant', content: 'INDEPENDENT-ANSWER' },
    ]));
    await writeFile(join(dir, 'updates.jsonl'), lines([{ method: 'session/update', params: { sessionId: branch, update: { sessionUpdate: 'user_message_chunk', _meta: { promptIndex: 0 } } } }]));
    // A new run recovers a previous process's unfinished independent turn.
    expect(await Effect.runPromise(native.prepareGrokContext(cwd, source.id, false))).toBe(source.id);
    await Effect.runPromise(native.finishGrokContext(cwd, source.id));
    const merged = await readFile(join(source.dir, 'chat_history.jsonl'), 'utf8');
    expect(merged.match(/INDEPENDENT-QUESTION/g)).toHaveLength(1);
    expect(merged).toContain('QUESTION-0'); expect(merged).toContain('QUESTION-2');
    expect((await readLines(join(source.dir, 'chat_history.jsonl'))).filter((entry) => 'prompt_index' in entry).map((entry) => entry.prompt_index)).toEqual([0, 1, 2, 3]);
    expect((await readLines(join(source.dir, 'updates.jsonl'))).at(-1).params).toMatchObject({ sessionId: source.id, update: { _meta: { promptIndex: 3 } } });
    expect(await readdir(source.dir)).not.toContain('cockpit-independent.json');
  });

  it('runs independent prompts on the native branch while keeping the visible session identity', async () => {
    const source = await fixture();
    const { runGrokTurn } = await import('./grokRunLive');
    const trace = join(home, 'runner-trace.jsonl');
    const events: Array<Record<string, unknown>> = [];
    const rekey = vi.fn();
    await runGrokTurn({ cwd, sessionId: source.id, prompt: 'ISOLATED-RUN', images: undefined, params: { noHistory: true },
      signal: new AbortController().signal, emit: (event) => events.push(event), rekey, currentKey: () => source.id, acceptInput: vi.fn(),
    }, { binary: process.execPath, args: [resolve('packages/feature/agent/src/server/engines/grokAcp/mock-agent.mjs'), 'native-context', trace] });
    const frames = await readLines(trace);
    const context = frames.find((frame) => frame.loadedContext)?.loadedContext;
    expect(context).toContain('<user_info>'); expect(context).not.toContain('QUESTION-');
    const prompt = frames.find((frame) => frame.method === 'session/prompt');
    expect(prompt.params.sessionId).not.toBe(source.id);
    expect(rekey).toHaveBeenCalledWith(source.id);
    expect(events.filter((event) => 'session_id' in event).every((event) => event.session_id === source.id)).toBe(true);
    const merged = await readFile(join(source.dir, 'chat_history.jsonl'), 'utf8');
    expect(merged).toContain('QUESTION-0'); expect(merged).toContain('ISOLATED-RUN');
    expect((await readLines(join(source.dir, 'chat_history.jsonl'))).at(-2).prompt_index).toBe(3);
    const transcript = await readFile(source.path, 'utf8');
    expect(transcript).toContain('ISOLATED-RUN'); expect(transcript).toContain('Hello 世界');
  });

  it('rolls back a partial multi-file edit before native resume', async () => {
    const source = await fixture();
    const path = join(source.dir, 'chat_history.jsonl');
    const original = await readFile(path, 'utf8');
    await writeFile(join(source.dir, 'cockpit-edit-backup.json'), JSON.stringify({ [path]: original }));
    await writeFile(path, 'partial edit');
    await Effect.runPromise(native.prepareGrokContext(cwd, source.id, false));
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('refuses inexact edits after compaction without changing either store', async () => {
    const source = await fixture();
    const chat = source.chat.filter((entry) => !('prompt_index' in entry && entry.prompt_index === 0));
    await writeFile(join(source.dir, 'chat_history.jsonl'), lines(chat));
    const before = await readFile(source.path, 'utf8');
    const result = await Effect.runPromiseExit(native.editGrokTurn(cwd, source.id, 'u-0', 'delete'));
    expect(result._tag).toBe('Failure'); expect(await readFile(source.path, 'utf8')).toBe(before);
  });
});
