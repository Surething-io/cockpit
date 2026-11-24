import { describe, expect, it, vi } from 'vitest';
import type { CodexNotification } from './codexAppServer/client';
import {
  CODEX_SUGGESTION_PROMPT,
  cancelCodexSuggestion,
  cleanCodexSuggestion,
  startCodexSuggestion,
  type CodexSuggestionTransport,
} from './codexSuggestion';

vi.mock('@cockpit/shared-utils', () => ({ readJsonFile: async () => ({}), SETTINGS_FILE: '/dev/null' }));

/**
 * Stands in for the app-server connection. Disposing it rejects whatever is
 * pending and resolves `exited`, which is what killing the real child does.
 */
function fakeTransport(opts: { hangOn?: string } = {}) {
  let exit: () => void = () => {};
  const hung: Array<(err: Error) => void> = [];
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let handler: ((n: CodexNotification) => void) | null = null;
  const t = {
    requests,
    disposed: 0,
    exited: new Promise<void>((resolve) => { exit = resolve; }),
    async request(method: string, params?: unknown) {
      requests.push({ method, params: params as Record<string, unknown> });
      if (method === opts.hangOn) return new Promise<Record<string, unknown>>((_r, reject) => { hung.push(reject); });
      if (method === 'thread/fork') return { thread: { id: 'fork-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-f' } };
      return {};
    },
    dispose() {
      t.disposed += 1;
      for (const reject of hung.splice(0)) reject(new Error('disposed'));
      exit();
    },
    bind(h: (n: CodexNotification) => void) { handler = h; },
    send(method: string, params: Record<string, unknown>) { handler?.({ method, params }); },
  };
  return t satisfies CodexSuggestionTransport & Record<string, unknown>;
}

async function turnStarted(t: ReturnType<typeof fakeTransport>) {
  await vi.waitFor(() => expect(t.requests.map((r) => r.method)).toContain('turn/start'));
}

function start(t: ReturnType<typeof fakeTransport>, over: Partial<Parameters<typeof startCodexSuggestion>[0]> = {}) {
  const publish = vi.fn();
  const onSettled = vi.fn();
  t.bind(startCodexSuggestion({
    transport: t, threadId: 'main', publish, onSettled, enabled: async () => true, ...over,
  }));
  return { publish, onSettled };
}

describe('cleanCodexSuggestion', () => {
  it('keeps the first non-empty line, trimmed and unquoted', () => {
    expect(cleanCodexSuggestion('\n  "先改第一项"  \nsecond line')).toBe('先改第一项');
    expect(cleanCodexSuggestion('「跑一下测试」')).toBe('跑一下测试');
  });

  it('rejects an empty or runaway reply', () => {
    expect(cleanCodexSuggestion('  \n ')).toBeNull();
    expect(cleanCodexSuggestion('x'.repeat(201))).toBeNull();
  });
});

describe('startCodexSuggestion', () => {
  it('forks ephemerally read-only, asks at low effort and publishes the reply', async () => {
    const t = fakeTransport();
    const { publish, onSettled } = start(t);
    await turnStarted(t);

    expect(t.requests[0]).toEqual({
      method: 'thread/fork',
      params: { threadId: 'main', ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', excludeTurns: true },
    });
    expect(t.requests[1].params).toMatchObject({
      threadId: 'fork-1', effort: 'low', input: [{ type: 'text', text: CODEX_SUGGESTION_PROMPT }],
    });

    t.send('item/completed', { threadId: 'fork-1', item: { type: 'agentMessage', text: '跑一下测试' } });
    t.send('turn/completed', { threadId: 'fork-1', turn: { status: 'completed' } });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());

    expect(publish).toHaveBeenCalledWith('跑一下测试');
    expect(t.disposed).toBeGreaterThan(0);
  });

  it('ignores notifications from any thread but the fork', async () => {
    const t = fakeTransport();
    const { publish, onSettled } = start(t);
    await turnStarted(t);
    t.send('item/completed', { threadId: 'main', item: { type: 'agentMessage', text: 'not mine' } });
    t.send('turn/completed', { threadId: 'main', turn: { status: 'completed' } });
    t.send('item/completed', { threadId: 'fork-1', item: { type: 'agentMessage', text: 'mine' } });
    t.send('turn/completed', { threadId: 'fork-1', turn: { status: 'completed' } });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(publish).toHaveBeenCalledWith('mine');
  });

  it('drops the suggestion and kills the child the moment the fork reaches for a tool', async () => {
    const t = fakeTransport();
    const { publish, onSettled } = start(t);
    await turnStarted(t);
    t.send('item/started', { threadId: 'fork-1', item: { type: 'commandExecution' } });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(publish).not.toHaveBeenCalled();
    expect(t.disposed).toBeGreaterThan(0);
  });

  it('publishes nothing for an interrupted or failed fork turn', async () => {
    const t = fakeTransport();
    const { publish, onSettled } = start(t);
    await turnStarted(t);
    t.send('item/completed', { threadId: 'fork-1', item: { type: 'agentMessage', text: 'half' } });
    t.send('turn/completed', { threadId: 'fork-1', turn: { status: 'interrupted' } });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not fork at all when the setting is off', async () => {
    const t = fakeTransport();
    const { onSettled } = start(t, { enabled: async () => false });
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(t.requests).toHaveLength(0);
    expect(t.disposed).toBeGreaterThan(0);
  });

  it('gives up and kills the child at the timeout', async () => {
    const t = fakeTransport();
    const { publish, onSettled } = start(t, { timeoutMs: 20 });
    await turnStarted(t);
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(publish).not.toHaveBeenCalled();
    expect(t.disposed).toBeGreaterThan(0);
  });

  it('survives the fork request failing', async () => {
    const t = fakeTransport({ hangOn: 'thread/fork' });
    const { onSettled } = start(t, { threadId: 'stuck' });
    await vi.waitFor(() => expect(t.requests).toHaveLength(1));
    await cancelCodexSuggestion('stuck');
    expect(onSettled).toHaveBeenCalledOnce();
  });
});

describe('cancelCodexSuggestion', () => {
  it('resolves at once when nothing is pending', async () => {
    await expect(cancelCodexSuggestion('nobody')).resolves.toBeUndefined();
    await expect(cancelCodexSuggestion(undefined)).resolves.toBeUndefined();
  });

  it('kills a generating suggestion, waits for the child, and never publishes it', async () => {
    const t = fakeTransport();
    const { publish, onSettled } = start(t, { threadId: 'busy' });
    await turnStarted(t);
    await cancelCodexSuggestion('busy');
    // Settled before cancel returned: the next run may spawn right away.
    expect(onSettled).toHaveBeenCalledOnce();
    expect(t.disposed).toBeGreaterThan(0);
    // A reply racing the kill is still dropped.
    t.send('item/completed', { threadId: 'fork-1', item: { type: 'agentMessage', text: 'late' } });
    t.send('turn/completed', { threadId: 'fork-1', turn: { status: 'completed' } });
    expect(publish).not.toHaveBeenCalled();
    // And the entry is gone, so a second cancel is a no-op.
    await expect(cancelCodexSuggestion('busy')).resolves.toBeUndefined();
  });
});
