import { describe, expect, it, vi, beforeEach } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { codexSpec, codexToolUseId, resolveCodexCallId, resolveCodexPatchCallId, resolveCodexSpawnCall, parsePatchFiles, createRolloutCallReader } from './codex';

const mocks = vi.hoisted(() => ({ rolloutPath: null as string | null }));
const sdkMocks = vi.hoisted(() => ({
  codexCtor: vi.fn(),
  startThread: vi.fn(),
  resumeThread: vi.fn(),
  runStreamed: vi.fn(),
  throwCtorOnce: false,
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: vi.fn(function MockCodex(this: { startThread: unknown; resumeThread: unknown }, options) {
    sdkMocks.codexCtor(options);
    if (sdkMocks.throwCtorOnce) {
      sdkMocks.throwCtorOnce = false;
      throw new Error('Unable to locate Codex CLI binaries. Ensure @openai/codex is installed with optional dependencies.');
    }
    const thread = { runStreamed: sdkMocks.runStreamed };
    sdkMocks.startThread.mockReturnValue(thread);
    sdkMocks.resumeThread.mockReturnValue(thread);
    this.startThread = sdkMocks.startThread;
    this.resumeThread = sdkMocks.resumeThread;
  }),
}));
vi.mock('@cockpit/shared-utils', () => ({
  sanitizedSpawnEnv: () => ({}),
  findCodexSessionPath: () => mocks.rolloutPath,
}));

function createEventStream() {
  const queue: unknown[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  const wake = () => waiters.shift()?.();
  return {
    push(event: unknown) {
      queue.push(event);
      wake();
    },
    close() {
      closed = true;
      wake();
    },
    async *events() {
      while (!closed || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

const fnCall = (callId: string, cmd: string) =>
  JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: callId, arguments: JSON.stringify({ cmd }) } }) + '\n';
const patchCall = (callId: string, file: string) =>
  JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: callId, input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\n` } }) + '\n';
const noise = JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', text: 'x' } }) + '\n';

describe('codexToolUseId', () => {
  it('prefers call_id so live snapshots match persisted Codex history', () => {
    expect(codexToolUseId({ id: 'item_1', call_id: 'call_1' })).toBe('call_1');
  });

  it('falls back to item id', () => {
    expect(codexToolUseId({ id: 'item_1' })).toBe('item_1');
  });
});

describe('resolveCodexCallId', () => {
  const calls = [
    { callId: 'call_A', cmd: 'echo AAA' },
    { callId: 'call_B', cmd: 'npm test -- pkg/a' },
    { callId: 'call_C', cmd: 'echo CCC > out.txt' },
  ];

  it('maps the index-th exec to its persistent call_id (live command is /bin/zsh wrapped)', () => {
    expect(resolveCodexCallId(calls, 0, "/bin/zsh -lc 'echo AAA'")).toBe('call_A');
    expect(resolveCodexCallId(calls, 2, "/bin/zsh -lc 'echo CCC > out.txt'")).toBe('call_C');
  });

  it('honours a resume offset via index (base + execSeen)', () => {
    // base=1 (one exec from a prior turn) + execSeen=1 → index 2
    expect(resolveCodexCallId(calls, 2, "/bin/zsh -lc 'echo CCC > out.txt'")).toBe('call_C');
  });

  it('unwraps double-quoted shell wrapper (codex uses " when the command contains \')', () => {
    const c = [{ callId: 'call_S', cmd: "sed -n '1,3p' README.zh.md" }];
    expect(resolveCodexCallId(c, 0, `/bin/zsh -lc "sed -n '1,3p' README.zh.md"`)).toBe('call_S');
  });

  it('unwraps single-quoted shell wrapper', () => {
    const c = [{ callId: 'call_T', cmd: 'tail -n 5 README.zh.md' }];
    expect(resolveCodexCallId(c, 0, "/bin/zsh -lc 'tail -n 5 README.zh.md'")).toBe('call_T');
  });

  it('tolerates truncated commands on either side (prefix match)', () => {
    expect(resolveCodexCallId(calls, 1, "/bin/zsh -lc 'npm test -- pkg/a --coverage'")).toBe('call_B');
    expect(resolveCodexCallId([{ callId: 'call_B', cmd: 'npm test -- pkg/a --coverage' }], 0, "/bin/zsh -lc 'npm test -- pkg/a'")).toBe('call_B');
  });

  it('falls back (null) on command desync so item.id is used instead', () => {
    expect(resolveCodexCallId(calls, 0, "/bin/zsh -lc 'rm -rf /'")).toBeNull();
  });

  it('falls back (null) when the entry is missing or has no call_id', () => {
    expect(resolveCodexCallId(calls, 9, "/bin/zsh -lc 'echo AAA'")).toBeNull();
    expect(resolveCodexCallId([{ cmd: 'echo AAA' }], 0, "/bin/zsh -lc 'echo AAA'")).toBeNull();
  });

  it('does not spuriously match a short command inside an unrelated long one (bounded includes)', () => {
    // persisted "ls" would be a substring of a long unrelated command; the length
    // bound must reject it so we fall back rather than bind the wrong call_id.
    const long = '/bin/zsh -lc "find . -name ls -type f | while read f; do echo $f; done"';
    expect(resolveCodexCallId([{ callId: 'call_X', cmd: 'ls' }], 0, long)).toBeNull();
  });
});

describe('parsePatchFiles', () => {
  it('extracts add/update/delete file paths from an apply_patch body', () => {
    const body = '*** Begin Patch\n*** Update File: a/b.ts\n@@\n-x\n+y\n*** Add File: c.md\n*** Delete File: d.txt\n*** End Patch\n';
    expect(parsePatchFiles(body)).toEqual(['a/b.ts', 'c.md', 'd.txt']);
  });
});

describe('resolveCodexPatchCallId', () => {
  const patches = [
    { callId: 'call_P0', files: ['README.zh.md'] },
    { callId: 'call_P1', files: ['src/a.ts', 'src/b.ts'] },
  ];

  it('maps the index-th patch by basename (live abs path vs rollout relative path)', () => {
    expect(resolveCodexPatchCallId(patches, 0, ['/repo/README.zh.md'])).toBe('call_P0');
    expect(resolveCodexPatchCallId(patches, 1, ['/repo/src/b.ts'])).toBe('call_P1');
  });

  it('trusts order when there is nothing to cross-check', () => {
    expect(resolveCodexPatchCallId([{ callId: 'call_P', files: [] }], 0, ['/x/y.ts'])).toBe('call_P');
    expect(resolveCodexPatchCallId(patches, 0, [])).toBe('call_P0');
  });

  it('falls back (null) on a file mismatch or missing/no-callId entry', () => {
    expect(resolveCodexPatchCallId(patches, 0, ['/repo/other.ts'])).toBeNull();
    expect(resolveCodexPatchCallId(patches, 9, ['/repo/README.zh.md'])).toBeNull();
    expect(resolveCodexPatchCallId([{ files: ['a'] }], 0, ['/x/a'])).toBeNull();
  });
});

describe('createRolloutCallReader', () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'codex-rollout-')), 'rollout.jsonl');

  it('accumulates exec and patch lists independently, in order', () => {
    const path = tmp();
    writeFileSync(path, noise + fnCall('call_1', 'echo A') + patchCall('call_P0', 'README.md'));
    const read = createRolloutCallReader();
    let r = read(path);
    expect(r.exec.map(c => c.callId)).toEqual(['call_1']);
    expect(r.patch.map(c => c.callId)).toEqual(['call_P0']);
    expect(r.patch[0].files).toEqual(['README.md']);
    // nothing appended → same lists
    r = read(path);
    expect(r.exec.length).toBe(1);
    expect(r.patch.length).toBe(1);
    // append more of both kinds
    appendFileSync(path, fnCall('call_2', 'echo B') + patchCall('call_P1', 'src/x.ts'));
    r = read(path);
    expect(r.exec.map(c => c.callId)).toEqual(['call_1', 'call_2']);
    expect(r.patch.map(c => c.callId)).toEqual(['call_P0', 'call_P1']);
  });

  it('routes 5.6 exec scripts into the exec or patch list by what the script calls', () => {
    // One freeform `exec` tool now carries both kinds, so the call_id → live item
    // mapping depends on classifying the script body.
    const execScript = (callId: string, cmd: string) =>
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: `const r = await tools.exec_command(${JSON.stringify({ cmd, workdir: '/repo' })}); text(r.output);` } }) + '\n';
    const patchScript = (callId: string, file: string) =>
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, input: `const patch = ${JSON.stringify(`*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch`)};\ntext(await tools.apply_patch(patch));` } }) + '\n';
    const unknownScript = JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_X', input: 'text("hi");' } }) + '\n';

    const path = tmp();
    writeFileSync(path, execScript('call_1', 'echo A') + patchScript('call_P0', 'src/x.ts') + unknownScript + execScript('call_2', 'echo B'));
    const r = createRolloutCallReader()(path);
    // The unclassifiable script is dropped rather than guessed into either list,
    // which is what keeps call_2 at index 1 of the exec list.
    expect(r.exec.map(c => c.callId)).toEqual(['call_1', 'call_2']);
    expect(r.exec.map(c => c.cmd)).toEqual(['echo A', 'echo B']);
    expect(r.patch).toEqual([{ callId: 'call_P0', files: ['src/x.ts'] }]);
    expect(resolveCodexCallId(r.exec, 1, '/bin/zsh -lc "echo B"')).toBe('call_2');
  });

  it('carries a partial trailing line until its newline arrives', () => {
    const path = tmp();
    const line = fnCall('call_1', 'echo hello');
    writeFileSync(path, line.slice(0, 20)); // half a line, no newline yet
    const read = createRolloutCallReader();
    expect(read(path).exec).toEqual([]);
    appendFileSync(path, line.slice(20));
    expect(read(path).exec.map(c => c.callId)).toEqual(['call_1']);
  });

  it('re-scans from scratch if the file shrinks (truncate/rewrite)', () => {
    const path = tmp();
    writeFileSync(path, fnCall('call_1', 'echo A') + fnCall('call_2', 'echo B'));
    const read = createRolloutCallReader();
    expect(read(path).exec.length).toBe(2);
    writeFileSync(path, fnCall('call_9', 'echo Z'));
    expect(read(path).exec.map(c => c.callId)).toEqual(['call_9']);
  });
});

describe('codex mode routing', () => {
  const events = async function* () {
    yield { type: 'thread.started', thread_id: 'sdk-thread' };
    yield { type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text: 'from sdk' } };
    yield {
      type: 'turn.completed',
      usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 },
    };
  };

  beforeEach(() => {
    mocks.rolloutPath = null;
    sdkMocks.codexCtor.mockClear();
    sdkMocks.startThread.mockClear();
    sdkMocks.resumeThread.mockClear();
    sdkMocks.runStreamed.mockReset();
    sdkMocks.throwCtorOnce = false;
    sdkMocks.runStreamed.mockResolvedValue({ events: events() });
  });

  it('defaults to the Codex SDK path', async () => {
    const emit = vi.fn();
    const rekey = vi.fn();
    await codexSpec.runner.run({
      prompt: 'hello',
      images: undefined,
      cwd: '/repo',
      sessionId: undefined,
      params: {} as never,
      signal: new AbortController().signal,
      emit,
      rekey,
      currentKey: () => 'k',
    } as never);

    expect(sdkMocks.codexCtor).toHaveBeenCalledWith({ env: {} });
    expect(sdkMocks.startThread).toHaveBeenCalledWith({
      workingDirectory: '/repo',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    });
    expect(sdkMocks.runStreamed).toHaveBeenCalledWith('hello', { signal: expect.any(AbortSignal) });
    expect(rekey).toHaveBeenCalledWith('sdk-thread');
    expect(emit).toHaveBeenCalledWith({ type: 'assistant', message: { content: [{ type: 'text', text: 'from sdk' }] } });
  });

  it('falls back to PATH codex when the bundled SDK binary is unavailable', async () => {
    sdkMocks.throwCtorOnce = true;

    await codexSpec.runner.run({
      prompt: 'hello',
      images: undefined,
      cwd: '/repo',
      sessionId: undefined,
      params: {} as never,
      signal: new AbortController().signal,
      emit: vi.fn(),
      rekey: vi.fn(),
      currentKey: () => 'k',
    } as never);

    expect(sdkMocks.codexCtor).toHaveBeenNthCalledWith(1, { env: {} });
    expect(sdkMocks.codexCtor).toHaveBeenNthCalledWith(2, { codexPathOverride: 'codex', env: {} });
  });

  it('stashes the Codex rollout while running an SDK no-history turn', async () => {
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
    sdkMocks.runStreamed.mockImplementation(async () => {
      expect(readFileSync(sessionPath, 'utf-8').trim().split('\n')).toEqual([meta]);
      appendFileSync(sessionPath, `${newLine}\n`);
      return { events: events() };
    });

    try {
      await codexSpec.runner.run({
        prompt: 'new',
        images: undefined,
        cwd: '/repo',
        sessionId: 'sdk-thread',
        params: { noHistory: true } as never,
        signal: new AbortController().signal,
        emit: vi.fn(),
        rekey: vi.fn(),
        currentKey: () => 'k',
      } as never);

      expect(readFileSync(sessionPath, 'utf-8').trim().split('\n')).toEqual([meta, oldLine, newLine]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends a non-empty text placeholder for SDK images-only turns', async () => {
    await codexSpec.runner.run({
      prompt: undefined,
      images: [{ media_type: 'image/png', data: Buffer.from('x').toString('base64') }] as never,
      cwd: '/repo',
      sessionId: undefined,
      params: {} as never,
      signal: new AbortController().signal,
      emit: vi.fn(),
      rekey: vi.fn(),
      currentKey: () => 'k',
    } as never);

    expect(sdkMocks.runStreamed.mock.calls[0][0]).toMatchObject([
      { type: 'text', text: '[Image]' },
      { type: 'local_image' },
    ]);
  });

  it('has no preflight rejecting images-only messages', () => {
    expect(codexSpec.preflight).toBeUndefined();
  });

  it('ignores unknown SDK item types without failing the turn', async () => {
    const unknownEvents = async function* () {
      yield { type: 'thread.started', thread_id: 'sdk-thread' };
      yield { type: 'item.completed', item: { id: 'future_1', type: 'future_item', text: 'metadata' } };
      yield {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
      };
    };
    const emit = vi.fn();
    sdkMocks.runStreamed.mockResolvedValue({ events: unknownEvents() });

    await codexSpec.runner.run({
      prompt: 'hello',
      images: undefined,
      cwd: '/repo',
      sessionId: undefined,
      params: {} as never,
      signal: new AbortController().signal,
      emit,
      rekey: vi.fn(),
      currentKey: () => 'k',
    } as never);

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

  it('keeps spawn calls out of the exec list so command call_ids stay aligned', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'codex-spawn-')), 'r.jsonl');
    writeFileSync(path, fnCall('call_1', 'ls') + spawnLine('call_s1', 'explorer', 'go') + fnCall('call_2', 'pwd'));
    const calls = createRolloutCallReader()(path);
    expect(calls.exec.map(c => c.callId)).toEqual(['call_1', 'call_2']);
    expect(calls.spawn.map(c => c.callId)).toEqual(['call_s1']);
  });
});

describe('codex sub-agents (collab_tool_call)', () => {
  let emit: ReturnType<typeof vi.fn>;
  let stream: ReturnType<typeof createEventStream>;

  beforeEach(() => {
    mocks.rolloutPath = null;
    emit = vi.fn();
    stream = createEventStream();
    sdkMocks.codexCtor.mockClear();
    sdkMocks.startThread.mockClear();
    sdkMocks.resumeThread.mockClear();
    sdkMocks.runStreamed.mockReset();
    sdkMocks.throwCtorOnce = false;
    sdkMocks.runStreamed.mockResolvedValue({ events: stream.events() });
  });

  const run = () =>
    codexSpec.runner.run({
      prompt: 'review the PR', images: undefined, cwd: '/repo', sessionId: undefined,
      params: {} as never, signal: new AbortController().signal,
      emit, rekey: vi.fn(), currentKey: () => 'k',
    } as never);

  const feed = async (event: unknown) => {
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

  it('keys the bubble by the persistent call_id when the rollout is readable', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'codex-live-spawn-')), 'r.jsonl');
    writeFileSync(
      path,
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'call_s1', arguments: JSON.stringify({ agent_type: 'explorer', message: '审查 Part A' }) } }) + '\n'
        + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_s1', output: JSON.stringify({ agent_id: 'agent-1', nickname: 'Turing' }) } }) + '\n'
    );
    mocks.rolloutPath = path;

    const p = run();
    await feed({ type: 'thread.started', thread_id: 'thread-1' });
    await feed(spawnCompleted);

    // call_id (not item_0) is what the resume parser keys on — a bubble minted under
    // item_0 would lose its drill-in and its snapshot on the next refresh. The
    // rollout also supplies agent_type and the nickname the header shows.
    expect(toolUses()).toEqual([{
      type: 'tool_use',
      id: 'call_s1',
      name: 'Task',
      input: { subagent_type: 'explorer', description: 'Turing (explorer)', prompt: '审查 Part A', agent_id: 'agent-1' },
    }]);

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
});

describe('codex mcp / web_search / todo_list items', () => {
  let emit: ReturnType<typeof vi.fn>;
  let stream: ReturnType<typeof createEventStream>;

  beforeEach(() => {
    mocks.rolloutPath = null;
    emit = vi.fn();
    stream = createEventStream();
    sdkMocks.codexCtor.mockClear();
    sdkMocks.startThread.mockClear();
    sdkMocks.resumeThread.mockClear();
    sdkMocks.runStreamed.mockReset();
    sdkMocks.throwCtorOnce = false;
    sdkMocks.runStreamed.mockResolvedValue({ events: stream.events() });
  });

  const run = () =>
    codexSpec.runner.run({
      prompt: 'do it', images: undefined, cwd: '/repo', sessionId: undefined,
      params: {} as never, signal: new AbortController().signal,
      emit, rekey: vi.fn(), currentKey: () => 'k',
    } as never);

  const feed = async (event: unknown) => {
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

  it('keys an MCP bubble by the rollout call_id, guarded by server+tool', async () => {
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
    await feed({ type: 'item.started', item: { id: 'item_0', type: 'mcp_tool_call', server: 'node_repl', tool: 'js', arguments: { code: '2 + 2' }, status: 'in_progress' } });

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
