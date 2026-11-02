// Pure helpers, registry wait, and status over a throwaway HOME / COCKPIT_HOME
// (paths.ts reads both at module load, so env is set before importing).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Cause, Effect, Exit, Option } from 'effect';
import type { SlotState } from './delegationLive';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-dl-'));
const home = path.join(root, 'home');
const cockpitHome = path.join(root, 'cockpit');
process.env.HOME = home;
// os.homedir() reads USERPROFILE on Windows, not HOME.
process.env.USERPROFILE = home;
process.env.COCKPIT_HOME = cockpitHome;

type LiveMod = typeof import('./delegationLive');
type HubMod = typeof import('../server/sessionRunHub');
type Services = typeof import('@cockpit/effect-services');
let dl: LiveMod;
let hub: HubMod;
let services: Services;
let encodePath: (cwd: string) => string;

const projectDir = path.join(root, 'project');
const line = (o: unknown) => JSON.stringify(o) + '\n';

const status = (sessionId: string, full = false) =>
  Effect.runPromiseExit(
    Effect.flatMap(services.DelegationService, (s) => s.status(projectDir, sessionId, { full })).pipe(
      Effect.provide(dl.DelegationServiceLive),
    ),
  );
const ok = async (sessionId: string, full = false) => {
  const exit = await status(sessionId, full);
  if (Exit.isFailure(exit)) throw new Error(`status failed: ${JSON.stringify(exit.cause)}`);
  return exit.value;
};

beforeAll(async () => {
  ({ encodePath } = await import('@cockpit/shared-utils/encodePath'));
  services = await import('@cockpit/effect-services');
  hub = await import('../server/sessionRunHub');
  dl = await import('./delegationLive');
  fs.mkdirSync(projectDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('validateRequest', () => {
  const run = (body: Record<string, unknown>, parentRunId?: string | null) =>
    Effect.runPromiseExit(dl.validateRequest(body, parentRunId));
  const reason = async (body: Record<string, unknown>) => {
    const exit = await run(body);
    return Exit.isFailure(exit) ? JSON.stringify(exit.cause) : 'ok';
  };

  it('accepts a minimal body and defaults engine + title', async () => {
    const exit = await run({ cwd: projectDir, prompt: 'Fix the flaky test\nmore detail' });
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ cwd: projectDir, engine: 'claude', title: 'Fix the flaky test' });
  });

  // A user talking to codex who writes `@bot` or `/dl` means "another one of
  // these". The engine is not in the request — a chat turn's engine is decided
  // by its ROUTE — so the caller's own run registry entry is the only record.
  describe('inherits the calling session\'s engine', () => {
    const engineOf = async (body: Record<string, unknown>, parentRunId?: string | null) => {
      const exit = await run(body, parentRunId);
      return Exit.isSuccess(exit) ? exit.value.engine : `failed: ${JSON.stringify(exit.cause)}`;
    };
    const body = { cwd: projectDir, prompt: 'x' };

    it('takes the parent run\'s engine when the body omits one', async () => {
      hub.startRun('run-codex', projectDir, undefined, undefined, 'codex');
      expect(await engineOf(body, 'run-codex')).toBe('codex');
    });

    it('does not wait for the parent to reveal a session id', async () => {
      // The first turn of a brand-new session has no sessionId yet. Reading the
      // engine through anything that gates on one (resolveParent does) would
      // fall back to claude exactly when a fresh session delegates — invisibly,
      // since that is also the old behaviour.
      hub.startRun('run-fresh', projectDir, undefined, undefined, 'glm');
      expect(await Effect.runPromise(dl.resolveParent('run-fresh'))).toBeNull();
      expect(await engineOf(body, 'run-fresh')).toBe('glm');
    });

    it('falls back to claude with no header, an unknown run, or a non-delegatable engine', async () => {
      hub.startRun('run-builtin', projectDir, undefined, undefined, 'some-builtin-agent');
      expect(await engineOf(body)).toBe('claude');
      expect(await engineOf(body, null)).toBe('claude');
      expect(await engineOf(body, 'run-evicted')).toBe('claude');
      expect(await engineOf(body, 'run-builtin')).toBe('claude');
    });

    it('never overrides an engine the caller spelled out', async () => {
      hub.startRun('run-codex2', projectDir, undefined, undefined, 'codex');
      expect(await engineOf({ ...body, engine: 'kimi' }, 'run-codex2')).toBe('kimi');
      // And a typo still 400s rather than quietly inheriting: the caller asked
      // for something specific and did not get it.
      expect(await engineOf({ ...body, engine: 'gpt' }, 'run-codex2')).toMatch(/expected one of/);
    });
  });

  it('rejects bad cwd, engine, missing task and missing brief', async () => {
    expect(await reason({ cwd: 'relative', prompt: 'x' })).toMatch(/absolute/);
    expect(await reason({ cwd: path.join(root, 'nope'), prompt: 'x' })).toMatch(/does not exist/);
    expect(await reason({ cwd: projectDir, engine: 'gpt', prompt: 'x' })).toMatch(/expected one of/);
    expect(await reason({ cwd: projectDir })).toMatch(/prompt or briefPath/);
    expect(await reason({ cwd: projectDir, briefPath: path.join(root, 'missing.md') })).toMatch(/does not exist/);
  });
});

describe('buildChildPrompt', () => {
  it('puts the title first, then the parent, then the brief pointer', () => {
    const text = dl.buildChildPrompt(
      { cwd: projectDir, engine: 'codex', title: 'Port X', briefPath: '/tmp/brief.md' },
      { cwd: '/Users/me/parent-proj', sessionId: 's1', link: '/project?cwd=%2Fp&sessionId=s1&view=agent' },
    );
    const [first, second] = text.split('\n');
    expect(first).toBe('Task: Port X');
    expect(second).toBe('[Delegated from Cockpit session /project?cwd=%2Fp&sessionId=s1&view=agent (parent-proj)]');
    expect(text).toContain('/tmp/brief.md');
  });
});

describe('claimSlot', () => {
  it('claims until the cap, counting active runs plus reservations, pruning finished runs', () => {
    const active = new Set(['r1']);
    const isActive = (k: string) => active.has(k);
    let state: SlotState = { runs: ['r1', 'r-done'], reserved: 0 };
    let claimed: boolean;
    [claimed, state] = dl.claimSlot(state, 3, isActive);
    expect(claimed).toBe(true);
    expect(state).toEqual({ runs: ['r1'], reserved: 1 });
    [claimed, state] = dl.claimSlot(state, 3, isActive);
    expect(claimed).toBe(true);
    [claimed, state] = dl.claimSlot(state, 3, isActive);
    expect(claimed).toBe(false);
    expect(state.reserved).toBe(2);
  });
});

describe('run registry bridges', () => {
  it('resolveParent follows a rekeyed run', async () => {
    hub.startRun('run-parent', '/parent/cwd');
    expect(await Effect.runPromise(dl.resolveParent('run-parent'))).toBeNull();
    hub.rekeyRun('run-parent', 'parent-session');
    expect((await Effect.runPromise(dl.resolveParent('run-parent')))?.sessionId).toBe('parent-session');
    expect(await Effect.runPromise(dl.resolveParent(null))).toBeNull();
  });

  // Effect.runPromise does not reach the Effect.async registration synchronously; yield a
  // macrotask so the listener is attached before the event under test is emitted.
  const tick = () => new Promise((r) => setImmediate(r));
  const failureKind = (exit: Exit.Exit<unknown, { kind?: string }>) =>
    Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause))?.kind : 'success';

  it('waitForSessionId resolves on system/init, and immediately when already rekeyed', async () => {
    hub.startRun('run-a', '/cwd');
    const p = Effect.runPromise(dl.waitForSessionId('run-a', '1 second'));
    await tick();
    hub.appendRun('run-a', { type: 'system', subtype: 'init', session_id: 'thread-a' });
    await expect(p).resolves.toBe('thread-a');

    hub.startRun('run-b', '/cwd');
    hub.rekeyRun('run-b', 'thread-b');
    await expect(Effect.runPromise(dl.waitForSessionId('run-b', '1 second'))).resolves.toBe('thread-b');
  });

  it('waitForSessionId fails with a protocol AgentError when the run ends while waiting', async () => {
    hub.startRun('run-c', '/cwd');
    const ended = Effect.runPromiseExit(dl.waitForSessionId('run-c', '5 seconds'));
    await tick();
    hub.markRunIdle('run-c', 'error');
    expect(failureKind(await ended)).toBe('protocol');
  });

  it('waitForSessionId fails at once (not after the timeout) when the run is already over', async () => {
    hub.startRun('run-e', '/cwd');
    hub.markRunIdle('run-e', 'error');
    const started = Date.now();
    expect(failureKind(await Effect.runPromiseExit(dl.waitForSessionId('run-e', '5 seconds')))).toBe('protocol');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('waitForSessionId fails with a timeout AgentError while the run stays silent', async () => {
    hub.startRun('run-d', '/cwd');
    expect(failureKind(await Effect.runPromiseExit(dl.waitForSessionId('run-d', '20 millis')))).toBe('timeout');
  });
});

describe('terminal markers (pure)', () => {
  const u = (text: string) => ({ type: 'user', message: { content: text } });
  const a = (stop: string | null, text = 'hi', extra: Record<string, unknown> = {}) => ({
    type: 'assistant', message: { stop_reason: stop, content: [{ type: 'text', text }] }, ...extra,
  });

  it('claude: end_turn → done; text-then-tool / interrupt / tool_result → incomplete; api error → failed', () => {
    expect(dl.claudeShapedTerminal([u('go'), a('end_turn')], 'claude')).toBe('done');
    expect(dl.claudeShapedTerminal([u('go'), a('tool_use', 'first I will check the code')], 'claude')).toBe('incomplete');
    expect(dl.claudeShapedTerminal([u('go'), a('tool_use'), { type: 'user', message: { content: [{ type: 'tool_result' }] } }], 'claude')).toBe('incomplete');
    expect(dl.claudeShapedTerminal([u('go'), a('end_turn'), u('[Request interrupted by user]')], 'claude')).toBe('incomplete');
    expect(dl.claudeShapedTerminal([u('go'), a('stop_sequence', 'API Error', { isApiErrorMessage: true })], 'claude')).toBe('failed');
    expect(dl.claudeShapedTerminal([u('go'), a('end_turn'), { type: 'user', isMeta: true, message: { content: 'meta' } }], 'claude')).toBe('done');
  });

  it('built-in: final row with usage → done; ⚠️ row without usage → failed; tool row → incomplete', () => {
    const final = { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }], usage: { output_tokens: 3 } } };
    const err = { type: 'assistant', message: { content: [{ type: 'text', text: '⚠️ 401 Unauthorized' }] } };
    const tool = { type: 'assistant', message: { content: [{ type: 'text', text: 'let me look' }, { type: 'tool_use' }] } };
    expect(dl.claudeShapedTerminal([u('go'), final], 'kimi')).toBe('done');
    expect(dl.claudeShapedTerminal([u('go'), err], 'kimi')).toBe('failed');
    expect(dl.claudeShapedTerminal([u('go'), tool], 'kimi')).toBe('incomplete');
  });

  it('codex: task_complete → done, with error → failed; turn_aborted / task_started / none → incomplete', () => {
    const ev = (type: string, extra: Record<string, unknown> = {}) => ({ type: 'event_msg', payload: { type, ...extra } });
    expect(dl.codexTerminal([ev('task_started'), ev('task_complete')])).toBe('done');
    expect(dl.codexTerminal([ev('task_started'), ev('task_complete', { error: { message: 'boom' } })])).toBe('failed');
    expect(dl.codexTerminal([ev('task_started'), ev('turn_aborted')])).toBe('incomplete');
    expect(dl.codexTerminal([ev('task_complete'), ev('task_started')])).toBe('incomplete');
    expect(dl.codexTerminal([])).toBeNull();
  });

  it('no evidence in the window is null, not incomplete', () => {
    expect(dl.claudeShapedTerminal([], 'claude')).toBeNull();
    expect(dl.claudeShapedTerminal([{ type: 'summary' }, { type: 'user', isMeta: true }], 'claude')).toBeNull();
    expect(dl.codexTerminal([{ type: 'response_item' }])).toBeNull();
  });

  it('parseTailEntries drops a cut first line and garbage', () => {
    expect(dl.parseTailEntries('{"half":\n{"type":"user"}\nnot json\n', true)).toEqual([{ type: 'user' }]);
  });

  it('lastReplyOf truncates and says so', () => {
    const msgs = [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'x'.repeat(50) }];
    expect(dl.lastReplyOf(msgs, 10)).toEqual({ lastReply: 'x'.repeat(10), lastReplyTruncated: true });
    expect(dl.lastReplyOf(msgs, Number.POSITIVE_INFINITY).lastReply).toHaveLength(50);
  });
});

describe('DelegationService.status', () => {
  const writeClaude = (sid: string, lines: unknown[]) => {
    const dir = path.join(home, '.claude', 'projects', encodePath(projectDir));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.map(line).join(''));
  };
  const userLine = (text: string) => ({ type: 'user', uuid: `u-${text}`, cwd: projectDir, timestamp: '2026-09-01T00:00:00Z', message: { role: 'user', content: text } });
  const asstLine = (stop: string, blocks: unknown[]) => ({ type: 'assistant', uuid: `a-${Math.random()}`, timestamp: '2026-09-01T00:00:03Z', message: { role: 'assistant', stop_reason: stop, content: blocks } });

  it('retains unresolved Pi input status across unrelated later successes', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const { getPiSessionsDir } = await import('@cockpit/shared-utils');
    const source = SessionManager.create(projectDir, getPiSessionsDir(projectDir));
    source.appendModelChange('ollama', 'test-model');
    source.appendMessage({ role: 'user', content: 'first task', timestamp: Date.now() });
    const success = {
      role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Old success' }],
      api: 'openai-completions' as const, provider: 'ollama', model: 'test-model',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop' as const, timestamp: Date.now(),
    };
    source.appendMessage(success);
    expect((await ok(source.getSessionId())).status).toBe('done');
    const sid = source.getSessionId();
    expect(hub.startRun(sid, projectDir, 'new accepted task', sid, 'ollama')).toBe(true);
    expect(hub.requestStop(sid)).toBe(true);
    // Model initialization is still blocked: no new native entry exists yet.
    expect(hub.isRunActive(sid)).toBe(false);
    expect((await ok(sid)).status).toBe('running');
    const notice = source.appendCustomEntry('cockpit.undelivered-input', { reason: 'failed', text: 'Unfinished accepted input' });
    expect((await ok(sid)).status).toBe('running');
    hub.releaseRun(sid);
    expect(await ok(source.getSessionId())).toMatchObject({ status: 'failed', lastReply: 'Unfinished accepted input' });
    source.appendMessage({ role: 'user', content: 'unrelated new task', timestamp: Date.now() });
    source.appendMessage(success);
    expect((await ok(source.getSessionId())).status).toBe('failed');
    source.branch(source.getEntry(notice)!.parentId!);
    source.appendMessage({ role: 'user', content: 'clean branch', timestamp: Date.now() });
    source.appendMessage(success);
    expect((await ok(source.getSessionId())).status).toBe('done');
  });

  it('done on end_turn, with the reply and a link', async () => {
    const sid = '33333333-3333-4333-8333-333333333333';
    writeClaude(sid, [userLine('Task: demo'), asstLine('end_turn', [{ type: 'text', text: 'DELEGATION-OK' }])]);
    const report = await ok(sid);
    expect(report).toMatchObject({ engine: 'claude', status: 'done', lastReply: 'DELEGATION-OK', lastReplyTruncated: false });
    expect(report.link).toContain(encodeURIComponent(sid));
  });

  it('incomplete when stopped after pre-tool text (the case the message list reports as a reply)', async () => {
    const sid = '55555555-5555-4555-8555-555555555555';
    writeClaude(sid, [
      userLine('Task: demo'),
      asstLine('tool_use', [{ type: 'text', text: 'First I will inspect the code.' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }]),
    ]);
    expect(await ok(sid)).toMatchObject({ status: 'incomplete', lastReply: 'First I will inspect the code.' });
  });

  it('running overrides terminal markers while the run is live', async () => {
    const sid = '33333333-3333-4333-8333-333333333333';
    hub.startRun(sid, projectDir);
    expect((await ok(sid)).status).toBe('running');
    hub.markRunIdle(sid, 'idle');
    hub.releaseRun(sid);
  });

  it('readTerminal grows a too-small window until it reaches the terminal record', async () => {
    const file = path.join(root, 'small-window.jsonl');
    const big = 'y'.repeat(2000);
    fs.writeFileSync(file, line(userLine('go')) + line(asstLine('end_turn', [{ type: 'text', text: big }])));
    const terminal = await Effect.runPromise(dl.readTerminal(file, (e) => dl.claudeShapedTerminal(e, 'claude'), 64));
    expect(terminal).toBe('done');
  });

  it('done when the final reply is a single JSONL line larger than the default 1 MB tail', async () => {
    const sid = '66666666-6666-4666-8666-666666666666';
    writeClaude(sid, [userLine('Task: long report'), asstLine('end_turn', [{ type: 'text', text: 'z'.repeat(1_300_000) }])]);
    expect(await ok(sid)).toMatchObject({ status: 'done', lastReplyTruncated: true });
  });

  it('NotFoundError for an unknown, not-running session', async () => {
    const exit = await status('no-such-session');
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toMatch(/NotFoundError/);
  });
});
