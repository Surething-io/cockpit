import { describe, expect, it, vi, beforeEach } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { codexSpec, codexToolUseId, resolveCodexSpawnCall, createRolloutCallReader } from './codex';

const mocks = vi.hoisted(() => ({ rolloutPath: null as string | null }));
/**
 * Stands in for the app-server child.
 *
 * Fixtures throughout this file are written in the EXEC event spelling, and
 * they stay that way: the shim's camelCase→snake_case key rewrite is a no-op on
 * keys that are already snake_case, so only the method name needs translating.
 * That keeps these tests about what they were always about — what the adapter
 * emits for a given Codex event — rather than about the transport under it.
 */
const appServer = vi.hoisted(() => {
  const METHOD: Record<string, string> = {
    'item.started': 'item/started',
    'item.completed': 'item/completed',
    'turn.completed': 'turn/completed',
    'turn.failed': 'turn/failed',
    error: 'error',
  };
  const state = {
    requests: [] as Array<{ method: string; params: Record<string, unknown> }>,
    notify: null as null | ((n: { method: string; params: Record<string, unknown> }) => void),
    threadId: 'sdk-thread',
    resumeThrows: false,
    onTurnStart: null as null | (() => void),
    /** Exec-shaped events replayed as soon as the turn is accepted. */
    script: [] as Array<Record<string, unknown>>,
    disposed: 0,
    feed(event: Record<string, unknown>) {
      // `thread.started` is no longer on the wire — the runner synthesises it
      // from the thread/start result so the rollout baseline is sampled before
      // the model can run.
      const method = METHOD[event.type as string];
      if (!method) return;
      const { type: _type, ...params } = event;
      state.notify?.({ method, params: params as Record<string, unknown> });
    },
    /** Resolve once the runner has actually opened the turn. */
    async ready() {
      for (let i = 0; i < 50; i += 1) {
        if (state.requests.some((r) => r.method === 'turn/start')) return;
        await new Promise((r) => setImmediate(r));
      }
    },
    reset() {
      state.requests = [];
      state.notify = null;
      state.threadId = 'sdk-thread';
      state.resumeThrows = false;
      state.onTurnStart = null;
      state.script = [];
      state.disposed = 0;
    },
  };
  return state;
});

vi.mock('./codexAppServer/client', () => ({
  CodexAppServerClient: {
    start(opts: { onNotification: (n: { method: string; params: Record<string, unknown> }) => void }) {
      appServer.notify = opts.onNotification;
      return {
        async request(method: string, params: Record<string, unknown>) {
          appServer.requests.push({ method, params });
          if (method === 'thread/resume' && appServer.resumeThrows) throw new Error('no such thread');
          if (method === 'thread/resume' || method === 'thread/start') {
            // The real protocol returns the rollout's path here, and the engine
            // binds its sub-agent reader to it rather than searching the disk.
            return { thread: { id: appServer.threadId, path: mocks.rolloutPath } };
          }
          if (method === 'turn/start') {
            appServer.onTurnStart?.();
            queueMicrotask(() => {
              for (const ev of appServer.script) appServer.feed(ev);
            });
            return { turn: { id: 'turn-1' } };
          }
          return {};
        },
        notify() {},
        dispose() {
          appServer.disposed += 1;
        },
      };
    },
  },
}));
vi.mock('@cockpit/shared-utils', () => ({
  sanitizedSpawnEnv: () => ({}),
  findCodexSessionPath: () => mocks.rolloutPath,
}));

/**
 * Push exec-shaped events at the runner. `close()` ends the turn, which under
 * app-server is a `turn/completed` notification rather than a stream ending.
 */
function createEventStream() {
  return {
    push(event: unknown) {
      appServer.feed(event as Record<string, unknown>);
    },
    close() {
      appServer.notify?.({ method: 'turn/completed', params: {} });
    },
  };
}

const fnCall = (callId: string, cmd: string) =>
  JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: callId, arguments: JSON.stringify({ cmd }) } }) + '\n';
const noise = JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', text: 'x' } }) + '\n';

describe('codexToolUseId', () => {
  it('prefers call_id so live snapshots match persisted Codex history', () => {
    expect(codexToolUseId({ id: 'item_1', call_id: 'call_1' })).toBe('call_1');
  });

  it('falls back to item id', () => {
    expect(codexToolUseId({ id: 'item_1' })).toBe('item_1');
  });
});

describe('codex mode routing', () => {
  /**
   * The assistant message is intentionally NOT scripted: text now arrives as
   * `item/agentMessage/delta`, and the completed item is dropped by the shim so
   * the reply is not appended twice.
   */
  const defaultScript: Array<Record<string, unknown>> = [{ type: 'turn.completed' }];
  const say = (text: string) =>
    appServer.notify?.({ method: 'item/agentMessage/delta', params: { delta: text } });

  const ctx = (over: Record<string, unknown> = {}) => ({
    prompt: 'hello', images: undefined, cwd: '/repo', sessionId: undefined,
    params: {} as never, signal: new AbortController().signal,
    emit: vi.fn(), rekey: vi.fn(), currentKey: () => 'k',
    ...over,
  });

  beforeEach(() => {
    mocks.rolloutPath = null;
    appServer.reset();
    appServer.script = [...defaultScript];
  });

  it('drives one turn over app-server: handshake, thread, turn, teardown', async () => {
    const rekey = vi.fn();
    await codexSpec.runner.run(ctx({ rekey }) as never);

    expect(appServer.requests.map((r) => r.method)).toEqual(['initialize', 'thread/start', 'turn/start']);
    expect(appServer.requests[1].params).toEqual({
      cwd: '/repo',
      sandbox: 'danger-full-access',
      // Load-bearing beyond permissions: it is what keeps the server from ever
      // issuing a blocking approval request this client would have to park.
      approvalPolicy: 'never',
    });
    expect(appServer.requests[2].params).toEqual({
      threadId: 'sdk-thread',
      input: [{ type: 'text', text: 'hello' }],
    });
    // Synthesised from the thread/start result, not awaited from a notification.
    expect(rekey).toHaveBeenCalledWith('sdk-thread');
    expect(appServer.disposed).toBe(1);
  });

  it('streams assistant text as deltas the client already knows how to append', async () => {
    const emit = vi.fn();
    appServer.script = [];
    const done = codexSpec.runner.run(ctx({ emit }) as never);
    await appServer.ready();
    say('Wa');
    say('ves');
    appServer.notify?.({ method: 'turn/completed', params: {} });
    await done;

    const deltas = emit.mock.calls.map(([e]) => e)
      .filter((e) => e.type === 'stream_event').map((e) => e.event.delta.text);
    expect(deltas).toEqual(['Wa', 'ves']);
    // The completed agent_message must NOT also arrive as whole text.
    const whole = emit.mock.calls.map(([e]) => e)
      .filter((e) => e.type === 'assistant')
      .flatMap((e) => e.message.content)
      .filter((b: { type?: string }) => b.type === 'text');
    expect(whole).toEqual([]);
  });

  it('falls back to a fresh thread when the stored id no longer resumes', async () => {
    appServer.resumeThrows = true;
    await codexSpec.runner.run(ctx({ sessionId: 'gone-thread' }) as never);
    expect(appServer.requests.map((r) => r.method)).toEqual([
      'initialize', 'thread/resume', 'thread/start', 'turn/start',
    ]);
  });

  /**
   * The fallback swaps the session id under the user (and with it the whole
   * context), which surfaces as a second tab for what looks like one
   * conversation. Reporting it is the only thing that makes that legible, so
   * the notice — and the raw reason inside it — is part of the contract.
   */
  it('reports the failed resume as a system notice carrying both ids', async () => {
    const emit = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    appServer.resumeThrows = true;
    await codexSpec.runner.run(ctx({ sessionId: 'locked-thread', emit }) as never);

    const notice = emit.mock.calls.map(([e]) => e).find((e) => e.type === 'system' && e.subtype === 'notice');
    expect(notice).toMatchObject({
      notice: 'codex_resume_failed',
      previous_session_id: 'locked-thread',
      session_id: 'sdk-thread',
      error: 'no such thread',
    });
    // After the rekey, so it lands on the run under the id the tab ends up bound to.
    const kinds = emit.mock.calls.map(([e]) => `${e.type}/${e.subtype ?? ''}`);
    expect(kinds.indexOf('system/notice')).toBeGreaterThan(kinds.indexOf('system/init'));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('thread/resume failed for locked-thread'));
    consoleError.mockRestore();
  });

  it('says nothing when the resume succeeds', async () => {
    const emit = vi.fn();
    await codexSpec.runner.run(ctx({ sessionId: 'sdk-thread', emit }) as never);
    expect(emit.mock.calls.map(([e]) => e).some((e) => e.subtype === 'notice')).toBe(false);
  });

  it('stashes the Codex rollout while running a no-history turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-run-nohistory-'));
    const sessionPath = join(dir, 'rollout-2026-08-08T00-00-00-sdk-thread.jsonl');
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'sdk-thread', cwd: '/repo', source: 'exec', thread_source: 'user' },
    });
    const oldLine = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old' }] } });
    const newLine = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new' }] } });
    writeFileSync(sessionPath, `${meta}\n${oldLine}\n`);
    mocks.rolloutPath = sessionPath;
    // The stub must be in place by the time the turn opens — that is the whole
    // mechanism, and it only holds because each turn gets a cold process.
    appServer.onTurnStart = () => {
      expect(readFileSync(sessionPath, 'utf-8').trim().split('\n')).toEqual([meta]);
      appendFileSync(sessionPath, `${newLine}\n`);
    };

    try {
      await codexSpec.runner.run(ctx({
        prompt: 'new', sessionId: 'sdk-thread', params: { noHistory: true } as never,
      }) as never);
      expect(readFileSync(sessionPath, 'utf-8').trim().split('\n')).toEqual([meta, oldLine, newLine]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends a non-empty text placeholder for images-only turns', async () => {
    await codexSpec.runner.run(ctx({
      prompt: undefined,
      images: [{ media_type: 'image/png', data: Buffer.from('x').toString('base64') }] as never,
    }) as never);

    const turn = appServer.requests.find((r) => r.method === 'turn/start');
    expect(turn?.params.input).toMatchObject([
      { type: 'text', text: '[Image]' },
      // app-server spells this `localImage`; exec spelled it `local_image`.
      { type: 'localImage' },
    ]);
  });

  it('has no preflight rejecting images-only messages', () => {
    expect(codexSpec.preflight).toBeUndefined();
  });

  it('ignores unknown item types without failing the turn', async () => {
    const emit = vi.fn();
    appServer.script = [
      { type: 'item.completed', item: { id: 'future_1', type: 'future_item', text: 'metadata' } },
      { type: 'turn.completed' },
    ];
    await codexSpec.runner.run(ctx({ emit }) as never);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', subtype: 'success' }));
  });
});

describe('resolveCodexSpawnCall', () => {
  const calls = [
    { callId: 'call_a', args: { message: 'A' }, agentId: 'agent-1' },
    { callId: 'call_b', args: { message: 'B' }, agentId: 'agent-2' },
  ];

  it('matches on the sub-agent thread id, not turn order', () => {
    expect(resolveCodexSpawnCall(calls, 0, 'agent-2')?.callId).toBe('call_b');
  });

  it('falls back to turn order before codex has flushed the spawn output', () => {
    const pending = [{ callId: 'call_a', args: {} }];
    expect(resolveCodexSpawnCall(pending, 0, 'agent-9')?.callId).toBe('call_a');
  });

  it('returns null when the rollout has no entry for this index', () => {
    expect(resolveCodexSpawnCall([], 0, undefined)).toBeNull();
  });
});

describe('createRolloutCallReader spawn_agent', () => {
  const spawnLine = (callId: string, agentType: string, message: string) =>
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', namespace: 'multi_agent_v1', call_id: callId, arguments: JSON.stringify({ agent_type: agentType, message }) } }) + '\n';
  const spawnOut = (callId: string, agentId: string, nickname: string) =>
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ agent_id: agentId, nickname }) } }) + '\n';

  it('back-fills the agent id from an output appended after the call', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'codex-spawn-')), 'r.jsonl');
    const read = createRolloutCallReader();

    // Codex writes the call first and the output only when the tool returns, so the
    // reader must survive seeing them on two separate reads.
    writeFileSync(path, spawnLine('call_s1', 'explorer', 'go'));
    expect(read(path).spawn).toEqual([{ callId: 'call_s1', args: { agent_type: 'explorer', message: 'go' } }]);

    appendFileSync(path, noise + spawnOut('call_s1', 'agent-1', 'Turing'));
    expect(read(path).spawn).toEqual([
      { callId: 'call_s1', args: { agent_type: 'explorer', message: 'go' }, agentId: 'agent-1', nickname: 'Turing' },
    ]);
  });

  it('collects only spawns, ignoring the ordinary tool traffic around them', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'codex-spawn-')), 'r.jsonl');
    writeFileSync(path, fnCall('call_1', 'ls') + spawnLine('call_s1', 'explorer', 'go') + fnCall('call_2', 'pwd'));
    expect(createRolloutCallReader()(path).spawn.map(c => c.callId)).toEqual(['call_s1']);
  });

  it('reads incrementally and re-scans when the file is rewritten', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'codex-spawn-inc-')), 'r.jsonl');
    const line = spawnLine('call_s1', 'explorer', 'go');
    // Half a line, no newline yet: nothing may be reported until it completes.
    writeFileSync(path, line.slice(0, 20));
    const read = createRolloutCallReader();
    expect(read(path).spawn).toEqual([]);
    appendFileSync(path, line.slice(20));
    expect(read(path).spawn.map(c => c.callId)).toEqual(['call_s1']);
    appendFileSync(path, spawnLine('call_s2', 'explorer', 'more'));
    expect(read(path).spawn.map(c => c.callId)).toEqual(['call_s1', 'call_s2']);
    // A SHRINKING file means truncate/rewrite, which is the only signal that the
    // accumulated state no longer describes what is on disk.
    writeFileSync(path, spawnLine('call_s9', 'explorer', 'go'));
    expect(read(path).spawn.map(c => c.callId)).toEqual(['call_s9']);
  });
});

describe('codex sub-agents (collab_tool_call)', () => {
  let emit: ReturnType<typeof vi.fn>;
  let stream: ReturnType<typeof createEventStream>;

  beforeEach(() => {
    mocks.rolloutPath = null;
    emit = vi.fn();
    stream = createEventStream();
    appServer.reset();
  });

  const run = () =>
    codexSpec.runner.run({
      prompt: 'review the PR', images: undefined, cwd: '/repo', sessionId: undefined,
      params: {} as never, signal: new AbortController().signal,
      emit, rekey: vi.fn(), currentKey: () => 'k',
    } as never);

  const feed = async (event: unknown) => {
    await appServer.ready();
    stream.push(event);
    await new Promise((r) => setImmediate(r));
  };

  // Verified against codex 0.141: a spawn's item.started has an EMPTY
  // receiver_thread_ids, so the agent is only identifiable on item.completed.
  const spawnStarted = { type: 'item.started', item: { id: 'item_0', type: 'collab_tool_call', tool: 'spawn_agent', sender_thread_id: 't', receiver_thread_ids: [], prompt: 'go', agents_states: {}, status: 'in_progress' } };
  const spawnCompleted = { type: 'item.completed', item: { id: 'item_0', type: 'collab_tool_call', tool: 'spawn_agent', sender_thread_id: 't', receiver_thread_ids: ['agent-1'], prompt: 'go', agents_states: { 'agent-1': { status: 'pending_init', message: null } }, status: 'completed' } };
  const waitCompleted = (status: string, message: string | null) => ({ type: 'item.completed', item: { id: 'item_1', type: 'collab_tool_call', tool: 'wait', sender_thread_id: 't', receiver_thread_ids: ['agent-1'], prompt: null, agents_states: { 'agent-1': { status, message } }, status: 'completed' } });

  const toolUses = () => emit.mock.calls
    .map(([e]) => e)
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => e.message.content)
    .filter((b: { type?: string }) => b.type === 'tool_use');
  const toolResults = () => emit.mock.calls
    .map(([e]) => e)
    .filter((e) => e.type === 'user')
    .flatMap((e) => e.message.content);

  it('emits one Task tool_use for a spawn and leaves it open until the wait reports', async () => {
    const p = run();
    await feed(spawnStarted);

    // item.started must not produce a bubble — it cannot name the agent yet, and a
    // second bubble would appear on item.completed.
    expect(toolUses()).toHaveLength(0);

    await feed(spawnCompleted);
    expect(toolUses()).toEqual([
      { type: 'tool_use', id: 'item_0', name: 'Task', input: { description: 'go', prompt: 'go', agent_id: 'agent-1' } },
    ]);
    // No result yet: the bubble stays loading, which is what keeps the drill-in polling.
    expect(toolResults()).toHaveLength(0);

    await feed(waitCompleted('completed', '2 条 findings'));
    expect(toolResults()).toEqual([{ tool_use_id: 'item_0', content: '2 条 findings' }]);

    stream.close();
    await p;
  });

  it('keys the bubble by the id the protocol gave the item, not by a rollout lookup', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'codex-live-spawn-')), 'r.jsonl');
    writeFileSync(
      path,
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'call_s1', arguments: JSON.stringify({ agent_type: 'explorer', message: '审查 Part A' }) } }) + '\n'
        + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_s1', output: JSON.stringify({ agent_id: 'agent-1', nickname: 'Turing' }) } }) + '\n'
    );
    mocks.rolloutPath = path;

    const p = run();
    await feed({ type: 'thread.started', thread_id: 'thread-1' });
    // A collab tool call's `item.id` IS its call_id, so the live stream already
    // carries the id the resume parser will key on. The rollout is still read,
    // but only for what the live item lacks: the spawn's arguments and the
    // agent's nickname.
    await feed({ ...spawnCompleted, item: { ...spawnCompleted.item, id: 'call_s1' } });

    expect(toolUses()).toEqual([{
      type: 'tool_use',
      id: 'call_s1',
      name: 'Task',
      input: { subagent_type: 'explorer', description: 'Turing (explorer)', prompt: '审查 Part A', agent_id: 'agent-1' },
    }]);

    stream.close();
    await p;
  });

  it('never lets the rollout override the id the item carries', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'codex-live-spawn-id-')), 'r.jsonl');
    // The rollout's only spawn says call_s1; the live item says otherwise. The
    // item wins — an ordinal match against a growing file is exactly the guess
    // this replaced.
    writeFileSync(
      path,
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'call_s1', arguments: '{}' } }) + '\n'
    );
    mocks.rolloutPath = path;

    const p = run();
    await feed({ type: 'thread.started', thread_id: 'thread-1' });
    await feed({ ...spawnCompleted, item: { ...spawnCompleted.item, id: 'call_from_item' } });

    expect(toolUses()[0]).toMatchObject({ id: 'call_from_item' });

    stream.close();
    await p;
  });

  it('keeps the bubble open when a wait times out with the agent still running', async () => {
    const p = run();
    await feed(spawnCompleted);
    await feed(waitCompleted('running', null));

    expect(toolResults()).toHaveLength(0);

    stream.close();
    await p;
  });

  it('surfaces an errored agent as the bubble result', async () => {
    const p = run();
    await feed(spawnCompleted);
    await feed(waitCompleted('errored', 'Selected model is at capacity.'));

    expect(toolResults()).toEqual([{ tool_use_id: 'item_0', content: 'Selected model is at capacity.' }]);

    stream.close();
    await p;
  });

  it('ignores reports for agents spawned in an earlier turn', async () => {
    const p = run();
    // codex cannot reach a previous turn's agents after `exec resume`; such a report
    // has no bubble of ours and must not be attached to an unrelated tool call.
    await feed({ type: 'item.completed', item: { id: 'item_0', type: 'collab_tool_call', tool: 'close_agent', receiver_thread_ids: ['stale-agent'], agents_states: { 'stale-agent': { status: 'not_found', message: null } }, status: 'completed' } });

    expect(toolUses()).toHaveLength(0);
    expect(toolResults()).toHaveLength(0);

    stream.close();
    await p;
  });

  // Captured from codex 0.147 (`exec --experimental-json`, a turn that spawned and
  // waited on one sub-agent): spawn_agent produces NO thread item whatsoever, and the
  // single collab_tool_call that does arrive is the wait — with receiver_thread_ids
  // and agents_states both EMPTY. Every field the ≤ 0.14x path reads is gone, so the
  // rollout is the only remaining source. This is what left a running multi-agent turn
  // showing just its Bash calls.
  const wait0147 = (type: string) => ({
    type,
    item: {
      id: 'item_0', type: 'collab_tool_call', tool: 'wait', sender_thread_id: 't',
      receiver_thread_ids: [], prompt: null, agents_states: {},
      status: type === 'item.started' ? 'in_progress' : 'completed',
    },
  });
  const line = (payload: unknown, type = 'response_item') => JSON.stringify({ type, payload }) + '\n';

  it('builds the Task bubble from the rollout when 0.147 emits no spawn item', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'codex-spawn-0147-')), 'r.jsonl');
    writeFileSync(path, '');
    mocks.rolloutPath = path;

    const p = run();
    await feed({ type: 'thread.started', thread_id: 'thread-1' });

    // What codex persists for a spawn: the call, then the activity line binding it to
    // the thread it created. Nothing is streamed for either.
    appendFileSync(path,
      line({ type: 'function_call', name: 'spawn_agent', call_id: 'call_s1', arguments: JSON.stringify({ task_name: 'cr_static', fork_turns: 'none', message: 'gAAAAABqgC5UxYN4TAQyXJF9r5jkyzSKoF8O_5i6SLmkmSdMlfMk4aB7dpw' }) })
      + line({ type: 'sub_agent_activity', event_id: 'call_s1', agent_thread_id: 'agent-1', agent_path: '/root/cr_static', kind: 'started' }, 'event_msg'));

    await feed(wait0147('item.started'));

    // Keyed by the spawning call_id and carrying agent_id, exactly as the resume parser
    // reconstructs it — otherwise the turn changes shape on refresh. The task prompt is
    // a Fernet token on 0.147, hence message_encrypted rather than a bogus prompt.
    expect(toolUses()).toEqual([{
      type: 'tool_use',
      id: 'call_s1',
      name: 'Task',
      input: {
        subagent_type: 'cr_static',
        description: 'cr_static',
        message_encrypted: true,
        agent_id: 'agent-1',
      },
    }]);
    expect(toolResults()).toHaveLength(0);

    // The report is no longer in wait_agent's output — it arrives as an agent_message
    // authored by the sub-agent's path.
    appendFileSync(path, line({
      type: 'agent_message', author: '/root/cr_static', recipient: '/root',
      content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/cr_static\nPayload:\nfound 3 issues' }],
    }));
    await feed(wait0147('item.completed'));

    expect(toolUses()).toHaveLength(1); // still one bubble, not a second
    expect(toolResults()).toEqual([{ tool_use_id: 'call_s1', content: 'found 3 issues' }]);

    stream.close();
    await p;
  });

  it('does not replay a previous turn\'s sub-agents when resuming', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'codex-spawn-resume-')), 'r.jsonl');
    writeFileSync(path,
      line({ type: 'function_call', name: 'spawn_agent', call_id: 'call_old', arguments: JSON.stringify({ task_name: 'old' }) })
      + line({ type: 'sub_agent_activity', event_id: 'call_old', agent_thread_id: 'agent-old', agent_path: '/root/old', kind: 'started' }, 'event_msg')
      + line({ type: 'agent_message', author: '/root/old', recipient: '/root', content: [{ type: 'input_text', text: 'Message Type: FINAL_ANSWER\nPayload:\nold report' }] }));
    mocks.rolloutPath = path;

    const p = codexSpec.runner.run({
      prompt: 'carry on', images: undefined, cwd: '/repo', sessionId: 'thread-1',
      params: {} as never, signal: new AbortController().signal,
      emit, rekey: vi.fn(), currentKey: () => 'k',
    } as never);
    await feed({ type: 'thread.started', thread_id: 'thread-1' });
    await feed(wait0147('item.started'));

    // The whole history is in the rollout the reader walks; only what this turn appends
    // may become a bubble.
    expect(toolUses()).toHaveLength(0);
    expect(toolResults()).toHaveLength(0);

    stream.close();
    await p;
  });
});

describe('codex mcp / web_search / todo_list items', () => {
  let emit: ReturnType<typeof vi.fn>;
  let stream: ReturnType<typeof createEventStream>;

  beforeEach(() => {
    mocks.rolloutPath = null;
    emit = vi.fn();
    stream = createEventStream();
    appServer.reset();
  });

  const run = () =>
    codexSpec.runner.run({
      prompt: 'do it', images: undefined, cwd: '/repo', sessionId: undefined,
      params: {} as never, signal: new AbortController().signal,
      emit, rekey: vi.fn(), currentKey: () => 'k',
    } as never);

  const feed = async (event: unknown) => {
    await appServer.ready();
    stream.push(event);
    await new Promise((r) => setImmediate(r));
  };

  const toolUses = () => emit.mock.calls.map(([e]) => e).filter((e) => e.type === 'assistant')
    .flatMap((e) => e.message.content).filter((b: { type?: string }) => b.type === 'tool_use');
  const toolResults = () => emit.mock.calls.map(([e]) => e).filter((e) => e.type === 'user')
    .flatMap((e) => e.message.content);

  it('opens an MCP bubble on item.started and fills its error on item.completed', async () => {
    const p = run();
    const base = { id: 'item_0', type: 'mcp_tool_call', server: 'node_repl', tool: 'js', arguments: { code: '2 + 2' } };
    await feed({ type: 'item.started', item: { ...base, result: null, error: null, status: 'in_progress' } });

    expect(toolUses()).toEqual([
      { type: 'tool_use', id: 'item_0', name: 'mcp__node_repl__js', input: { code: '2 + 2' } },
    ]);
    expect(toolResults()).toHaveLength(0);

    await feed({ type: 'item.completed', item: { ...base, result: null, error: { message: 'Mcp error: -32602' }, status: 'failed' } });

    // One bubble, not two: item.completed must reuse the id item.started minted.
    expect(toolUses()).toHaveLength(1);
    expect(toolResults()).toEqual([{ tool_use_id: 'item_0', content: 'Mcp error: -32602' }]);

    stream.close();
    await p;
  });

  it('keys an MCP bubble by the id the item carries', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'codex-mcp-')), 'r.jsonl');
    writeFileSync(path, JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', name: 'js', namespace: 'mcp__node_repl', call_id: 'call_m1', arguments: '{"code":"2 + 2"}' },
    }) + '\n');
    mocks.rolloutPath = path;

    const p = run();
    await feed({ type: 'thread.started', thread_id: 'thread-1' });
    // MCP tools are unknown names, so isMutatingToolName treats them as mutating and
    // they get snapshots — the id has to be the persistent one or the diff is orphaned.
    // That id now comes from the item itself; the rollout is not consulted.
    await feed({ type: 'item.started', item: { id: 'call_m1', type: 'mcp_tool_call', server: 'node_repl', tool: 'js', arguments: { code: '2 + 2' }, status: 'in_progress' } });

    expect(toolUses()[0]).toMatchObject({ id: 'call_m1', name: 'mcp__node_repl__js' });

    stream.close();
    await p;
  });

  it('emits a web search as WebSearch and an opened page as WebFetch', async () => {
    const p = run();
    await feed({ type: 'item.completed', item: { id: 'ws_1', type: 'web_search', query: 'codex cli', action: { type: 'search', query: 'codex cli', queries: ['codex cli', 'openai codex'] } } });
    await feed({ type: 'item.completed', item: { id: 'ws_2', type: 'web_search', query: 'https://x.dev', action: { type: 'open_page', url: 'https://x.dev' } } });

    expect(toolUses()).toEqual([
      { type: 'tool_use', id: 'ws_1', name: 'WebSearch', input: { query: 'codex cli' } },
      { type: 'tool_use', id: 'ws_2', name: 'WebFetch', input: { url: 'https://x.dev' } },
    ]);
    // Neither may stay loading: codex reports no hits, so there is nothing else coming.
    expect(toolResults()).toEqual([
      { tool_use_id: 'ws_1', content: 'codex cli\nopenai codex' },
      { tool_use_id: 'ws_2', content: 'https://x.dev' },
    ]);

    stream.close();
    await p;
  });

  it('emits a plan as TodoWrite with claude-shaped todo statuses', async () => {
    const p = run();
    await feed({ type: 'item.completed', item: { id: 'item_0', type: 'todo_list', items: [{ text: '读文件', completed: true }, { text: '分析', completed: false }] } });

    expect(toolUses()).toEqual([{
      type: 'tool_use',
      id: 'item_0',
      name: 'TodoWrite',
      input: { todos: [{ content: '读文件', status: 'completed' }, { content: '分析', status: 'pending' }] },
    }]);
    expect(toolResults()).toEqual([{ tool_use_id: 'item_0', content: '1/2 completed' }]);

    stream.close();
    await p;
  });
});
