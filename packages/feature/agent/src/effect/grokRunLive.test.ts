import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RunCtx, RunEvent } from '../server/engines/types';

describe('Grok CLI subscription ACP runner', () => {
  let home: string;
  let runGrokTurn: typeof import('./grokRunLive').runGrokTurn;
  let grokSessionPath: typeof import('./grokSessionLive').grokSessionPath;
  let parseTranscriptFile: typeof import('../server/api/session/transcriptParsers').parseTranscriptFile;
  let serial = 0;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'cockpit-grok-'));
    vi.stubEnv('COCKPIT_HOME', home);
    vi.stubEnv('XAI_API_KEY', 'must-not-be-used');
    vi.resetModules();
    ({ runGrokTurn } = await import('./grokRunLive'));
    ({ grokSessionPath } = await import('./grokSessionLive'));
    ({ parseTranscriptFile } = await import('../server/api/session/transcriptParsers'));
  });
  afterAll(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

  function setup(scenario: string, resume = false) {
    const events: RunEvent[] = [];
    const controller = new AbortController();
    const trace = join(home, `trace-${serial++}.jsonl`);
    // The child cwd must exist; the isolated home also works as a project.
    const ctx: RunCtx = {
      prompt: 'Read hello.ts', images: undefined, cwd: home,
      sessionId: resume ? 'grok-test-session' : undefined,
      params: { model: 'custom-grok-model', runId: 'test-input' }, outputStyle: 'Use concise replies.', signal: controller.signal,
      emit: (event) => events.push(event), rekey: vi.fn(), currentKey: () => 'test-run', acceptInput: vi.fn(),
    };
    const run = () => runGrokTurn(ctx, {
      binary: process.execPath,
      args: [resolve('packages/feature/agent/src/server/engines/grokAcp/mock-agent.mjs'), scenario, trace],
    });
    return { ctx, events, controller, trace, run };
  }

  it.each(['auth', 'v2', 'rpc-complete'])('handles %s, restores sessions, and persists text/tools with stable IDs', async (scenario) => {
    const test = setup(scenario, true);
    test.ctx.params.grokReasoningEffort = 'low';
    await test.run();
    const trace = (await readFile(test.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(trace.every((frame) => !frame.apiKeyPresent)).toBe(true);
    expect(trace[0]).toMatchObject({ method: 'initialize', params: { protocolVersion: 2, _meta: { clientType: 'extension' } } });
    if (scenario === 'auth') expect(trace).toContainEqual(expect.objectContaining({ method: 'authenticate', params: { methodId: 'cached_token' } }));
    expect(trace).toContainEqual(expect.objectContaining({ method: scenario === 'v2' ? 'session/resume' : 'session/load' }));
    expect(trace).toContainEqual(expect.objectContaining({ method: scenario === 'v2' ? 'session/set_config_option' : 'session/set_model' }));
    expect(trace).toContainEqual(expect.objectContaining(scenario === 'v2'
      ? { method: 'session/set_config_option', params: { sessionId: 'grok-test-session', configId: 'effort', value: 'low' } }
      : { method: 'session/set_model', params: { sessionId: 'grok-test-session', modelId: 'custom-grok-model', _meta: { reasoningEffort: 'low' } } }));
    expect(trace.find((frame) => frame.method === 'session/prompt').params.prompt[0].text).toContain('Use concise replies.');
    expect(test.ctx.rekey).toHaveBeenCalledWith('grok-test-session');
    expect(JSON.stringify(test.events)).not.toContain('old replay');
    expect(JSON.stringify(test.events)).not.toContain('foreign text');
    expect(test.events.at(-1)).toMatchObject({ type: 'result', subtype: 'success' });
    const parsed = await parseTranscriptFile(grokSessionPath(home, 'grok-test-session'));
    expect(test.events.find((event) => event.subtype === 'input_binding')).toMatchObject({
      inputId: 'test-input', sourceId: parsed.messages.findLast((row) => row.role === 'user')?.sourceId,
    });
    expect(parsed.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Hello 世界\n\n done', toolCalls: [expect.objectContaining({ id: 'read-1', name: 'Read', result: 'file contents' })] });
    expect(() => process.kill(trace[0].pid, 0)).toThrow();
  });

  it('restores the session model and reasoning when a follow-up omits them', async () => {
    const initial = setup('auth', true);
    initial.ctx.params.grokReasoningEffort = 'low';
    await initial.run();
    const test = setup('auth', true);
    delete test.ctx.params.model;
    delete test.ctx.params.grokReasoningEffort;
    await test.run();
    const frames = (await readFile(test.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(frames).toContainEqual(expect.objectContaining({ method: 'session/set_model', params: {
      sessionId: 'grok-test-session', modelId: 'custom-grok-model', _meta: { reasoningEffort: 'low' },
    } }));
  });

  it.each(['error', 'disconnect'])('reports %s instead of waiting forever or reporting success', async (scenario) => {
    const test = setup(scenario);
    await expect(test.run()).rejects.toThrow(scenario === 'error' ? 'Subscription quota exhausted' : 'exited');
    expect(test.events.some((event) => event.type === 'result')).toBe(false);
  });

  it('keeps native background subagents alive through their report and wake continuation', async () => {
    const test = setup('background');
    await test.run();
    expect(JSON.stringify(test.events)).toContain('Wake continuation');
    expect(test.events).toContainEqual(expect.objectContaining({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bg-tool', content: 'Child report', is_error: false }] } }));
    expect(test.events.at(-1)).toMatchObject({ type: 'result' });
    const { Effect } = await import('effect');
    const { listGrokProjects } = await import('./grokSessionLive');
    const { resolveSessionPath, isForkableStore } = await import('../server/api/session/sessionStore');
    expect(await Effect.runPromise(listGrokProjects)).toContainEqual(expect.objectContaining({ cwd: home, count: 1 }));
    const store = await resolveSessionPath(home, 'grok-test-session');
    expect(store?.engine).toBe('grok');
    expect(isForkableStore(store!)).toBe(false);
  });

  it('answers reverse requests without persistent grants and surfaces questions in the chat', async () => {
    const test = setup('reverse');
    await test.run();
    const frames = (await readFile(test.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(frames).toContainEqual(expect.objectContaining({ id: 'reverse-unknown', error: expect.objectContaining({ code: -32601 }) }));
    expect(frames).toContainEqual(expect.objectContaining({ id: 'reverse-permission', result: { outcome: { outcome: 'cancelled' } } }));
    expect(frames).toContainEqual(expect.objectContaining({ id: 'reverse-question', result: { outcome: 'cancelled' } }));
    expect(JSON.stringify(test.events)).toContain('Which file should I edit?');
  });

  it.each(['hang', 'startup-hang'])('stops and reaps the child during %s', async (scenario) => {
    const test = setup(scenario);
    const running = test.run();
    // Attach rejection handling before aborting the run.
    const settled = running.catch((error: unknown) => error);
    await vi.waitFor(async () => {
      const text = await readFile(test.trace, 'utf8');
      expect(text).toContain(scenario === 'hang' ? 'session/prompt' : 'initialize');
    });
    test.controller.abort();
    await settled;
    const frames = (await readFile(test.trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(() => process.kill(frames[0].pid, 0)).toThrow();
    if (scenario === 'hang') expect(frames).toContainEqual(expect.objectContaining({ method: 'session/cancel', params: { sessionId: 'grok-test-session', _meta: { cancelTrigger: 'ctrl_c' } } }));
  });
});
